import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Ledger } from './ledger.js';
import { databaseConfig } from './config.js';
import { MemoryStore } from './memory.js';

function save(path: string, value: unknown, exclusive = true): void {
  const fd = openSync(path, exclusive ? 'wx' : 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
}

const args = process.argv.slice(2);
const option = (key: string) => args[args.indexOf(key) + 1];
const command = args[0];
const config = option('--config');
if (!config || !args.includes('--config')) throw new Error('Use admin <migrate|status|pause|resume|export|delete> --config FILE');
const ledger = new Ledger(databaseConfig(config));
try {
  if (command === 'migrate') {
    const c = await ledger.pool.connect();
    try {
      await c.query('SELECT pg_advisory_lock(801200)');
      const passwordFile = option('--app-password-file');
      if (!args.includes('--app-password-file') || !passwordFile) throw new Error('app_password_file_required');
      const secret = readFileSync(passwordFile, 'utf8').trim();
      if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('invalid_app_password');
      await c.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='life_app') THEN CREATE ROLE life_app LOGIN; END IF; END $$");
      const folder = fileURLToPath(new URL('../migrations/', import.meta.url));
      for (const filename of readdirSync(folder).filter(f => /^\d+-.*\.sql$/.test(f)).sort()) {
        const version = Number(filename.split('-')[0]);
        const exists = (await c.query("SELECT to_regclass('public.life_migrations') AS table")).rows[0].table;
        if (!exists || !(await c.query('SELECT version FROM life_migrations WHERE version=$1', [version])).rowCount) {
          await c.query(readFileSync(folder + filename, 'utf8'));
        }
      }
      // Generated hex only, never accepted from messages. PostgreSQL role DDL has no bind parameters.
      await c.query("ALTER ROLE life_app PASSWORD '" + secret + "'");
      const dbName = (await c.query('SELECT current_database() AS name')).rows[0].name as string;
      await c.query('GRANT CONNECT ON DATABASE "' + dbName.replaceAll('"', '""') + '" TO life_app');
      await c.query(`GRANT USAGE ON SCHEMA public TO life_app;
        GRANT SELECT ON ALL TABLES IN SCHEMA public TO life_app;
        GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO life_app;
        GRANT INSERT ON life_events,life_conversations,life_session_links,life_jobs,life_outbox,life_blobs,life_event_media,life_rates,life_legacy_seen,life_settings TO life_app;
        GRANT UPDATE ON life_conversations,life_jobs,life_outbox,life_settings TO life_app;
        GRANT SELECT,INSERT,UPDATE ON life_memories TO life_app;
        GRANT SELECT,INSERT,UPDATE ON life_people,life_conversation_people,life_person_aliases TO life_app;
        GRANT SELECT,INSERT ON life_memory_revisions,life_memory_evidence,life_memory_links,life_memory_ops TO life_app;
        GRANT SELECT,INSERT,UPDATE ON life_memory_cursors,life_memory_tasks TO life_app;
        GRANT SELECT,INSERT ON life_memory_calls TO life_app;
        GRANT UPDATE(finished_at,usage,error) ON life_memory_calls TO life_app;`);
      await c.query(`GRANT SELECT,INSERT,UPDATE ON life_style_profiles,life_style_rules TO life_app;
        GRANT SELECT,INSERT ON life_style_evidence,life_style_revisions TO life_app;`);
      await c.query('GRANT SELECT,INSERT ON life_image_labels,life_memes TO life_app');
      await c.query('GRANT SELECT,INSERT,UPDATE ON life_habits TO life_app; GRANT SELECT,INSERT ON life_habit_revisions,life_habit_ops TO life_app');
      await c.query('GRANT SELECT,INSERT,UPDATE ON life_attention_aliases TO life_app; GRANT SELECT,INSERT ON life_attention_evidence,life_attention_revisions TO life_app');
      console.log(JSON.stringify({ migrated: 9, runtimeRole: 'life_app', eventUpdateDelete: false }));
    } finally { await c.query('SELECT pg_advisory_unlock(801200)').catch(() => {}); c.release(); }
  } else if (command === 'status') {
    console.log(JSON.stringify(await ledger.status(), null, 2));
  } else if (command === 'scope-status') {
    const conversation = option('--conversation');
    if (!args.includes('--conversation') || !conversation) throw new Error('explicit_conversation_required');
    const events = Number((await ledger.pool.query('SELECT count(*) FROM life_events WHERE conversation=$1', [conversation])).rows[0].count);
    console.log(JSON.stringify({ events }));
  } else if (command === 'usage') {
    const since = args.includes('--since') ? new Date(option('--since')!) : new Date(Date.now() - 86400000);
    const until = args.includes('--until') ? new Date(option('--until')!) : new Date();
    if (!Number.isFinite(since.getTime()) || !Number.isFinite(until.getTime()) || until <= since) throw new Error('invalid_usage_window');
    const conversation = args.includes('--conversation') ? option('--conversation') : null;
    const rows = (await ledger.pool.query(`SELECT payload->>'provider' AS provider,payload->>'model' AS model,
      payload->>'credentialLabel' AS "credentialLabel",COALESCE(payload->>'purpose','chat') AS purpose,count(*)::int AS "modelResponses",
      COALESCE(sum((payload->'usage'->>'inputTokens')::bigint),0)::text AS "uncachedInputTokens",
      COALESCE(sum((payload->'usage'->>'cacheReadTokens')::bigint),0)::text AS "cacheReadTokens",
      COALESCE(sum((payload->'usage'->>'cacheWriteTokens')::bigint),0)::text AS "cacheWriteTokens",
      COALESCE(sum((payload->'usage'->>'outputTokens')::bigint),0)::text AS "outputTokens",
      COALESCE(sum((payload->'usage'->>'totalTokens')::bigint),0)::text AS "reportedTotalTokens",
      count(*) FILTER (WHERE NOT (payload->'usage' ? 'totalTokens'))::int AS "responsesWithoutTotal"
      FROM life_events WHERE kind='model.usage' AND recorded_at>=$1 AND recorded_at<$2
        AND ($3::text IS NULL OR conversation=$3)
      GROUP BY 1,2,3,4`, [since, until, conversation])).rows;
    const missing = Number((await ledger.pool.query(`SELECT count(*) FROM life_events
      WHERE kind='model.usage_unavailable' AND recorded_at>=$1 AND recorded_at<$2 AND ($3::text IS NULL OR conversation=$3)`, [since, until, conversation])).rows[0].count);
    const webRequests=(await ledger.pool.query(`SELECT payload->>'operation' AS operation,
      count(*) FILTER(WHERE kind='web.requested')::int AS reserved,
      count(*) FILTER(WHERE kind='web.completed' AND payload->>'ok'='true')::int AS succeeded,
      count(*) FILTER(WHERE kind='web.completed' AND payload->>'producedResult'='true')::int AS nonempty,
      count(*) FILTER(WHERE kind='web.completed' AND payload->>'ok'='false')::int AS failed
      FROM life_events WHERE kind IN ('web.requested','web.completed') AND recorded_at>=$1 AND recorded_at<$2
        AND ($3::text IS NULL OR conversation=$3) GROUP BY 1`,[since,until,conversation])).rows;
    console.log(JSON.stringify({ since: since.toISOString(), until: until.toISOString(), rows, responsesWithoutUsage: missing, webRequests, currencyCost: 'not_calculated', source: 'provider_tokens_and_external_request_audit_not_a_billing_statement' }, null, 2));
  } else if (command === 'pause' || command === 'resume') {
    await ledger.pause(command === 'pause');
    console.log(JSON.stringify({ paused: command === 'pause' }));
  } else if(command==='consolidation-status'){
    const tasks=(await ledger.pool.query('SELECT status,count(*)::int FROM life_memory_tasks GROUP BY status')).rows;
    const calls=(await ledger.pool.query(`SELECT count(*)::int AS reserved,count(*) FILTER(WHERE finished_at IS NOT NULL)::int AS finished
      FROM life_memory_calls WHERE reserved_at>now()-interval '24 hours'`)).rows[0];
    const paused=(await ledger.pool.query("SELECT value FROM life_settings WHERE key='consolidation_paused'")).rows[0]?.value===true;
    console.log(JSON.stringify({paused,tasks,callsLast24Hours:calls},null,2));
  } else if (['memory-pause','memory-resume','consolidation-pause','consolidation-resume','style-pause','style-resume','meme-pause','meme-resume','habit-pause','habit-resume','attention-pause','attention-resume'].includes(command!)) {
    const key=command!.startsWith('attention-')?'attention_learning_paused':command!.startsWith('habit-')?'habit_writes_paused':command!.startsWith('meme-')?'meme_learning_paused':command!.startsWith('style-')?'style_learning_paused':command!.startsWith('consolidation-')?'consolidation_paused':'memory_writes_paused';
    const value=command!.endsWith('-pause');
    const c=await ledger.pool.connect();
    try{
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(801205)');
      await c.query('UPDATE life_settings SET value=$1 WHERE key=$2',[JSON.stringify(value),key]);
      await c.query("INSERT INTO life_events(id,conversation,kind,payload) VALUES($1,'__admin__','admin.memory_pause',$2)",[randomUUID(),{paused:value}]);
      await c.query('COMMIT');
    }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}
    console.log(JSON.stringify({setting:key,paused:value,memoryWritesPaused:key==='memory_writes_paused'?value:undefined}));
  } else if(['attention-list','attention-suppress','attention-reset'].includes(command!)){
    const conversation=option('--conversation');if(!args.includes('--conversation')||!conversation)throw Error('explicit_conversation_required');
    if(command==='attention-list')console.log(JSON.stringify((await ledger.pool.query('SELECT * FROM life_attention_aliases WHERE conversation=$1 ORDER BY last_seen_at DESC',[conversation])).rows,null,2));
    else{
      await ledger.transaction(async c=>{
        await c.query('SELECT pg_advisory_xact_lock(801205)');
        if(command==='attention-reset'){
          await c.query('DELETE FROM life_attention_aliases WHERE conversation=$1',[conversation]);
          await c.query('UPDATE life_conversations SET attention_floor_seq=COALESCE((SELECT max(seq) FROM life_events WHERE conversation=$1),0) WHERE key=$1',[conversation]);
        }else{
          const id=option('--alias-id');if(!args.includes('--alias-id')||!id||!/^[a-f0-9-]{36}$/i.test(id))throw Error('alias_id_required');
          const row=(await c.query("UPDATE life_attention_aliases SET status='suppressed',revision=revision+1,updated_at=now() WHERE conversation=$1 AND id=$2 RETURNING *",[conversation,id])).rows[0];
          if(!row)throw Error('alias_not_found');await c.query('INSERT INTO life_attention_revisions(alias_id,revision,payload) VALUES($1,$2,$3)',[id,row.revision,{alias:row.alias,status:'suppressed',reason:'admin_requested'}]);
        }
        await c.query("INSERT INTO life_events(id,conversation,kind,payload) VALUES($1,'__admin__',$2,$3)",[randomUUID(),'admin.'+command,{conversation}]);
      });console.log(JSON.stringify({applied:true}));
    }
  } else if(command==='habit-promote'){
    const actor=option('--actor'),realm=option('--realm');if(!args.includes('--actor')||!args.includes('--realm')||!actor||!realm)throw Error('explicit_actor_and_realm_required');
    const result=await ledger.transaction(async c=>{
      await c.query('SELECT pg_advisory_xact_lock(801205)');
      if((await c.query("SELECT j.id FROM life_jobs j JOIN life_conversations conv ON conv.key=j.conversation WHERE conv.identity_realm=$1 AND j.status='running' AND j.lease_until>now()",[realm])).rowCount)throw Error('running_jobs_prevent_profile_promotion');
      const rows=(await c.query("SELECT * FROM life_habits WHERE realm=$1 AND actor_id=$2 AND scope='person' AND status='active' FOR UPDATE",[realm,actor])).rows;
      for(const row of rows){
        const existing=(await c.query("SELECT id FROM life_habits WHERE realm=$1 AND scope='global' AND setting=$2",[realm,row.setting])).rows[0];
        const updated=(await c.query(existing?"UPDATE life_habits SET status='revoked',revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *"
          :"UPDATE life_habits SET scope='global',subject_key=realm,person_id=NULL,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *",[row.id])).rows[0];
        const old=(await c.query('SELECT quote FROM life_habit_revisions WHERE habit_id=$1 ORDER BY revision DESC LIMIT 1',[row.id])).rows[0];
        await c.query('INSERT INTO life_habit_revisions(habit_id,revision,source_id,actor_id,quote,payload) VALUES($1,$2,$3,$4,$5,$6)',[row.id,updated.revision,row.source_id,actor,old?.quote??'',
          {id:row.id,scope:updated.scope,setting:updated.setting,value:updated.value,status:updated.status,revision:updated.revision,reason:'administrator_promoted_unified_base',existing_base:existing?.id??null}]);
      }
      await c.query('UPDATE life_conversations SET session_id=NULL,generation=generation+1 WHERE identity_realm=$1',[realm]);
      await c.query("INSERT INTO life_events(id,conversation,kind,payload) VALUES($1,'__admin__','admin.habit_promote',$2)",[randomUUID(),{realm,actor,count:rows.length}]);
      return {promoted:rows.length};
    });console.log(JSON.stringify(result));
  } else if(command==='habit-list'){
    const conversation=option('--conversation');if(!args.includes('--conversation')||!conversation)throw Error('explicit_conversation_required');
    const rows=(await ledger.pool.query('SELECT * FROM life_habits WHERE conversation=$1 OR source_conversation=$1 ORDER BY updated_at DESC',[conversation])).rows;
    console.log(JSON.stringify(rows,null,2));
  } else if(command==='meme-list'||command==='meme-suppress'){
    const conversation=option('--conversation');if(!args.includes('--conversation')||!conversation)throw Error('explicit_conversation_required');
    if(command==='meme-list'){
      console.log(JSON.stringify((await ledger.pool.query('SELECT id,hash,description,tags,use_when,avoid_when,status,source_id,created_at FROM life_memes WHERE conversation=$1 ORDER BY created_at DESC LIMIT 100',[conversation])).rows,null,2));
    }else{
      const id=option('--meme-id');if(!args.includes('--meme-id')||!id)throw Error('meme_id_required');
      await ledger.transaction(async c=>{
        await c.query('SELECT pg_advisory_xact_lock(801205)');
        const r=await c.query("UPDATE life_memes SET status='suppressed' WHERE conversation=$1 AND id=$2 RETURNING id",[conversation,id]);
        if(!r.rowCount)throw Error('meme_not_found');
        await c.query("INSERT INTO life_events(id,conversation,kind,payload) VALUES($1,'__admin__','admin.meme_suppress',$2)",[randomUUID(),{conversation,id}]);
      });console.log(JSON.stringify({applied:true}));
    }
  } else if(['style-list','style-suppress','style-reset','style-bootstrap','attention-bootstrap'].includes(command!)){
    const conversation=option('--conversation');if(!args.includes('--conversation')||!conversation||conversation==='__admin__')throw Error('explicit_conversation_required');
    if(command==='style-list'){
      const profile=(await ledger.pool.query('SELECT * FROM life_style_profiles WHERE conversation=$1',[conversation])).rows[0]??null;
      const rules=(await ledger.pool.query(`SELECT r.*,count(e.event_id)::int AS support_messages,count(DISTINCT e.actor)::int AS support_speakers
        FROM life_style_rules r LEFT JOIN life_style_evidence e ON e.rule_id=r.id WHERE r.conversation=$1 GROUP BY r.id ORDER BY r.last_seen_at DESC LIMIT 100`,[conversation])).rows;
      console.log(JSON.stringify({profile,rules},null,2));
    }else if(command==='style-bootstrap'||command==='attention-bootstrap'){
      const result=await ledger.transaction(async c=>{
        await c.query('SELECT pg_advisory_xact_lock(801205)');
        const floor=command==='attention-bootstrap'?'attention_floor_seq':'style_floor_seq';
        const anchor=(await c.query(`SELECT e.*,s.${floor} AS learning_floor_seq FROM life_events e JOIN life_jobs j ON j.id=e.id JOIN life_conversations s ON s.key=e.conversation
          WHERE e.conversation=$1 AND e.kind='inbound.message' AND j.status IN ('done','skipped') AND e.seq>GREATEST(s.${floor},s.memory_floor_seq)
          ORDER BY e.seq DESC LIMIT 1`,[conversation])).rows[0];
        if(!anchor)return {queued:false,reason:'no_eligible_source'};
        const dedup=command+':'+conversation+':'+anchor.learning_floor_seq;
        if((await c.query('SELECT id FROM life_events WHERE dedup_key=$1',[dedup])).rowCount)return {queued:false,reason:'already_requested'};
        const task=await c.query(`INSERT INTO life_memory_tasks(id,conversation,actor,anchor_id,source_ids,from_seq,to_seq,epoch,status)
          SELECT $1,$2,$3,$4,'{}'::uuid[],$5,$5,memory_epoch,'pending' FROM life_conversations WHERE key=$2
          ON CONFLICT DO NOTHING RETURNING id`,[randomUUID(),conversation,anchor.actor,anchor.id,anchor.seq]);
        if(!task.rowCount)return {queued:false,reason:command==='attention-bootstrap'?'existing_task_will_include_attention':'existing_task_will_include_style'};
        await c.query('INSERT INTO life_events(id,conversation,kind,payload,cause,dedup_key) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),conversation,command==='attention-bootstrap'?'attention.bootstrap_requested':'style.bootstrap_requested',{boundedRecentSnapshot:true,personalSourcesReprocessed:false},anchor.id,dedup]);
        return {queued:true,existingBudgetApplies:true};
      });console.log(JSON.stringify(result));
    }else{
      await ledger.transaction(async c=>{
        await c.query('SELECT pg_advisory_xact_lock(801205)');
        if(command==='style-reset'){
          await c.query('DELETE FROM life_style_rules WHERE conversation=$1',[conversation]);await c.query('DELETE FROM life_style_profiles WHERE conversation=$1',[conversation]);
          await c.query(`UPDATE life_conversations SET style_floor_seq=COALESCE((SELECT max(seq) FROM life_events WHERE conversation=$1),0),session_id=NULL,generation=generation+1 WHERE key=$1`,[conversation]);
        }else{
          const id=option('--style-id');if(!args.includes('--style-id')||!id||!/^[a-f0-9-]{36}$/i.test(id))throw Error('style_id_required');
          const r=(await c.query("UPDATE life_style_rules SET status='suppressed',revision=revision+1,updated_at=now() WHERE conversation=$1 AND id=$2 RETURNING *",[conversation,id])).rows[0];
          if(!r)throw Error('style_not_found');await c.query('INSERT INTO life_style_revisions(rule_id,revision,payload) VALUES($1,$2,$3)',[r.id,r.revision,{status:'suppressed',reason:'admin_requested'}]);
          await c.query('UPDATE life_conversations SET session_id=NULL,generation=generation+1 WHERE key=$1',[conversation]);
        }
        await c.query("INSERT INTO life_events(id,conversation,kind,payload) VALUES($1,'__admin__',$2,$3)",[randomUUID(),'admin.'+command,{conversation}]);
      });
      console.log(JSON.stringify({conversation,action:command,applied:true}));
    }
  } else if(command==='person-list'||command==='person-show'){
    if(command==='person-list'){
      console.log(JSON.stringify((await ledger.pool.query(`SELECT p.id,p.realm,p.platform,p.platform_user_id,p.last_seen,
        (SELECT count(*)::int FROM life_conversation_people cp WHERE cp.person_id=p.id) AS conversations,
        (SELECT count(*)::int FROM life_memories m WHERE m.person_id=p.id AND m.visibility='person' AND m.status='active') AS shared_memories
        FROM life_people p ORDER BY p.last_seen DESC LIMIT 100`)).rows,null,2));
    }else{
      const personId=option('--person-id');if(!args.includes('--person-id')||!personId)throw new Error('person_id_required');
      const person=(await ledger.pool.query('SELECT * FROM life_people WHERE id=$1',[personId])).rows[0];if(!person)throw new Error('person_not_found');
      const aliases=(await ledger.pool.query('SELECT conversation,name,last_seen FROM life_person_aliases WHERE person_id=$1 ORDER BY last_seen DESC',[personId])).rows;
      const memories=(await ledger.pool.query('SELECT id,visibility,share_category,content,summary,status,revision FROM life_memories WHERE person_id=$1 ORDER BY updated_at DESC LIMIT 100',[personId])).rows;
      console.log(JSON.stringify({person,aliases,memories},null,2));
    }
  } else if (command === 'memory-search' || command === 'memory-list' || command === 'memory-history') {
    const conversation=option('--conversation');
    if(!args.includes('--conversation')||!conversation)throw new Error('explicit_conversation_required');
    if(command==='memory-search') {
      const query=args.includes('--query')?option('--query')!:'';
      console.log(JSON.stringify(await new MemoryStore(ledger).query(ledger.pool,conversation,query,10,true),null,2));
    } else if(command==='memory-list') {
      const rows=(await ledger.pool.query('SELECT id,type,subject_type,subject_id,subject_label,person_id,visibility,share_category,content,summary,status,revision,sensitivity,updated_at FROM life_memories WHERE conversation=$1 ORDER BY updated_at DESC LIMIT 100',[conversation])).rows;
      console.log(JSON.stringify(rows,null,2));
    } else {
      const memoryId=option('--memory-id');
      if(!args.includes('--memory-id')||!memoryId)throw new Error('memory_id_required');
      const rows=(await ledger.pool.query(`SELECT r.revision,r.snapshot,r.reason,r.actor,r.created_at,
        ARRAY(SELECT e.event_id FROM life_memory_evidence e WHERE e.memory_id=r.memory_id AND e.revision=r.revision) AS source_event_ids
        FROM life_memory_revisions r JOIN life_memories m ON m.id=r.memory_id WHERE m.conversation=$1 AND m.id=$2 ORDER BY r.revision`,[conversation,memoryId])).rows;
      console.log(JSON.stringify(rows,null,2));
    }
  } else if (command === 'export') {
    const conversation = option('--conversation'), output = option('--output');
    if (!args.includes('--conversation') || !conversation || !args.includes('--output') || !output) throw new Error('explicit_conversation_and_output_required');
    if (existsSync(output)) throw new Error('export_file_exists');
    const c = await ledger.pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const events = (await c.query('SELECT * FROM life_events WHERE conversation=$1 ORDER BY seq', [conversation])).rows;
      const jobs = (await c.query('SELECT * FROM life_jobs WHERE conversation=$1 ORDER BY seq', [conversation])).rows;
      const outbox = (await c.query('SELECT o.* FROM life_outbox o JOIN life_jobs j ON j.id=o.job_id WHERE j.conversation=$1 ORDER BY j.seq,o.part', [conversation])).rows;
      const media = (await c.query('SELECT m.event_id,m.role,b.* FROM life_event_media m JOIN life_blobs b ON b.hash=m.hash JOIN life_events e ON e.id=m.event_id WHERE e.conversation=$1', [conversation])).rows;
      const sessions = (await c.query('SELECT session_id FROM life_session_links WHERE conversation=$1', [conversation])).rows;
      const hasMemory=!!(await c.query("SELECT to_regclass('public.life_memories') AS table")).rows[0].table;
      const memories=hasMemory?(await c.query('SELECT * FROM life_memories WHERE conversation=$1 ORDER BY created_at',[conversation])).rows:[];
      const revisions=hasMemory?(await c.query('SELECT r.* FROM life_memory_revisions r JOIN life_memories m ON m.id=r.memory_id WHERE m.conversation=$1 ORDER BY r.memory_id,r.revision',[conversation])).rows:[];
      const evidence=hasMemory?(await c.query('SELECT e.* FROM life_memory_evidence e JOIN life_memories m ON m.id=e.memory_id JOIN life_events source ON source.id=e.event_id WHERE m.conversation=$1 AND source.conversation=$1',[conversation])).rows:[];
      const links=hasMemory?(await c.query('SELECT l.* FROM life_memory_links l JOIN life_memories m ON m.id=l.source_id WHERE m.conversation=$1',[conversation])).rows:[];
      const hasPeople=!!(await c.query("SELECT to_regclass('public.life_people') AS table")).rows[0].table;
      const people=hasPeople?(await c.query('SELECT p.* FROM life_people p JOIN life_conversation_people cp ON cp.person_id=p.id WHERE cp.conversation=$1',[conversation])).rows:[];
      const aliases=hasPeople?(await c.query('SELECT * FROM life_person_aliases WHERE conversation=$1',[conversation])).rows:[];
      const hasConsolidation=!!(await c.query("SELECT to_regclass('public.life_memory_tasks') AS table")).rows[0].table;
      const consolidationTasks=hasConsolidation?(await c.query('SELECT * FROM life_memory_tasks WHERE conversation=$1 ORDER BY created_at',[conversation])).rows:[];
      const consolidationCursors=hasConsolidation?(await c.query('SELECT * FROM life_memory_cursors WHERE conversation=$1',[conversation])).rows:[];
      const hasStyle=!!(await c.query("SELECT to_regclass('public.life_style_rules') AS table")).rows[0].table;
      const styleProfiles=hasStyle?(await c.query('SELECT * FROM life_style_profiles WHERE conversation=$1',[conversation])).rows:[];
      const styleRules=hasStyle?(await c.query('SELECT * FROM life_style_rules WHERE conversation=$1',[conversation])).rows:[];
      const styleEvidence=hasStyle?(await c.query('SELECT e.* FROM life_style_evidence e JOIN life_style_rules r ON r.id=e.rule_id WHERE r.conversation=$1',[conversation])).rows:[];
      const styleRevisions=hasStyle?(await c.query('SELECT h.* FROM life_style_revisions h JOIN life_style_rules r ON r.id=h.rule_id WHERE r.conversation=$1',[conversation])).rows:[];
      const hasMemes=!!(await c.query("SELECT to_regclass('public.life_memes') AS table")).rows[0].table;
      const memes=hasMemes?(await c.query('SELECT * FROM life_memes WHERE conversation=$1',[conversation])).rows:[];
      const imageLabels=hasMemes?(await c.query('SELECT l.* FROM life_image_labels l JOIN life_events e ON e.id=l.event_id WHERE e.conversation=$1',[conversation])).rows:[];
      const hasHabits=!!(await c.query("SELECT to_regclass('public.life_habits') AS table")).rows[0].table;
      const habits=hasHabits?(await c.query('SELECT * FROM life_habits WHERE conversation=$1 OR source_conversation=$1',[conversation])).rows:[];
      const habitRevisions=hasHabits?(await c.query('SELECT r.* FROM life_habit_revisions r JOIN life_events e ON e.id=r.source_id WHERE e.conversation=$1',[conversation])).rows:[];
      const hasAttention=!!(await c.query("SELECT to_regclass('public.life_attention_aliases') AS table")).rows[0].table;
      const attentionAliases=hasAttention?(await c.query('SELECT * FROM life_attention_aliases WHERE conversation=$1',[conversation])).rows:[];
      const attentionEvidence=hasAttention?(await c.query('SELECT e.* FROM life_attention_evidence e JOIN life_attention_aliases a ON a.id=e.alias_id WHERE a.conversation=$1',[conversation])).rows:[];
      const attentionRevisions=hasAttention?(await c.query('SELECT r.* FROM life_attention_revisions r JOIN life_attention_aliases a ON a.id=r.alias_id WHERE a.conversation=$1',[conversation])).rows:[];
      await c.query('COMMIT');
      writeFileSync(output, JSON.stringify({ version: 9, conversation, exportedAt: new Date().toISOString(), events, jobs, outbox, media, sessions, memories, revisions, evidence, links,people,aliases,consolidationTasks,consolidationCursors,styleProfiles,styleRules,styleEvidence,styleRevisions,memes,imageLabels,habits,habitRevisions,attentionAliases,attentionEvidence,attentionRevisions }, null, 2), { mode: 0o600, flag: 'wx' });
      chmodSync(output, 0o600);
      console.log(JSON.stringify({ output, events: events.length, jobs: jobs.length, outbox: outbox.length, media: media.length, memories:memories.length }));
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  } else if (command === 'delete') {
    // Channel-specific spool, media and DSH cleanup is handled by its stopped-service wrapper.
    const conversation = option('--conversation');
    if (!args.includes('--conversation') || !conversation || conversation === '__admin__') throw new Error('explicit_conversation_required');
    const c = await ledger.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(801205)');
      if (!(await ledger.paused())) throw new Error('pause_and_stop_adapter_before_delete');
      if ((await c.query("SELECT id FROM life_jobs WHERE conversation=$1 AND status='running' AND lease_until>now()", [conversation])).rowCount) throw new Error('running_jobs_prevent_delete');
      await c.query('SELECT key FROM life_conversations WHERE key=$1 FOR UPDATE', [conversation]);
      const hashes = (await c.query('SELECT DISTINCT m.hash FROM life_event_media m JOIN life_events e ON e.id=m.event_id WHERE e.conversation=$1', [conversation])).rows.map(row => row.hash);
      const hasMemory=!!(await c.query("SELECT to_regclass('public.life_memories') AS table")).rows[0].table;
      const hasPeople=!!(await c.query("SELECT to_regclass('public.life_people') AS table")).rows[0].table;
      // Revoking a source group also revokes shared facts derived from its evidence.
      const memoryIds=hasMemory?(await c.query(`SELECT DISTINCT m.id FROM life_memories m LEFT JOIN life_memory_evidence e ON e.memory_id=m.id
        LEFT JOIN life_events source ON source.id=e.event_id WHERE m.conversation=$1 OR source.conversation=$1`,[conversation])).rows.map(r=>r.id):[];
      const affected=hasPeople?(await c.query(`SELECT DISTINCT cp.conversation FROM life_conversation_people cp JOIN life_memories m ON m.person_id=cp.person_id
        WHERE m.id=ANY($1::uuid[]) AND m.visibility='person'`,[memoryIds])).rows.map(r=>r.conversation):[];
      const hasHabits=!!(await c.query("SELECT to_regclass('public.life_habits') AS table")).rows[0].table;
      const habitIds=hasHabits?(await c.query(`SELECT DISTINCT h.id FROM life_habits h LEFT JOIN life_habit_revisions r ON r.habit_id=h.id
        LEFT JOIN life_events e ON e.id=r.source_id WHERE h.conversation=$1 OR h.source_conversation=$1 OR e.conversation=$1`,[conversation])).rows.map(r=>r.id):[];
      const habitAffected=hasHabits?(await c.query(`SELECT DISTINCT conv.key FROM life_conversations conv JOIN life_habits h ON h.realm=conv.identity_realm
        AND (h.scope='global' OR (h.scope='conversation' AND h.conversation=conv.key) OR (h.scope='person' AND EXISTS
        (SELECT 1 FROM life_conversation_people cp WHERE cp.conversation=conv.key AND cp.person_id=h.person_id))) WHERE h.id=ANY($1::uuid[])`,[habitIds])).rows.map(r=>r.key):[];
      const invalidatedConversations=[...new Set([conversation,...affected,...habitAffected])];
      const hasConsolidation=!!(await c.query("SELECT to_regclass('public.life_memory_tasks') AS table")).rows[0].table;
      if(hasConsolidation&&(await c.query("SELECT id FROM life_memory_tasks WHERE conversation=ANY($1::text[]) AND status='running' AND lease_until>now()",[invalidatedConversations])).rowCount)throw new Error('running_memory_tasks_prevent_delete');
      if(hasConsolidation){
        await c.query(`UPDATE life_conversations SET memory_epoch=memory_epoch+1,
          memory_floor_seq=COALESCE((SELECT max(seq) FROM life_events e WHERE e.conversation=life_conversations.key),0) WHERE key=ANY($1::text[])`,[invalidatedConversations]);
        await c.query("UPDATE life_memory_tasks SET status='cancelled',plan=NULL,error='source_deleted',owner=NULL,lease_until=NULL WHERE conversation=ANY($1::text[]) AND status IN ('pending','running')",[invalidatedConversations]);
      }
      if((await c.query("SELECT id FROM life_jobs WHERE conversation=ANY($1::text[]) AND status='running' AND lease_until>now()",[invalidatedConversations])).rowCount)throw new Error('running_jobs_prevent_delete');
      const sessions=(await c.query('DELETE FROM life_session_links WHERE conversation=ANY($1::text[]) RETURNING session_id',[invalidatedConversations])).rows.map(r=>r.session_id);
      const removedMemories=hasMemory?await c.query('DELETE FROM life_memories WHERE id=ANY($1::uuid[])',[memoryIds]):undefined;
      const hasStyle=!!(await c.query("SELECT to_regclass('public.life_style_rules') AS table")).rows[0].table;
      if(hasStyle){await c.query('DELETE FROM life_style_rules WHERE conversation=$1',[conversation]);await c.query('DELETE FROM life_style_profiles WHERE conversation=$1',[conversation]);}
      if((await c.query("SELECT to_regclass('public.life_attention_aliases') AS table")).rows[0].table)await c.query('DELETE FROM life_attention_aliases WHERE conversation=$1',[conversation]);
      if(hasHabits){
        await c.query('DELETE FROM life_habit_ops WHERE job_id IN (SELECT id FROM life_events WHERE conversation=$1) OR result->>\'id\'=ANY($2::text[])',[conversation,habitIds]);
        await c.query('DELETE FROM life_habits WHERE id=ANY($1::uuid[])',[habitIds]);
      }
      if(hasMemory)await c.query(`DELETE FROM life_memory_ops WHERE conversation=$1 OR result->>'id'=ANY($2::text[])
        OR result->>'source_id'=ANY($2::text[]) OR result->>'target_id'=ANY($2::text[])`,[conversation,memoryIds]);
      if(hasPeople){
        await c.query('DELETE FROM life_person_aliases WHERE conversation=$1',[conversation]);
        await c.query('DELETE FROM life_conversation_people WHERE conversation=$1',[conversation]);
        await c.query('DELETE FROM life_people p WHERE NOT EXISTS(SELECT 1 FROM life_conversation_people cp WHERE cp.person_id=p.id)');
      }
      // Keep only non-content dedup tombstones so old samples cannot be silently re-imported.
      await c.query("INSERT INTO life_legacy_seen(key) SELECT dedup_key FROM life_events WHERE conversation=$1 AND kind='inbound.message' AND dedup_key IS NOT NULL ON CONFLICT DO NOTHING", [conversation]);
      const deleted = await c.query('DELETE FROM life_events WHERE conversation=$1 RETURNING id', [conversation]);
      if(hasConsolidation)await c.query('DELETE FROM life_memory_cursors WHERE conversation=$1',[conversation]);
      await c.query('UPDATE life_conversations SET session_id=NULL,generation=generation+1 WHERE key=ANY($1::text[])', [invalidatedConversations]);
      await c.query('DELETE FROM life_rates WHERE bucket=$1 OR bucket=$2', [conversation, conversation + ':turns']);
      const blobs = (await c.query('DELETE FROM life_blobs b WHERE b.hash=ANY($1::text[]) AND NOT EXISTS(SELECT 1 FROM life_event_media m WHERE m.hash=b.hash) RETURNING path', [hashes])).rows;
      const remainingScopes = Number((await c.query("SELECT count(*) FROM (SELECT conversation FROM life_events WHERE conversation<>'__admin__' UNION SELECT conversation FROM life_session_links) scopes")).rows[0].count);
      const result = { conversation, deletedEvents: deleted.rowCount, deletedMemories:removedMemories?.rowCount??0,invalidatedConversations, sessions, orphanPaths: blobs.map(b => b.path), remainingScopes };
      const manifest = args.includes('--manifest') ? option('--manifest') : undefined;
      if (manifest) save(manifest, { ...result, phase: 'prepared' });
      await c.query("INSERT INTO life_events(id,conversation,kind,payload) VALUES($1,'__admin__','admin.delete',$2)", [randomUUID(), { conversation, events: deleted.rowCount }]);
      await c.query('COMMIT');
      if (manifest) { save(manifest + '.tmp', { ...result, phase: 'committed' }); renameSync(manifest + '.tmp', manifest); }
      console.log(JSON.stringify(result));
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  } else throw new Error('unknown_admin_command');
} catch (e) {
  // Do not let driver diagnostics expose SQL parameters or credential configuration.
  console.error(JSON.stringify({ error: e instanceof Error && /^[a-z_]+$/.test(e.message) ? e.message : 'life_admin_failed' }));
  process.exitCode = 1;
} finally { await ledger.close(); }
