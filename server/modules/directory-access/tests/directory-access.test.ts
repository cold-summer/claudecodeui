import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { createDirectoryAccessService } from '../directory-access.service.js';

test('members can only list and read sessions in explicitly assigned active projects', async () => {
  const fixture = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cloudcli-accounts-')));
  process.env.DATABASE_PATH = path.join(fixture, 'auth.db');
  const { closeConnection, getConnection, initializeDatabase, memberChatTurnsDb, projectsDb, sessionsDb, userDb, userPreferencesDb } = await import('@/modules/database/index.js');
  const { getProjectsWithSessions, getProjectSessionsPage } = await import('@/modules/projects/index.js');
  const { sessionsService } = await import('@/modules/providers/index.js');
  try {
    getConnection().exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME,
        is_active BOOLEAN DEFAULT 1
      );
      INSERT INTO users (username, password_hash) VALUES ('legacy-admin', 'test-hash');
    `);
    await initializeDatabase();
    assert.equal(userDb.getFirstUser()?.role, 'admin');
    assert.equal(userDb.getFirstUser()?.username, 'legacy-admin');

    const alpha = path.join(fixture, 'alpha');
    const beta = path.join(alpha, 'private-worktree');
    sessionsDb.createAppSession('alpha-session', 'claude', alpha, 'Alpha conversation');
    sessionsDb.createAppSession('beta-session', 'claude', beta, 'Beta conversation');
    sessionsDb.createAppSession('archived-session', 'claude', alpha, 'Archived conversation');
    sessionsDb.updateSessionIsArchived('archived-session', true);
    const alphaId = projectsDb.getProjectPath(alpha)!.project_id;
    const betaId = projectsDb.getProjectPath(beta)!.project_id;

    let historyReads = 0;
    const usedModels: string[] = [];
    const defaultModel = 'group/test';
    const gptModel = 'codex/gpt-test';
    let reportStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => { reportStarted = resolve; });
    let resolveReply: () => void = () => {};
    const blockedReply = new Promise<void>((resolve) => { resolveReply = resolve; });
    const service = createDirectoryAccessService({
      users: userDb,
      projects: projectsDb,
      sessions: sessionsDb,
      listProjects: getProjectsWithSessions,
      listSessions: getProjectSessionsPage,
      hashPassword: async () => 'test-hash',
      createSession: sessionsService.createAppSession,
      renameSession: sessionsService.renameSessionById,
      sessionDetails: sessionsService.getSessionDetailsById,
      recentSessions: sessionsService.listRecentSessions,
      turns: memberChatTurnsDb,
      preferences: userPreferencesDb,
      getDefaultChatModel: async () => defaultModel,
      getModelCatalog: async () => ({ defaultModel, models: [
        { id: defaultModel, label: 'Default fixture', provider: 'claude' },
        { id: gptModel, label: 'GPT fixture', provider: 'codex' },
      ] }),
      completeChat: async (messages, model) => {
        usedModels.push(model);
        const prompt = messages.at(-1)?.content;
        if (prompt === 'Revoke model mid-reply') {
          reportStarted();
          await blockedReply;
        }
        if (prompt === 'Provider failure') throw new Error('Provider failure');
        return `Answer: ${messages.map((message) => message.content).join(' | ')}`;
      },
      readHistory: async (sessionId) => {
        historyReads += 1;
        return { messages: [{ id: 'message-1', sessionId, timestamp: '', provider: 'claude', kind: 'text', role: 'assistant', content: `History for ${sessionId}` }], total: 1, offset: 0, limit: 50, hasMore: false };
      },
    });
    const alice = await service.createAccount('alice', 'test-password', [alpha, alpha]);
    const bob = await service.createAccount('bob', 'test-password', [beta]);
    assert.equal(userDb.getUserById(alice.id)?.role, 'member');
    assert.equal(userDb.getUserByUsername('alice')?.role, 'member');
    assert.equal(getConnection().prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(alice.id), undefined);
    assert.deepEqual((await service.getProjects(alice.id)).map((project) => project.projectId), [alphaId]);
    assert.deepEqual((await service.getProjects(bob.id)).map((project) => project.projectId), [betaId]);
    assert.deepEqual((await service.getSessions(alice.id, alphaId, 0)).sessions.map((session) => session.id), ['alpha-session']);
    assert.deepEqual(service.getRecentSessions(alice.id, 40, 0).conversations.map((row) => row.sessionId), ['alpha-session']);
    assert.equal(service.getSessionDetails(alice.id, 'alpha-session').project?.projectId, alphaId);
    const accessDenied = (error: unknown) => error instanceof AppError && error.statusCode === 404;
    assert.equal(alice.hostWorkspaceAccess, false);
    assert.equal((await service.updateDirectories(alice.id, [alpha], undefined, true)).hostWorkspaceAccess, true);
    assert.equal((await service.updateDirectories(alice.id, [alpha])).hostWorkspaceAccess, true);
    assert.equal((await service.updateDirectories(alice.id, [alpha], undefined, false)).hostWorkspaceAccess, false);
    await assert.rejects(service.getSessions(alice.id, betaId, 0), accessDenied);
    await assert.rejects(service.getMessages(alice.id, 'beta-session', 0), accessDenied);
    assert.throws(() => service.getSessionDetails(alice.id, 'beta-session'), accessDenied);
    await assert.rejects(service.createWorkspaceSession(alice.id, beta, 'No'), accessDenied);
    await assert.rejects(service.getMessages(alice.id, 'archived-session', 0), accessDenied);
    assert.equal(historyReads, 0);
    assert.equal((await service.getMessages(alice.id, 'alpha-session', 0)).messages[0]?.content, 'History for alpha-session');
    await assert.rejects(service.createAccount('alice', 'test-password', [alpha]), { code: 'AUTH_USERNAME_CONFLICT' });
    await assert.rejects(service.updateDirectories(alice.id, [path.join(alpha, 'unregistered')]), { code: 'INVALID_PROJECT_SELECTION' });

    const historyWhileRevoked = service.getMessages(alice.id, 'alpha-session', 0);
    await service.updateDirectories(alice.id, []);
    await assert.rejects(historyWhileRevoked, accessDenied);
    assert.deepEqual(await service.getProjects(alice.id), []);
    await assert.rejects(service.getMessages(alice.id, 'alpha-session', 0), accessDenied);
    await assert.rejects(service.updateDirectories(1, []), { code: 'MEMBER_NOT_FOUND' });

    await assert.rejects(service.createSession(bob.id, alphaId), accessDenied);
    assert.throws(() => service.renameSession(bob.id, 'alpha-session', 'No'), accessDenied);
    await assert.rejects(service.sendMessage(bob.id, 'alpha-session', 'No'), accessDenied);
    const created = await service.createWorkspaceSession(bob.id, beta, 'New member session from workspace');
    assert.equal(created.sessionName, 'New member session from');
    service.renameSession(bob.id, created.sessionId, 'Scoped session');
    assert.equal((await service.getMessages(bob.id, created.sessionId, 0)).title, 'Scoped session');
    const first = await service.sendMessage(bob.id, created.sessionId, 'First prompt');
    const continuation = await service.sendMessage(bob.id, created.sessionId, 'Second prompt');
    assert.match(continuation.turns.at(-1)!.reply, /First prompt.*Second prompt/);
    await assert.rejects(service.sendMessage(bob.id, created.sessionId, 'Provider failure', first.turns[0].id), /Provider failure/);
    assert.equal(memberChatTurnsDb.list(bob.id, created.sessionId).length, 2);

    await service.updateDirectories(alice.id, [beta]);
    assert.deepEqual((await service.getMessages(alice.id, created.sessionId, 0)).turns, []);
    await assert.rejects(service.sendMessage(alice.id, created.sessionId, 'Edit another account', first.turns[0].id), { code: 'MEMBER_CHAT_MESSAGE_NOT_FOUND' });
    const edited = await service.sendMessage(bob.id, created.sessionId, 'Edited prompt', first.turns[0].id);
    assert.deepEqual(edited.turns.map((turn) => turn.prompt), ['Edited prompt']);
    const history = await service.getWorkspaceHistory(bob.id, created.sessionId, 0, 2);
    assert.equal(history.total, 3);
    assert.equal(history.hasMore, true);
    assert.equal(history.messages[0]?.transcriptAnchorId, 'member-turn-1');
    assert.equal(history.messages[0]?.content, 'Edited prompt');
    const earlierHistory = await service.getWorkspaceHistory(bob.id, created.sessionId, 2, 2);
    assert.equal(earlierHistory.messages.length, 1);
    assert.equal(earlierHistory.hasMore, false);
    const nativeHistory = await sessionsService.fetchHistory(created.sessionId, { legacyMemberUserId: bob.id, limit: 1 });
    assert.equal(nativeHistory.total, 2);
    assert.equal(nativeHistory.hasMore, true);
    assert.equal(nativeHistory.messages[0]?.role, 'assistant');
    assert.equal(nativeHistory.messages[0]?.transcriptAnchorId, undefined);
    assert.equal((await sessionsService.fetchHistory(created.sessionId, { legacyMemberUserId: alice.id })).total, 0);
    assert.deepEqual(usedModels, [defaultModel, defaultModel, defaultModel, defaultModel]);
    assert.equal(bob.models, null);
    await assert.rejects(service.updateDirectories(bob.id, [beta], ['unknown/unlisted']), { code: 'INVALID_MODEL_SELECTION' });
    await service.updateDirectories(bob.id, [beta], [gptModel, gptModel]);
    assert.deepEqual((await service.listAccounts()).accounts.find((account) => account.id === bob.id)?.models, [gptModel]);
    assert.deepEqual((await service.getModelCatalog(bob.id, 'claude')).OPTIONS, []);
    assert.deepEqual((await service.getModelCatalog(bob.id, 'codex')).OPTIONS.map((option) => option.value), [gptModel]);
    assert.deepEqual((await service.getModelCatalog(alice.id, 'codex')).OPTIONS, []);
    await assert.rejects(service.sendMessage(bob.id, created.sessionId, 'Not allowed', undefined, defaultModel), { code: 'MEMBER_CHAT_MODEL_DENIED' });
    await assert.rejects(service.setSessionModel(alice.id, created.sessionId, gptModel), { code: 'MEMBER_CHAT_MODEL_DENIED' });
    await service.setSessionModel(bob.id, created.sessionId, gptModel);
    assert.equal((await service.getSessionModel(bob.id, created.sessionId)).model, gptModel);
    assert.equal((await service.getSessionModel(alice.id, created.sessionId)).model, null);
    const pending = service.sendMessage(bob.id, created.sessionId, 'Revoke model mid-reply', undefined, gptModel);
    const denied = assert.rejects(pending, { code: 'MEMBER_CHAT_NO_MODELS' });
    await started;
    assert.deepEqual(service.listRunningSessions(bob.id).map((run) => run.sessionId), [created.sessionId]);
    assert.deepEqual(service.listRunningSessions(alice.id), []);
    assert.equal(usedModels.at(-1), gptModel);
    await service.updateDirectories(bob.id, [beta], []);
    resolveReply();
    await denied;
    assert.deepEqual(service.listRunningSessions(bob.id), []);
    await assert.rejects(service.createWorkspaceSession(bob.id, beta, 'No new chats'), { code: 'MEMBER_CHAT_NO_MODELS' });
    assert.equal((await service.getSessionModel(bob.id, created.sessionId)).model, null);
    await service.updateDirectories(bob.id, [], [gptModel]);
    await assert.rejects(service.sendMessage(bob.id, created.sessionId, 'Revoked project'), accessDenied);
    assert.deepEqual(memberChatTurnsDb.list(bob.id, created.sessionId).map((turn) => turn.prompt), ['Edited prompt']);
  } finally {
    closeConnection();
    await rm(fixture, { recursive: true, force: true });
  }
});
