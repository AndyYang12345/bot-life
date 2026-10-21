import {describe,it,expect,vi} from 'vitest';
import type {HabitContext,HabitStore} from '@local/qqbot-life';
import {MemoryError} from '@local/qqbot-life';
import {habitTools,habitBundle} from '../src/habit-tools.js';

const job={id:'job',conversation:'group-a',phase:'generating' as const,attempts:1,owner:'worker',payload:{}};
const current:Omit<HabitContext,'operationKey'>={job,actorId:'owner',ownerIds:['owner']};
const execution=()=>({callId:'operation',signal:new AbortController().signal}) as any;
describe('scoped habit tools',()=>{
  it('binds identity and permissions to the current job and refreshes only after a real write',async()=>{
    const save=vi.fn().mockResolvedValue({id:'h',status:'active',revision:1}),refresh=vi.fn().mockResolvedValue(undefined);
    const tool=habitTools({save} as unknown as HabitStore,()=>current,refresh).find(t=>t.name==='habit_save')!;
    const args={scope:'person',setting:'reply.length',value:'brief',expected_revision:0,quote:'以后回答简短些'};
    expect(await tool.execute({...args,ownerIds:['forged']},execution())).toMatchObject({error:'unknown_habit_argument'});expect(save).not.toHaveBeenCalled();
    expect(await tool.execute(args,execution())).toMatchObject({ok:true,result:{revision:1}});expect(save.mock.calls[0]).toEqual([{...current,operationKey:'operation'},args]);expect(refresh).toHaveBeenCalledOnce();
  });
  it('keeps no-active-turn, cancellation and store errors from producing a false saved result',async()=>{
    const list=vi.fn().mockRejectedValue(new MemoryError('habit_owner_required'));
    const noTurn=habitTools({list} as unknown as HabitStore,()=>undefined,async()=>{})[0]!;
    expect(await noTurn.execute({},execution())).toMatchObject({error:'no_active_turn'});
    const tool=habitTools({list} as unknown as HabitStore,()=>current,async()=>{})[0]!;
    expect(await tool.execute({},execution())).toMatchObject({error:'habit_owner_required'});
    list.mockRejectedValueOnce(Error('SQL_PASSWORD_PRIVATE'));expect(await tool.execute({},execution())).toMatchObject({error:'habit_operation_failed'});
    const controller=new AbortController();controller.abort();expect(await tool.execute({},{callId:'x',signal:controller.signal} as any)).toMatchObject({error:'cancelled'});
  });
  it('bounds tool calls per turn and does not expose a model-selected conversation',async()=>{
    const list=vi.fn().mockResolvedValue({rules:[]});let active=current;
    const tool=habitTools({list} as unknown as HabitStore,()=>active,async()=>{})[0]!;
    for(let n=0;n<6;n++)expect(await tool.execute({},execution())).toMatchObject({ok:true});
    expect(await tool.execute({},execution())).toMatchObject({error:'habit_tool_budget'});
    active={...current,job:{...job,id:'new'}};expect(await tool.execute({conversation:'group-b'},execution())).toMatchObject({error:'unknown_habit_argument'});
  });
  it('preserves literal data without treating it as a system template',()=>{
    const result=habitBundle({effective:[],note:'{{unsafe}}'});expect(result).not.toContain('{{');expect(JSON.parse(result.split('\n')[1]!).note).toBe('{{unsafe}}');
  });
});
