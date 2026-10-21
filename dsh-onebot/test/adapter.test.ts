import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowed, imageGuard, ImageToolGuard } from '../src/safety.js';
import { normalize } from '../src/inbound.js';
import { trustedImageUrl } from '../src/media.js';
import { LegacyState } from '../src/state.js';
import { OneBotClient } from '../src/client.js';
import type { Api, MessageEvent, Policy } from '../src/types.js';

const event: MessageEvent = { post_type: 'message', message_type: 'group', self_id: 100, user_id: 200, group_id: 300, message_id: 400, time: 1, message: [{ type: 'text', data: { text: 'hello' } }] };
const policy = { allowedGroupIds: ['300'], allowedPrivateIds: [] } as unknown as Policy;
const media = { image: async () => '/sandbox/image.png' };

describe('conversation boundary', () => {
  it('allows the configured test group', () => expect(allowed(event, policy)).toBe(true));
  it('rejects other groups, private chats and self events', () => {
    expect(allowed({ ...event, group_id: 301 }, policy)).toBe(false);
    expect(allowed({ ...event, message_type: 'private' }, policy)).toBe(false);
    expect(allowed({ ...event, user_id: 100 }, policy)).toBe(false);
    expect(allowed({ ...event, post_type: 'message_sent' }, policy)).toBe(false);
  });
  it('does not expose quoted text or images from another group', async () => {
    const api = (async () => ({ group_id: 301, message: [{ type: 'text', data: { text: 'secret' } }, { type: 'image', data: {} }] })) as Api;
    const result = await normalize({ ...event, message: [{ type: 'reply', data: { id: 7 } }] }, api, media);
    expect(result.body).not.toContain('secret'); expect(result.images).toBe(0); expect(result.quotes).toBe(0);
  });
  it('makes a scoped quoted image visible to the model', async () => {
    const api = (async () => ({ group_id: 300, message: [{ type: 'image', data: { file: 'a' } }] })) as Api;
    const result = await normalize({ ...event, message: [{ type: 'reply', data: { id: 7 } }, { type: 'text', data: { text: '看这张图' } }] }, api, media);
    expect(result.body).toContain('/sandbox/image.png'); expect(result.images).toBe(1); expect(result.quotes).toBe(1);
  });
  it('rejects bot-authored private quotes when their recipient cannot be proven', async () => {
    const api = (async () => ({ message_type: 'private', sender: { user_id: 100 }, message: [{ type: 'text', data: { text: 'another peer secret' } }] })) as Api;
    const result = await normalize({ ...event, message_type: 'private', message: [{ type: 'reply', data: { id: 7 } }] }, api, media);
    expect(result.body).not.toContain('secret'); expect(result.quotes).toBe(0);
  });
  it('reports media failure without making up content', async () => {
    const result = await normalize({ ...event, message: [{ type: 'image', data: { file: 'bad' } }] }, (async () => ({})) as Api, { image: async () => { throw Error(); } });
    expect(result.mediaFailures).toBe(1); expect(result.body).toContain('do not guess');
  });
});

describe('filesystem and network boundaries', () => {
  const root = mkdtempSync(join(tmpdir(), 'onebot-'));
  const sandbox = join(root, 'media'); mkdirSync(sandbox); writeFileSync(join(sandbox, 'ok.png'), 'test'); writeFileSync(join(root, 'private.png'), 'test');
  symlinkSync(join(root, 'private.png'), join(sandbox, 'link.png'));
  it('rejects unknown tools even when they were newly installed', () => expect(imageGuard('new_shell_tool', {}, sandbox)).toBeTruthy());
  it('bounds image tool calls per turn and resets for the next turn', () => {
    const guard = new ImageToolGuard(sandbox, 1); const args = { file_path: join(sandbox, 'ok.png') };
    expect(guard.check('read_image', args)).toBeUndefined(); expect(guard.check('read_image', args)).toContain('budget');
    guard.reset(); expect(guard.check('read_image', args)).toBeUndefined();
  });
  it('rejects another conversation image even inside the same media root',()=>{
    const other=join(sandbox,'other.png');writeFileSync(other,'other');const guard=new ImageToolGuard(sandbox);
    guard.reset([join(sandbox,'ok.png')]);expect(guard.check('read_image',{file_path:other})).toContain('conversation');expect(guard.check('read_image',{file_path:join(sandbox,'ok.png')})).toBeUndefined();
  });
  it('allows real media paths and rejects escapes, symlinks and missing paths', () => {
    expect(imageGuard('read_image', { file_path: join(sandbox, 'ok.png') }, sandbox)).toBeUndefined();
    for (const file_path of [join(root, 'private.png'), join(sandbox, 'link.png'), '/missing.png', 'https://example.com/a.png']) expect(imageGuard('read_image', { file_path }, sandbox)).toBeTruthy();
  });
  it('does not fetch arbitrary or misleading image hosts', () => {
    expect(trustedImageUrl('https://gchat.qpic.cn/a')).toBe(true);
    for (const u of ['http://127.0.0.1/a', 'file:///etc/passwd', 'https://qpic.cn.evil.example/a', 'https://u:p@gchat.qpic.cn/a', 'https://gchat.qpic.cn:8080/a']) expect(trustedImageUrl(u)).toBe(false);
  });
  it('rejects remote or unauthenticated OneBot connections', () => {
    expect(() => new OneBotClient('https://example.com/', 'ws://127.0.0.1:1/', 'a', 'b')).toThrow();
    expect(() => new OneBotClient('http://127.0.0.1/', 'ws://127.0.0.1:1/', '', 'b')).toThrow();
  });
});

describe('legacy migration source', () => {
  it('reads old state without rewriting it', () => {
    const root = mkdtempSync(join(tmpdir(), 'onebot-state-'));
    const body = JSON.stringify({ sessions:{a:'session'},seen:['a'],outbound:['a:reply'],rates:{a:[10]},paused:true });
    const file = join(root,'adapter-state.json'); writeFileSync(file,body);
    expect(new LegacyState(root).data.paused).toBe(true);expect(readFileSync(file,'utf8')).toBe(body);
  });
  it('starts with empty legacy data when no file exists',()=>{
    const root=mkdtempSync(join(tmpdir(),'onebot-empty-'));expect(new LegacyState(root).data.seen).toEqual([]);
  });
  it('refuses malformed legacy data rather than silently losing dedup history',()=>{
    const root=mkdtempSync(join(tmpdir(),'onebot-bad-'));writeFileSync(join(root,'adapter-state.json'),'{');expect(()=>new LegacyState(root)).toThrow();
  });
});
