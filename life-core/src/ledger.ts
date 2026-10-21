import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { PoolClient, PoolConfig } from 'pg';
import { jsonSafe } from './json.js';
import { observeIdentity,personForJob } from './identity.js';
import type { IdentityInput } from './identity.js';

export interface Inbound {
  key: string; conversation: string; actor: string; occurredAt: string; payload: unknown;
  identity?: IdentityInput;
}
export interface Job {
  id: string; conversation: string; phase: 'pending' | 'generating' | 'ready';
  attempts: number; owner: string; payload: unknown;
  memoryTaskId?: string;
}
export interface Outbound { id: string; part: number; payload: { text?: string; meme?: {id:string;hash:string} }; status: string }
export interface BlobRef { hash: string; path: string; bytes: number; mime: string; role: string }
export interface MediaHistory { eventId: string; path: string; hash: string; occurredAt: string; role: string }
export interface ConversationContext { messages: { eventId: string; actor: string; body: string; occurredAt: string }[]; botReplies:{body:string;at:string}[]; lastSpokenAt?: string }
export class LeaseLost extends Error { constructor() { super('lease_lost'); } }

/** No dependency on QQ, OneBot, DSH, model providers or persona. */
export class Ledger {
  readonly pool: pg.Pool;
  constructor(config: PoolConfig) {
    this.pool = new pg.Pool(config);
    this.pool.on('error', () => { /* The next operation reports a safe error to the worker. */ });
  }
  async close(): Promise<void> { await this.pool.end(); }
  async transaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try { await c.query('BEGIN'); const result = await fn(c); await c.query('COMMIT'); return result; }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }
  async check(): Promise<void> {
    const r = await this.pool.query('SELECT max(version) AS version FROM life_migrations');
    if (![2,3,4,5,6,7,8,9].includes(r.rows[0]?.version)) throw new Error('unsupported_life_schema');
  }
  private async owned(c: PoolClient, job: Job): Promise<void> {
    if(job.memoryTaskId){
      const r=await c.query(`SELECT t.id FROM life_memory_tasks t JOIN life_conversations s ON s.key=t.conversation
        JOIN life_events e ON e.id=t.anchor_id AND e.conversation=t.conversation AND e.actor=t.actor
        WHERE t.id=$1 AND t.anchor_id=$2 AND t.owner=$3 AND t.conversation=$4 AND t.status='running'
          AND t.lease_until>clock_timestamp() AND t.epoch=s.memory_epoch AND t.to_seq>s.memory_floor_seq FOR UPDATE OF t`,
        [job.memoryTaskId,job.id,job.owner,job.conversation]);
      if(!r.rowCount)throw new LeaseLost();
      return;
    }
    const r = await c.query("SELECT id FROM life_jobs WHERE id=$1 AND owner=$2 AND conversation=$3 AND status='running' AND lease_until>clock_timestamp() FOR UPDATE", [job.id, job.owner, job.conversation]);
    if (!r.rowCount) throw new LeaseLost();
  }
  private async event(c: PoolClient, conversation: string, kind: string, payload: unknown, cause?: string, dedup?: string, actor?: string): Promise<string> {
    const id = randomUUID();
    const r = await c.query(`INSERT INTO life_events(id,dedup_key,conversation,kind,payload,cause,actor)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(dedup_key) DO NOTHING RETURNING id`, [id, dedup ?? null, conversation, kind, jsonSafe(payload), cause ?? null, actor ?? null]);
    return r.rows[0]?.id ?? (await c.query('SELECT id FROM life_events WHERE dedup_key=$1', [dedup])).rows[0].id;
  }
  async ingest(input: Inbound): Promise<boolean> {
    return this.transaction(async c => {
      if ((await c.query('SELECT key FROM life_legacy_seen WHERE key=$1', [input.key])).rowCount) return false;
      await c.query('INSERT INTO life_conversations(key) VALUES($1) ON CONFLICT DO NOTHING', [input.conversation]);
      const id = randomUUID();
      const r = await c.query(`INSERT INTO life_events(id,dedup_key,conversation,kind,actor,occurred_at,payload)
        VALUES($1,$2,$3,'inbound.message',$4,$5,$6) ON CONFLICT(dedup_key) DO NOTHING RETURNING id`,
      [id, input.key, input.conversation, input.actor, input.occurredAt, jsonSafe(input.payload)]);
      if (!r.rowCount) return false;
      if(input.identity)await observeIdentity(c,input.identity,input.conversation,input.actor);
      await c.query('INSERT INTO life_jobs(id,conversation) VALUES($1,$2)', [id, input.conversation]);
      return true;
    });
  }
  async claim(owner: string, leaseMs = 60000): Promise<Job | undefined> {
    return this.transaction(async c => {
      const expired = await c.query(`UPDATE life_jobs SET status='failed',error='crash_attempt_limit',updated_at=now()
        WHERE status='running' AND lease_until<now() AND attempts>=3 RETURNING id,conversation`);
      for (const row of expired.rows) {
        await c.query("UPDATE life_outbox SET status='unknown',error='worker_lost',updated_at=now() WHERE job_id=$1 AND status='dispatching'", [row.id]);
        await this.event(c, row.conversation, 'job.failed', { reason: 'crash_attempt_limit' }, row.id);
      }
      const r = await c.query(`WITH candidate AS (
        SELECT j.id FROM life_jobs j
        WHERE (j.status='pending' OR (j.status='running' AND j.lease_until<now())) AND j.due_at<=now()
        AND NOT EXISTS (SELECT 1 FROM life_jobs older WHERE older.conversation=j.conversation
          AND older.seq<j.seq AND older.status IN ('pending','running'))
        ORDER BY j.seq FOR UPDATE OF j SKIP LOCKED LIMIT 1
      ) UPDATE life_jobs j SET status='running',owner=$1,lease_until=now()+$2*interval '1 millisecond',
        attempts=attempts+1,updated_at=now() FROM candidate WHERE j.id=candidate.id RETURNING j.*`, [owner, leaseMs]);
      const job = r.rows[0];
      if (!job) return undefined;
      // A crashed dispatch may already have reached the platform. Never retry it automatically.
      await c.query("UPDATE life_outbox SET status='unknown',error='worker_lost',updated_at=now() WHERE job_id=$1 AND status='dispatching'", [job.id]);
      const source = await c.query('SELECT payload FROM life_events WHERE id=$1', [job.id]);
      await this.event(c, job.conversation, 'job.claimed', { attempt: job.attempts, recovered: job.attempts > 1 }, job.id);
      return { ...job, payload: source.rows[0].payload } as Job;
    });
  }
  async heartbeat(job: Job, leaseMs = 60000): Promise<void> {
    if(job.memoryTaskId){
      await this.withJob(job,async c=>{await c.query("UPDATE life_memory_tasks SET lease_until=clock_timestamp()+$2*interval '1 millisecond' WHERE id=$1",[job.memoryTaskId,leaseMs]);});
      return;
    }
    const r = await this.pool.query(`UPDATE life_jobs SET lease_until=clock_timestamp()+$3*interval '1 millisecond'
      WHERE id=$1 AND owner=$2 AND status='running' AND lease_until>clock_timestamp()`, [job.id, job.owner, leaseMs]);
    if (!r.rowCount) throw new LeaseLost();
  }
  async append(job: Job, kind: string, payload: unknown, dedup?: string): Promise<string> {
    return this.transaction(async c => { await this.owned(c, job); return this.event(c, job.conversation, kind, payload, job.id, dedup); });
  }
  async withJob<T>(job: Job, fn: (c: PoolClient, append: (kind: string, payload: unknown) => Promise<string>) => Promise<T>): Promise<T> {
    return this.transaction(async c => {
      // Short database operations share a privacy barrier. In particular, a
      // background write cannot pass its epoch check and commit after forgetting.
      // No model/network call is made while holding this transaction lock.
      await c.query('SELECT pg_advisory_xact_lock(801205)');
      await this.owned(c, job);
      return fn(c, (kind, payload) => this.event(c, job.conversation, kind, payload, job.id));
    });
  }
  async identify(job:Job,identity:IdentityInput):Promise<void>{
    await this.withJob(job,async c=>{
      const existing=await personForJob(c,job);
      if(existing){
        if(existing.realm!==identity.realm||existing.platform!==identity.platform||existing.platform_user_id!==identity.userId)throw new Error('identity_binding_mismatch');
        return;
      }
      const actor=(await c.query('SELECT actor FROM life_events WHERE id=$1',[job.id])).rows[0]?.actor;
      await observeIdentity(c,identity,job.conversation,actor);
    });
  }
  async capture(input: { key: string; conversation: string; kind: string; payload: unknown; cause: string }): Promise<void> {
    await this.transaction(async c => { await this.event(c, input.conversation, input.kind, input.payload, input.cause, input.key); });
  }
  async generating(job: Job): Promise<void> {
    await this.transaction(async c => {
      await this.owned(c, job);
      await c.query("UPDATE life_jobs SET phase='generating',updated_at=now() WHERE id=$1", [job.id]);
      await this.event(c, job.conversation, 'turn.started', { attempt: job.attempts }, job.id);
    });
  }
  async prepare(job: Job, text: string | null, kind = 'assistant.output', meme?: {id:string;hash:string;mode:'image_only'|'with_text'}): Promise<void> {
    await this.transaction(async c => {
      await this.owned(c, job);
      const phase = (await c.query('SELECT phase FROM life_jobs WHERE id=$1', [job.id])).rows[0].phase;
      if (phase === 'ready') return;
      if(meme){
        const selected=await c.query(`SELECT m.id FROM life_memes m JOIN life_events e ON e.cause=$1 AND e.conversation=m.conversation
          AND e.kind='meme.selected' AND e.payload->>'id'=m.id::text AND e.payload->>'hash'=m.hash AND e.payload->>'mode'=$5
          WHERE m.conversation=$2 AND m.id=$3 AND m.hash=$4 AND m.status='active'`,[job.id,job.conversation,meme.id,meme.hash,meme.mode]);
        if(!selected.rowCount)throw Error('meme_selection_required');
      }
      const chars = [...(meme?.mode==='image_only'?'':text ?? '')].slice(0, 6000);
      await this.event(c, job.conversation, kind, { text: chars.join(''),...(meme?{meme}:{}) }, job.id, job.id + ':output');
      for (let part = 0; part * 2000 < chars.length; part++) {
        await c.query('INSERT INTO life_outbox(id,job_id,part,payload) VALUES($1,$2,$3,$4)',
          [randomUUID(), job.id, part, jsonSafe({ text: chars.slice(part * 2000, (part + 1) * 2000).join('') })]);
      }
      if(meme){
        const part=Math.max(0,Math.ceil(chars.length/2000)-1),asset={id:meme.id,hash:meme.hash};
        if(chars.length)await c.query("UPDATE life_outbox SET payload=payload||jsonb_build_object('meme',$3::jsonb) WHERE job_id=$1 AND part=$2",[job.id,part,JSON.stringify(asset)]);
        else await c.query('INSERT INTO life_outbox(id,job_id,part,payload) VALUES($1,$2,0,$3)',[randomUUID(),job.id,{meme:asset}]);
      }
      await c.query("UPDATE life_jobs SET phase='ready',updated_at=now() WHERE id=$1", [job.id]);
    });
    job.phase = 'ready';
  }
  async outbox(job: Job): Promise<Outbound[]> {
    return (await this.pool.query('SELECT id,part,payload,status FROM life_outbox WHERE job_id=$1 ORDER BY part', [job.id])).rows;
  }
  async dispatch(job: Job, id: string): Promise<boolean> {
    return this.transaction(async c => {
      await this.owned(c, job);
      const r = await c.query("UPDATE life_outbox SET status='dispatching',updated_at=now() WHERE id=$1 AND job_id=$2 AND status='pending' RETURNING id", [id, job.id]);
      if (r.rowCount) await this.event(c, job.conversation, 'outbound.dispatching', { outboxId: id }, job.id);
      return !!r.rowCount;
    });
  }
  async delivered(job: Job, id: string, status: 'confirmed' | 'unknown' | 'failed' | 'cancelled', responseId?: string): Promise<void> {
    await this.transaction(async c => {
      await this.owned(c, job);
      const r = await c.query(`UPDATE life_outbox SET status=$3,response_id=$4,updated_at=now()
        WHERE id=$1 AND job_id=$2 AND status IN ('pending','dispatching') RETURNING id`, [id, job.id, status, responseId ?? null]);
      if (r.rowCount) await this.event(c, job.conversation, 'outbound.' + status, { outboxId: id, responseId }, job.id);
    });
  }
  async complete(job: Job, status: 'done' | 'skipped' | 'failed' = 'done'): Promise<void> {
    await this.transaction(async c => {
      await this.owned(c, job);
      const remaining = await c.query("SELECT id FROM life_outbox WHERE job_id=$1 AND status IN ('pending','dispatching')", [job.id]);
      if (remaining.rowCount) throw new Error('outbox_unfinished');
      await c.query('UPDATE life_jobs SET status=$2,owner=NULL,lease_until=NULL,updated_at=now() WHERE id=$1', [job.id, status]);
      await this.event(c, job.conversation, 'job.' + status, {}, job.id);
    });
  }
  async retry(job: Job, reason: string): Promise<void> {
    await this.transaction(async c => {
      await this.owned(c, job);
      // A failed DB write after dispatch is ambiguous too. Preserve its reservation.
      await c.query("UPDATE life_outbox SET status='unknown',error='dispatch_interrupted',updated_at=now() WHERE job_id=$1 AND status='dispatching'", [job.id]);
      const status = job.attempts >= 3 ? 'failed' : 'pending';
      await c.query(`UPDATE life_jobs SET status=$2,error=$3,owner=NULL,lease_until=NULL,
        due_at=now()+interval '2 seconds',updated_at=now() WHERE id=$1`, [job.id, status, reason]);
      await this.event(c, job.conversation, 'job.' + (status === 'failed' ? 'failed' : 'retry'), { reason }, job.id);
    });
  }
  async linkMedia(job: Job, refs: BlobRef[]): Promise<void> {
    await this.transaction(async c => {
      await this.owned(c, job);
      for (const ref of refs) {
        await c.query('INSERT INTO life_blobs(hash,path,bytes,mime) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [ref.hash, ref.path, ref.bytes, ref.mime]);
        await c.query('INSERT INTO life_event_media(event_id,hash,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [job.id, ref.hash, ref.role]);
      }
      await this.event(c, job.conversation, 'media.indexed', { count: refs.length }, job.id);
    });
  }
  async session(key: string): Promise<{ id: string | null; generation: number }> {
    const r = await this.pool.query('SELECT session_id AS id,generation FROM life_conversations WHERE key=$1', [key]);
    return r.rows[0] ?? { id: null, generation: 0 };
  }
  async setSession(job: Job, id: string | null, resetContext = false): Promise<void> {
    await this.transaction(async c => {
      await this.owned(c, job);
      await c.query('UPDATE life_conversations SET session_id=$2,generation=generation+1 WHERE key=$1', [job.conversation, id]);
      if (id) await c.query('INSERT INTO life_session_links VALUES($1,$2) ON CONFLICT DO NOTHING', [job.conversation, id]);
      if (resetContext) await this.event(c, job.conversation, 'conversation.reset', {}, job.id);
    });
  }
  async recentMedia(job: Job, limit = 3): Promise<MediaHistory[]> {
    const r = await this.pool.query(`SELECT e.id AS "eventId",b.path,b.hash,e.occurred_at AS "occurredAt",m.role
      FROM life_events e JOIN life_event_media m ON m.event_id=e.id JOIN life_blobs b ON b.hash=m.hash
      JOIN life_events anchor ON anchor.id=$1 AND anchor.conversation=$2
      WHERE e.conversation=$2 AND e.kind='inbound.message' AND e.seq<anchor.seq
        AND (m.role='message' OR m.role ~ '^message:[0-9]+$')
        AND e.seq>COALESCE((SELECT max(source.seq) FROM life_events reset
          JOIN life_events source ON source.id=reset.cause
          WHERE reset.conversation=$2 AND reset.kind='conversation.reset' AND source.seq<anchor.seq),0)
      ORDER BY e.seq DESC,CASE WHEN m.role='message' THEN 0 ELSE split_part(m.role,':',2)::int END DESC
      LIMIT $3`, [job.id, job.conversation, Math.min(Math.max(limit,1),10)]);
    return r.rows.reverse().map(row => ({ ...row, occurredAt: new Date(row.occurredAt).toISOString() }));
  }
  /** Bounded same-conversation input history, including observed turns. No
   * platform dependency; normalized bodies are derived untrusted event data. */
  async conversationContext(job: Job): Promise<ConversationContext> {
    const rows = await this.pool.query(`SELECT e.id AS "eventId", e.actor, e.occurred_at AS "occurredAt",
      left(COALESCE(n.payload->>'body',e.payload->>'text',''),700) AS body
      FROM life_events e JOIN life_events anchor ON anchor.id=$1 AND anchor.conversation=$2
      LEFT JOIN LATERAL (SELECT payload FROM life_events WHERE cause=e.id AND kind='inbound.normalized' ORDER BY seq DESC LIMIT 1) n ON true
      WHERE e.conversation=$2 AND e.kind='inbound.message' AND e.seq<anchor.seq
        AND e.seq>COALESCE((SELECT max(source.seq) FROM life_events reset JOIN life_events source ON source.id=reset.cause
          WHERE reset.conversation=$2 AND reset.kind='conversation.reset' AND source.seq<anchor.seq),0)
      ORDER BY e.seq DESC LIMIT 8`, [job.id,job.conversation]);
    const last = await this.pool.query(`SELECT max(e.recorded_at) AS at FROM life_events e
      JOIN life_events source ON source.id=e.cause JOIN life_events anchor ON anchor.id=$1 AND anchor.conversation=$2
      WHERE e.conversation=$2 AND e.kind='outbound.confirmed' AND source.seq<anchor.seq`,[job.id,job.conversation]);
    const replies=await this.pool.query(`SELECT left(o.payload->>'text',800) AS body,o.updated_at AS at FROM life_outbox o JOIN life_events e ON e.id=o.job_id
      JOIN life_events anchor ON anchor.id=$1 AND anchor.conversation=$2 WHERE e.conversation=$2 AND e.seq<anchor.seq AND o.status='confirmed'
      AND o.payload ? 'text' AND e.seq>COALESCE((SELECT max(source.seq) FROM life_events reset JOIN life_events source ON source.id=reset.cause
        WHERE reset.conversation=$2 AND reset.kind='conversation.reset' AND source.seq<anchor.seq),0) ORDER BY e.seq DESC,o.part DESC LIMIT 2`,[job.id,job.conversation]);
    return { messages: rows.rows.reverse().map(row=>({...row,occurredAt:new Date(row.occurredAt).toISOString()})),botReplies:replies.rows.reverse().map(r=>({body:r.body,at:new Date(r.at).toISOString()})),
      lastSpokenAt: last.rows[0]?.at ? new Date(last.rows[0].at).toISOString() : undefined };
  }
  async derived(job: Job, kind: string): Promise<Record<string,unknown> | undefined> {
    const r=await this.pool.query('SELECT payload FROM life_events WHERE cause=$1 AND conversation=$2 AND kind=$3 ORDER BY seq DESC LIMIT 1',[job.id,job.conversation,kind]);
    return r.rows[0]?.payload;
  }
  async paused(): Promise<boolean> { return (await this.pool.query("SELECT value FROM life_settings WHERE key='paused'")).rows[0]?.value === true; }
  async pause(value: boolean): Promise<void> {
    await this.transaction(async c => {
      await c.query('SELECT pg_advisory_xact_lock(801205)');
      await c.query("UPDATE life_settings SET value=$1 WHERE key='paused'", [JSON.stringify(value)]);
      await this.event(c, '__admin__', 'admin.pause', { paused: value });
    });
  }
  async reserve(bucket: string, token: string, max: number): Promise<boolean> {
    return this.transaction(async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [bucket]);
      if ((await c.query('SELECT token FROM life_rates WHERE token=$1', [token])).rowCount) return true;
      const n = Number((await c.query("SELECT count(*) FROM life_rates WHERE bucket=$1 AND at>now()-interval '1 hour'", [bucket])).rows[0].count);
      if (n >= max) return false;
      await c.query('INSERT INTO life_rates(token,bucket) VALUES($1,$2)', [token, bucket]);
      return true;
    });
  }
  /** Global rolling quotas for external reads, fenced by the active job and pause switch. */
  async reserveExternal(job:Job,bucket:string,token:string,limits:{hour:number;day:number}):Promise<boolean>{
    if(!/^external:[a-z0-9_-]{1,32}$/.test(bucket)||![limits.hour,limits.day].every(n=>Number.isSafeInteger(n)&&n>0&&n<=10000))throw Error('invalid_external_budget');
    return this.withJob(job,async c=>{
      if((await c.query("SELECT value FROM life_settings WHERE key='paused'")).rows[0]?.value===true)return false;
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[bucket]);
      if((await c.query('SELECT token FROM life_rates WHERE token=$1',[token])).rowCount)return false;
      const counts=(await c.query(`SELECT count(*) FILTER(WHERE at>now()-interval '1 hour')::int AS hour,count(*)::int AS day
        FROM life_rates WHERE bucket=$1 AND at>now()-interval '24 hours'`,[bucket])).rows[0];
      if(counts.hour>=limits.hour||counts.day>=limits.day)return false;
      await c.query('INSERT INTO life_rates(token,bucket) VALUES($1,$2)',[token,bucket]);return true;
    });
  }
  async status(): Promise<Record<string, unknown>> {
    const [jobs, outbox, count, events] = await Promise.all([
      this.pool.query('SELECT status,count(*)::int FROM life_jobs GROUP BY status'),
      this.pool.query('SELECT status,count(*)::int FROM life_outbox GROUP BY status'),
      this.pool.query('SELECT count(*)::int AS count FROM life_blobs'),
      this.pool.query('SELECT count(*)::int AS count FROM life_events')]);
    return { paused: await this.paused(), jobs: jobs.rows, outbox: outbox.rows, blobs: count.rows[0].count, events: events.rows[0].count };
  }
  async importLegacy(data: { seen: string[]; sessions: Record<string, string>; paused: boolean; rates: Record<string, number[]> }): Promise<void> {
    await this.transaction(async c => {
      await c.query('SELECT pg_advisory_xact_lock(801201)');
      if ((await c.query("SELECT key FROM life_settings WHERE key='legacy_imported'")).rowCount) return;
      for (const id of data.seen) await c.query('INSERT INTO life_legacy_seen(key) VALUES($1) ON CONFLICT DO NOTHING', ['onebot:' + id]);
      for (const [key, id] of Object.entries(data.sessions)) {
        await c.query('INSERT INTO life_conversations(key,session_id) VALUES($1,$2) ON CONFLICT DO NOTHING', ['onebot:' + key, id]);
        await c.query('INSERT INTO life_session_links VALUES($1,$2) ON CONFLICT DO NOTHING', ['onebot:' + key, id]);
      }
      for (const [key, times] of Object.entries(data.rates)) for (const at of times.filter(at => at > Date.now() - 3600000)) {
        await c.query('INSERT INTO life_rates(token,bucket,at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', ['legacy:' + key + ':' + at, 'onebot:' + key, new Date(at)]);
      }
      await c.query("UPDATE life_settings SET value=$1 WHERE key='paused'", [JSON.stringify(data.paused)]);
      await c.query("INSERT INTO life_settings VALUES('legacy_imported','true')");
    });
  }
}
