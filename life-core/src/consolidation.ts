import {ConsolidationQueue} from './consolidation-queue.js';
import type {MemoryTask,TokenUsage} from './consolidation-queue.js';
import {MemoryStore,MemoryError} from './memory.js';
import type {RememberInput} from './memory.js';
import {containsSecret,instructionLike,shareable} from './memory-policy.js';
import {personForJob} from './identity.js';
import {StyleStore,parseStyleProposals} from './style.js';
import type {StyleInput,StyleProposal} from './style.js';
import {AttentionStore,parseAliasProposals} from './attention-learning.js';
import type {AliasInput,AliasProposal} from './attention-learning.js';
import {HabitStore,habitSettings,feedbackChoices} from './habits.js';
import type {HabitSetting} from './habits.js';
interface SelfHabitChange {setting:HabitSetting;value:string;event_id:string;quote:string}

export interface ExtractionInput {
  events:{id:string;text:string;at:string}[];
  existing:{id:string;revision:number;type:string;status:string;slot:string|null;content:string;summary:string}[];
  style?:StyleInput;
  attention?:AliasInput;
  selfHabits?:{feedback:{id:string;text:string}[];settings:typeof habitSettings};
}
export interface ExtractionResponse {content:string;usage?:TokenUsage}
export interface Extractor {provider:string;model:string;extract(input:ExtractionInput):Promise<ExtractionResponse>}
interface Proposal {
  type:'semantic'|'episodic'|'open_thread';content:string;summary:string;
  source_kind:'user_report'|'agent_inference';confidence:number;importance:number;
  sensitivity:'internal'|'sensitive';share_category:'preference'|'communication'|null;
  slot:string|null;evidence:{event_id:string;quote:string}[];
  duplicate_of:string|null;contradicts:string|null;
}
interface Plan {version:1;memories:Proposal[];rejected:number;filteredSources:number;references:ExtractionInput['existing'];style?:StyleInput;styleRules?:StyleProposal[];attention?:AliasInput;aliases?:AliasProposal[];selfHabits?:ExtractionInput['selfHabits'];habitChanges?:SelfHabitChange[]}
const keys=['type','content','summary','source_kind','confidence','importance','sensitivity','share_category','slot','evidence','duplicate_of','contradicts'];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);

export function parseExtraction(content:string,input:ExtractionInput):{memories:Proposal[];rejected:number;styleRules?:StyleProposal[];aliases?:AliasProposal[];habitChanges?:SelfHabitChange[]}{
  if(content.length>20000)throw Error('invalid_extraction');
  let value:unknown;try{value=JSON.parse(content);}catch{throw Error('invalid_extraction');}
  if(!object(value)||Object.keys(value).some(k=>!['memories',...(input.style?['styles']:[]),...(input.attention?['aliases']:[]),...(input.selfHabits?['habit_changes']:[])].includes(k))||!Array.isArray(value.memories)||value.memories.length>4)throw Error('invalid_extraction');
  const sources=new Map(input.events.map(e=>[e.id,e.text.normalize('NFKC')]));
  const references=new Set(input.existing.map(e=>e.id));
  const memories:Proposal[]=[];let rejected=0;
  for(const raw of value.memories){
    if(!object(raw)||Object.keys(raw).some(k=>!keys.includes(k))){rejected++;continue;}
    const m:Record<string,any>={sensitivity:'internal',share_category:null,slot:null,duplicate_of:null,contradicts:null,...raw};
    const score=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1;
    const text=(v:unknown,max:number)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
    if(!['semantic','episodic','open_thread'].includes(m.type)||!['user_report','agent_inference'].includes(m.source_kind)
      ||!['internal','sensitive'].includes(m.sensitivity)||!text(m.content,800)||!text(m.summary,160)||!score(m.confidence)||!score(m.importance)
      ||(m.share_category!==null&&!['preference','communication'].includes(m.share_category))
      ||(m.slot!==null&&(typeof m.slot!=='string'||!/^[a-z0-9_.:-]{1,80}$/i.test(m.slot)))
      ||[m.duplicate_of,m.contradicts].some(id=>id!==null&&(typeof id!=='string'||!uuid.test(id)||!references.has(id)))
      ||!Array.isArray(m.evidence)||!m.evidence.length||m.evidence.length>4
      ||m.evidence.some((e:any)=>!object(e)||Object.keys(e).some(k=>!['event_id','quote'].includes(k))||!text(e.quote,800)
        ||!sources.get(e.event_id)?.includes(e.quote.normalize('NFKC').trim()))
      ||containsSecret(m.content+'\n'+m.summary)||instructionLike(m.content+'\n'+m.summary)){
      rejected++;continue;
    }
    memories.push(m as Proposal);
  }
  const result:{memories:Proposal[];rejected:number;styleRules?:StyleProposal[];aliases?:AliasProposal[];habitChanges?:SelfHabitChange[]}={memories,rejected};
  if(input.style){const styles=parseStyleProposals(value.styles,input.style);result.styleRules=styles.rules;result.rejected+=styles.rejected;}
  if(input.attention){const aliases=parseAliasProposals(value.aliases,input.attention);result.aliases=aliases.aliases;result.rejected+=aliases.rejected;}
  if(input.selfHabits&&value.habit_changes!==undefined){
    if(!Array.isArray(value.habit_changes)||value.habit_changes.length>3)throw Error('invalid_extraction');
    result.habitChanges=[];
    for(const p of value.habit_changes){
      if(!object(p)||Object.keys(p).some(k=>!['setting','value','event_id','quote'].includes(k))||typeof p.quote!=='string'
        ||!input.selfHabits.feedback.find(e=>e.id===p.event_id)?.text.includes(p.quote)
        ||!feedbackChoices(p.quote).some(c=>c.setting===p.setting&&c.value===p.value)){result.rejected++;continue;}
      result.habitChanges.push(p as SelfHabitChange);
    }
  }
  return result;
}

/** No chat transport, shell/tools, identity assignment or arbitrary database action. */
export class Consolidator {
  readonly queue:ConsolidationQueue;
  readonly store:MemoryStore;
  constructor(queue:ConsolidationQueue,private options:{personalProfiles:boolean;ownerIds:readonly string[];maxPerHour:number;maxPerDay:number;styleLearning?:boolean;attentionLearning?:boolean;identityName?:string;unifiedPersona?:boolean}){
    this.queue=queue;this.store=new MemoryStore(queue.ledger,{personalProfiles:options.personalProfiles});
  }
  private async existing(task:MemoryTask):Promise<ExtractionInput['existing']>{
    return this.queue.ledger.withJob(task.job,async c=>{
      const person=this.options.personalProfiles?await personForJob(c,task.job):undefined;
      return (await c.query(`SELECT id,revision,type,status,slot,left(content,600) AS content,left(summary,160) AS summary
        FROM life_memories WHERE subject_type='user' AND subject_id=$1 AND status IN ('active','candidate')
        AND (conversation=$2 OR (visibility='person' AND person_id=$3)) ORDER BY updated_at DESC LIMIT 6`,
        [task.actor,task.job.conversation,person?.id??null])).rows;
    });
  }
  async run(task:MemoryTask,extractor:Extractor,stillAllowed:()=>Promise<boolean>=async()=>true):Promise<Record<string,unknown>>{
    const sources=await this.queue.sources(task);
    let plan=task.plan as Plan|null;
    if(!plan){
      const events=sources.filter(e=>e.text.trim()&&!e.text.trim().startsWith('/')&&e.text.length<=1500&&!containsSecret(e.text)&&!instructionLike(e.text)
        &&!/(?:不要|别|不许).{0,6}(?:记住|记录|保存|存档)|(?:忘记|删除).{0,8}(?:记忆|偏好|资料)/.test(e.text));
      const input:ExtractionInput={events,existing:await this.existing(task)};
      if(this.options.styleLearning){
        const paused=!!(await this.queue.ledger.pool.query("SELECT key FROM life_settings WHERE key='style_learning_paused' AND value='true'")).rowCount;
        if(!paused)input.style=await new StyleStore(this.queue.ledger).input(task.job,Math.min(3400,13500-JSON.stringify(input).length));
      }
      if(this.options.attentionLearning)input.attention=await new AttentionStore(this.queue.ledger).input(task.job,this.options.identityName??'奶鲸',Math.min(2600,13500-JSON.stringify(input).length));
      if(this.options.unifiedPersona&&this.options.ownerIds.includes(task.actor)){
        const feedback=events.filter(e=>e.text.length<=600&&feedbackChoices(e.text).length).slice(-3).map(e=>({id:e.id,text:e.text}));
        if(feedback.length){const selfHabits={feedback,settings:habitSettings};if(JSON.stringify({...input,selfHabits}).length<=13500)input.selfHabits=selfHabits;}
      }
      let parsed:ReturnType<typeof parseExtraction>={memories:[],rejected:0};
      if(events.length||input.style||input.attention){
        if(JSON.stringify(input).length>14000)throw Error('input_budget_exceeded');
        const call=await this.queue.reserveCall(task,this.options.maxPerHour,this.options.maxPerDay);
        if(!call)throw Error('model_budget');
        let response:ExtractionResponse;
        try{response=await extractor.extract(input);}
        catch(error){await this.queue.finishCall(call,extractor.provider,extractor.model,undefined,'request_failed');throw Error('extraction_request_failed');}
        await this.queue.finishCall(call,extractor.provider,extractor.model,response.usage);
        parsed=parseExtraction(response.content,input);
      }
      // Store decisions before applying them: recovery replays the same operation
      // keys and never asks the model to improvise a different replacement plan.
      // Only reference IDs/revisions are retained, not other groups' memory text.
      plan={version:1,...parsed,filteredSources:sources.length-events.length,references:input.existing.map(e=>({...e,content:'',summary:''})),...(input.style?{style:input.style}:{}),...(input.attention?{attention:input.attention}:{}),...(input.selfHabits?{selfHabits:input.selfHabits}:{})};
      await this.queue.savePlan(task,plan);
    }
    if(plan.version!==1||!Array.isArray(plan.memories))throw Error('invalid_saved_plan');
    if(!await stillAllowed())throw Error('scope_disabled');
    const current=await this.existing(task),byId=new Map(current.map(m=>[m.id,m]));
    const sourceMap=new Map(sources.map(e=>[e.id,e.text]));
    const result={written:0,candidates:0,deduplicated:0,rejected:plan.rejected,filteredSources:plan.filteredSources};
    for(const [index,m] of plan.memories.entries()){
      if(!await stillAllowed())throw Error('scope_disabled');
      const reference=m.duplicate_of??m.contradicts;
      const old=reference?byId.get(reference):undefined;
      const snapshot=reference?plan.references.find(r=>r.id===reference):undefined;
      if(reference&&(!old||old.revision!==snapshot?.revision)){result.rejected++;continue;}
      if(m.duplicate_of){result.deduplicated++;continue;}
      const privateSource=/住址|地址|住在|电话|手机|身份证|邮箱|诊断|医疗|性取向|性癖|宗教|信仰|政治|党派|婚姻|恋爱|伴侣|收入|工资|借款|银行|家庭|家人|公司|学校|密码|密钥|\b\d{7,}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i;
      const sensitive=m.sensitivity==='sensitive'||privateSource.test(m.content+' '+m.summary+' '+m.evidence.map(e=>sourceMap.get(e.event_id)??'').join('\n'));
      const hypothetical=m.evidence.some(e=>/假如|如果|举.{0,3}例|例如|比如|他说|她说|你说|引用|转述|扮演|开玩笑|别当真|不是真的/.test(sourceMap.get(e.event_id)??''));
      const shared=this.options.personalProfiles&&m.type==='semantic'&&!sensitive&&m.source_kind==='user_report'&&!!m.share_category
        &&!hypothetical&&!m.contradicts&&m.confidence>=0.75
        &&m.evidence.every(e=>shareable(sourceMap.get(e.event_id)??'',m.share_category!))&&shareable('我喜欢 '+m.content+' '+m.summary,m.share_category);
      const ctx={job:task.job,actorId:task.actor,ownerIds:this.options.ownerIds,writer:'worker:consolidation-v1',
        operationKey:'consolidation:'+task.job.memoryTaskId+':'+index,candidateOnly:!!m.contradicts||m.type==='open_thread'||m.confidence<0.75||hypothetical};
      const input:RememberInput={type:m.type==='semantic'?'semantic':'episodic',subject_type:'user',subject_id:task.actor,
        content:m.content,summary:m.summary,confidence:m.confidence,importance:m.importance,sensitivity:sensitive?'sensitive':'internal',
        source_kind:m.source_kind,evidence:m.evidence.map(e=>({event_id:e.event_id,quote:e.quote})),slot:old?.slot??m.slot??undefined,
        visibility:shared?'person':'conversation',...(shared?{share_category:m.share_category!}:{})};
      try{
        const saved=await this.store.remember(ctx,input);
        if(saved.deduplicated)result.deduplicated++;else{result.written++;if(saved.status==='candidate')result.candidates++;}
        if(m.contradicts&&saved.id!==m.contradicts){
          try{await this.store.link({...ctx,operationKey:ctx.operationKey+':link'},{source_id:String(saved.id),target_id:m.contradicts,kind:'contradicts',reason:'consolidation_detected_conflict'});}
          catch(error){if(!(error instanceof MemoryError&&error.code==='cross_scope_link_not_allowed'))throw error;}
        }
      }catch(error){
        if(error instanceof MemoryError&&['memory_forgotten','memory_revision_superseded','personal_sharing_not_allowed','secret_not_allowed','operation_result_superseded'].includes(error.code)){result.rejected++;continue;}
        throw error;
      }
    }
    let style:unknown;
    const stylePaused=!!(this.options.styleLearning&&(await this.queue.ledger.pool.query("SELECT key FROM life_settings WHERE key='style_learning_paused' AND value='true'")).rowCount);
    if(this.options.styleLearning&&plan.style&&!stylePaused){
      if(!await stillAllowed())throw Error('scope_disabled');
      style=await new StyleStore(this.queue.ledger).apply(task.job,plan.style,plan.styleRules??[]);
    }
    let attention:unknown;
    if(this.options.attentionLearning&&plan.attention){
      if(!await stillAllowed())throw Error('scope_disabled');
      const paused=!!(await this.queue.ledger.pool.query("SELECT key FROM life_settings WHERE key='attention_learning_paused' AND value='true'")).rowCount;
      if(!paused)attention=await new AttentionStore(this.queue.ledger).apply(task.job,plan.attention,plan.aliases??[]);
    }
    let selfHabits:unknown;
    if(this.options.unifiedPersona&&this.options.ownerIds.includes(task.actor)&&plan.selfHabits){
      const store=new HabitStore(this.queue.ledger);let saved=0,rejected=0;
      for(const [index,p] of (plan.habitChanges??[]).entries()){
        if(!await stillAllowed())throw Error('scope_disabled');
        const ctx={job:task.job,actorId:task.actor,ownerIds:this.options.ownerIds,operationKey:'self-summary:'+task.job.memoryTaskId+':'+index,defaultScope:'global' as const,sourceEventId:p.event_id};
        try{const state=await store.list(ctx),existing=state.rules.find((r:any)=>r.scope==='global'&&r.setting===p.setting);
          await store.save(ctx,{scope:'global',setting:p.setting,value:p.value,expected_revision:existing?.revision??0,quote:p.quote});saved++;
        }catch(error){if(error instanceof MemoryError){rejected++;continue;}throw error;}
      }
      selfHabits={saved,rejected};
    }
    const combined={...result,...(style?{style}:{}),...(attention?{attention}:{}),...(selfHabits?{selfHabits}:{})};
    await this.queue.complete(task,combined);return combined;
  }
}
