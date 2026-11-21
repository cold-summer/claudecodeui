import type { Request } from 'express';

import { userDb } from '@/modules/database/index.js';

/** Reads the account populated by JWT middleware for workspace routes. */
export function getWorkspaceAccount(request: Request) {
  return (request as Request & { user?: ReturnType<typeof userDb.getUserById> }).user;
}

/** Supplies the directory filter for the project and session listings used by the sidebar. */
export function getSidebarProjectPaths(request: Request): Set<string> | undefined {
  const user = getWorkspaceAccount(request);
  return user?.role === 'member' ? new Set(userDb.getMemberDirectories(user.id)) : undefined;
}
