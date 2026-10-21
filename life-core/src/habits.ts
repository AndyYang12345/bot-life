import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {Job} from './ledger.js';
import {Ledger} from './ledger.js';
import {MemoryError,bounded,containsSecret,instructionLike} from './memory-policy.js';
import {personForJob} from './identity.js';

/** Finite behavioral preferences, not user-authored executable system instructions. */
export const habitSettings={
  'reply.length':{brief:'通常简短凝练，先说结论；必要细节按追问展开。',balanced:'按问题复杂度给适量细节。',detailed:'需要解释时给出较充分的细节和例子。'},
  'reply.format':{conversational:'像正常聊天自然回答，避免不必要的小标题和罗列。',structured:'复杂问题可用条理清晰的分点表达。'},
  'reply.tone':{casual:'采用自然、平等的日常交流口吻，不强行加梗。',neutral:'采用平实中性的表达。',formal:'采用较正式、严谨的表达。'},
  'reply.process':{answer_first:'把核验结果融入回答，先给答案，不主动播报搜索过程；必要来源仍附上。',explain_method:'答案之外简短交代可核查的方法或来源依据。'},
  'reply.punctuation':{natural:'日常短聊天使用自然停顿，不机械补句号；清晰度优先，代码、链接和长解释保留必要标点。',standard:'使用规范、清楚的标点。'},
  'reply.stance':{direct:'直接表达内容或观点，避免反复用“我看了/我认为/我是怎么看的”作开场。',reflective:'需要时简短交代自己的判断与依据。'},
  'search.mode':{proactive:'遇到时效性信息或需要查证的事实，主动搜索并按需读正文后回答；闲聊无需搜索。',on_request:'仅在用户要求搜索时使用网页工具；未查证的时效信息必须说明未知，不凭印象装作已核实。'},
  'search.sources':{primary:'查证优先官方、一手或权威原始来源。',multiple:'有争议或重要事实尽量交叉核对多个独立来源。'},
} as const;
export type HabitSetting=keyof typeof habitSettings;
export type HabitScope='person'|'conversation'|'global';
export interface HabitContext {job:Job;actorId:string;ownerIds:readonly string[];operationKey:string;defaultScope?:'person'|'global';sourceEventId?:string}
export interface HabitInput {scope:HabitScope;setting:HabitSetting;value:string;expected_revision:number;quote:string}
const revokeCue=/(?:撤销|取消|删除|停用|忘掉|恢复默认).{0,16}(?:习惯|偏好|设置|规则)|(?:习惯|偏好|设置|规则).{0,16}(?:撤销|取消|删除|停用|恢复默认)/;
const globalCue=/全局(?:生效|习惯|设置|规则)|(?:习惯|设置|规则).{0,4}全局|(?:在|对|以后|今后)?所有群|每个群(?:都|里)|无论.{0,6}哪个群/;
const groupCue=/本群|这个群|当前群|群里|群内/;
const feedbackCue=/(?:以后|今后|下次|记住|改成|改为|恢复默认).{0,100}(?:回复|回答|说话|简短|详细|自然|搜索|上网|查证|官网|分点|过程|句号|标点)|我(?:希望|偏好|喜欢).{0,50}(?:回复|回答|说话)|(?:刚才|这次).{0,30}(?:太长|啰嗦|太短)|^(?:请|麻烦)?(?:回复|回答|说话).{0,20}(?:简短|详细|自然|正式)|(?:不要|不用|别|不打).{0,12}(?:句号|说你怎么看|说你是怎么看的|念叨我怎么看)/;
const privateText=/(?:\b\d{7,}\b|https?:\/\/|[\w.+-]+@[\w.-]+\.[a-z]{2,})/i;
export function directHabitText(payload:any):string{
  if(payload?.post_type==='message_sent'||payload?.self_id!==undefined&&String(payload.self_id)===String(payload.user_id))return '';
  const text=typeof payload?.text==='string'?payload.text:typeof payload?.message==='string'?payload.message
    :Array.isArray(payload?.message)?payload.message.filter((s:any)=>s?.type==='text').map((s:any)=>String(s.data?.text??'')).join(''):'';
  return text.normalize('NFKC').trim();
}
export function feedbackScope(text:string,defaultScope:'person'|'global'='person'):HabitScope{
  if(/(?:只|仅).{0,6}(?:对我|跟我|本人|我的(?:回答|回复))/.test(text))return 'person';
  if(/(?:只|仅).{0,4}(?:本群|这个群|当前群)/.test(text))return 'conversation';
  if(/(?:不要|不用|别|不必).{0,8}(?:所有群|全局)/.test(text))return groupCue.test(text)?'conversation':'person';
  return globalCue.test(text)?'global':groupCue.test(text)?'conversation':defaultScope;
}
export function feedbackChoices(text:string):{setting:HabitSetting;value:string}[]{
  if(!feedbackCue.test(text)||text.length>600||containsSecret(text)||instructionLike(text)||privateText.test(text)
    ||/假设|举个例子|有人说|转述|以下.{0,4}引用|我(?:以后|下次|今后).{0,8}(?:简短|详细|说话)|(?:不要|不用|无需|别).{0,5}(?:记住|保存|长期)|(?:只|仅).{0,3}(?:这次|本次|当前)/.test(text))return [];
  const patterns:Record<HabitSetting,Record<string,RegExp>>={
    'reply.length':{brief:/简短|精简|凝练|简明|太长|啰[嗦唆]|少说|短一点/,balanced:/长度适中|适量细节|正常长度/,detailed:/详细|展开说|多说一点|太短|充分解释/},
    'reply.format':{conversational:/自然.{0,8}(?:回答|回复|说话|聊天)|(?:回答|回复|说话).{0,8}自然|(?:不要|不用|别).{0,8}(?:分点|罗列|小标题|列表)|像.{0,5}(?:群友|网友|人类)/,structured:/(?<!不)(?<!别)(?<!要)(?:分点|结构化|列点)/},
    'reply.tone':{casual:/日常口吻|随意一点|平等交流|像.{0,5}(?:群友|网友)/,neutral:/中性|平实口吻/,formal:/正式一点|严谨口吻|正式表达/},
    'reply.process':{answer_first:/直接.{0,10}(?:答|结论)|先.{0,5}(?:答案|结论)|(?:不要|不用|别).{0,12}(?:搜索过程|检索过程|播报|报幕)|融入.{0,8}(?:回答|答复)/,explain_method:/解释.{0,8}(?:方法|依据|步骤)|说明.{0,8}(?:核验依据|核验方法)/},
    'reply.punctuation':{natural:/不打句号|(?:不要|不用|别).{0,5}(?:加|打|用|带)?句号|自然停顿/,standard:/规范标点|标准标点|标点完整/},
    'reply.stance':{direct:/直接.{0,8}(?:说内容|表达观点)|(?:不要|不用|别).{0,12}(?:说你怎么看|说你是怎么看的|念叨我怎么看)|别老说我(?:认为|觉得|看了)/,reflective:/交代.{0,8}(?:判断|依据)|说明自己的判断/},
    'search.mode':{proactive:/(?:主动|自行|自己|先|优先).{0,18}(?:搜索|上网|查证|核实|查官网)|(?:不确定|没把握|时效|价格|版本|新闻).{0,25}(?:搜索|查证|上网|查官网)/,on_request:/(?:只|仅).{0,12}(?:明确|要求|让你|叫你).{0,12}(?:搜|查)|(?:不要|别).{0,8}(?:主动|自行).{0,8}(?:搜|上网|查)/},
    'search.sources':{primary:/官网|官方|原始来源|一手来源|权威来源/,multiple:/多个来源|多方核对|交叉验证|交叉核对/},
  };
  const result:{setting:HabitSetting;value:string}[]=[];
  for(const [key,values] of Object.entries(patterns)){
    let matched=Object.entries(values).filter(([,pattern])=>pattern.test(text)).map(([value])=>value);
    if(key==='reply.format'&&/(?:不要|不用|别).{0,8}(?:分点|列点|罗列|列表)/.test(text))matched=matched.filter(v=>v!=='structured');
    if(key==='search.mode'&&matched.includes('on_request'))matched=matched.filter(v=>v!=='proactive');
    if(key==='reply.length'){
      if(/(?:不要|不用|别).{0,3}(?:简短|精简|简明|凝练)/.test(text))matched=matched.filter(v=>v!=='brief');
      if(/(?:不要|不用|别).{0,3}(?:详细|展开)/.test(text))matched=matched.filter(v=>v!=='detailed');
    }
    if(key==='reply.tone'&&/(?:不要|不用|别).{0,3}正式/.test(text))matched=matched.filter(v=>v!=='formal');
    if(key==='search.sources'&&/(?:不要|不用|别).{0,3}(?:官方|官网|权威)/.test(text))matched=matched.filter(v=>v!=='primary');
    if(matched.length===1)result.push({setting:key as HabitSetting,value:matched[0]!});
  }
  return result.slice(0,6);
}
const publicRule=(row:any)=>({id:row.id,scope:row.scope,setting:row.setting,value:row.value,status:row.status,revision:row.revision,
  behavior:(habitSettings[row.setting as HabitSetting] as Record<string,string>)?.[row.value]??'',updated_at:new Date(row.updated_at).toISOString()});

export class HabitStore {
  constructor(private ledger:Ledger){}
  private async source(c:PoolClient,ctx:HabitContext){
    const eventId=ctx.sourceEventId??ctx.job.id;
    if(eventId!==ctx.job.id&&(!ctx.job.memoryTaskId||!(await c.query('SELECT id FROM life_memory_tasks WHERE id=$1 AND $2=ANY(source_ids)',[ctx.job.memoryTaskId,eventId])).rowCount))throw new MemoryError('habit_source_mismatch');
    const source=(await c.query(`SELECT e.actor,e.payload,conv.identity_realm AS realm FROM life_events e
      JOIN life_conversations conv ON conv.key=e.conversation WHERE e.id=$1 AND e.conversation=$2 AND e.kind='inbound.message'`,[eventId,ctx.job.conversation])).rows[0];
    if(!source||source.actor!==ctx.actorId||!source.realm)throw new MemoryError('habit_source_mismatch');
    const text=directHabitText(source.payload);
    const mentions=Array.isArray(source.payload?.message)?source.payload.message.filter((s:any)=>s?.type==='at').map((s:any)=>String(s.data?.qq)):[];
    return {...source,eventId,text,addressedElsewhere:mentions.some((id:string)=>id!=='all'&&id!==String(source.payload?.self_id)),person:await personForJob(c,ctx.job)};
  }
  private proof(source:{text:string;addressedElsewhere:boolean},quote:string):string{
    const text=source.text;
    const value=bounded(quote,600,'invalid_habit_quote');
    if(source.addressedElsewhere||!text.includes(value)||containsSecret(text)||instructionLike(text)||privateText.test(text))throw new MemoryError('habit_direct_evidence_required');
    return value;
  }
  private async writable(c:PoolClient){
    if((await c.query("SELECT key FROM life_settings WHERE key IN ('paused','memory_writes_paused','habit_writes_paused') AND value='true'")).rowCount)throw new MemoryError('habit_writes_paused');
  }
  private async invalidate(c:PoolClient,row:any){
    await c.query(`UPDATE life_conversations SET session_id=NULL,generation=generation+1 WHERE identity_realm=$1 AND
      ($2='global' OR ($2='conversation' AND key=$3) OR ($2='person' AND key IN
      (SELECT conversation FROM life_conversation_people WHERE person_id=$4)))`,[row.realm,row.scope,row.conversation,row.person_id]);
  }
  async list(ctx:HabitContext):Promise<Record<string,any>>{
    return this.ledger.withJob(ctx.job,async c=>{
      const source=await this.source(c,ctx),person=source.person?.id??null;
      const rows=(await c.query(`SELECT * FROM life_habits WHERE realm=$1 AND
        (scope='global' OR (scope='conversation' AND conversation=$2) OR (scope='person' AND person_id=$3))
        ORDER BY CASE scope WHEN 'person' THEN 3 WHEN 'conversation' THEN 2 ELSE 1 END DESC,updated_at DESC`,[source.realm,ctx.job.conversation,person])).rows;
      const effective=new Map<string,any>();for(const row of rows)if(row.status==='active'&&!effective.has(row.setting))effective.set(row.setting,publicRule(row));
      return {rules:rows.map(publicRule),self_base:rows.filter(r=>r.scope==='global'&&r.status==='active').map(publicRule),effective:[...effective.values()],source:{event_id:ctx.job.id},can_manage_shared:ctx.ownerIds.includes(ctx.actorId),default_scope:ctx.defaultScope??'person'};
    });
  }
  async save(ctx:HabitContext,input:HabitInput):Promise<Record<string,any>>{
    return this.ledger.withJob(ctx.job,async(c,append)=>{
      const saved=(await c.query('SELECT result FROM life_habit_ops WHERE job_id=$1 AND operation_key=$2',[ctx.job.id,ctx.operationKey])).rows[0];if(saved)return saved.result;
      await this.writable(c);const source=await this.source(c,ctx),quote=this.proof(source,input.quote);
      if(!['person','conversation','global'].includes(input.scope)||feedbackScope(source.text,ctx.defaultScope)!==input.scope)throw new MemoryError('habit_scope_not_explicit');
      if(input.scope!=='person'&&!ctx.ownerIds.includes(ctx.actorId))throw new MemoryError('habit_owner_required');
      if(!Object.hasOwn(habitSettings,input.setting)||!Object.hasOwn(habitSettings[input.setting],input.value))throw new MemoryError('unsupported_habit');
      if(!feedbackChoices(quote).some(v=>v.setting===input.setting&&v.value===input.value))throw new MemoryError('habit_feedback_not_supported');
      if(!Number.isSafeInteger(input.expected_revision)||input.expected_revision<0)throw new MemoryError('invalid_habit_revision');
      const person=input.scope==='person'?source.person?.id:null;if(input.scope==='person'&&!person)throw new MemoryError('habit_person_unavailable');
      const subject=input.scope==='global'?source.realm:input.scope==='conversation'?ctx.job.conversation:person;
      const existing=(await c.query('SELECT * FROM life_habits WHERE realm=$1 AND scope=$2 AND subject_key=$3 AND setting=$4 FOR UPDATE',[source.realm,input.scope,subject,input.setting])).rows[0];
      if((existing?.revision??0)!==input.expected_revision)throw new MemoryError('habit_revision_conflict');
      if(existing?.status==='active'&&existing.value===input.value){
        const result={...publicRule(existing),deduplicated:true};await c.query('INSERT INTO life_habit_ops VALUES($1,$2,$3)',[ctx.job.id,ctx.operationKey,result]);return result;
      }
      const id=existing?.id??randomUUID(),revision=(existing?.revision??0)+1;
      const row=(await c.query(`INSERT INTO life_habits(id,realm,scope,subject_key,person_id,conversation,setting,value,status,revision,source_id,source_conversation,actor_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10,$11,$12)
        ON CONFLICT(realm,scope,subject_key,setting) DO UPDATE SET value=EXCLUDED.value,status='active',revision=EXCLUDED.revision,
          source_id=EXCLUDED.source_id,source_conversation=EXCLUDED.source_conversation,actor_id=EXCLUDED.actor_id,updated_at=clock_timestamp() RETURNING *`,
        [id,source.realm,input.scope,subject,person,input.scope==='conversation'?ctx.job.conversation:null,input.setting,input.value,revision,source.eventId,ctx.job.conversation,ctx.actorId])).rows[0];
      const result=publicRule(row);
      await c.query('INSERT INTO life_habit_revisions(habit_id,revision,source_id,actor_id,quote,payload) VALUES($1,$2,$3,$4,$5,$6)',[row.id,revision,source.eventId,ctx.actorId,quote,result]);
      await this.invalidate(c,row);await append('habit.saved',result);
      await c.query('INSERT INTO life_habit_ops VALUES($1,$2,$3)',[ctx.job.id,ctx.operationKey,result]);return result;
    });
  }
  async revoke(ctx:HabitContext,input:{habit_id:string;expected_revision:number;quote:string}):Promise<Record<string,any>>{
    return this.ledger.withJob(ctx.job,async(c,append)=>{
      const saved=(await c.query('SELECT result FROM life_habit_ops WHERE job_id=$1 AND operation_key=$2',[ctx.job.id,ctx.operationKey])).rows[0];if(saved)return saved.result;
      await this.writable(c);const source=await this.source(c,ctx),quote=this.proof(source,input.quote);
      if(!revokeCue.test(quote))throw new MemoryError('habit_revoke_request_required');
      if(!/^[a-f0-9-]{36}$/i.test(input.habit_id))throw new MemoryError('invalid_habit_id');
      const row=(await c.query(`SELECT * FROM life_habits WHERE id=$1 AND realm=$2 AND
        (scope='global' OR (scope='conversation' AND conversation=$3) OR (scope='person' AND person_id=$4)) FOR UPDATE`,[input.habit_id,source.realm,ctx.job.conversation,source.person?.id??null])).rows[0];
      if(!row)throw new MemoryError('habit_not_found');
      if(row.scope!=='person'&&!ctx.ownerIds.includes(ctx.actorId))throw new MemoryError('habit_owner_required');
      if(row.revision!==input.expected_revision)throw new MemoryError('habit_revision_conflict');
      if(row.status==='revoked'){
        const result={...publicRule(row),deduplicated:true};await c.query('INSERT INTO life_habit_ops VALUES($1,$2,$3)',[ctx.job.id,ctx.operationKey,result]);return result;
      }
      const updated=(await c.query("UPDATE life_habits SET status='revoked',revision=revision+1,source_id=$2,source_conversation=$3,actor_id=$4,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",[row.id,ctx.job.id,ctx.job.conversation,ctx.actorId])).rows[0];
      const result=publicRule(updated);await c.query('INSERT INTO life_habit_revisions(habit_id,revision,source_id,actor_id,quote,payload) VALUES($1,$2,$3,$4,$5,$6)',[row.id,updated.revision,ctx.job.id,ctx.actorId,quote,result]);
      await this.invalidate(c,updated);await append('habit.revoked',result);
      await c.query('INSERT INTO life_habit_ops VALUES($1,$2,$3)',[ctx.job.id,ctx.operationKey,result]);return result;
    });
  }
  async observe(ctx:HabitContext):Promise<Record<string,any>|null>{
    const source=await this.ledger.withJob(ctx.job,c=>this.source(c,ctx));
    if(source.addressedElsewhere)return null;
    const choices=feedbackChoices(source.text);
    if(!choices.length){
      const management=revokeCue.test(source.text)||/(?:查看|列出|看看).{0,8}(?:习惯|偏好)|(?:保存|记住)了哪些习惯/.test(source.text);
      return management&&!containsSecret(source.text)&&!instructionLike(source.text)&&!privateText.test(source.text)?{state:'management_request',changes:[]}:null;
    }
    const scope=feedbackScope(source.text,ctx.defaultScope),state=await this.list(ctx),changes:Record<string,any>[]=[];
    for(const choice of choices){
      const existing=state.rules.find((r:any)=>r.scope===scope&&r.setting===choice.setting);
      try{changes.push(await this.save({...ctx,operationKey:'observe:'+choice.setting},{...choice,scope,expected_revision:existing?.revision??0,quote:source.text}));}
      catch(error){changes.push({setting:choice.setting,error:error instanceof MemoryError?error.code:'habit_save_failed'});}
    }
    return {state:changes.some(c=>c.status==='active')?'saved':'rejected',changes};
  }
}
