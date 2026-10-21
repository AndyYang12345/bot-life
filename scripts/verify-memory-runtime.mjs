#!/usr/bin/env node
/** Opt-in acceptance using the real DSH + model API, isolated DB/profile, local OneBot fixture. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { spawn,spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,copyFileSync,rmSync } from 'node:fs';
import { dirname,join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { Ledger,MemoryStore,databaseConfig } from '../life-core/dist/index.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const personalProfiles=process.argv.includes('--personal-profiles');
const require=createRequire(join(root,'dsh-onebot/package.json'));
const {WebSocketServer}=require('ws');
if(!process.env.DEEPSEEK_API_KEY)throw Error('Load this bot private model.env before running this opt-in live API test.');
const temp=mkdtempSync(join(tmpdir(),'qqbot-memory-runtime-'));
const db='qqbot_runtime_test_'+process.pid,restoreDb=db+'_restore';
const configPath=join(root,'data/config/life-db-admin.json');
const raw=JSON.parse(readFileSync(configPath,'utf8'));
const control=new Ledger(databaseConfig(configPath));
let ledger,child,ws,server,logs='',created=false,restoreCreated=false,stage='prepare';
const received=[];let socket,sequence=0;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=120000){const end=Date.now()+timeout;while(Date.now()<end){if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error('runtime_exited');const result=await fn();if(result)return result;await wait(300);}throw Error('acceptance_timeout');}
function migrate(database){const cfg=join(temp,database+'.json');writeFileSync(cfg,JSON.stringify({...raw,database}),{mode:0o600});const r=spawnSync(process.execPath,[join(root,'life-core/dist/admin.js'),'migrate','--config',cfg,'--app-password-file',raw.passwordFile.replace('pg-admin-password','pg-app-password')],{encoding:'utf8'});assert.equal(r.status,0,'fixture migration failed');}
async function message(text,group='10001',user='90002',nickname='fixture-user'){
  stage=text.startsWith('/')?text:'model_turn_'+(sequence+1);
  const before=received.length;
  socket.send(JSON.stringify({post_type:'message',self_id:'90001',user_id:user,message_id:String(++sequence),message_type:'group',group_id:group,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text}}],sender:{nickname}}));
  const receipt=await until(()=>received[before]);
  await until(async()=>!(await ledger.pool.query("SELECT id FROM life_jobs WHERE status IN ('pending','running')")).rowCount);
  return receipt.text;
}
const summary={realDsh:true,realModelApi:true,externalQqDelivery:false,isolatedDatabase:true,personalProfiles};
try{
  await control.pool.query('CREATE DATABASE '+db);created=true;migrate(db);
  ledger=new Ledger({...databaseConfig(configPath),database:db});
  if(personalProfiles){
    const conversation='onebot:90001:group:10001';
    await ledger.ingest({key:'fixture-preexisting-local',conversation,actor:'90002',occurredAt:new Date().toISOString(),payload:{text:'我喜欢乌龙茶'}});
    const job=await ledger.claim(randomUUID());
    await new MemoryStore(ledger).remember({job,actorId:'90002',ownerIds:[],writer:'fixture:legacy',operationKey:'seed'},
      {type:'semantic',subject_type:'user',subject_id:'90002',content:'用户自述喜欢喝乌龙茶。',summary:'喜欢乌龙茶',slot:'drink_preference',confidence:0.8,importance:0.6,sensitivity:'internal',source_kind:'user_report',evidence:[{event_id:job.id,quote:'我喜欢乌龙茶'}]});
    await ledger.complete(job);
  }
  const token='fixture-'+randomUUID();
  server=createServer(async(req,res)=>{
    if(req.headers.authorization!=='Bearer '+token){res.writeHead(401).end();return;}
    let input='';for await(const chunk of req)input+=chunk;const args=input?JSON.parse(input):{};
    let data;
    if(req.url==='/get_login_info')data={user_id:'90001'};
    else if(req.url==='/get_status')data={online:true,good:true};
    else if(req.url==='/send_group_msg'){received.push({group:String(args.group_id),text:args.message.map(m=>m.data.text??'').join('')});data={message_id:received.length};}
    else{res.end(JSON.stringify({retcode:1404}));return;}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({retcode:0,data}));
  });
  ws=new WebSocketServer({server});ws.on('connection',(s,req)=>{if(req.headers.authorization!=='Bearer '+token){s.close();return;}socket=s;});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
  const base=JSON.parse(readFileSync(join(root,'data/config/adapter.json'),'utf8'));
  const state=join(temp,'state'),workspace=join(temp,'workspace'),home=join(temp,'home'),dshHome=join(temp,'dsh-home'),profile=join(dshHome,'profiles/onebot');
  for(const path of [state,workspace,home,profile])mkdirSync(path,{recursive:true,mode:0o700});
  const onebotConfig=join(temp,'onebot.json'),appConfig=join(temp,'app.json'),policy=join(temp,'policy.json');
  writeFileSync(onebotConfig,JSON.stringify({network:{httpServers:[{enable:true,token}],websocketServers:[{enable:true,token}]}}),{mode:0o600});
  writeFileSync(appConfig,JSON.stringify({...raw,user:'life_app',database:db,passwordFile:raw.passwordFile.replace('pg-admin-password','pg-app-password')}),{mode:0o600});
  writeFileSync(policy,JSON.stringify({...base,httpUrl:`http://127.0.0.1:${port}`,wsUrl:`ws://127.0.0.1:${port}`,onebotConfigFile:onebotConfig,databaseConfigFile:appConfig,stateDir:state,workspace,allowedGroupIds:['10001','10002','10003'],allowedPrivateIds:[],ownerIds:['90002'],expectedSelfId:'90001',maxPerHour:100,memory:{enabled:true,contextLimit:6,personalProfiles},replayFile:undefined}),{mode:0o600});
  const source=join(root,'data/dsh-home/profiles/onebot');
  for(const name of ['package.json','cordis.yml'])copyFileSync(join(source,name),join(profile,name));
  symlinkSync(join(source,'node_modules'),join(profile,'node_modules'),'dir');
  writeFileSync(join(profile,'cordis.patch.yml'),readFileSync(join(source,'cordis.patch.yml'),'utf8').replace(join(root,'data/config/adapter.json'),policy));
  const global=spawnSync('npm',['root','-g'],{encoding:'utf8'}).stdout.trim();
  child=spawn(process.execPath,[join(global,'@deepseek-ai/dsh/lib/bin.js'),'--profile','onebot'],{cwd:workspace,env:{...process.env,HOME:home,DSH_HOME:dshHome,ONEBOT_POLICY:policy,DSH_PERMISSION_MODE:'workspace-write'},stdio:['ignore','pipe','pipe']});
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{logs=(logs+chunk).slice(-200000);});
  stage='ready';await until(()=>socket,20000);
  await message(personalProfiles?'我喜欢乌龙茶':'记住：我喜欢乌龙茶。');
  let row=(await ledger.pool.query('SELECT * FROM life_memories')).rows[0];
  assert.equal(row?.status,'active','model must actually commit a memory');assert.match(row.content,/乌龙茶/);summary.remember=true;
  assert.equal(row.visibility,personalProfiles?'person':'conversation');
  if(personalProfiles){assert.equal(row.revision,2);summary.plainSelfReportPromotesLegacy=true;}
  const firstSession=(await ledger.session('onebot:90001:group:10001')).id;
  await message('/new');const recalled=await message('我喜欢什么茶？');assert.match(recalled,/乌龙茶/);
  assert.notEqual((await ledger.session('onebot:90001:group:10001')).id,firstSession);summary.newSessionRecall=true;
  const other=await message('我喜欢什么茶？','10002','90002','Changed-name');
  if(personalProfiles){
    assert.match(other,/乌龙茶/);summary.crossGroupRecall=true;
    const profiles=(await ledger.pool.query('SELECT count(DISTINCT person_id)::int AS n FROM life_conversation_people')).rows[0];assert.equal(profiles.n,1);summary.identitySurvivesNicknameChange=true;
    assert.doesNotMatch(await message('我喜欢什么茶？','10003','90003'),/乌龙茶/);summary.sameNicknameDifferentAccountIsolated=true;
  }else{assert.doesNotMatch(other,/乌龙茶/);summary.crossGroupIsolation=true;}
  assert.equal((await ledger.pool.query("SELECT count(*)::int AS n FROM life_memories WHERE conversation='onebot:90001:group:10002'")).rows[0].n,0);summary.noConversationCopyCreated=true;
  const updateGroup=personalProfiles?'10002':'10001';
  await message('我的偏好更新了：我喜欢红茶。请用 memory_revise 修订原来那条茶偏好，不要另建一条。',updateGroup);
  row=(await ledger.pool.query('SELECT * FROM life_memories WHERE id=$1',[row.id])).rows[0];assert.equal(row.revision,personalProfiles?3:2);assert.match(row.content,/红茶/);summary.revise=true;
  await message('请用 memory_forget 忘记我的茶偏好。',updateGroup);
  row=(await ledger.pool.query('SELECT * FROM life_memories WHERE id=$1',[row.id])).rows[0];assert.equal(row.status,'forgotten');assert.equal(row.revision,personalProfiles?4:3);
  assert.deepEqual(await new MemoryStore(ledger).query(ledger.pool,'onebot:90001:group:10001','茶'),[]);summary.forget=true;
  if(personalProfiles){assert.doesNotMatch(await message('我喜欢什么茶？'),/乌龙茶|红茶/);summary.forgetPropagatesAcrossGroups=true;}
  stage='backup_restore';
  const dump=spawnSync('docker',['exec','napcat-life-postgres-1','pg_dump','-U','life_admin','-d',db,'-Fc','--no-owner','--no-acl'],{maxBuffer:10*1024*1024});assert.equal(dump.status,0);
  await control.pool.query('CREATE DATABASE '+restoreDb);restoreCreated=true;
  const restored=spawnSync('docker',['exec','-i','napcat-life-postgres-1','pg_restore','-U','life_admin','-d',restoreDb,'--no-owner','--no-acl','--exit-on-error'],{input:dump.stdout});assert.equal(restored.status,0);migrate(restoreDb);
  const restoredLedger=new Ledger({...databaseConfig(configPath),database:restoreDb});
  try{
    const counts=(await restoredLedger.pool.query('SELECT (SELECT count(*)::int FROM life_memories) AS memories,(SELECT count(*)::int FROM life_memory_revisions) AS revisions,(SELECT count(*)::int FROM life_memory_evidence) AS evidence')).rows[0];assert.deepEqual(counts,{memories:1,revisions:personalProfiles?4:3,evidence:personalProfiles?3:2});summary.nonemptyMemoryBackupRestore=counts;
    const people=Number((await restoredLedger.pool.query('SELECT count(*) FROM life_people')).rows[0].count);assert.equal(people,personalProfiles?2:1);summary.restoredPeople=people;
  }finally{await restoredLedger.close();}
  summary.passed=true;
}catch(error){summary.passed=false;summary.failedStage=stage;summary.reason=error instanceof Error?error.message.replaceAll(process.env.DEEPSEEK_API_KEY,'[redacted]').slice(0,400):'acceptance_failed';process.exitCode=1;}
finally{
  if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),wait(5000)]);if(child.exitCode===null)child.kill('SIGKILL');}
  ws?.clients.forEach(s=>s.terminate());ws?.close();server?.close();await ledger?.close();
  if(restoreCreated)await control.pool.query('DROP DATABASE '+restoreDb+' WITH (FORCE)');if(created)await control.pool.query('DROP DATABASE '+db+' WITH (FORCE)');await control.close();
  mkdirSync(join(root,'evidence'),{recursive:true,mode:0o700});
  const evidenceName=personalProfiles?'person-runtime':'memory-runtime';
  writeFileSync(join(root,'evidence/'+evidenceName+'.json'),JSON.stringify({...summary,checkedAt:new Date().toISOString()},null,2),{mode:0o600});
  if(!summary.passed)writeFileSync(join(root,'evidence/'+evidenceName+'-debug.log'),logs.replaceAll(process.env.DEEPSEEK_API_KEY,'[redacted]'),{mode:0o600});
  rmSync(temp,{recursive:true,force:true});console.log(JSON.stringify(summary));
}
