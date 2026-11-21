import { randomUUID } from 'node:crypto';

import { WebSocket } from 'ws';

import { AppError, readObjectRecord } from '@/shared/utils.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';

import type { createDirectoryAccessService } from './directory-access.service.js';

/** Connects the standard composer to private member chat without joining the host chat gateway. */
export function createMemberChatConnection(service: ReturnType<typeof createDirectoryAccessService>) {
  const viewers = new Map<number, Map<WebSocket, string | null>>();
  const runs = new Map<string, AbortController>();
  const approvals = new Map<string, {
    userId: number;
    sessionId: string;
    requestId: string;
    toolName: string;
    input: Record<string, unknown>;
    settle(allow: boolean): void;
  }>();

  function emit(ws: WebSocket, event: Record<string, unknown>) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  }

  function emitToSession(userId: number, sessionId: string, sender: WebSocket, event: Record<string, unknown>) {
    const recipients = new Set([sender]);
    for (const [viewer, selected] of viewers.get(userId) ?? []) {
      if (selected === sessionId) recipients.add(viewer);
    }
    for (const recipient of recipients) emit(recipient, { ...event, sessionId });
  }

  function ask(userId: number, sessionId: string, ws: WebSocket, signal: AbortSignal, toolName: string, input: Record<string, unknown>) {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => settle(false), 75_000);
      const cancel = () => settle(false);
      function settle(allow: boolean) {
        if (!approvals.delete(requestId)) return;
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        emitToSession(userId, sessionId, ws, { kind: 'permission_resolved', requestId, allow });
        resolve(allow);
      }
      const approval = { userId, sessionId, requestId, toolName, input, settle };
      approvals.set(requestId, approval);
      signal.addEventListener('abort', cancel, { once: true });
      emitToSession(userId, sessionId, ws, { kind: 'permission_request', requestId, toolName, input });
    });
  }

  return (ws: WebSocket, request: AuthenticatedWebSocketRequest) => {
    const userId = Number(request.user?.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      ws.close(1008, 'Authentication required');
      return;
    }
    const subscriptions = viewers.get(userId) ?? new Map<WebSocket, string | null>();
    viewers.set(userId, subscriptions);
    subscriptions.set(ws, null);
    ws.on('close', () => {
      subscriptions.delete(ws);
      if (!subscriptions.size) viewers.delete(userId);
    });

    ws.on('message', async (raw, isBinary) => {
      if (isBinary || !Buffer.isBuffer(raw)) return;
      if (raw.length > 256_000) {
        ws.close(1009, 'Message too large');
        return;
      }

      let sessionId = '';
      try {
        const frame = readObjectRecord(JSON.parse(raw.toString()));
        if (frame?.type === 'chat.permission-response') {
          const approval = typeof frame.requestId === 'string' ? approvals.get(frame.requestId) : undefined;
          if (approval?.userId === userId) approval.settle(frame.allow === true);
          return;
        }

        sessionId = typeof frame?.sessionId === 'string' ? frame.sessionId : '';
        if (!sessionId) return;
        const runKey = `${userId}:${sessionId}`;

        if (frame?.type === 'chat.abort') {
          runs.get(runKey)?.abort();
          return;
        }

        if (frame?.type === 'chat.subscribe') {
          const isProcessing = service.isProcessing(userId, sessionId);
          subscriptions.set(ws, sessionId);
          const pendingPermissions = [...approvals.values()]
            .filter((approval) => approval.userId === userId && approval.sessionId === sessionId)
            .map(({ requestId, toolName, input }) => ({ requestId, toolName, input, sessionId }));
          emit(ws, { kind: 'chat_subscribed', sessionId, isProcessing, pendingPermissions });
          return;
        }

        if (frame?.type !== 'chat.send' && frame?.type !== 'chat.edit-send') {
          throw new AppError('This action is unavailable for your account.', { code: 'MEMBER_CHAT_ACTION_UNAVAILABLE' });
        }

        const prompt = typeof frame.content === 'string' ? frame.content.trim() : '';
        const editing = frame.type === 'chat.edit-send';
        const anchor = typeof frame.anchorId === 'string' ? frame.anchorId : '';
        const editId = editing ? Number(/^member-turn-(\d+)$/.exec(anchor)?.[1]) : undefined;
        if (!prompt || prompt.length > 30_000 || (editId !== undefined && (!Number.isSafeInteger(editId) || editId < 1))) {
          throw new AppError('Enter a valid message of 1–30,000 characters.', { code: 'INVALID_MEMBER_CHAT_MESSAGE' });
        }
        const options = readObjectRecord(frame.options);
        if (Array.isArray(options?.attachments) && options.attachments.length > 0) {
          throw new AppError('Member chat supports text messages.', { code: 'MEMBER_CHAT_TEXT_ONLY' });
        }

        if (runs.has(runKey)) {
          throw new AppError('Wait for the current reply before sending another message.', { code: 'MEMBER_CHAT_IN_PROGRESS' });
        }
        const controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]);
        runs.set(runKey, controller);
        try {
          emitToSession(userId, sessionId, ws, { kind: 'chat_subscribed', isProcessing: true, pendingPermissions: [] });
          await service.sendMessage(userId, sessionId, prompt, editId, options?.model, {
            permissionMode: options?.permissionMode,
            signal,
            approve: (toolName, input) => ask(userId, sessionId, ws, signal, toolName, input),
          });
          if (editing) emitToSession(userId, sessionId, ws, { kind: 'history_truncated', anchorId: anchor });
          emitToSession(userId, sessionId, ws, { kind: 'complete', success: true });
        } catch (error) {
          if (!controller.signal.aborted) throw error;
          emitToSession(userId, sessionId, ws, { kind: 'complete', success: false, aborted: true });
        } finally {
          runs.delete(runKey);
        }
      } catch (error) {
        if (!sessionId) return;
        const message = error instanceof AppError ? error.message : 'The message could not be sent. Please try again.';
        const code = error instanceof AppError ? error.code : 'MEMBER_CHAT_FAILED';
        emit(ws, { kind: 'protocol_error', sessionId, code, error: message });
        // A reconnected tab may have received a processing acknowledgement while this call was pending.
        for (const [viewer, selectedSessionId] of viewers.get(userId) ?? []) {
          if (viewer !== ws && selectedSessionId === sessionId && code !== 'MEMBER_CHAT_IN_PROGRESS') {
            emit(viewer, { kind: 'chat_subscribed', sessionId, isProcessing: false, pendingPermissions: [] });
          }
        }
      }
    });
  };
}
