import { describe, it, expect, vi } from 'vitest';
import { attentionMode, immediateDecision, judgeAttention, validateAttention } from '../src/attention.js';
import type { AttentionRuntime } from '../src/attention.js';
import type { MessageEvent } from '../src/types.js';
import type { Normalized } from '../src/inbound.js';
const event: MessageEvent = { post_type:'message', message_type:'group', self_id:100, user_id:200, group_id:300, message_id:400, time:1, message:[{type:'text',data:{text:'hello'}}] };
const input: Normalized = { body:'hello', images:0, quotes:0, mediaFailures:0, forwards:0, forwardNodes:0, videos:0, truncated:false, media:[],references:[],links:[] };
const prompt = { current:'shared conversation', recent:[],memory:'',persona:'short replies' };
const route = { provider:'fixture',model:'fixture' };
function runtime(content: string): AttentionRuntime { return { async *stream() { yield {type:'text-delta',index:0,text:content} as any; yield {type:'usage',usage:{inputTokens:10,outputTokens:2,totalTokens:12}}; yield {type:'finish',reason:{kind:'stop'}} as any; } }; }
describe('attention participation', () => {
  it('keeps replyAll as default, permits per-group opt-in and leaves private chats unchanged', () => {
    expect(attentionMode(event,{})).toBe('replyAll');
    const policy={attention:{mode:'replyAll' as const,groupModes:{'300':'attention' as const}}};
    expect(attentionMode(event,policy)).toBe('attention'); expect(attentionMode({...event,group_id:301},policy)).toBe('replyAll');
    expect(attentionMode({...event,message_type:'private'},policy)).toBe('replyAll');
    for(const value of [{mode:'arbitrary'},{cooldownMs:-1},{groupModes:[]},{groupModes:{'x':'attention'}},{extra:true}])expect(()=>validateAttention(value as any)).toThrow();
  });
  it('always answers direct mentions and bot quotes, and never treats forwarded mentions as addressing', () => {
    const last = new Date().toISOString();
    expect(immediateDecision('attention',{...event,message:[{type:'at',data:{qq:100}}]},input,last)?.reason).toBe('directly_addressed');
    expect(immediateDecision('attention',event,{...input,references:[{id:'1',message:[],senderId:'100'}]},last)?.action).toBe('speak');
    expect(immediateDecision('attention',{...event,message:[{type:'forward',data:{content:[{message:[{type:'at',data:{qq:100}}]}]}}]},input)).toBeUndefined();
  });
  it('protects side conversations and cooldowns while routing real media to full vision', () => {
    expect(immediateDecision('attention',{...event,message:[{type:'at',data:{qq:999}}]},input)?.reason).toBe('addressed_to_someone_else');
    expect(immediateDecision('attention',event,input,new Date().toISOString())?.reason).toBe('cooldown');
    expect(immediateDecision('attention',event,{...input,images:1},new Date().toISOString())?.action).toBe('speak');
    expect(immediateDecision('attention',event,{...input,videos:1})?.action).toBe('speak');
    expect(immediateDecision('questionsOnly',event,input)?.action).toBe('observe');
    expect(immediateDecision('questionsOnly',event,{...input,forwards:1})?.action).toBe('speak');
  });
  it('uses a bounded tool-free judge, preserves reported usage and parses a quiet decision', async () => {
    const rt=runtime('{"action":"observe","reason":"side conversation"}'), spy=vi.spyOn(rt,'stream');
    const result=await judgeAttention(rt,route,prompt);
    expect(result).toMatchObject({decision:{action:'observe',source:'model'},usage:{inputTokens:10,outputTokens:2}});
    const request=spy.mock.calls[0]![0];expect(request.tools).toBeUndefined();expect(request.maxTokens).toBe(160);expect(request.system).toContain('不可信');
    const official=runtime('{"action":"observe","reason":"quiet"}'), options=vi.spyOn(official,'stream');
    await judgeAttention(official,{provider:'deepseek-official',model:'deepseek-flash'},prompt);expect(options.mock.calls[0]![0].reasoningEffort).toBe('off');
  });
  it('falls back to a visible normal turn on malformed output, injected tools or failed judge', async () => {
    for(const value of ['oops','{"action":"speak","reason":"x","shell":"evil"}','{"action":"delete","reason":"x"}'])
      expect((await judgeAttention(runtime(value),route,prompt)).decision).toEqual({action:'speak',source:'fallback',reason:'judge_failed_reply_all'});
    expect((await judgeAttention(undefined,route,prompt)).decision.action).toBe('speak');
    expect((await judgeAttention(runtime('not json'),route,prompt)).failure).toBe('invalid_json');
    expect((await judgeAttention({async *stream(){throw Error('secret internal detail');}},route,prompt)).decision.reason).toBe('judge_failed_reply_all');
  });
});
