// authRoutes: used by the server entrypoint to mount public authentication endpoints.
export { authRoutes, hashAccountPassword } from './auth.module.js';

// authenticateToken: used by the server entrypoint to protect authenticated API modules.
export { authenticateAdministrator, authenticateToken } from './auth.middleware.js';
// authenticateWebSocket: used by WebSocket setup to verify connection tokens.
export { authenticateWebSocket, requireAdministrator } from './auth.middleware.js';
// validateApiKey: used by the server entrypoint for optional API-wide key validation.
export { validateApiKey } from './auth.middleware.js';
export { getWorkspaceAccount, getSidebarProjectPaths } from './workspace-account.js';
