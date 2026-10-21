import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Ledger } from './ledger.js';
import type { Job } from './ledger.js';
import { bounded, containsSecret, fingerprint, instructionLike, MemoryError, questionLike, selfReport, shareable, terms } from './memory-policy.js';
import { invalidatePersonSessions,personForJob,personProfile } from './identity.js';
import { explicitPreference } from './preference.js';

export { MemoryError } from './memory-policy.js';
export interface MemoryContext { job: Job; writer: string; actorId: string; ownerIds: readonly string[]; operationKey: string; candidateOnly?:boolean }
export interface EvidenceInput { event_id: string; quote: string }
export interface RememberInput {
  type: 'semantic'|'episodic'; subject_type: 'user'|'group'|'project'; subject_id: string;
  content: string; summary: string; confidence: number; importance: number;
  sensitivity: 'internal'|'sensitive'; source_kind: 'user_report'|'agent_inference';
  evidence: EvidenceInput[]; slot?: string;
  visibility?: 'conversation'|'person'; share_category?: 'preference'|'communication';
}
export interface ReviseInput extends Omit<RememberInput,'type'|'subject_type'|'subject_id'|'slot'> {
  memory_id: string; expected_revision: number; reason: string;
}
export interface MemoryRecord {
  id: string; conversation: string; type: string; subject_type: string; subject_id: string; subject_label: string;
  slot: string|null; content: string; summary: string; confidence: number; importance: number;
  sensitivity: string; status: string; revision: number; content_hash: string; search_terms: string;
  created_at: string|Date; updated_at: string|Date; valid_until: string|Date|null;
  source_event_ids?: string[];
  search_document?: unknown;
  person_id: string|null; visibility:'conversation'|'person'; share_category:'preference'|'communication'|null; ownership_scope:string;
}
interface Evidence { event_id: string; quote: string; source_actor: string|null; source_kind: string; weight: number; direct: boolean; label: string; source:string }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function id(value: string): string { if(!uuid.test(value))throw new MemoryError('invalid_memory_id');return value; }
function textOf(payload: any): string {
  if(typeof payload?.text==='string')return payload.text;
  if(typeof payload?.message==='string')return payload.message;
  return Array.isArray(payload?.message)?payload.message.filter((s:any)=>s.type==='text').map((s:any)=>String(s.data?.text??'')).join('\n'):'';
}
function safe<T>(value:T):T { return JSON.parse(JSON.stringify(value)); }
export function publicMemory(row: MemoryRecord): Record<string,unknown> {
  const { conversation,content_hash,search_terms,search_document,ownership_scope,...value }=row;
  return safe(value);
}

/** Caller binds conversation/job/actor; none of those identities are model arguments. */
export class MemoryStore {
  constructor(private ledger: Ledger,private options:{personalProfiles?:boolean}={}) {}
  private canChange(ctx:MemoryContext,row:MemoryRecord):void {
    if(!ctx.ownerIds.includes(ctx.actorId)&&!(row.subject_type==='user'&&row.subject_id===ctx.actorId))throw new MemoryError('subject_change_not_allowed');
  }
  private async mutable(c:PoolClient):Promise<void> {
    if((await c.query("SELECT value FROM life_settings WHERE key='memory_writes_paused'")).rows[0]?.value===true)throw new MemoryError('memory_writes_paused');
  }
  private async operation<T>(ctx:MemoryContext,name:string,input:unknown,work:(c:PoolClient,append:(kind:string,payload:unknown)=>Promise<string>)=>Promise<T>):Promise<T> {
    return this.ledger.withJob(ctx.job,async(c,append)=>{
      await this.mutable(c);
      if(ctx.job.memoryTaskId&&(await c.query("SELECT key FROM life_settings WHERE key IN ('paused','consolidation_paused') AND value='true'")).rowCount)throw new MemoryError('memory_writes_paused');
      const source=(await c.query('SELECT actor FROM life_events WHERE id=$1',[ctx.job.id])).rows[0];
      if(source?.actor!==ctx.actorId)throw new MemoryError('memory_actor_mismatch');
      const key=ctx.job.id+':'+ctx.operationKey;
      const hash=fingerprint({name,input,...(ctx.candidateOnly?{candidateOnly:true}:{})});
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,3))',[key]);
      const old=(await c.query('SELECT conversation,fingerprint,result FROM life_memory_ops WHERE key=$1',[key])).rows[0];
      if(old) {
        if(old.conversation!==ctx.job.conversation||old.fingerprint!==hash)throw new MemoryError('idempotency_conflict');
        if(old.result?.id&&name!=='forget'){
          const current=await this.load(c,ctx.job,old.result.id);
          if(current.status==='forgotten')throw new MemoryError('memory_forgotten');
          if(current.revision!==old.result.revision)throw new MemoryError('operation_result_superseded');
        }
        return old.result as T;
      }
      const result=safe(await work(c,append));
      await c.query('INSERT INTO life_memory_ops(key,conversation,fingerprint,result) VALUES($1,$2,$3,$4)',[key,ctx.job.conversation,hash,result]);
      return result;
    });
  }
  private validate(input:RememberInput):RememberInput {
    const value={...input,subject_id:bounded(input.subject_id,100,'invalid_subject'),content:bounded(input.content,2000,'invalid_content'),summary:bounded(input.summary,300,'invalid_summary')};
    if(!['semantic','episodic'].includes(value.type)||!['user','group','project'].includes(value.subject_type)||!['internal','sensitive'].includes(value.sensitivity)||!['user_report','agent_inference'].includes(value.source_kind))throw new MemoryError('invalid_memory_type');
    if(![value.confidence,value.importance].every(n=>Number.isFinite(n)&&n>=0&&n<=1))throw new MemoryError('invalid_memory_score');
    if(value.slot!==undefined)value.slot=bounded(value.slot,80,'invalid_slot');
    if(value.visibility!==undefined&&!['conversation','person'].includes(value.visibility))throw new MemoryError('invalid_visibility');
    if(value.share_category!==undefined&&!['preference','communication'].includes(value.share_category))throw new MemoryError('invalid_share_category');
    if(containsSecret(value.content+'\n'+value.summary))throw new MemoryError('secret_not_allowed');
    return value;
  }
  private async evidence(c:PoolClient,ctx:MemoryContext,input:RememberInput):Promise<Evidence[]> {
    if(!Array.isArray(input.evidence)||!input.evidence.length||input.evidence.length>8)throw new MemoryError('evidence_required');
    const output:Evidence[]=[];
    for(const item of input.evidence) {
      if(!uuid.test(item.event_id)||typeof item.quote!=='string'||item.quote.length>2000)throw new MemoryError('invalid_evidence');
      const e=(await c.query(`SELECT e.id,e.actor,e.payload,e.kind,e.seq FROM life_events e
        JOIN life_events anchor ON anchor.id=$1 AND anchor.conversation=$2
        WHERE e.id=$3 AND e.conversation=$2 AND e.seq<=anchor.seq AND e.kind='inbound.message'`,[ctx.job.id,ctx.job.conversation,item.event_id])).rows[0];
      if(!e)throw new MemoryError('evidence_not_available_in_scope');
      const source=textOf(e.payload);
      const quote=item.quote.normalize('NFKC').trim();
      if(!quote||!source.normalize('NFKC').includes(quote))throw new MemoryError('evidence_quote_mismatch');
      if(containsSecret(quote))throw new MemoryError('secret_not_allowed');
      const question=questionLike(source),instruction=instructionLike(source)||instructionLike(input.content);
      const self=input.subject_type==='user'&&e.actor===input.subject_id&&selfReport(quote);
      const owner=ctx.ownerIds.includes(e.actor)&&input.subject_type==='group';
      const direct=input.source_kind==='user_report'&&!question&&!instruction&&(self||owner);
      output.push({event_id:e.id,quote,source_actor:e.actor,source_kind:input.source_kind,
        weight:direct?(owner?1:0.8):0.3,direct,
        label:input.subject_type==='user'&&e.actor===input.subject_id?String(e.payload?.sender?.card||e.payload?.sender?.nickname||input.subject_id).slice(0,80):input.subject_id,source});
    }
    return output;
  }
  private async snapshot(c:PoolClient,row:MemoryRecord,ctx:MemoryContext,evidence:Evidence[],reason:string):Promise<void> {
    const state=safe(row);
    await c.query('INSERT INTO life_memory_revisions(memory_id,revision,snapshot,reason,actor) VALUES($1,$2,$3,$4,$5)',[row.id,row.revision,state,reason,ctx.writer]);
    for(const e of evidence)await c.query(`INSERT INTO life_memory_evidence(memory_id,revision,event_id,quote,source_actor,source_kind,weight)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[row.id,row.revision,e.event_id,e.quote,e.source_actor,e.source_kind,e.weight]);
  }
  private async load(c:PoolClient,job:Job,memoryId:string,lock=false):Promise<MemoryRecord> {
    const person=this.options.personalProfiles?await personForJob(c,job):undefined;
    const row=(await c.query(`SELECT * FROM life_memories WHERE id=$1 AND (conversation=$2 OR (visibility='person' AND person_id=$3))${lock?' FOR UPDATE':''}`,[memoryId,job.conversation,person?.id??null])).rows[0] as MemoryRecord|undefined;
    if(!row)throw new MemoryError('not_found');
    return row;
  }
  private async result(c:PoolClient,job:Job,memoryId:string):Promise<Record<string,unknown>> {
    const row=await this.load(c,job,memoryId);
    if(row.conversation!==job.conversation)row.subject_label=(await c.query('SELECT name FROM life_person_aliases WHERE person_id=$1 AND conversation=$2 ORDER BY last_seen DESC,name LIMIT 1',[row.person_id,job.conversation])).rows[0]?.name??row.subject_id;
    row.source_event_ids=(await c.query('SELECT DISTINCT e.event_id FROM life_memory_evidence e JOIN life_events source ON source.id=e.event_id WHERE e.memory_id=$1 AND e.revision=$2 AND source.conversation=$3 ORDER BY e.event_id',[row.id,row.revision,job.conversation])).rows.map(r=>r.event_id);
    return publicMemory(row);
  }
  private async ownership(c:PoolClient,ctx:MemoryContext,input:RememberInput,evidence:Evidence[],old?:MemoryRecord):Promise<{personId:string|null;visibility:'conversation'|'person';category:string|null;scope:string}>{
    const person=input.subject_type==='user'?(await c.query(`SELECT p.id FROM life_people p JOIN life_conversation_people cp ON cp.person_id=p.id
      JOIN life_conversations conv ON conv.key=cp.conversation AND conv.identity_realm=p.realm AND conv.identity_platform=p.platform WHERE conv.key=$1 AND p.platform_user_id=$2 LIMIT 1`,[ctx.job.conversation,input.subject_id])).rows[0]:undefined;
    const visibility=input.visibility??old?.visibility??'conversation',category=input.share_category??old?.share_category??null;
    if(visibility==='conversation'){
      if(old?.visibility==='person'&&old.conversation!==ctx.job.conversation)throw new MemoryError('shared_memory_cannot_move_conversation');
      return {personId:person?.id??old?.person_id??null,visibility,category:null,scope:'conversation:'+(old?.conversation??ctx.job.conversation)};
    }
    if(!this.options.personalProfiles)throw new MemoryError('personal_profiles_disabled');
    const permitted=(await c.query('SELECT profile_sharing FROM life_conversations WHERE key=$1',[ctx.job.conversation])).rows[0]?.profile_sharing;
    if(!person||!permitted||input.subject_type!=='user'||input.subject_id!==ctx.actorId||input.type!=='semantic'||input.sensitivity!=='internal'||input.source_kind!=='user_report'
      ||!category||!evidence.every(e=>e.direct&&e.source_actor===ctx.actorId&&shareable(e.source,category))
      ||!shareable('我喜欢 '+input.content+' '+input.summary,category))throw new MemoryError('personal_sharing_not_allowed');
    return {personId:person.id,visibility,category,scope:'person:'+person.id};
  }
  async remember(ctx:MemoryContext,raw:RememberInput):Promise<Record<string,unknown>> {
    const input=this.validate(raw);
    return this.operation(ctx,'remember',input,async(c,append)=>{
      if(input.subject_type==='group'&&input.subject_id!==ctx.job.conversation.split(':').at(-1))throw new MemoryError('invalid_group_subject');
      const evidence=await this.evidence(c,ctx,input);
      const ownership=await this.ownership(c,ctx,input,evidence);
      const hash=fingerprint({type:input.type,subject_type:input.subject_type,subject_id:input.subject_id,content:input.content.toLowerCase()});
      // Serialize semantic duplicates across independent operation IDs.
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4))',[ownership.scope]);
      const old=(await c.query('SELECT id,status FROM life_memories WHERE ownership_scope=$1 AND content_hash=$2',[ownership.scope,hash])).rows[0];
      if(old) {
        if(old.status==='forgotten')throw new MemoryError('memory_forgotten');
        return {...await this.result(c,ctx.job,old.id),deduplicated:true};
      }
      const previous=(await c.query(`SELECT r.memory_id FROM life_memory_revisions r JOIN life_memories m ON m.id=r.memory_id
        WHERE (m.ownership_scope=$1 OR r.snapshot->>'ownership_scope'=$1 OR 'conversation:'||m.conversation=$1)
          AND r.snapshot->>'content_hash'=$2 LIMIT 1`,[ownership.scope,hash])).rows[0];
      if(previous)throw new MemoryError('memory_revision_superseded');
      const conflict=input.slot?(await c.query(`SELECT id FROM life_memories WHERE ownership_scope=$1 AND subject_type=$2 AND subject_id=$3
        AND slot=$4 AND status='active'`,[ownership.scope,input.subject_type,input.subject_id,input.slot])).rows:[];
      const status=!ctx.candidateOnly&&evidence.some(e=>e.direct)&&input.sensitivity==='internal'&&!conflict.length?'active':'candidate';
      const confidence=Math.min(input.confidence,status==='active'?0.9:0.5);
      const row=(await c.query(`INSERT INTO life_memories(id,conversation,type,subject_type,subject_id,subject_label,slot,content,summary,
        confidence,importance,sensitivity,status,content_hash,search_terms,person_id,visibility,share_category,ownership_scope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [randomUUID(),ctx.job.conversation,input.type,input.subject_type,input.subject_id,evidence[0]!.label,input.slot??null,input.content,input.summary,confidence,input.importance,input.sensitivity,status,hash,terms(input.content+' '+input.summary+' '+(ownership.visibility==='person'?input.subject_id:evidence[0]!.label)).join(' '),ownership.personId,ownership.visibility,ownership.category,ownership.scope])).rows[0] as MemoryRecord;
      await this.snapshot(c,row,ctx,evidence,'remember');
      for(const other of conflict)await c.query("INSERT INTO life_memory_links(source_id,target_id,kind,reason) VALUES($1,$2,'contradicts','same_subject_slot_conflict') ON CONFLICT DO NOTHING",[row.id,other.id]);
      await append('memory.remembered',{memoryId:row.id,revision:row.revision,status,visibility:row.visibility,personId:row.person_id,writer:ctx.writer,sourceEventIds:evidence.map(e=>e.event_id)});
      return this.result(c,ctx.job,row.id);
    });
  }
  async revise(ctx:MemoryContext,input:ReviseInput):Promise<Record<string,unknown>> {
    id(input.memory_id);const reason=bounded(input.reason,300,'revision_reason_required');
    return this.operation(ctx,'revise',input,async(c,append)=>{
      const before=await this.load(c,ctx.job,input.memory_id);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4))',[before.ownership_scope]);
      const old=await this.load(c,ctx.job,input.memory_id,true);
      this.canChange(ctx,old);
      if(old.status==='forgotten')throw new MemoryError('memory_forgotten');
      if(old.revision!==input.expected_revision)throw new MemoryError('revision_conflict');
      const checked=this.validate({...input,type:old.type as RememberInput['type'],subject_type:old.subject_type as RememberInput['subject_type'],subject_id:old.subject_id,slot:old.slot??undefined});
      const evidence=await this.evidence(c,ctx,checked);
      const ownership=await this.ownership(c,ctx,checked,evidence,old);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4))',[ownership.scope]);
      const hash=fingerprint({type:old.type,subject_type:old.subject_type,subject_id:old.subject_id,content:checked.content.toLowerCase()});
      if((await c.query('SELECT id FROM life_memories WHERE ownership_scope=$1 AND content_hash=$2 AND id<>$3',[ownership.scope,hash,old.id])).rowCount)throw new MemoryError('memory_duplicate');
      const conflict=old.slot?(await c.query("SELECT id FROM life_memories WHERE ownership_scope=$1 AND subject_type=$2 AND subject_id=$3 AND slot=$4 AND status='active' AND id<>$5",[ownership.scope,old.subject_type,old.subject_id,old.slot,old.id])).rowCount:0;
      const status=!ctx.candidateOnly&&evidence.some(e=>e.direct)&&checked.sensitivity==='internal'&&!conflict?'active':'candidate';
      const row=(await c.query(`UPDATE life_memories SET content=$2,summary=$3,confidence=$4,importance=$5,sensitivity=$6,status=$7,
        content_hash=$8,search_terms=$9,person_id=$10,visibility=$11,share_category=$12,ownership_scope=$13,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`,[old.id,checked.content,checked.summary,Math.min(checked.confidence,status==='active'?0.9:0.5),checked.importance,checked.sensitivity,status,hash,terms(checked.content+' '+checked.summary+' '+(ownership.visibility==='person'?old.subject_id:old.subject_label)).join(' '),ownership.personId,ownership.visibility,ownership.category,ownership.scope])).rows[0] as MemoryRecord;
      await this.snapshot(c,row,ctx,evidence,reason);
      // The next turn starts without stale tool results/prompt snapshots from the old revision.
      await invalidatePersonSessions(c,ctx.job.conversation,old.visibility==='person'||row.visibility==='person'?row.person_id:undefined);
      await append('memory.revised',{memoryId:row.id,revision:row.revision,writer:ctx.writer,sourceEventIds:evidence.map(e=>e.event_id)});
      return this.result(c,ctx.job,row.id);
    });
  }
  async forget(ctx:MemoryContext,input:{memory_id:string;expected_revision:number;reason:string}):Promise<Record<string,unknown>> {
    id(input.memory_id);const reason=bounded(input.reason,300,'forget_reason_required');
    return this.operation(ctx,'forget',input,async(c,append)=>{
      const before=await this.load(c,ctx.job,input.memory_id);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4))',[before.ownership_scope]);
      const old=await this.load(c,ctx.job,input.memory_id,true);
      this.canChange(ctx,old);
      if(old.revision!==input.expected_revision)throw new MemoryError('revision_conflict');
      if(old.status==='forgotten')return {id:old.id,revision:old.revision,status:'forgotten'};
      const row=(await c.query("UPDATE life_memories SET status='forgotten',revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *",[old.id])).rows[0] as MemoryRecord;
      await this.snapshot(c,row,ctx,[],reason);
      await invalidatePersonSessions(c,ctx.job.conversation,old.visibility==='person'?old.person_id:undefined);
      await append('memory.forgotten',{memoryId:row.id,revision:row.revision,writer:ctx.writer});
      return {id:row.id,revision:row.revision,status:'forgotten'};
    });
  }
  async link(ctx:MemoryContext,input:{source_id:string;target_id:string;kind:'related'|'contradicts'|'supports';reason:string}):Promise<Record<string,unknown>> {
    id(input.source_id);id(input.target_id);const reason=bounded(input.reason,300,'link_reason_required');
    if(input.source_id===input.target_id||!['related','contradicts','supports'].includes(input.kind))throw new MemoryError('invalid_memory_link');
    return this.operation(ctx,'link',input,async(c,append)=>{
      const source=await this.load(c,ctx.job,input.source_id),target=await this.load(c,ctx.job,input.target_id);
      if(source.status==='forgotten'||target.status==='forgotten')throw new MemoryError('not_found');
      if(source.ownership_scope!==target.ownership_scope)throw new MemoryError('cross_scope_link_not_allowed');
      await c.query('INSERT INTO life_memory_links(source_id,target_id,kind,reason) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[input.source_id,input.target_id,input.kind,reason]);
      await append('memory.linked',{sourceId:input.source_id,targetId:input.target_id,kind:input.kind,writer:ctx.writer});
      return {source_id:input.source_id,target_id:input.target_id,kind:input.kind};
    });
  }
  async search(ctx:Pick<MemoryContext,'job'>,query:string,limit=5,includeCandidates=false):Promise<Record<string,unknown>[]> {
    return this.ledger.withJob(ctx.job,async c=>{
      const person=this.options.personalProfiles?await personForJob(c,ctx.job):undefined;
      return this.query(c,ctx.job.conversation,query,limit,includeCandidates,person?.id);
    });
  }
  async recent(ctx:Pick<MemoryContext,'job'>,limit=5):Promise<Record<string,unknown>[]> { return this.search(ctx,'',limit); }
  async profile(ctx:Pick<MemoryContext,'job'>):Promise<Record<string,unknown>|null>{
    if(!this.options.personalProfiles)throw new MemoryError('personal_profiles_disabled');
    return this.ledger.withJob(ctx.job,c=>personProfile(c,ctx.job));
  }
  async observePreference(ctx:MemoryContext):Promise<Record<string,unknown>|null>{
    if(!this.options.personalProfiles)return null;
    const decision=await this.ledger.withJob(ctx.job,async c=>{
      const source=(await c.query("SELECT actor,payload FROM life_events WHERE id=$1 AND kind='inbound.message'",[ctx.job.id])).rows[0];
      if(source?.actor!==ctx.actorId)throw new MemoryError('memory_actor_mismatch');
      const preference=explicitPreference(textOf(source.payload));if(!preference)return null;
      // A fresh matching self-report may promote its existing local record. Old
      // facts are never bulk-published just because this feature is switched on.
      const locals=(await c.query(`SELECT m.id,m.revision,e.quote FROM life_memories m JOIN life_memory_evidence e ON e.memory_id=m.id AND e.revision=m.revision
        WHERE m.conversation=$1 AND m.subject_type='user' AND m.subject_id=$2 AND m.type='semantic' AND m.sensitivity='internal'
          AND m.status='active' AND m.visibility='conversation' AND e.source_actor=$2 AND e.source_kind='user_report'
        ORDER BY m.updated_at DESC LIMIT 100`,[ctx.job.conversation,ctx.actorId])).rows;
      const legacy=locals.find(row=>explicitPreference(row.quote)?.content===preference.content);
      return {preference,legacy};
    });
    if(!decision)return null;
    const {preference,legacy}=decision;
    const input:RememberInput={type:'semantic',subject_type:'user',subject_id:ctx.actorId,content:preference.content,summary:preference.summary,
      slot:preference.slot,confidence:0.8,importance:0.6,sensitivity:'internal',source_kind:'user_report',visibility:'person',share_category:preference.category,
      evidence:[{event_id:ctx.job.id,quote:preference.quote}]};
    let result:Record<string,unknown>;
    try{
      result=legacy?await this.revise({...ctx,operationKey:ctx.operationKey+':promote:'+legacy.id},{...input,memory_id:legacy.id,expected_revision:legacy.revision,reason:'fresh_matching_self_report_promotes_local_fact'})
        :await this.remember({...ctx,operationKey:ctx.operationKey+':remember'},input);
    }catch(error){
      if(!(legacy&&error instanceof MemoryError&&error.code==='memory_duplicate'))throw error;
      result=await this.remember({...ctx,operationKey:ctx.operationKey+':remember'},input);
      await this.forget({...ctx,operationKey:ctx.operationKey+':merge:'+legacy.id},{memory_id:legacy.id,expected_revision:legacy.revision,reason:'merged_into_shared_profile:'+result.id});
    }
    return {state:legacy?'promoted':result.deduplicated?'deduplicated':'remembered',id:result.id,revision:result.revision,status:result.status,visibility:result.visibility};
  }
  async query(c:Pick<PoolClient,'query'>,conversation:string,query:string,limit=5,includeCandidates=false,personId?:string):Promise<Record<string,unknown>[]> {
    if(typeof query!=='string'||query.length>500||!Number.isInteger(limit)||limit<1||limit>10)throw new MemoryError('invalid_search');
    const words=terms(query).slice(0,80);
    const q=words.map(word=>"'"+word+"'").join(' | ');
    const rows=(await c.query(`SELECT m.*,
      CASE WHEN m.conversation=$1 THEN m.subject_label ELSE COALESCE((SELECT a.name FROM life_person_aliases a WHERE a.person_id=m.person_id AND a.conversation=$1 ORDER BY a.last_seen DESC,a.name LIMIT 1),m.subject_id) END AS subject_label,
      ARRAY(SELECT DISTINCT e.event_id FROM life_memory_evidence e JOIN life_events source ON source.id=e.event_id WHERE e.memory_id=m.id AND e.revision=m.revision AND source.conversation=$1) AS source_event_ids
      FROM life_memories m WHERE (m.conversation=$1 OR (m.visibility='person' AND m.person_id=$5)) AND (m.status='active' OR ($4 AND m.status='candidate'))
        AND m.sensitivity='internal' AND (m.valid_until IS NULL OR m.valid_until>now())
        AND ($2='' OR m.search_document@@to_tsquery('simple',$2))
      ORDER BY CASE WHEN m.person_id=$5 THEN 1 ELSE 0 END DESC,
        CASE WHEN $2='' THEN 0 ELSE ts_rank_cd(m.search_document,to_tsquery('simple',$2)) END DESC,
        CASE WHEN $2='' THEN extract(epoch from m.updated_at) ELSE m.importance END DESC,
        m.importance DESC,m.updated_at DESC,m.id LIMIT $3`,[conversation,q,limit,includeCandidates,personId??null])).rows as MemoryRecord[];
    return rows.map(publicMemory);
  }
}
