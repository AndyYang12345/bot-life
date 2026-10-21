import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { BlobRef, Inbound } from '@local/qqbot-life';
import type { MessageEvent } from './types.js';
import { segments } from './inbound.js';

export const conversationOf = (event: MessageEvent) => `onebot:${event.self_id}:${event.message_type}:${event.group_id ?? event.user_id}`;
export const sourceKey = (event: MessageEvent) => `${conversationOf(event)}:${event.message_id}`;
export const identityOf=(event:MessageEvent)=>({realm:'onebot:'+event.self_id,platform:'qq',userId:String(event.user_id),displayName:event.sender?.card||event.sender?.nickname,allowProfileSharing:event.message_type==='group'});
export function inbound(event: MessageEvent): Inbound {
  const payload: MessageEvent = { post_type: event.post_type, self_id: event.self_id, user_id: event.user_id,
    group_id: event.group_id, message_type: event.message_type, message_id: event.message_id,
    message: segments(event.message), time: event.time, sender: event.sender && { nickname: event.sender.nickname, card: event.sender.card } };
  return { key: sourceKey(event), conversation: conversationOf(event), actor: String(event.user_id),
    identity:identityOf(event),
    occurredAt: new Date(Number.isFinite(event.time) ? event.time * 1000 : Date.now()).toISOString(), payload };
}
export function blobRef(path: string, role: string): BlobRef {
  const bytes = readFileSync(path);
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (!basename(path).startsWith(hash + '.')) throw new Error('media_hash_mismatch');
  const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.avi': 'video/x-msvideo' } as Record<string, string>)[extname(path)] ?? 'application/octet-stream';
  return { hash, path, bytes: bytes.length, mime, role };
}
export function toolPayload(type: string, data: Record<string, unknown>): unknown {
  if (type === 'tool/call') return { turn: data.turn, step: data.step, callId: data.callId, name: data.name, arguments: String(data.arguments ?? '').slice(0, 16000) };
  const message = data.message as { callId?: string; toolCallId?: string; isError?: boolean; content?: Record<string, unknown>[] } | undefined;
  return { turn: data.turn, step: data.step, callId: message?.callId ?? message?.toolCallId, isError: message?.isError,
    content: message?.content?.map(block => block.type === 'text'
      ? { type: 'text', text: String(block.text ?? '').slice(0, 16000) }
      : { type: block.type, mimeType: block.mimeType, attachment: block.attachment, storedIn: 'dsh-attachment-store' }) };
}
