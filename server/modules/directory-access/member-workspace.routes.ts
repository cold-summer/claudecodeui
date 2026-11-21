import express from 'express';

import { sessionConversationsSearchService } from '@/modules/providers/index.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

import type { createDirectoryAccessService } from './directory-access.service.js';
import { readOffset, readUserId } from './directory-access.routes.js';
import { memberPermissionModes, memberToolsAvailable } from './member-project-tools.js';

const providers = ['claude', 'codex', 'cursor', 'opencode'] as const;

function parseProvider(value: unknown) {
  const provider = providers.find((candidate) => candidate === value);
  if (!provider) throw new AppError('Provider not found.', { statusCode: 404 });
  return provider;
}

function readLimit(value: unknown, fallback: number, max: number): number {
  return value === undefined ? fallback : Math.max(1, Math.min(max, readOffset(value)));
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Supplies the standard workspace endpoints using the member's directory assignments. */
export function createMemberWorkspaceRouters(service: ReturnType<typeof createDirectoryAccessService>) {
  const projects = express.Router();
  const sessions = express.Router();

  projects.get('/', asyncHandler(async (req, res) => {
    res.json(await service.getProjects(readUserId(req)));
  }));
  projects.get('/archived', (_req, res) => {
    res.json(createApiSuccessResponse({ projects: [] }));
  });
  projects.get('/:projectId/sessions', asyncHandler(async (req, res) => {
    res.json(await service.getSessions(
      readUserId(req), String(req.params.projectId), readOffset(req.query.offset), readLimit(req.query.limit, 20, 200),
    ));
  }));

  sessions.get('/capabilities', (_req, res) => {
    res.json(createApiSuccessResponse({
      providers: providers.map((provider) => ({
        provider,
        permissionModes: memberPermissionModes(provider),
        defaultPermissionMode: 'default',
        supportsPermissionRequests: memberToolsAvailable(),
        supportsAbort: true,
        supportsEffort: false, supportsMessageEditing: true,
      })),
    }));
  });
  sessions.get('/:provider/models', asyncHandler(async (req, res) => {
    const provider = parseProvider(req.params.provider);
    const models = await service.getModelCatalog(readUserId(req), provider);
    res.json(createApiSuccessResponse({ provider, models }));
  }));
  sessions.get('/:provider/sessions/:sessionId/active-model', asyncHandler(async (req, res) => {
    parseProvider(req.params.provider);
    res.json(createApiSuccessResponse(await service.getSessionModel(readUserId(req), String(req.params.sessionId))));
  }));
  sessions.post('/:provider/sessions/:sessionId/active-model', asyncHandler(async (req, res) => {
    parseProvider(req.params.provider);
    res.json(createApiSuccessResponse(await service.setSessionModel(readUserId(req), String(req.params.sessionId), req.body?.model)));
  }));
  sessions.get('/sessions/archived', (_req, res) => {
    res.json(createApiSuccessResponse({ sessions: [] }));
  });
  sessions.get('/sessions/running', (req, res) => {
    res.json(createApiSuccessResponse({ sessions: service.listRunningSessions(readUserId(req)) }));
  });
  sessions.get('/sessions/recent', (req, res) => {
    res.json(createApiSuccessResponse(service.getRecentSessions(
      readUserId(req), readLimit(req.query.limit, 40, 100), readOffset(req.query.offset),
    )));
  });
  sessions.get('/search/sessions', (req, res) => {
    const query = stringField(req.query.q).slice(0, 200);
    const titleResults = sessionConversationsSearchService.searchTitles(
      query, readLimit(req.query.limit, 50, 200), service.getActivePaths(readUserId(req)),
    );
    res.type('text/event-stream').set('X-Accel-Buffering', 'no');
    res.end(`event: title-results\ndata: ${JSON.stringify({ titleResults })}\n\nevent: done\ndata: {}\n\n`);
  });
  sessions.post('/sessions', asyncHandler(async (req, res) => {
    const projectPath = stringField(req.body?.projectPath);
    const initialMessage = stringField(req.body?.initialMessage).slice(0, 200);
    const provider = parseProvider(req.body?.provider ?? 'claude');
    res.status(201).json(createApiSuccessResponse(await service.createWorkspaceSession(readUserId(req), projectPath, initialMessage, provider)));
  }));
  sessions.get('/sessions/:sessionId', (req, res) => {
    res.json(createApiSuccessResponse(service.getSessionDetails(readUserId(req), String(req.params.sessionId))));
  });
  sessions.put('/sessions/:sessionId', (req, res) => {
    const summary = stringField(req.body?.summary);
    if (!summary || summary.length > 200) {
      throw new AppError('Enter a session title of 1–200 characters.', { statusCode: 400 });
    }
    res.json(createApiSuccessResponse(service.renameSession(readUserId(req), String(req.params.sessionId), summary)));
  });
  sessions.get('/sessions/:sessionId/messages', asyncHandler(async (req, res) => {
    const limit = req.query.limit === undefined ? undefined : readLimit(req.query.limit, 50, 200);
    res.json(createApiSuccessResponse(await service.getWorkspaceHistory(
      readUserId(req), String(req.params.sessionId), readOffset(req.query.offset), limit,
    )));
  }));

  return { projects, sessions };
}
