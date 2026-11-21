import { getConnection } from '@/modules/database/connection.js';
import type { MemberChatTurn } from '@/shared/types.js';

/** Stores private member turns for Directory Access, separately from provider transcripts. */
export const memberChatTurnsDb = {
  list(userId: number, sessionId: string): MemberChatTurn[] {
    return getConnection().prepare(`
      SELECT id, prompt, reply FROM member_chat_turns
      WHERE user_id = ? AND session_id = ? ORDER BY id
    `).all(userId, sessionId) as MemberChatTurn[];
  },

  /** Returns legacy turns with their timestamps for the native provider history reader. */
  listTranscript(userId: number, sessionId: string): (MemberChatTurn & { recordedAt: string | null })[] {
    return getConnection().prepare(`
      SELECT id, prompt, reply, recorded_at AS recordedAt FROM member_chat_turns
      WHERE user_id = ? AND session_id = ? ORDER BY id
    `).all(userId, sessionId) as (MemberChatTurn & { recordedAt: string | null })[];
  },

  replaceFrom(userId: number, sessionId: string, turn: MemberChatTurn): void {
    const db = getConnection();
    db.transaction(() => {
      db.prepare('DELETE FROM member_chat_turns WHERE user_id = ? AND session_id = ? AND id >= ?')
        .run(userId, sessionId, turn.id);
      db.prepare('INSERT INTO member_chat_turns (user_id, session_id, id, prompt, reply, recorded_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(userId, sessionId, turn.id, turn.prompt, turn.reply, new Date().toISOString());
      db.prepare('UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE session_id = ?').run(sessionId);
    })();
  },
};
