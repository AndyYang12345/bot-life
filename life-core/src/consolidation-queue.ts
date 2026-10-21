import {randomUUID} from 'node:crypto';
import {Ledger,LeaseLost} from './ledger.js';
import type {Job} from './ledger.js';

export interface BatchOptions {minMessages:number;maxMessages:number;maxAgeMs:number;leaseMs:number}
export interface MemoryTask {job:Job;actor:string;sourceIds:string[];plan:unknown|null}
export interface TokenUsage {inputTokens:number;cacheReadTokens:number;outputTokens:number;totalTokens:number}

/** Durable incremental work, separate from channel reply jobs and outbox. */
export class ConsolidationQueue {
  constructor(readonly ledger:Ledger){}
  async claim(owner:string,scopes:readonly string[],options:BatchOptions):Promise<MemoryTask|undefined>{
    if(!scopes.length)return;
    const {minMessages,maxMessages,maxAgeMs,leaseMs}=options;
    if(!Number.isInteger(minMessages)||minMessages<1||minMessages>maxMessages||maxMessages>20||maxAgeMs<0||leaseMs<1000)throw Error('invalid_batch_options');
    return this.ledger.transaction(async c=>{
      await c.query('SELECT pg_advisory_xact_lock(801205)');
      if((await c.query("SELECT key FROM life_settings WHERE key IN ('paused','memory_writes_paused','consolidation_paused') AND value='true'")).rowCount)return;
      await c.query(`UPDATE life_memory_tasks t SET status='cancelled',plan=NULL,error='privacy_epoch_changed',owner=NULL,lease_until=NULL,updated_at=now()
        FROM life_conversations s WHERE t.conversation=s.key AND t.status IN ('pending','running')
        AND (t.epoch<>s.memory_epoch OR t.to_seq<=s.memory_floor_seq)`);
      await c.query(`UPDATE life_memory_tasks SET status='failed',owner=NULL,lease_until=NULL,error='attempt_limit',updated_at=now()
        WHERE status='running' AND lease_until<now() AND attempts>=3`);
      let row=(await c.query(`SELECT t.* FROM life_memory_tasks t WHERE t.conversation=ANY($1::text[])
        AND ((t.status='pending' AND t.due_at<=now()) OR (t.status='running' AND t.lease_until<now()))
        ORDER BY t.created_at FOR UPDATE SKIP LOCKED LIMIT 1`,[scopes])).rows[0];
      if(!row){
        await c.query(`INSERT INTO life_memory_cursors(conversation,actor)
          SELECT DISTINCT e.conversation,e.actor FROM life_events e JOIN life_conversations s ON s.key=e.conversation
          WHERE e.conversation=ANY($1::text[]) AND e.kind='inbound.message' AND e.actor IS NOT NULL
          ON CONFLICT DO NOTHING`,[scopes]);
        const candidates=(await c.query(`SELECT p.*,s.memory_epoch,s.memory_floor_seq FROM life_memory_cursors p
          JOIN life_conversations s ON s.key=p.conversation WHERE p.conversation=ANY($1::text[])
          AND NOT EXISTS(SELECT 1 FROM life_memory_tasks t WHERE t.conversation=p.conversation AND t.actor=p.actor AND t.status IN ('pending','running'))
          AND EXISTS(SELECT 1 FROM life_events e JOIN life_jobs j ON j.id=e.id
            WHERE e.conversation=p.conversation AND e.actor=p.actor AND e.kind='inbound.message'
            AND e.seq>GREATEST(p.last_seq,s.memory_floor_seq) AND j.status IN ('done','skipped','failed'))
          ORDER BY (SELECT min(e.seq) FROM life_events e WHERE e.conversation=p.conversation AND e.actor=p.actor
            AND e.kind='inbound.message' AND e.seq>GREATEST(p.last_seq,s.memory_floor_seq)),p.conversation,p.actor
          LIMIT 30 FOR UPDATE OF p SKIP LOCKED`,[scopes])).rows;
        for(const candidate of candidates){
          const rows=(await c.query(`SELECT e.id,e.seq,e.recorded_at,e.payload FROM life_events e JOIN life_jobs j ON j.id=e.id
            WHERE e.conversation=$1 AND e.actor=$2 AND e.kind='inbound.message' AND e.seq>GREATEST($3::bigint,$4::bigint)
            AND j.status IN ('done','skipped','failed') ORDER BY e.seq LIMIT $5`,
            [candidate.conversation,candidate.actor,candidate.last_seq,candidate.memory_floor_seq,maxMessages])).rows;
          const events:typeof rows=[];let chars=0;
          for(const event of rows){
            const length=textOf(event.payload).length;
            if(length<=1500&&chars+length>6000)break;
            events.push(event);if(length<=1500)chars+=length;
          }
          if(!events.length||(events.length<minMessages&&Date.now()-new Date(events[0].recorded_at).getTime()<maxAgeMs))continue;
          const last=events.at(-1)!;
          row=(await c.query(`INSERT INTO life_memory_tasks(id,conversation,actor,anchor_id,source_ids,from_seq,to_seq,epoch,status)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING *`,
            [randomUUID(),candidate.conversation,candidate.actor,last.id,events.map(e=>e.id),candidate.last_seq,last.seq,candidate.memory_epoch])).rows[0];
          await c.query('UPDATE life_memory_cursors SET last_seq=$3 WHERE conversation=$1 AND actor=$2',[candidate.conversation,candidate.actor,last.seq]);
          break;
        }
      }
      if(!row)return;
      row=(await c.query(`UPDATE life_memory_tasks SET status='running',owner=$2,attempts=attempts+1,
        lease_until=now()+$3*interval '1 millisecond',updated_at=now() WHERE id=$1 RETURNING *`,[row.id,owner,leaseMs])).rows[0];
      const source=(await c.query('SELECT payload FROM life_events WHERE id=$1',[row.anchor_id])).rows[0];
      return {job:{id:row.anchor_id,conversation:row.conversation,owner,attempts:row.attempts,phase:'pending',payload:source.payload,memoryTaskId:row.id},
        actor:row.actor,sourceIds:row.source_ids,plan:row.plan};
    });
  }
  async sources(task:MemoryTask):Promise<{id:string;text:string;at:string}[]>{
    return this.ledger.withJob(task.job,async c=>{
      const rows=(await c.query(`SELECT e.id,e.payload,e.occurred_at,e.recorded_at FROM life_events e
        JOIN life_conversations s ON s.key=e.conversation WHERE e.id=ANY($1::uuid[]) AND e.conversation=$2 AND e.actor=$3
        AND e.kind='inbound.message' AND e.seq>s.memory_floor_seq ORDER BY e.seq`,[task.sourceIds,task.job.conversation,task.actor])).rows;
      if(rows.length!==task.sourceIds.length)throw new LeaseLost();
      return rows.map(e=>({id:e.id,text:textOf(e.payload),at:new Date(e.occurred_at??e.recorded_at).toISOString()}));
    });
  }
  async savePlan(task:MemoryTask,plan:unknown):Promise<void>{
    await this.ledger.withJob(task.job,async c=>{
      await c.query('UPDATE life_memory_tasks SET plan=$2,updated_at=now() WHERE id=$1',[task.job.memoryTaskId,JSON.stringify(plan)]);
    });
  }
  async complete(task:MemoryTask,result:Record<string,unknown>):Promise<void>{
    await this.ledger.withJob(task.job,async(c,append)=>{
      if((await c.query("SELECT key FROM life_settings WHERE key IN ('paused','memory_writes_paused','consolidation_paused') AND value='true'")).rowCount)throw Error('memory_writes_paused');
      await c.query("UPDATE life_memory_tasks SET status='done',owner=NULL,lease_until=NULL,result=$2,updated_at=now() WHERE id=$1",[task.job.memoryTaskId,result]);
      await append('memory.consolidated',{taskId:task.job.memoryTaskId,...result});
    });
  }
  async fail(task:MemoryTask,reason:string):Promise<void>{
    await this.ledger.transaction(async c=>{
      await c.query('SELECT pg_advisory_xact_lock(801205)');
      const row=(await c.query(`SELECT t.*,s.memory_epoch,s.memory_floor_seq FROM life_memory_tasks t JOIN life_conversations s ON s.key=t.conversation
        WHERE t.id=$1 AND t.owner=$2 AND t.status='running' FOR UPDATE OF t`,[task.job.memoryTaskId,task.job.owner])).rows[0];
      if(!row)return;
      const cancelled=row.epoch!==row.memory_epoch||BigInt(row.to_seq)<=BigInt(row.memory_floor_seq);
      const waiting=['model_budget','memory_writes_paused','scope_disabled'].includes(reason);
      const status=cancelled?'cancelled':waiting?'pending':row.attempts>=3?'failed':'pending';
      await c.query(`UPDATE life_memory_tasks SET status=$2,owner=NULL,lease_until=NULL,error=$3,
        attempts=GREATEST(attempts-$4,0),plan=CASE WHEN $2='cancelled' THEN NULL ELSE plan END,
        due_at=now()+$5*interval '1 millisecond',updated_at=now() WHERE id=$1`,
        [row.id,status,cancelled?'privacy_epoch_changed':reason,waiting?1:0,waiting?300000:10000]);
    });
  }
  async reserveCall(task:MemoryTask,maxPerHour:number,maxPerDay:number):Promise<string|undefined>{
    if(!Number.isInteger(maxPerHour)||maxPerHour<1||maxPerHour>12||!Number.isInteger(maxPerDay)||maxPerDay<maxPerHour||maxPerDay>48)throw Error('invalid_consolidation_budget');
    return this.ledger.withJob(task.job,async c=>{
      if((await c.query("SELECT key FROM life_settings WHERE key IN ('paused','memory_writes_paused','consolidation_paused') AND value='true'")).rowCount)throw Error('memory_writes_paused');
      const n=(await c.query(`SELECT count(*) FILTER(WHERE reserved_at>now()-interval '1 hour')::int AS hour,
        count(*)::int AS day FROM life_memory_calls WHERE reserved_at>now()-interval '24 hours'`)).rows[0];
      if(n.hour>=maxPerHour||n.day>=maxPerDay)return;
      const call=randomUUID();await c.query('INSERT INTO life_memory_calls(id,task_id) VALUES($1,$2)',[call,task.job.memoryTaskId]);return call;
    });
  }
  async finishCall(call:string,provider:string,model:string,usage:TokenUsage|undefined,error?:string):Promise<void>{
    if(usage&&!Object.values(usage).every(v=>Number.isSafeInteger(v)&&v>=0&&v<=10000000))usage=undefined;
    // Billing metadata survives source deletion; it contains no chat or account.
    await this.ledger.transaction(async c=>{
      const updated=await c.query(`UPDATE life_memory_calls SET finished_at=now(),usage=$2,error=$3
        WHERE id=$1 AND finished_at IS NULL RETURNING id`,[call,usage??null,error??null]);
      if(!updated.rowCount)return;
      await c.query(`INSERT INTO life_events(id,dedup_key,conversation,kind,payload) VALUES($1,$2,'__admin__',$3,$4)`,
        [randomUUID(),'consolidation-call:'+call,usage?'model.usage':'model.usage_unavailable',
          {provider,model,credentialLabel:'qqbot-independent',purpose:'memory_consolidation',callId:call,...(usage?{usage}:{}),...(error?{reason:error}:{})}]);
    });
  }
}

function textOf(payload:any):string{
  if(typeof payload?.text==='string')return payload.text;
  if(typeof payload?.message==='string')return payload.message;
  return Array.isArray(payload?.message)?payload.message.filter((s:any)=>s.type==='text').map((s:any)=>String(s.data?.text??'')).join('\n'):'';
}
