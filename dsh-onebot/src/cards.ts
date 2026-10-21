import type { Segment } from './types.js';

type ObjectValue = Record<string, any>;
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const clean = (value: unknown, limit = 500): string => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').slice(0, limit) : '';
export interface SharedLink { url: string; platform: 'bilibili' | 'web'; videoId?: string }

/** Metadata only. No page fetch, short-link resolution, cookies or MCP execution. */
export function sharedLink(input: unknown): SharedLink | undefined {
  if (typeof input !== 'string' || input.length > 2048) return;
  try {
    const u = new URL(input);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || (u.port && !['80', '443'].includes(u.port))) return;
    if (u.hostname === 'b23.tv' && /^\/[a-zA-Z0-9]+\/?$/.test(u.pathname)) return { platform: 'bilibili', url: 'https://b23.tv' + u.pathname };
    if (u.hostname === 'bilibili.com' || u.hostname.endsWith('.bilibili.com')) {
      const id = /^\/video\/(BV[a-zA-Z0-9]{10}|av[0-9]+)(?:\/|$)/.exec(u.pathname)?.[1];
      if (id) {
        const parts=u.searchParams.getAll('p');
        if(parts.length>1||(parts.length===1&&!/^[1-9][0-9]?$/.test(parts[0]!)))return;
        const p=parts[0];
        return { platform: 'bilibili', videoId: id, url: 'https://www.bilibili.com/video/' + id+(p&&p!=='1'?'?p='+p:'') };
      }
      return { platform: 'bilibili', url: u.origin + u.pathname };
    }
    return { platform: 'web', url: u.href };
  } catch { return; }
}
export function textLinks(text: string): SharedLink[] {
  const links=[...text.matchAll(/https?:\/\/[^\s<>"'\u3000]+/g)].slice(0, 8)
    .map(m => sharedLink(m[0].replace(/[，。！？；、）)\]}]+$/, ''))).filter((v): v is SharedLink => !!v && v.platform === 'bilibili');
  for(const match of text.matchAll(/\bBV[A-Za-z0-9]{10}\b/g)){
    const id=match[0];if(!links.some(l=>l.videoId===id))links.push({platform:'bilibili',videoId:id,url:'https://www.bilibili.com/video/'+id});
    if(links.length>=8)break;
  }
  return links.slice(0,8);
}
export interface Card { forwardId?: string; title?: string; description?: string; links: SharedLink[] }
function entities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name]!);
}
/** Only known fields are rendered; arbitrary JSON/XML and embedded instructions remain data. */
export function card(segment: Segment): Card {
  const result: Card = { links: [] };
  if (segment.type === 'json') {
    let raw: unknown = segment.data.data;
    if (typeof raw === 'string') { if (raw.length > 64000) return result; try { raw = JSON.parse(raw); } catch { return result; } }
    const value = object(raw), meta = object(value.meta), detail = object(meta.detail), view = object(meta.detail_1 ?? meta.news ?? meta.music ?? meta.video ?? meta.miniapp ?? detail);
    if (value.app === 'com.tencent.multimsg') result.forwardId = clean(detail.resid ?? detail.resId ?? detail.uniseq, 512);
    result.title = clean(view.title ?? value.prompt);
    result.description = clean(view.desc ?? view.summary ?? detail.summary, 1200);
    for (const url of [view.qqdocurl, view.url, view.jumpUrl, detail.url, value.url]) { const link = sharedLink(url); if (link && !result.links.some(l => l.url === link.url)) result.links.push(link); }
  } else if (segment.type === 'xml') {
    const xml = clean(segment.data.data, 64000);
    // Attribute extraction only: never parse DTDs/entities or retrieve resources.
    const attr = (name: string) => entities(new RegExp('\\b' + name + '\\s*=\\s*(["\'])(.*?)\\1', 's').exec(xml)?.[2] ?? '');
    if (/\b(?:action=["']viewMultiMsg["']|m_resid=)/.test(xml)) result.forwardId = attr('m_resid').slice(0, 512);
    result.title = entities(/<title\b[^>]*>([\s\S]*?)<\/title>/.exec(xml)?.[1]?.replace(/<[^>]*>/g, '') ?? attr('brief')).slice(0, 500);
    result.description = entities(/<summary\b[^>]*>([\s\S]*?)<\/summary>/.exec(xml)?.[1]?.replace(/<[^>]*>/g, '') ?? '').slice(0, 1200);
    for (const value of [attr('url'), attr('jumpUrl')]) { const link = sharedLink(value); if (link) result.links.push(link); }
  } else if (segment.type === 'share') {
    result.title = clean(segment.data.title); result.description = clean(segment.data.content, 1200);
    const link = sharedLink(segment.data.url); if (link) result.links.push(link);
  }
  return result;
}
