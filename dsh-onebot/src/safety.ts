import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { MessageEvent, Policy } from './types.js';

export function allowed(event: MessageEvent, policy: Policy): boolean {
  if (event.post_type !== 'message' || !event.message_id || !event.user_id || !event.self_id) return false;
  if (String(event.user_id) === String(event.self_id)) return false;
  return event.message_type === 'group'
    ? !!event.group_id && policy.allowedGroupIds.includes(String(event.group_id))
    : event.message_type === 'private' && policy.allowedPrivateIds.includes(String(event.user_id));
}
export function imageGuard(name: string, args: unknown, root: string): string | undefined {
  if (name !== 'read_image') return 'Only sandboxed read_image is enabled for this chat.';
  const path = (args as { file_path?: unknown } | null)?.file_path;
  if (typeof path !== 'string' || !path || /^[a-z]+:\/\//i.test(path)) return 'A local image path is required.';
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(isAbsolute(path) ? path : resolve(root, path));
    const rel = relative(realRoot, real);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return 'Image path is outside the media sandbox.';
    return undefined;
  } catch { return 'Image file does not exist in the media sandbox.'; }
}
export class ImageToolGuard {
  private calls = 0;
  private paths?: Set<string>;
  constructor(private root: string, private maxCalls = 8) {}
  reset(paths?: string[]): void {
    this.calls = 0; this.paths = paths && new Set<string>();
    this.extend(paths??[]);
  }
  extend(paths:string[]):void {
    for(const path of paths){try{if(!imageGuard('read_image',{file_path:path},this.root))this.paths?.add(realpathSync(path));}catch{/* Only existing sandboxed images can be added; the call budget is not reset. */}}
  }
  check(name: string, args: unknown): string | undefined {
    const denied = imageGuard(name, args, this.root);
    if (denied) return denied;
    if (this.paths) {
      const path = (args as { file_path: string }).file_path;
      const real = realpathSync(isAbsolute(path) ? path : resolve(this.root, path));
      if (!this.paths.has(real)) return 'Image is not part of this conversation context.';
    }
    if (++this.calls > this.maxCalls) return 'Image tool budget for this turn is exhausted.';
    return undefined;
  }
}
