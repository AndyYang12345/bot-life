#!/usr/bin/env node
/** One real API call, isolated DB, no QQ delivery; includes crash replay and restore. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Ledger,MemoryStore,ConsolidationQueue,Consolidator,databaseConfig} from '../life-core/dist/index.js';
import {DeepSeekConsolidationModel} from '../dsh-onebot/dist/consolidation-model.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),config=join(root,'data/config/life-db-admin.json');
if(!process.env.DEEPSEEK_API_KEY)throw Error('Load the dedicated bot model.env locally before this bounded live API test.');
const temp=mkdtempSync(join(tmpdir(),'consolidation-live-')),db='qqbot_consolidation_live_'+process.pid,restored=db+'_restore';
const control=new Ledger(databaseConfig(config)),raw=JSON.parse(readFileSync(config,'utf8'));
const A='fixture:bot:group:a',B='fixture:bot:group:b',C='fixture:bot:group:c',options={minMessages:3,maxMessages:12,maxAgeMs:0,leaseMs:90000};
let admin,app,restoredApp,created=false,restoreCreated=false,stage='prepare',calls=0;
const summary={realModelApi:true,externalQqDelivery:false,isolatedDatabase:true};
function migrate(database){
  const file=join(temp,database+'.json');writeFileSync(file,JSON.stringify({...raw,database}),{mode:0o600});
  const r=spawnSync(process.execPath,[join(root,'life-core/dist/admin.js'),'migrate','--config',file,'--app-password-file',raw.passwordFile.replace('pg-admin-password','pg-app-password')],{encoding:'utf8'});
  assert.equal(r.status,0,'fixture migration failed');
}
async function start(ledger,text,conversation=A,actor='fixture-user',nickname='fixture-a'){
  await ledger.ingest({key:randomUUID(),conversation,actor,occurredAt:new Date().toISOString(),payload:{text},
    identity:{realm:'fixture-bot',platform:'qq',userId:actor,displayName:nickname,allowProfileSharing:true}});
  return await ledger.claim(randomUUID());
}
try{
  await control.pool.query('CREATE DATABASE '+db);created=true;migrate(db);
  admin=new Ledger({...databaseConfig(config),database:db});
  const appBase={...databaseConfig(config.replace('admin.json','app.json')),database:db};app=new Ledger(appBase);
  for(const text of ['我喜欢乌龙茶，平时不加糖。','平常会把它泡得淡一点。','这个习惯已经有好几年了。'])await app.complete(await start(app,text));
  const queue=new ConsolidationQueue(app),task=await queue.claim(randomUUID(),[A],options);assert(task,'three fixture messages must be queued');
  const provider=new DeepSeekConsolidationModel('deepseek-flash',process.env.DEEPSEEK_API_KEY,{maxTokens:1500,timeoutMs:45000});
  const extractor={provider:provider.provider,model:provider.model,extract:async input=>{assert.equal(++calls,1,'recovery must not issue another paid API call');return provider.extract(input);}};
  const engine=new Consolidator(queue,{personalProfiles:true,ownerIds:[],maxPerHour:2,maxPerDay:12});
  stage='extract_and_interruption';const complete=queue.complete.bind(queue);queue.complete=async()=>{throw Error('acceptance_interruption');};
  await assert.rejects(engine.run(task,extractor),/acceptance_interruption/);await queue.fail(task,'acceptance_interruption');queue.complete=complete;
  const committed=(await admin.pool.query("SELECT id FROM life_memories WHERE status='active' AND visibility='person' AND content LIKE '%乌龙茶%'"));
  assert(committed.rowCount>0,'ordinary multi-sentence preference must actually be committed');summary.ordinaryConversationLearned=true;
  stage='saved_plan_recovery';await admin.pool.query('UPDATE life_memory_tasks SET due_at=now()');
  const recovered=await queue.claim(randomUUID(),[A],options);assert(recovered?.plan,'interrupted task must retain its extraction decisions');
  summary.result=await engine.run(recovered,extractor);summary.realApiCalls=calls;summary.savedPlanRecovery=true;
  assert.equal((await admin.pool.query('SELECT sum(revision)::int AS n,count(*)::int AS rows FROM life_memories')).rows[0].n,
    (await admin.pool.query('SELECT count(*)::int AS n FROM life_memories')).rows[0].n,'replay must not revise already written memories');
  const store=new MemoryStore(app,{personalProfiles:true});
  stage='cross_group_retrieval';const cross=await start(app,'我喜欢什么茶？',B,'fixture-user','fixture-b');
  const facts=await store.search({job:cross},'茶',6);assert(facts.some(m=>String(m.content).includes('乌龙茶')),'same person in another group must retrieve preference');
  assert(!JSON.stringify(facts).includes(A),'source scope must not leak');assert(facts.every(m=>m.source_event_ids.length===0),'cross-group raw evidence must stay hidden');
  await app.setSession(cross,null,true);assert((await store.search({job:cross},'茶',6)).length>0,'new short-term context must preserve long-term memory');await app.complete(cross);
  const other=await start(app,'我喜欢什么茶？',C,'fixture-other','fixture-a');assert.deepEqual(await store.search({job:other},'茶',6),[]);await app.complete(other);
  summary.crossGroupPersonRecall=true;summary.otherPersonIsolated=true;summary.shortTermResetPreservesMemory=true;
  stage='backup_restore';const dump=spawnSync('docker',['exec','napcat-life-postgres-1','pg_dump','-U','life_admin','-d',db,'-Fc','--no-owner','--no-acl'],{maxBuffer:10*1024*1024});assert.equal(dump.status,0);
  await control.pool.query('CREATE DATABASE '+restored);restoreCreated=true;
  const restore=spawnSync('docker',['exec','-i','napcat-life-postgres-1','pg_restore','-U','life_admin','-d',restored,'--no-owner','--no-acl','--exit-on-error'],{input:dump.stdout});assert.equal(restore.status,0);migrate(restored);
  restoredApp=new Ledger({...appBase,database:restored});await restoredApp.check();
  const counts=(await restoredApp.pool.query(`SELECT (SELECT max(version) FROM life_migrations) AS schema,
    (SELECT count(*)::int FROM life_memories) AS memories,(SELECT count(*)::int FROM life_memory_revisions) AS revisions,
    (SELECT count(*)::int FROM life_memory_evidence) AS evidence,(SELECT count(*)::int FROM life_memory_tasks) AS tasks,
    (SELECT count(*)::int FROM life_memory_calls) AS calls,(SELECT count(*)::int FROM life_people) AS people`)).rows[0];
  assert.equal(counts.schema,9);assert(counts.memories>0);assert.equal(counts.tasks,1);assert.equal(counts.calls,1);assert(counts.evidence>0);
  assert.equal((await restoredApp.pool.query("SELECT has_table_privilege(current_user,'life_memory_tasks','INSERT') AS ok")).rows[0].ok,true);
  summary.nonemptyBackupRestore=counts;
  const billing=(await admin.pool.query("SELECT payload->'usage' AS usage FROM life_events WHERE kind='model.usage' AND payload->>'purpose'='memory_consolidation'")).rows;
  assert.equal(billing.length,1,'one real response must appear in usage');summary.usage=billing[0].usage;summary.passed=true;
}catch(error){summary.passed=false;summary.failedStage=stage;summary.reason=(error instanceof Error?error.message:'acceptance_failed').replaceAll(process.env.DEEPSEEK_API_KEY,'[redacted]').slice(0,400);process.exitCode=1;}
finally{
  await restoredApp?.close();await app?.close();await admin?.close();
  if(restoreCreated)await control.pool.query('DROP DATABASE '+restored+' WITH (FORCE)');if(created)await control.pool.query('DROP DATABASE '+db+' WITH (FORCE)');await control.close();
  mkdirSync(join(root,'evidence'),{recursive:true,mode:0o700});writeFileSync(join(root,'evidence/consolidation-runtime.json'),JSON.stringify({...summary,verifiedAt:new Date().toISOString()},null,2),{mode:0o600});
  rmSync(temp,{recursive:true,force:true});console.log(JSON.stringify(summary));
}
