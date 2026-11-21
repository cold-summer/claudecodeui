/**
 * User repository.
 *
 * Provides typed CRUD operations for administrator and member accounts.
 */

import { getConnection } from '@/modules/database/connection.js';
import type { AccountRole, DirectoryMember } from '@/shared/types.js';

type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
  last_login: string | null;
  is_active: number;
  git_name: string | null;
  git_email: string | null;
  has_completed_onboarding: number;
  role: AccountRole;
  host_workspace_access: number;
};

type UserPublicRow = Pick<UserRow, 'id' | 'username' | 'created_at' | 'last_login' | 'role' | 'host_workspace_access'>;

type UserGitConfig = {
  git_name: string | null;
  git_email: string | null;
};

type CreateUserResult = {
  id: number | bigint;
  username: string;
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Persists and resolves accounts for Auth, User, Agent, and Directory Access. */
export const userDb = {
  /** Returns true if at least one user exists in the database. */
  hasUsers(): boolean {
    const db = getConnection();
    const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as {
      count: number;
    };
    return row.count > 0;
  },

  /** Inserts a new user and returns the created ID + username. */
  createUser(username: string, passwordHash: string): CreateUserResult {
    const db = getConnection();
    const result = db
      .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
      .run(username, passwordHash);
    return { id: result.lastInsertRowid, username };
  },

  listDirectoryMembers(): DirectoryMember[] {
    const rows = getConnection().prepare(`
      SELECT id, username, allowed_directories, allowed_models, host_workspace_access FROM users
      WHERE role = 'member' ORDER BY username, id
    `).all() as (Pick<UserRow, 'id' | 'username' | 'host_workspace_access'> & {
      allowed_directories: string; allowed_models: string | null;
    })[];
    return rows.map(({ id, username, allowed_directories, allowed_models, host_workspace_access }) => ({
      id, username, directories: JSON.parse(allowed_directories) as string[],
      models: allowed_models === null ? null : JSON.parse(allowed_models) as string[],
      hostWorkspaceAccess: host_workspace_access === 1,
    }));
  },

  createDirectoryMember(username: string, passwordHash: string, directories: string[], models: string[] | null = null): DirectoryMember {
    // Older CloudCLI builds use is_active as their only workspace access check.
    // Keep members ineligible in those builds, including through existing JWTs.
    const result = getConnection().prepare(`
      INSERT INTO users (username, password_hash, is_active, role, allowed_directories, allowed_models)
      VALUES (?, ?, 0, 'member', ?, ?)
    `).run(username, passwordHash, JSON.stringify(directories), models === null ? null : JSON.stringify(models));
    return { id: Number(result.lastInsertRowid), username, directories, models, hostWorkspaceAccess: false };
  },

  updateMemberDirectories(userId: number, directories: string[], models?: string[], hostWorkspaceAccess?: boolean): boolean {
    const result = getConnection().prepare(`
      UPDATE users SET allowed_directories = ?, allowed_models = COALESCE(?, allowed_models),
        host_workspace_access = COALESCE(?, host_workspace_access)
      WHERE id = ? AND role = 'member'
    `).run(
      JSON.stringify(directories), models === undefined ? null : JSON.stringify(models),
      hostWorkspaceAccess === undefined ? null : Number(hostWorkspaceAccess), userId,
    );
    return result.changes > 0;
  },

  getMemberDirectories(userId: number): string[] {
    const row = getConnection().prepare(`
      SELECT allowed_directories FROM users WHERE id = ? AND role = 'member'
    `).get(userId) as { allowed_directories: string } | undefined;
    return row ? JSON.parse(row.allowed_directories) as string[] : [];
  },

  getMemberModels(userId: number): string[] | null {
    const row = getConnection().prepare("SELECT allowed_models FROM users WHERE id = ? AND role = 'member'")
      .get(userId) as { allowed_models: string | null } | undefined;
    return row?.allowed_models == null ? null : JSON.parse(row.allowed_models) as string[];
  },

  /**
   * Looks up a sign-in account by username.
   * Returns the full row (including password hash) for auth verification.
   */
  getUserByUsername(username: string): UserRow | undefined {
    const db = getConnection();
    return db
      .prepare("SELECT * FROM users WHERE username = ? AND (is_active = 1 OR role = 'member')")
      .get(username) as UserRow | undefined;
  },

  /** Updates the last_login timestamp. Non-fatal — logs but does not throw. */
  updateLastLogin(userId: number): void {
    try {
      const db = getConnection();
      db.prepare(
        'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(userId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to update last login', { error: message });
    }
  },

  /** Returns public user fields by ID (no password hash). */
  getUserById(userId: number): UserPublicRow | undefined {
    const db = getConnection();
    return db
      .prepare(
        "SELECT id, username, created_at, last_login, role, host_workspace_access FROM users WHERE id = ? AND (is_active = 1 OR role = 'member')"
      )
      .get(userId) as UserPublicRow | undefined;
  },

  /** Returns the first active administrator for the platform's implicit account. */
  getFirstUser(): UserPublicRow | undefined {
    const db = getConnection();
    return db
      .prepare(
        "SELECT id, username, created_at, last_login, role, host_workspace_access FROM users WHERE is_active = 1 AND role = 'admin' ORDER BY id LIMIT 1"
      )
      .get() as UserPublicRow | undefined;
  },

  /** Stores the user's preferred git name and email. */
  updateGitConfig(
    userId: number,
    gitName: string,
    gitEmail: string
  ): void {
    const db = getConnection();
    db.prepare('UPDATE users SET git_name = ?, git_email = ? WHERE id = ?').run(
      gitName,
      gitEmail,
      userId
    );
  },

  /** Retrieves the user's git identity (name + email). */
  getGitConfig(userId: number): UserGitConfig | undefined {
    const db = getConnection();
    return db
      .prepare('SELECT git_name, git_email FROM users WHERE id = ?')
      .get(userId) as UserGitConfig | undefined;
  },

  /** Marks onboarding as complete for the given user. */
  completeOnboarding(userId: number): void {
    const db = getConnection();
    db.prepare(
      'UPDATE users SET has_completed_onboarding = 1 WHERE id = ?'
    ).run(userId);
  },

  /** Returns true if the user has finished the onboarding flow. */
  hasCompletedOnboarding(userId: number): boolean {
    const db = getConnection();
    const row = db
      .prepare('SELECT has_completed_onboarding FROM users WHERE id = ?')
      .get(userId) as { has_completed_onboarding: number } | undefined;
    return row?.has_completed_onboarding === 1;
  },
};
