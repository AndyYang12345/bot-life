import { describe, it, expect } from 'vitest';
import { inbound, sourceKey, toolPayload } from '../src/journal.js';
import type { MessageEvent } from '../src/types.js';
import { imageTimeline } from '../src/timeline.js';
const event:MessageEvent={post_type:'message',self_id:100,user_id:200,group_id:300,message_type:'group',message_id:400,time:1,message:[{type:'text',data:{text:'hello'}}]};
describe('channel event boundary',()=>{
  it('namespaces source identifiers by transport, account and conversation',()=>{
    expect(new Set([sourceKey(event),sourceKey({...event,self_id:101}),sourceKey({...event,group_id:301}),sourceKey({...event,message_type:'private',group_id:undefined})]).size).toBe(4);
  });
  it('records only allowed inbound fields without copying protocol credentials',()=>{
    const record=inbound({...event,token:'private',authorization:'private'} as MessageEvent);
    expect(JSON.stringify(record)).not.toContain('private');expect(record.actor).toBe('200');expect(record.occurredAt).toBe('1970-01-01T00:00:01.000Z');
  });
  it('keeps image tool-result references without copying binary/base64 payloads into the ledger',()=>{
    const value=toolPayload('tool/result',{message:{toolCallId:'call-1',content:[{type:'image',data:'large-base64',mimeType:'image/png'},{type:'text',text:'read image'}]}});
    expect(JSON.stringify(value)).not.toContain('large-base64');expect(JSON.stringify(value)).toContain('read image');
  });
  it('labels the latest image from ordered ledger facts without guessing captions',()=>{
    const rows=[{eventId:'a',path:'/media/earlier.png',hash:'a',occurredAt:'2026-01-01T00:00:00Z',role:'message:0'},{eventId:'b',path:'/media/latest.png',hash:'b',occurredAt:'2026-01-01T00:01:00Z',role:'message:0'}];
    const timeline=imageTimeline(rows);expect(timeline).toContain('最近一张用户直接发送的图片; time=2026-01-01T00:01:00Z; event_id=b');expect(timeline).toContain('引用同一张图不改变原图顺序');
  });
});
