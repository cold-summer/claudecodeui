import express, { type Request, type RequestHandler } from 'express';

import { AppError, asyncHandler } from '@/shared/utils.js';

import type { createDirectoryAccessService } from './directory-access.service.js';

type DirectoryAccessService = ReturnType<typeof createDirectoryAccessService>;

type WorkspaceRequest = Request & { user?: { id: number; role: string; host_workspace_access: number } };

/** Used by the server to admit administrators and individually authorized host workspace accounts. */
export const requireHostWorkspace: RequestHandler = (request: WorkspaceRequest, response, next) => {
  if (request.user?.role === 'admin') return next();
  if (request.user?.role === 'member' && request.user.host_workspace_access === 1) {
    response.set('Cache-Control', 'private, no-store');
    return next();
  }
  response.status(403).json({ error: 'Host workspace access required' });
};

export function readUserId(request: unknown): number {
  const userId = (request as { user?: { id: number } }).user?.id;
  if (!userId) throw new AppError('Sign in to continue.', { code: 'AUTH_USER_REQUIRED', statusCode: 401 });
  return userId;
}

export function readOffset(value: unknown): number {
  if (value === undefined) return 0;
  const offset = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(offset)) {
    throw new AppError('Invalid offset.', { code: 'INVALID_OFFSET', statusCode: 400 });
  }
  return offset;
}

/** Builds the administrator-only router mounted by the Directory Access module. */
export function createDirectoryAccountsRouter(service: DirectoryAccessService): express.Router {
  const router = express.Router();
  router.get('/', asyncHandler(async (_req, res) => {
    res.set('Cache-Control', 'private, no-store').json(await service.listAccounts());
  }));
  router.post('/', asyncHandler(async (req, res) => {
    const { username, password, directories, models } = req.body ?? {};
    res.status(201).json({ account: await service.createAccount(username, password, directories, models) });
  }));
  router.put('/:userId/directories', asyncHandler(async (req, res) => {
    const userId = Number(req.params.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      throw new AppError('Invalid user ID.', { code: 'INVALID_USER_ID', statusCode: 400 });
    }
    const hostWorkspaceAccess: unknown = req.body?.hostWorkspaceAccess;
    if (hostWorkspaceAccess !== undefined && typeof hostWorkspaceAccess !== 'boolean') {
      throw new AppError('Invalid host workspace access setting.', { statusCode: 400 });
    }
    res.json(await service.updateDirectories(userId, req.body?.directories, req.body?.models, hostWorkspaceAccess));
  }));
  return router;
}

/** Builds the member workspace router using only the current account's assignments. */
export function createAssignedProjectsRouter(service: DirectoryAccessService): express.Router {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  });
  router.get('/projects', asyncHandler(async (req, res) => {
    res.json({ projects: await service.getProjects(readUserId(req)) });
  }));
  router.get('/projects/:projectId/sessions', asyncHandler(async (req, res) => {
    res.json(await service.getSessions(readUserId(req), String(req.params.projectId), readOffset(req.query.offset)));
  }));
  router.get('/sessions/:sessionId/messages', asyncHandler(async (req, res) => {
    res.json(await service.getMessages(readUserId(req), String(req.params.sessionId), readOffset(req.query.offset)));
  }));
  router.post('/projects/:projectId/sessions', asyncHandler(async (req, res) => {
    res.status(201).json(await service.createSession(readUserId(req), String(req.params.projectId)));
  }));
  router.put('/sessions/:sessionId', (req, res) => {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title || title.length > 200) {
      throw new AppError('Enter a session title of 1–200 characters.', { code: 'INVALID_SESSION_SUMMARY', statusCode: 400 });
    }
    res.json(service.renameSession(readUserId(req), String(req.params.sessionId), title));
  });
  router.post('/sessions/:sessionId/messages', asyncHandler(async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const editId: unknown = req.body?.editId;
    if (!text || text.length > 30_000 || (editId !== undefined && (typeof editId !== 'number' || !Number.isSafeInteger(editId) || editId <= 0))) {
      throw new AppError('Enter a message of 1–30,000 characters.', { code: 'INVALID_MEMBER_CHAT_MESSAGE', statusCode: 400 });
    }
    res.json(await service.sendMessage(readUserId(req), String(req.params.sessionId), text, typeof editId === 'number' ? editId : undefined, req.body?.model));
  }));
  router.use((_req, res) => { res.status(404).json({ error: 'Not found' }); });
  return router;
}
