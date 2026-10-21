import { describe,it,expect,vi } from 'vitest';
import { memoryBundle,memoryTools,memoryToolNames } from '../src/memory-tools.js';
import type { MemoryContext,MemoryStore } from '@local/qqbot-life';

const job={id:'source-event',conversation:'trusted-group',owner:'worker',phase:'pending' as const,attempts:1,payload:{}};
const execution=(id='call')=>({callId:id,signal:new AbortController().signal}) as any;
describe('scoped DSH memory capabilities',()=>{
  it('binds scope/writer to the active job and rejects model scope overrides',async()=>{
    const remember=vi.fn().mockResolvedValue({id:'memory',status:'active'}),refresh=vi.fn().mockResolvedValue(undefined);
    const current:Omit<MemoryContext,'operationKey'>={job,writer:'agent:test',actorId:'member',ownerIds:['owner']};
    const tools=memoryTools({remember} as unknown as MemoryStore,()=>current,refresh);
    expect(tools.map(t=>t.name)).toEqual(memoryToolNames);
    const tool=tools.find(t=>t.name==='memory_remember')!;
    const input={type:'semantic',subject_type:'user',subject_id:'member',content:'我喜欢茶',summary:'茶',confidence:0.8,importance:0.5,sensitivity:'internal',source_kind:'user_report',evidence:[{event_id:'source-event',quote:'我喜欢茶'}]};
    const denied:any=await tool.execute({...input,conversation:'other-group'},execution());expect(denied.error).toBe('unknown_memory_argument');expect(remember).not.toHaveBeenCalled();
    expect(await tool.execute(input,execution('operation'))).toMatchObject({ok:true});
    expect(remember.mock.calls[0]![0]).toEqual({...current,operationKey:'operation'});expect(refresh).toHaveBeenCalledOnce();
  });
  it('caps per-turn calls and resets the budget for a new job',async()=>{
    const search=vi.fn().mockResolvedValue([]);let active={job,writer:'agent:test',actorId:'member',ownerIds:[]};
    const tool=memoryTools({search} as unknown as MemoryStore,()=>active,async()=>{})[0]!;
    for(let n=0;n<12;n++)expect(await tool.execute({query:'茶'},execution(String(n)))).toMatchObject({ok:true});
    expect(await tool.execute({query:'茶'},execution())).toMatchObject({error:'memory_tool_budget'});
    active={...active,job:{...job,id:'next-event'}};expect(await tool.execute({query:'茶'},execution())).toMatchObject({ok:true});
  });
  it('keeps reads scoped and hides SQL/driver errors',async()=>{
    const search=vi.fn().mockRejectedValue(Error('SQL parameters PRIVATE'));
    const tool=memoryTools({search} as unknown as MemoryStore,()=>({job,writer:'w',actorId:'a',ownerIds:[]}),async()=>{})[0]!;
    const result=await tool.execute({query:'茶',include_candidates:true,limit:3},execution());
    expect(search.mock.calls[0]).toEqual([expect.objectContaining({job}),'茶',3,true]);
    expect(result).toMatchObject({ok:false,error:'memory_operation_failed'});expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('does not execute without an active job or after cancellation',async()=>{
    const search=vi.fn();const tool=memoryTools({search} as unknown as MemoryStore,()=>undefined,async()=>{})[0]!;
    expect(await tool.execute({query:'茶'},execution())).toMatchObject({error:'no_active_turn'});
    const controller=new AbortController();controller.abort();
    expect(await tool.execute({query:'茶'},{callId:'cancelled',signal:controller.signal} as any)).toMatchObject({error:'cancelled'});
    expect(search).not.toHaveBeenCalled();
  });
  it('bounds the prompt bundle and excludes arbitrary database fields',()=>{
    const rows=Array.from({length:10},(_,n)=>({id:String(n),content:'文'.repeat(2000),summary:'字'.repeat(300),status:'active',search_terms:'private',conversation:'other',source_event_ids:['a','b','c','d']}));
    const text=memoryBundle(rows,{event_id:'e',sender_id:'s',peer_id:'p'}),data=JSON.parse(text.split('\n')[1]!);
    expect(data.memories).toHaveLength(6);expect(data.memories[0].content).toHaveLength(400);expect(text).not.toContain('other');expect(text).not.toContain('search_terms');
  });
  it('preserves literal template-like content without invoking DSH interpolation',()=>{
    const text=memoryBundle([{content:'我喜欢 {{unknown}}',summary:'{{system}}'}],{event_id:'e',sender_id:'s',peer_id:'p'});
    expect(text).not.toContain('{{');expect(JSON.parse(text.split('\n')[1]!).memories[0].content).toBe('我喜欢 {{unknown}}');
  });
  it('reads only the active speaker profile and rejects an account selector',async()=>{
    const profile=vi.fn().mockResolvedValue({person_id:'canonical',display_name:'Here'});
    const current={job,writer:'agent:test',actorId:'member',ownerIds:[]};
    const tool=memoryTools({profile} as unknown as MemoryStore,()=>current,async()=>{}).find(t=>t.name==='person_get')!;
    expect(await tool.execute({user_id:'other'},execution())).toMatchObject({error:'unknown_memory_argument'});expect(profile).not.toHaveBeenCalled();
    expect(await tool.execute({},execution())).toMatchObject({ok:true,result:{person_id:'canonical'}});expect(profile.mock.calls[0]![0]).toMatchObject(current);
    const text=memoryBundle([],{event_id:'e',sender_id:'s',peer_id:'p'},{person_id:'canonical',display_name:'{{nickname}}'});
    expect(text).not.toContain('{{');expect(JSON.parse(text.split('\n')[1]!).profile.display_name).toBe('{{nickname}}');
  });
});
