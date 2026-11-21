import { hashAccountPassword } from '@/modules/auth/index.js';
import { memberChatTurnsDb, projectsDb, sessionsDb, userDb, userPreferencesDb } from '@/modules/database/index.js';
import { getProjectsWithSessions, getProjectSessionsPage } from '@/modules/projects/index.js';
import { sessionsService } from '@/modules/providers/index.js';

import { createAssignedProjectsRouter, createDirectoryAccountsRouter } from './directory-access.routes.js';
import { createDirectoryAccessService } from './directory-access.service.js';
import { createMemberChatConnection } from './member-chat-websocket.js';
import { createMemberWorkspaceRouters } from './member-workspace.routes.js';
import { completeMemberChat, getMemberChatCatalog, getMemberChatModel } from './member-chat-model.js';

const service = createDirectoryAccessService({
  users: userDb,
  projects: projectsDb,
  sessions: sessionsDb,
  listProjects: getProjectsWithSessions,
  listSessions: getProjectSessionsPage,
  readHistory: (sessionId, options) => sessionsService.fetchHistory(sessionId, options),
  createSession: sessionsService.createAppSession,
  renameSession: sessionsService.renameSessionById,
  sessionDetails: sessionsService.getSessionDetailsById,
  recentSessions: sessionsService.listRecentSessions,
  turns: memberChatTurnsDb,
  preferences: userPreferencesDb,
  getDefaultChatModel: getMemberChatModel,
  getModelCatalog: getMemberChatCatalog,
  completeChat: completeMemberChat,
  hashPassword: hashAccountPassword,
});

/** Mounted by the server so administrators can manage member accounts. */
export const directoryAccountsRoutes = createDirectoryAccountsRouter(service);

/** Mounted by the server so members can browse assigned projects and their conversations. */
export const assignedProjectsRoutes = createAssignedProjectsRouter(service);


export const memberWorkspaceRoutes = createMemberWorkspaceRouters(service);
export const handleMemberChatConnection = createMemberChatConnection(service);

export { requireHostWorkspace } from './directory-access.routes.js';
