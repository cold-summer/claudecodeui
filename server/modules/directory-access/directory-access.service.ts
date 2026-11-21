import path from 'node:path';

import type { memberChatTurnsDb, projectsDb, sessionsDb, userDb, userPreferencesDb } from '@/modules/database/index.js';
import type { getProjectsWithSessions, getProjectSessionsPage } from '@/modules/projects/index.js';
import type { sessionsService } from '@/modules/providers/index.js';
import type { LLMProvider, MemberChatMessage, MemberChatRun, MemberModelOption, NormalizedMessage } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { describeMemberModel } from './member-chat-model.js';
import { readMemberPermissionMode } from './member-project-tools.js';

type DirectoryAccessDependencies = {
  users: Pick<typeof userDb, 'listDirectoryMembers' | 'createDirectoryMember' | 'updateMemberDirectories' | 'getMemberDirectories' | 'getMemberModels' | 'getUserById'>;
  projects: Pick<typeof projectsDb, 'getProjectPaths' | 'getProjectById' | 'getProjectPath'>;
  sessions: Pick<typeof sessionsDb, 'getSessionById'>;
  listProjects: typeof getProjectsWithSessions;
  listSessions: typeof getProjectSessionsPage;
  readHistory: typeof sessionsService.fetchHistory;
  createSession: typeof sessionsService.createAppSession;
  renameSession: typeof sessionsService.renameSessionById;
  sessionDetails: typeof sessionsService.getSessionDetailsById;
  recentSessions: typeof sessionsService.listRecentSessions;
  turns: typeof memberChatTurnsDb;
  preferences: Pick<typeof userPreferencesDb, 'getPreference' | 'savePreferences'>;
  getDefaultChatModel(): Promise<string>;
  getModelCatalog(): Promise<{ defaultModel: string; models: MemberModelOption[] }>;
  completeChat(messages: MemberChatMessage[], model: string, run?: MemberChatRun): Promise<string>;
  hashPassword(password: string): Promise<string>;
};

function validateDirectories(input: unknown, activePaths: ReadonlySet<string>): string[] {
  if (!Array.isArray(input) || input.some((entry) => typeof entry !== 'string' || !activePaths.has(entry))) {
    throw new AppError('Select projects from the active project list.', { code: 'INVALID_PROJECT_SELECTION', statusCode: 400 });
  }
  return [...new Set(input as string[])];
}

function denyDirectoryAccess(): never {
  throw new AppError('This project or session is not available to your account.', {
    code: 'PROJECT_ACCESS_DENIED', statusCode: 404,
  });
}

/** Coordinates account management and scoped conversations for the Directory Access routes. */
export function createDirectoryAccessService({ users, projects, sessions, listProjects, listSessions, readHistory, createSession, renameSession, sessionDetails, recentSessions, turns, preferences, getDefaultChatModel, getModelCatalog, completeChat, hashPassword }: DirectoryAccessDependencies) {
  const activePaths = () => new Set(projects.getProjectPaths().map((project) => project.project_path));
  const pending = new Map<string, { userId: number; sessionId: string; provider: string; startedAt: number }>();

  function checkProject(userId: number, project: ReturnType<typeof projects.getProjectById>) {
    if (!project || project.isArchived || !users.getMemberDirectories(userId).includes(project.project_path)) {
      denyDirectoryAccess();
    }
    return project;
  }

  function checkSession(userId: number, sessionId: string) {
    const session = sessions.getSessionById(sessionId);
    if (!session?.project_path || session.isArchived) denyDirectoryAccess();
    checkProject(userId, projects.getProjectPath(session.project_path));
    return session;
  }

  function verifySameSession(userId: number, sessionId: string, projectPath: string | null) {
    const current = checkSession(userId, sessionId);
    if (current.project_path !== projectPath) denyDirectoryAccess();
    return current;
  }

  const modelPreferenceKey = (sessionId: string) => `member-chat-model:${sessionId}`;
  const allowedModels = (userId: number, defaultModel: string) => users.getMemberModels(userId) ?? [defaultModel];

  function checkModel(userId: number, defaultModel: string, requestedModel?: unknown, savedModel?: unknown): string {
    const allowed = allowedModels(userId, defaultModel);
    if (!allowed.length) {
      throw new AppError('No models are assigned to your account.', { code: 'MEMBER_CHAT_NO_MODELS', statusCode: 403 });
    }
    if (requestedModel === undefined || requestedModel === '' || requestedModel === 'default') {
      return typeof savedModel === 'string' && allowed.includes(savedModel)
        ? savedModel
        : (allowed.includes(defaultModel) ? defaultModel : allowed[0]);
    }
    if (typeof requestedModel !== 'string' || !allowed.includes(requestedModel)) {
      throw new AppError('This model is not assigned to your account.', { code: 'MEMBER_CHAT_MODEL_DENIED', statusCode: 403 });
    }
    return requestedModel;
  }

  async function validateModels(input: unknown, previous: readonly string[] = []): Promise<string[]> {
    const { models } = await getModelCatalog();
    const choices = new Set([...models.map((model) => model.id), ...previous]);
    if (!Array.isArray(input) || input.length > 500 || input.some((model) => typeof model !== 'string' || !choices.has(model))) {
      throw new AppError('Select models from the available model list.', { code: 'INVALID_MODEL_SELECTION', statusCode: 400 });
    }
    return [...new Set(input as string[])];
  }

  return {
    async listAccounts() {
      const { defaultModel, models } = await getModelCatalog();
      return {
        defaultModel,
        models,
        accounts: users.listDirectoryMembers(),
        projects: projects.getProjectPaths().map((project) => ({
          path: project.project_path,
          displayName: project.custom_project_name?.trim() || path.basename(project.project_path) || project.project_path,
        })),
      };
    },

    async createAccount(usernameInput: unknown, password: unknown, directoriesInput: unknown, modelsInput?: unknown) {
      const username = typeof usernameInput === 'string' ? usernameInput.trim() : '';
      if (username.length < 3 || username.length > 64 || typeof password !== 'string'
        || password.length < 6 || Buffer.byteLength(password) > 72) {
        throw new AppError('Use a username of 3–64 characters and a password of at least 6 characters and at most 72 bytes.', {
          code: 'INVALID_ACCOUNT_CREDENTIALS', statusCode: 400,
        });
      }
      const directories = validateDirectories(directoriesInput, activePaths());
      const models = modelsInput === undefined ? null : await validateModels(modelsInput);
      const passwordHash = await hashPassword(password);
      try {
        return users.createDirectoryMember(username, passwordHash, directories, models);
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          throw new AppError('Username already exists.', { code: 'AUTH_USERNAME_CONFLICT', statusCode: 409 });
        }
        throw error;
      }
    },

    async updateDirectories(userId: number, input: unknown, modelsInput?: unknown, hostWorkspaceAccess?: boolean) {
      const directories = validateDirectories(input, activePaths());
      const models = modelsInput === undefined ? undefined : await validateModels(modelsInput, users.getMemberModels(userId) ?? []);
      if (!users.updateMemberDirectories(userId, directories, models, hostWorkspaceAccess)) {
        throw new AppError('Member account not found.', { code: 'MEMBER_NOT_FOUND', statusCode: 404 });
      }
      return {
        directories, models: users.getMemberModels(userId),
        hostWorkspaceAccess: users.getUserById(userId)?.host_workspace_access === 1,
      };
    },

    async getModelCatalog(userId: number, provider: LLMProvider) {
      const { defaultModel, models } = await getModelCatalog();
      const byId = new Map(models.map((model) => [model.id, model]));
      const allowed = allowedModels(userId, defaultModel)
        .map((id) => byId.get(id) ?? describeMemberModel(id))
        .filter((model) => model.provider === provider);
      const preferred = allowed.find((model) => model.id === defaultModel) ?? allowed[0];
      return {
        DEFAULT: preferred?.id ?? '',
        OPTIONS: allowed.map((model) => ({ value: model.id, label: model.label })),
      };
    },

    async getSessionModel(userId: number, sessionId: string) {
      const defaultModel = await getDefaultChatModel();
      const session = checkSession(userId, sessionId);
      const allowed = allowedModels(userId, defaultModel);
      const saved = preferences.getPreference(userId, modelPreferenceKey(sessionId));
      const model = typeof saved === 'string' && allowed.includes(saved) ? saved : null;
      return { provider: session.provider, sessionId, model, source: model ? 'session' : 'default' };
    },

    async setSessionModel(userId: number, sessionId: string, input: unknown) {
      const defaultModel = await getDefaultChatModel();
      const session = checkSession(userId, sessionId);
      if (typeof input !== 'string' || !input || input === 'default') {
        throw new AppError('Choose an assigned model.', { code: 'INVALID_MODEL_SELECTION', statusCode: 400 });
      }
      const model = checkModel(userId, defaultModel, input);
      preferences.savePreferences(userId, { [modelPreferenceKey(sessionId)]: model });
      return { provider: session.provider, sessionId, model, source: 'session' };
    },

    getActivePaths(userId: number) {
      const active = activePaths();
      return new Set(users.getMemberDirectories(userId).filter((directory) => active.has(directory)));
    },

    async getProjects(userId: number) {
      const result = await listProjects({ allowedProjectPaths: new Set(users.getMemberDirectories(userId)) });
      const current = new Set(users.getMemberDirectories(userId));
      const stillActive = activePaths();
      return result.filter((project) => current.has(project.path) && stillActive.has(project.path));
    },

    async getSessions(userId: number, projectId: string, offset: number, limit?: number) {
      checkProject(userId, projects.getProjectById(projectId));
      const result = await listSessions(projectId, { offset, limit });
      checkProject(userId, projects.getProjectById(projectId));
      return result;
    },

    getSessionDetails(userId: number, sessionId: string) {
      checkSession(userId, sessionId);
      return sessionDetails(sessionId);
    },

    getRecentSessions(userId: number, limit: number, offset: number) {
      return recentSessions(limit, offset, users.getMemberDirectories(userId));
    },

    isProcessing(userId: number, sessionId: string) {
      checkSession(userId, sessionId);
      return pending.has(`${userId}:${sessionId}`);
    },

    listRunningSessions(userId: number) {
      const allowedPaths = users.getMemberDirectories(userId);
      return [...pending.values()].filter((run) => {
        if (run.userId !== userId) return false;
        const session = sessions.getSessionById(run.sessionId);
        return session?.project_path && !session.isArchived && allowedPaths.includes(session.project_path);
      }).map(({ sessionId, provider, startedAt }) => ({ sessionId, provider, startedAt, lastSeq: 0, canInterrupt: true }));
    },

    async createWorkspaceSession(userId: number, projectPath: string, initialMessage: string, provider: LLMProvider = 'claude') {
      const defaultModel = await getDefaultChatModel();
      const project = checkProject(userId, projects.getProjectPath(projectPath));
      if (project.project_path !== projectPath) denyDirectoryAccess();
      checkModel(userId, defaultModel);
      return createSession(provider, project.project_path, initialMessage);
    },

    async getWorkspaceHistory(userId: number, sessionId: string, offset: number, limit?: number) {
      const session = checkSession(userId, sessionId);
      const history = await readHistory(sessionId);
      const current = verifySameSession(userId, sessionId, session.project_path);
      const messages: NormalizedMessage[] = history.messages.flatMap((message) =>
        message.kind === 'text' && message.role && message.content
          ? [{
              kind: 'text', id: message.id, provider: message.provider, sessionId,
              role: message.role, content: message.content, timestamp: message.timestamp,
            }]
          : []);
      const lastBaseTimestamp = Date.parse(messages.at(-1)?.timestamp ?? '') || 0;
      const lastActivity = Date.parse(current.updated_at ?? '') || Date.now();
      const saved = turns.list(userId, sessionId);
      const timestamp = new Date(Math.max(lastBaseTimestamp, lastActivity)).toISOString();
      for (const turn of saved) {
        const anchor = `member-turn-${turn.id}`;
        messages.push(
          { kind: 'text', id: anchor, transcriptAnchorId: anchor, sessionId, provider: current.provider as NormalizedMessage['provider'],
            role: 'user', content: turn.prompt, timestamp },
          { kind: 'text', id: `${anchor}-reply`, sessionId, provider: current.provider as NormalizedMessage['provider'],
            role: 'assistant', content: turn.reply, timestamp },
        );
      }

      const end = Math.max(0, messages.length - offset);
      const start = limit === undefined ? 0 : Math.max(0, end - limit);
      return { messages: messages.slice(start, end), total: messages.length, hasMore: start > 0 };
    },

    async getMessages(userId: number, sessionId: string, offset: number) {
      const session = checkSession(userId, sessionId);
      const result = await readHistory(sessionId, { limit: 50, offset });
      const current = verifySameSession(userId, sessionId, session.project_path);
      return {
        title: current.custom_name,
        messages: result.messages.flatMap((message) =>
          message.kind === 'text' && (message.role === 'user' || message.role === 'assistant') && message.content
            ? [{ id: message.id, role: message.role, content: message.content }]
            : []),
        returnedCount: result.messages.length,
        hasMore: result.hasMore,
        turns: offset === 0 ? turns.list(userId, sessionId) : [],
      };
    },

    async createSession(userId: number, projectId: string) {
      const defaultModel = await getDefaultChatModel();
      const project = checkProject(userId, projects.getProjectById(projectId));
      checkModel(userId, defaultModel);
      return createSession('claude', project.project_path, '');
    },

    renameSession(userId: number, sessionId: string, title: string) {
      checkSession(userId, sessionId);
      return renameSession(sessionId, title);
    },

    async sendMessage(
      userId: number,
      sessionId: string,
      prompt: string,
      editId?: number,
      requestedModel?: unknown,
      tools?: Pick<MemberChatRun, 'approve' | 'signal'> & { permissionMode?: unknown },
    ) {
      const defaultModel = await getDefaultChatModel();
      const session = checkSession(userId, sessionId);
      const permissionMode = tools ? readMemberPermissionMode(session.provider as LLMProvider, tools.permissionMode) : undefined;
      const preferenceKey = modelPreferenceKey(sessionId);
      const model = checkModel(userId, defaultModel, requestedModel, preferences.getPreference(userId, preferenceKey));
      const key = `${userId}:${sessionId}`;
      if (pending.has(key)) {
        throw new AppError('Wait for the current reply before sending another message.', { code: 'MEMBER_CHAT_IN_PROGRESS', statusCode: 409 });
      }
      const saved = turns.list(userId, sessionId);
      if (editId !== undefined && !saved.some((turn) => turn.id === editId)) {
        throw new AppError('Message not found.', { code: 'MEMBER_CHAT_MESSAGE_NOT_FOUND', statusCode: 404 });
      }
      const turnId = editId ?? ((saved.at(-1)?.id ?? 0) + 1);
      pending.set(key, { userId, sessionId, provider: session.provider, startedAt: Date.now() });
      try {
        const existing = await readHistory(sessionId, { limit: 30, offset: 0 });
        verifySameSession(userId, sessionId, session.project_path);
        const messages: MemberChatMessage[] = [];
        for (const message of existing.messages) {
          if (message.kind === 'text' && message.role && message.content) {
            messages.push({ role: message.role, content: message.content });
          }
        }
        for (const turn of saved.filter((turn) => turn.id < turnId).slice(-20)) {
          messages.push({ role: 'user', content: turn.prompt }, { role: 'assistant', content: turn.reply });
        }
        // Keep the recent suffix and bound the request even for large imported transcripts.
        let contextSize = prompt.length;
        let start = messages.length;
        while (start > 0 && contextSize + messages[start - 1].content.length <= 80_000) {
          start -= 1;
          contextSize += messages[start].content.length;
        }
        checkModel(userId, defaultModel, model);
        if (preferences.getPreference(userId, preferenceKey) !== model) {
          preferences.savePreferences(userId, { [preferenceKey]: model });
        }
        const hostWorkspaceAccess = users.getUserById(userId)?.host_workspace_access === 1;
        const checkAccess = () => {
          verifySameSession(userId, sessionId, session.project_path);
          checkModel(userId, defaultModel, model);
          if (hostWorkspaceAccess && users.getUserById(userId)?.host_workspace_access !== 1) denyDirectoryAccess();
        };
        const run = tools && permissionMode && session.project_path
          ? { approve: tools.approve, signal: tools.signal, checkAccess, permissionMode, hostWorkspaceAccess, projectPath: session.project_path }
          : undefined;
        const reply = await completeChat([...messages.slice(start), { role: 'user', content: prompt }], model, run);
        run?.signal.throwIfAborted();
        checkAccess();
        turns.replaceFrom(userId, sessionId, { id: turnId, prompt, reply });
        return { turns: turns.list(userId, sessionId) };
      } finally {
        pending.delete(key);
      }
    },
  };
}
