import { describe, it, expect, vi } from 'vitest';
import { normalize } from '../src/inbound.js';
import { card, sharedLink, textLinks } from '../src/cards.js';
import type { Api, MessageEvent, Segment } from '../src/types.js';

const text = (value: string): Segment => ({ type: 'text', data: { text: value } });
const event = (message: Segment[]): MessageEvent => ({ post_type: 'message', message_type: 'group', self_id: 100, user_id: 200, group_id: 300, message_id: 400, time: 1, message });
const media = { image: vi.fn(async () => '/sandbox/forward.png') };

describe('merged forwards and shared cards', () => {
  it('fetches the actual NapCat messages shape and exposes claimed authors, order, text and images', async () => {
    const api = vi.fn(async () => ({ messages: [
      { sender: { user_id: 1, nickname: 'Alice' }, time: 100, message: [text('first')] },
      { sender: { user_id: 2, nickname: 'Bob' }, time: 101, message: [text('second'), { type: 'image', data: { file: 'image-id' } }] },
    ] }));
    const value = await normalize(event([{ type: 'forward', data: { id: 'received-resource' } }]), api as Api, media);
    expect(api).toHaveBeenCalledWith('get_forward_msg', { message_id: 'received-resource' });
    expect(value).toMatchObject({ forwards: 1, forwardNodes: 2, images: 1, truncated: false });
    expect(value.body.indexOf('first')).toBeLessThan(value.body.indexOf('second'));
    expect(value.body).toContain('Alice'); expect(value.body).toContain('not the current sender');
    expect(value.media[0]?.role).toMatch(/^message:0:forward:2:/);
  });
  it('handles inline content and node wrappers without fetching arbitrary message IDs', async () => {
    const api = vi.fn(async () => { throw Error(); });
    const value = await normalize(event([{ type: 'forward', data: { id: 'inline', content: [
      { type: 'node', data: { nickname: 'claimed', content: [text('outer'), { type: 'forward', data: { id: 'nested', content: [
        { sender: { nickname: 'other' }, message: [text('inner'), { type: 'reply', data: { id: 'another-group-secret' } }] },
      ] } }] } },
    ] } }]), api as Api, media);
    expect(value.body).toContain('outer'); expect(value.body).toContain('inner'); expect(value.forwards).toBe(2); expect(api).not.toHaveBeenCalled();
  });
  it('expands XML/JSON forward cards but treats their previews as shared data', async () => {
    const api = vi.fn(async () => ({ messages: [{ message: [text('actual body')] }] }));
    for (const segment of [
      { type: 'json', data: { data: JSON.stringify({ app: 'com.tencent.multimsg', meta: { detail: { resid: 'resource-A' } } }) } },
      { type: 'xml', data: { data: '<msg action="viewMultiMsg" m_resid="resource-A"><title>preview</title></msg>' } },
    ]) {
      const value = await normalize(event([segment]), api as Api, media);
      expect(value.body).toContain('actual body'); expect(value.forwards).toBe(1);
    }
  });
  it('bounds recursive, repeated and enormous forwarding, and reports omissions', async () => {
    const api = vi.fn(async () => ({ messages: [{ message: [{ type: 'forward', data: { id: 'cycle' } }] }] }));
    const cyclic = await normalize(event([{ type: 'forward', data: { id: 'cycle' } }]), api as Api, media);
    expect(api).toHaveBeenCalledTimes(1); expect(cyclic.body).toContain('Repeated');
    const huge = await normalize(event([{ type: 'forward', data: { content: Array.from({ length: 100 }, () => ({ message: [text('x'.repeat(1000))] })) } }]), api as Api, media);
    expect(huge.truncated).toBe(true); expect(huge.forwardNodes).toBeLessThanOrEqual(30); expect(huge.body.length).toBeLessThan(28000);
    const many = await normalize(event(Array.from({ length: 1000 }, (_, i) => ({ type: 'forward', data: { id: 'different-' + i } }))), api as Api, media);
    expect(many.truncated).toBe(true); expect(api.mock.calls.length).toBeLessThanOrEqual(6);
  });
  it('retains the outer text when a forward is expired instead of inventing its contents', async () => {
    const value = await normalize(event([text('please read'), { type: 'forward', data: { id: 'expired' } }]), (async () => { throw Error('private diagnostic URL'); }) as Api, media);
    expect(value.body).toContain('please read'); expect(value.body).toContain('expired'); expect(value.body).not.toContain('private diagnostic');
  });
  it('expands forwards inside an authorized quote, rejects another group before any forward fetch', async () => {
    const api = vi.fn(async (action: string) => action === 'get_msg' ? { group_id: 300, sender: { user_id: 100 }, message: [{ type: 'forward', data: { id: 'quoted' } }] }
      : { messages: [{ message: [text('quote-forward')] }] });
    const value = await normalize(event([{ type: 'reply', data: { id: 2 } }]), api as Api, media);
    expect(value.body).toContain('quote-forward'); expect(value.references[0]?.senderId).toBe('100');
    api.mockClear(); api.mockImplementation(async () => ({ group_id: 999, sender: { user_id: 100 }, message: [{ type: 'forward', data: { id: 'secret' } }] }));
    expect((await normalize(event([{ type: 'reply', data: { id: 2 } }]), api as Api, media)).forwards).toBe(0); expect(api).toHaveBeenCalledTimes(1);
  });
  it('extracts a Bilibili miniapp card and plain links without claiming it watched the video', async () => {
    const segment = { type: 'json', data: { data: JSON.stringify({ app: 'com.tencent.miniapp_01', meta: { detail_1: { title: 'video title', desc: 'shared description', qqdocurl: 'https://www.bilibili.com/video/BV1xx411c7mD/?share_source=QQ' } } }) } };
    const value = await normalize(event([segment, text('https://b23.tv/AbC123。')]), (async () => { throw Error(); }) as Api, media);
    expect(value.body).toContain('video title'); expect(value.body).toContain('do not claim unread video content');
    expect(value.links).toEqual([{ platform: 'bilibili', videoId: 'BV1xx411c7mD', url: 'https://www.bilibili.com/video/BV1xx411c7mD' }, { platform: 'bilibili', url: 'https://b23.tv/AbC123' }]);
    expect(sharedLink('https://bilibili.com.evil.invalid/video/BV1xx411c7mD')?.platform).toBe('web');
    expect(sharedLink('file:///private')).toBeUndefined(); expect(sharedLink('http://user:secret@b23.tv/abc')).toBeUndefined();
    expect(textLinks('https://b23.tv/abc')).toHaveLength(1);
  });
  it('does not execute XML entities or pass arbitrary card properties to the model', () => {
    expect(card({ type: 'xml', data: { data: '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///private">]><msg><title>&x;</title></msg>' } }).title).toBe('&x;');
    expect(JSON.stringify(card({ type: 'json', data: { data: '{"token":"do-not-copy","meta":{"news":{"title":"ok"}}}' } }))).not.toContain('do-not-copy');
  });
  it('presents forwarded video frames as bounded samples with audio explicitly unavailable', async () => {
    const value = await normalize(event([{ type: 'forward', data: { content: [{ message: [{ type: 'video', data: { file: 'opaque' } }] }] } }]), (async () => ({})) as Api,
      { ...media, video: async () => ({ path: '/sandbox/video.mp4', duration: 3, frames: [{ path: '/sandbox/frame.jpg', at: 1 }] }) });
    expect(value.videos).toBe(1); expect(value.body).toContain('no audio/subtitles'); expect(value.body).toContain('read_image');
    expect(value.media.map(m => m.role)).toEqual(['message:0:forward:1:0:video', 'message:0:forward:1:0:frame:0']);
  });
});
