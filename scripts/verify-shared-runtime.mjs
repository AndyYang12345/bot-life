#!/usr/bin/env node
/** Opt-in real DSH/model/vision acceptance. Local OneBot fixture, isolated DB,
 * no connection or delivery to real QQ. Load the dedicated model.env locally. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,copyFileSync,rmSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {Ledger,StyleStore,AttentionStore,ConsolidationQueue,Consolidator,databaseConfig} from '../life-core/dist/index.js';
import {DeepSeekConsolidationModel} from '../dsh-onebot/dist/consolidation-model.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(join(root,'dsh-onebot/package.json')),{WebSocketServer}=require('ws');
const styleLearning=process.argv.includes('--style-learning');
const memeLearning=process.argv.includes('--memes');
const bilibiliFrames=process.argv.includes('--bilibili-frames');
const bilibiliReading=process.argv.includes('--bilibili')||bilibiliFrames;
const webReading=process.argv.includes('--web');
const habitLearning=process.argv.includes('--habits');
const attentionRecall=process.argv.includes('--attention');
if(!process.env.DEEPSEEK_API_KEY)throw Error('Load the independent bot key before this opt-in paid model test.');
const temp=mkdtempSync(join(tmpdir(),'qqbot-shared-runtime-')),db='qqbot_shared_runtime_'+process.pid;
const cfg=join(root,'data/config/life-db-admin.json'),raw=JSON.parse(readFileSync(cfg)),control=new Ledger(databaseConfig(cfg));
let ledger,runtimeApp,restoredApp,child,ws,server,socket,created=false,restoreCreated=false,stage='prepare',logs='',sequence=0;
const received=[],summary={realDsh:true,realModelApi:true,externalQqDelivery:false,isolatedDatabase:true,styleLearning,memeLearning,bilibiliReading,bilibiliFrames,webReading,habitLearning,attentionRecall};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=120000){const end=Date.now()+timeout;while(Date.now()<end){if(child&&child.exitCode!==null)throw Error('runtime_exited');const value=await fn();if(value)return value;await wait(250);}throw Error('acceptance_timeout');}
async function send(message){
  const id=String(++sequence),before=received.length;
  socket.send(JSON.stringify({post_type:'message',message_type:'group',self_id:'90001',user_id:'90002',group_id:'10001',message_id:id,time:Math.floor(Date.now()/1000),message,sender:{nickname:'fixture-user'}}));
  const row=await until(async()=>{const r=await ledger.pool.query("SELECT j.* FROM life_jobs j JOIN life_events e ON e.id=j.id WHERE e.payload->>'message_id'=$1 AND j.status IN ('done','skipped','failed')",[id]);return r.rows[0];});
  assert.notEqual(row.status,'failed','fixture turn failed');
  return {job:row,output:received.slice(before).map(x=>x.text).join('')};
}
const text=value=>({type:'text',data:{text:value}}),at=id=>({type:'at',data:{qq:id}});
try{
  await control.pool.query('CREATE DATABASE '+db);created=true;
  const dbConfig=join(temp,'db.json');writeFileSync(dbConfig,JSON.stringify({...raw,database:db}),{mode:0o600});
  const migration=spawnSync(process.execPath,[join(root,'life-core/dist/admin.js'),'migrate','--config',dbConfig,'--app-password-file',raw.passwordFile.replace('pg-admin-password','pg-app-password')],{encoding:'utf8'});
  assert.equal(migration.status,0,'fixture migration failed');ledger=new Ledger({...databaseConfig(cfg),database:db});
  if(attentionRecall){
    stage='real_alias_learning';runtimeApp=new Ledger({...databaseConfig(cfg.replace('admin.json','app.json')),database:db});
    const corpus=['星露鲸，你在吗？','星露鲸，帮我看看代码','星露鲸，你觉得这个办法怎么样？','星露鲸，再解释一下步骤'];
    for(const [i,value] of corpus.entries()){
      const actor=i%2?'90003':'90002';await runtimeApp.ingest({key:'fixture-alias-'+i,conversation:'onebot:90001:group:10001',actor,occurredAt:new Date().toISOString(),payload:{message:[at('90001'),text(value)],user_id:actor,self_id:'90001'}});
      await runtimeApp.complete(await runtimeApp.claim(randomUUID()));
    }
    const queue=new ConsolidationQueue(runtimeApp),task=await queue.claim(randomUUID(),['onebot:90001:group:10001'],{minMessages:1,maxMessages:12,maxAgeMs:0,leaseMs:90000});assert(task);
    const model=new DeepSeekConsolidationModel('deepseek-flash',process.env.DEEPSEEK_API_KEY,{maxTokens:1500});
    const result=await new Consolidator(queue,{personalProfiles:false,ownerIds:[],maxPerHour:2,maxPerDay:12,attentionLearning:true,identityName:'奶鲸'}).run(task,model);
    assert.equal((await ledger.pool.query("SELECT count(*)::int AS n FROM life_attention_aliases WHERE alias='星露鲸' AND status='active'")).rows[0].n,1);
    summary.realAliasLearning=result;
  }
  if(styleLearning){
    stage='real_style_extraction';runtimeApp=new Ledger({...databaseConfig(cfg.replace('admin.json','app.json')),database:db});
    const corpus=['这轮编译终于全绿，蓝莓收工。','蓝莓收工，今天能歇会了。','慢慢改，先找错误位置。','最后一个问题也修好了，蓝莓收工。','别急，分两步来。','蓝莓收工！检查已经通过。','有问题先看日志。','这回终于搞定了，蓝莓收工。','先把改动存下来。','日志也核对过了。','测试结果没有问题。','可以休息一会了。'];
    for(const [i,value] of corpus.entries()){
      const actor=i%2?'90003':'90002';await runtimeApp.ingest({key:'fixture-style-'+i,conversation:'onebot:90001:group:10001',actor,occurredAt:new Date().toISOString(),payload:{message:[text(value)],user_id:actor,self_id:'90001'}});
      await runtimeApp.complete(await runtimeApp.claim(randomUUID()));
    }
    await runtimeApp.ingest({key:'other-style',conversation:'onebot:90001:group:10002',actor:'90003',occurredAt:new Date().toISOString(),payload:{text:'隔壁专用表达橘子开工'}});await runtimeApp.complete(await runtimeApp.claim(randomUUID()));
    const queue=new ConsolidationQueue(runtimeApp),task=await queue.claim(randomUUID(),['onebot:90001:group:10001'],{minMessages:1,maxMessages:12,maxAgeMs:0,leaseMs:90000});assert(task);
    const provider=new DeepSeekConsolidationModel('deepseek-flash',process.env.DEEPSEEK_API_KEY,{maxTokens:1500});let extractionCalls=0;
    const extractor={provider:provider.provider,model:provider.model,extract:async(input)=>{assert(input.style);assert(!JSON.stringify(input).includes('橘子开工'));extractionCalls++;return provider.extract(input);}};
    const result=await new Consolidator(queue,{personalProfiles:false,ownerIds:[],maxPerHour:2,maxPerDay:12,styleLearning:true}).run(task,extractor);
    const learned=(await ledger.pool.query("SELECT expression,status FROM life_style_rules WHERE expression='蓝莓收工' AND status='active'")).rows;
    assert.equal(learned.length,1,'multiple actual examples must produce an active learned expression');assert.equal(extractionCalls,1);summary.autonomousStyleExtraction=result;summary.singleExtractionCall=true;
  }
  const state=join(temp,'state'),workspace=join(temp,'workspace'),home=join(temp,'home'),dshHome=join(temp,'dsh-home'),profile=join(dshHome,'profiles/onebot'),configDir=join(temp,'data/config'),qq=join(temp,'data/qq');
  for(const path of [state,workspace,home,profile,configDir,qq])mkdirSync(path,{recursive:true,mode:0o700});
  execFileSync('/usr/bin/ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=160x160','-frames:v','1','-threads','1',join(qq,'square.png')]);
  execFileSync('/usr/bin/ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=duration=2:size=160x90:rate=8','-threads','1','-c:v','mpeg4',join(qq,'clip.mp4')]);
  if(memeLearning)execFileSync('python3',['-c',[
    'from PIL import Image, ImageDraw, ImageFont','import sys','from pathlib import Path','root=Path(sys.argv[1])',
    'font=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",44)',
    'im=Image.new("RGB",(480,400),"#fff5be");d=ImageDraw.Draw(im)',
    'd.ellipse((120,25,360,265),fill="#ffd641",outline="black",width=5)',
    'd.ellipse((175,90,192,117),fill="black");d.ellipse((288,90,305,117),fill="black")',
    'd.arc((175,110,305,210),0,180,fill="black",width=8);d.text((48,295),"YAY! GREAT JOB!",font=font,fill="black")',
    'im.save(root/"meme.png")',
    'im=Image.new("RGB",(680,480),"white");d=ImageDraw.Draw(im);font=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",26)',
    'd.multiline_text((30,35),"DEPLOYMENT REPORT\\n\\nRequests: 1250\\nErrors: 14\\nSuccess: 98.88%\\nRegion: us-east\\n\\nStatus: Needs investigation",font=font,fill="black",spacing=12)',
    'im.save(root/"report.png")',
  ].join('\n'),qq]);
  const token='fixture-'+randomUUID();
  server=createServer(async(req,res)=>{
    if(req.headers.authorization!=='Bearer '+token){res.writeHead(401).end();return;}
    let body='';for await(const c of req)body+=c;const args=body?JSON.parse(body):{};let data;
    if(req.url==='/get_login_info')data={user_id:'90001'};
    else if(req.url==='/get_status')data={online:true};
    else if(req.url==='/get_image')data={file:'/app/.config/QQ/'+(memeLearning&&['meme','report'].includes(args.file)?args.file+'.png':'square.png')};
    else if(req.url==='/get_file')data={file:'/app/.config/QQ/clip.mp4'};
    else if(req.url==='/get_forward_msg')data={messages:[
      {sender:{nickname:'Alice',user_id:'777'},message:[text('转发记录里的暗号是蓝色彗星731。'),{type:'image',data:{file:'fixture-image'}}]},
      {sender:{nickname:'Bob',user_id:'778'},message:[{type:'video',data:{file:'a'.repeat(32)}}]},
    ]};
    else if(req.url==='/send_group_msg'){assert.equal(String(args.group_id),'10001');received.push({text:args.message.map(m=>m.data.text??'').join(''),segments:args.message});data={message_id:received.length};}
    else {res.end(JSON.stringify({retcode:1404}));return;}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({retcode:0,data}));
  });
  ws=new WebSocketServer({server});ws.on('connection',(s,req)=>{if(req.headers.authorization!=='Bearer '+token){s.close();return;}socket=s;});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
  const base=JSON.parse(readFileSync(join(root,'data/config/adapter.json'))),policy=join(temp,'policy.json'),onebot=join(configDir,'onebot.json'),app=join(temp,'app.json');
  writeFileSync(onebot,JSON.stringify({network:{httpServers:[{enable:true,token}],websocketServers:[{enable:true,token}]}}),{mode:0o600});
  writeFileSync(app,JSON.stringify({...raw,user:'life_app',database:db,passwordFile:raw.passwordFile.replace('pg-admin-password','pg-app-password')}),{mode:0o600});
  writeFileSync(policy,JSON.stringify({...base,httpUrl:`http://127.0.0.1:${port}`,wsUrl:`ws://127.0.0.1:${port}`,onebotConfigFile:onebot,databaseConfigFile:app,stateDir:state,workspace,allowedGroupIds:['10001'],allowedPrivateIds:[],ownerIds:styleLearning||habitLearning?['90002']:[],expectedSelfId:'90001',maxPerHour:100,memory:{enabled:false},attention:{mode:styleLearning?'replyAll':'attention',cooldownMs:attentionRecall?20000:0,
      ...(attentionRecall?{recall:{enabled:true,learning:true,maxPerHour:6,embedding:{enabled:true,python:join(root,'data/attention/venv/bin/python'),server:join(root,'attention_backend/server.py'),cacheDir:join(root,'data/attention/models'),device:'cpu'}}}:{})},
    conversationLearning:{enabled:styleLearning||memeLearning||bilibiliReading||webReading||habitLearning||attentionRecall,identityName:'奶鲸'},memes:{enabled:memeLearning,cooldownMs:300000},habits:{enabled:habitLearning},
    web:webReading||habitLearning?{enabled:true,maxPerHour:20,maxPerDay:100}:undefined,
    bilibili:bilibiliReading?{enabled:true,python:join(root,'data/bilibili/venv/bin/python'),server:join(root,'bilibili/server.py'),credentials:join(root,'data/bilibili/credential.json'),maxPerHour:40}:undefined,
    ...(styleLearning?{persona:'每句必须包含旧口癖LEGACY_FIXED_PERSONA'}:{}),replayFile:undefined}),{mode:0o600});
  const source=join(root,'data/dsh-home/profiles/onebot');for(const name of ['package.json','cordis.yml'])copyFileSync(join(source,name),join(profile,name));
  symlinkSync(join(source,'node_modules'),join(profile,'node_modules'),'dir');writeFileSync(join(profile,'cordis.patch.yml'),readFileSync(join(source,'cordis.patch.yml'),'utf8').replace(join(root,'data/config/adapter.json'),policy));
  const global=spawnSync('npm',['root','-g'],{encoding:'utf8'}).stdout.trim();
  const launch=()=>{
    child=spawn(process.execPath,[join(global,'@deepseek-ai/dsh/lib/bin.js'),'--profile','onebot'],{cwd:workspace,env:{...process.env,HOME:home,DSH_HOME:dshHome,ONEBOT_POLICY:policy,DSH_PERMISSION_MODE:'workspace-write'},stdio:['ignore','pipe','pipe']});
    for(const s of [child.stdout,child.stderr])s.on('data',c=>{logs=(logs+c).slice(-150000);});
  };
  launch();
  stage='ready';await until(()=>socket,20000);
  if(attentionRecall){
    stage='canonical_name_without_judge';
    const first=await send([text('奶鲸，简短说说给代码写测试有什么用？')]);assert(first.output);
    assert.equal((await ledger.derived(first.job,'attention.decided')).decision.reason,'local_alias_call');
    stage='learned_alias_bypasses_cooldown_and_judge';
    const called=await send([text('星露鲸，你在吗？')]);assert(called.output);
    assert.equal((await ledger.derived(called.job,'attention.decided')).decision.reason,'local_alias_call');
    assert.equal((await ledger.pool.query("SELECT count(*)::int AS n FROM life_events WHERE cause=$1 AND kind='model.usage' AND payload->>'purpose'='attention'",[called.job.id])).rows[0].n,0);
    summary.learnedAliasSkipsJudge=true;
    stage='semantic_recall_wakes_real_judge';
    await until(()=>JSON.parse(readFileSync(join(state,'health.json'),'utf8')).embeddingState==='ready',20000);
    const followup=await send([text('你刚才说的那个怎么操作')]);
    assert.equal((await ledger.derived(followup.job,'attention.recalled')).kind,'semantic');
    assert.equal((await ledger.derived(followup.job,'attention.decided')).decision.source,'model');
    summary.realSemanticRecall=true;
    stage='side_conversation_stays_quiet';
    const side=await send([at('99999'),text('星露鲸刚才说了什么？')]);assert.equal(side.output,'');
    assert.equal((await ledger.derived(side.job,'attention.decided')).decision.reason,'addressed_to_someone_else');summary.sideConversationProtected=true;
    stage='actual_restart_preserves_learned_alias';
    child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));socket=undefined;launch();await until(()=>socket,20000);
    const again=await send([text('星露鲸，在吗？')]);assert(again.output);assert.equal((await ledger.derived(again.job,'attention.decided')).decision.reason,'local_alias_call');summary.aliasSurvivesRestart=true;
    summary.privateSnapshotWritten=JSON.stringify(readFileSync(join(state,'attention', (await import('node:crypto')).createHash('sha256').update('onebot:90001:group:10001').digest('hex')+'.json'),'utf8')).includes('星露鲸');
    assert(summary.privateSnapshotWritten);
    stage='nonempty_attention_backup_restore';
    const restoreDb=db+'_restore',dump=spawnSync('docker',['exec','napcat-life-postgres-1','pg_dump','-U','life_admin','-d',db,'-Fc','--no-owner','--no-acl'],{maxBuffer:10*1024*1024});assert.equal(dump.status,0);
    await control.pool.query('CREATE DATABASE '+restoreDb);restoreCreated=true;
    assert.equal(spawnSync('docker',['exec','-i','napcat-life-postgres-1','pg_restore','-U','life_admin','-d',restoreDb,'--no-owner','--no-acl','--exit-on-error'],{input:dump.stdout}).status,0);
    const restoreConfig=join(temp,'restore.json');writeFileSync(restoreConfig,JSON.stringify({...raw,database:restoreDb}),{mode:0o600});
    assert.equal(spawnSync(process.execPath,[join(root,'life-core/dist/admin.js'),'migrate','--config',restoreConfig,'--app-password-file',raw.passwordFile.replace('pg-admin-password','pg-app-password')],{encoding:'utf8'}).status,0);
    restoredApp=new Ledger({...databaseConfig(cfg.replace('admin.json','app.json')),database:restoreDb});await restoredApp.check();
    const counts=(await restoredApp.pool.query('SELECT (SELECT max(version) FROM life_migrations) AS schema,(SELECT count(*)::int FROM life_attention_aliases) AS aliases,(SELECT count(*)::int FROM life_attention_evidence) AS evidence,(SELECT count(*)::int FROM life_attention_revisions) AS revisions')).rows[0];
    assert.equal(counts.schema,9);assert.equal(counts.aliases,1);assert(counts.evidence>=3);assert.equal(counts.revisions,1);summary.nonemptyAttentionRestore=counts;
  }else if(habitLearning){
    stage='natural_feedback_saved';
    const feedback=await send([at('90001'),text('以后回复简短一点，不要分点，直接给答案，不用播报搜索过程。')]);
    const rows=(await ledger.pool.query("SELECT setting,value,scope FROM life_habits WHERE status='active' ORDER BY setting")).rows;
    assert.equal(rows.length,3);assert(rows.every(r=>r.scope==='person'));summary.naturalFeedbackSaved=rows;
    stage='actual_restart_preserves_habits';
    child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));socket=undefined;launch();await until(()=>socket,20000);
    const reply=await send([at('90001'),text('你觉得给代码写测试有什么用？')]);
    const habitContext=await ledger.derived({id:reply.job.id,conversation:reply.job.conversation},'context.habits');
    assert(habitContext.effective.some(r=>r.setting==='reply.length'&&r.value==='brief'));assert(reply.output.length<=220);assert.doesNotMatch(reply.output,/(?:^|\n)\s*(?:[-*]|\d+[.)、])\s/);
    summary.actualRestartKeepsBehavior=true;summary.replyAfterRestart=reply.output;
    stage='natural_revoke_uses_real_tool';
    const revoked=await send([at('90001'),text('撤销个人习惯里“不分点、自然聊天”这一条回复形式习惯，保留简短和先给答案。')]);
    assert.equal((await ledger.pool.query("SELECT status FROM life_habits WHERE setting='reply.format'")).rows[0].status,'revoked');
    assert.equal((await ledger.pool.query("SELECT count(*)::int AS n FROM life_habit_revisions")).rows[0].n,4);summary.realHabitRevokeTool=true;summary.revokeReply=revoked.output;
    stage='habit_driven_autonomous_search';
    await send([at('90001'),text('以后遇到版本等不确定的信息主动上网查证，优先官方来源，把结果融入回答，不用播报搜索过程。')]);
    child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));socket=undefined;launch();await until(()=>socket,20000);
    const verified=await send([at('90001'),text('Raspberry Pi Imager 当前最新稳定版是多少？')]);
    const effective=await ledger.derived({id:verified.job.id,conversation:verified.job.conversation},'context.habits');
    assert(effective.effective.some(h=>h.setting==='search.mode'&&h.value==='proactive'));
    assert((await ledger.pool.query("SELECT count(*)::int AS n FROM life_events WHERE cause=$1 AND kind='web.completed' AND payload->>'operation'='web_search' AND payload->>'ok'='true'",[verified.job.id])).rows[0].n>=1);
    assert.match(verified.output,/https:\/\//);summary.autonomousSearchAfterRestart=true;summary.searchReply=verified.output.slice(0,1600);
    stage='search_only_when_requested_habit';
    await send([at('90001'),text('以后只有我明确要求时才搜索。')]);
    const held=await send([at('90001'),text('今天有哪些树莓派新闻？')]);
    assert.equal((await ledger.pool.query("SELECT count(*)::int AS n FROM life_events WHERE cause=$1 AND kind='web.requested'",[held.job.id])).rows[0].n,0);
    assert((await ledger.derived({id:held.job.id,conversation:held.job.conversation},'context.habits')).effective.some(h=>h.setting==='search.mode'&&h.value==='on_request'));
    summary.onRequestHabitStopsAutomaticSearch=true;
    stage='habit_backup_restore';
    const restoreDb=db+'_restore',dump=spawnSync('docker',['exec','napcat-life-postgres-1','pg_dump','-U','life_admin','-d',db,'-Fc','--no-owner','--no-acl'],{maxBuffer:10*1024*1024});assert.equal(dump.status,0);
    await control.pool.query('CREATE DATABASE '+restoreDb);restoreCreated=true;
    assert.equal(spawnSync('docker',['exec','-i','napcat-life-postgres-1','pg_restore','-U','life_admin','-d',restoreDb,'--no-owner','--no-acl','--exit-on-error'],{input:dump.stdout}).status,0);
    const restoreConfig=join(temp,'restore.json');writeFileSync(restoreConfig,JSON.stringify({...raw,database:restoreDb}),{mode:0o600});
    assert.equal(spawnSync(process.execPath,[join(root,'life-core/dist/admin.js'),'migrate','--config',restoreConfig,'--app-password-file',raw.passwordFile.replace('pg-admin-password','pg-app-password')],{encoding:'utf8'}).status,0);
    restoredApp=new Ledger({...databaseConfig(cfg.replace('admin.json','app.json')),database:restoreDb});await restoredApp.check();
    const counts=(await restoredApp.pool.query('SELECT (SELECT count(*)::int FROM life_habits) AS habits,(SELECT count(*)::int FROM life_habit_revisions) AS revisions')).rows[0];assert(counts.habits>=5&&counts.revisions>=6);summary.habitBackupRestore=counts;
  }else if(webReading){
    stage='observed_link_without_web_request';const quiet=await send([at('999'),text('这条发给小林：https://www.raspberrypi.com/documentation/computers/getting-started.html')]);
    assert.equal(quiet.job.status,'skipped');assert.equal((await ledger.pool.query("SELECT count(*)::int AS n FROM life_events WHERE kind='web.requested'")).rows[0].n,0);summary.observedWithoutWebRequests=true;
    stage='real_web_search_and_read';
    const result=await send([at('90001'),text('帮我上网查一下树莓派官方的新手文档，并打开一条官方正文核对：第一次给树莓派装系统用什么工具？简短回答，附实际来源链接。')]);
    const completed=(await ledger.pool.query("SELECT payload FROM life_events WHERE cause=$1 AND kind='web.completed'",[result.job.id])).rows.map(x=>x.payload);
    assert(completed.some(x=>x.operation==='web_search'&&x.ok&&x.producedResult));assert(completed.some(x=>x.operation==='web_fetch'&&x.ok));
    assert.match(result.output,/Imager|镜像工具|镜像写入|映像工具/i);assert.match(result.output,/raspberrypi\.com/);
    summary.realWebSearchAndFetch=true;summary.reply=result.output.slice(0,1600);summary.requests=completed;
    stage='web_private_address_rejected';const denied=await send([at('90001'),text('请调用 web_fetch 读取 http://127.0.0.1:6099/webui/ ，告诉我结果；不要使用其他工具。')]);
    assert.equal((await ledger.pool.query("SELECT count(*)::int AS n FROM life_events WHERE cause=$1 AND kind='web.completed' AND payload->>'ok'='true'",[denied.job.id])).rows[0].n,0);
    assert.match(denied.output,/公网|内网|本机|本地|拒绝|不支持|不能|无法/);summary.privateDestinationNotFetched=true;
    const statistics=spawnSync(process.execPath,[join(root,'life-core/dist/admin.js'),'usage','--config',dbConfig],{encoding:'utf8'});assert.equal(statistics.status,0);
    summary.webRequestAccounting=JSON.parse(statistics.stdout).webRequests;assert(summary.webRequestAccounting.some(x=>x.operation==='web_search'&&x.succeeded>=1));
  }else if(bilibiliReading){
    stage='observed_link_no_fetch';const quiet=await send([at('999'),text('这是发给小林的 https://www.bilibili.com/video/BV16U4y1879Q')]);
    assert.equal(quiet.job.status,'skipped');assert.equal((await ledger.pool.query("SELECT count(*)::int AS n FROM life_events WHERE kind='bilibili.read'")).rows[0].n,0);summary.observedLinkNotFetched=true;
    if(bilibiliFrames){
      stage='real_bilibili_automatic_frames';
      const card=await send([at('999'),{type:'json',data:{data:JSON.stringify({app:'com.tencent.miniapp_01',meta:{detail_1:{title:'漫画视频',qqdocurl:'https://www.bilibili.com/video/BV1kmnN6MEwg'}}})}}]);
      assert.equal(card.job.status,'skipped');
      const visual=await send([at('90001'),text('请看上一条分享的视频。它没有字幕，请用 bili_video_preview 并 read_image 实际读取抽出的全部 6 帧，根据画面文字简短总结，不要只复述标题。')]);
      const preview=(await ledger.pool.query("SELECT payload FROM life_events WHERE cause=$1 AND kind='bilibili.read' AND payload->>'tool'='bili_video_preview'",[visual.job.id])).rows[0]?.payload;
      assert(preview?.ok);assert.equal(preview.frameCount,6);
      const finished=await ledger.derived({id:visual.job.id,conversation:visual.job.conversation},'turn.finished');assert(finished.imagesRead>=6,'must actually read all sampled frames');
      const successful=(await ledger.pool.query("SELECT count(*)::int AS n FROM life_events c JOIN life_events r ON r.cause=c.cause AND r.payload->>'callId'=c.payload->>'callId' WHERE c.cause=$1 AND c.kind='tool.call' AND c.payload->>'name'='read_image' AND r.kind='tool.result' AND COALESCE((r.payload->>'isError')::boolean,false)=false AND r.payload->'content' @> $2::jsonb",[visual.job.id,JSON.stringify([{type:'image'}])])).rows[0].n;
      assert.equal(successful,6,'all six actual image tool results must contain image data');summary.successfulImageResults=successful;
      assert.match(visual.output,/苹果皮/);assert.doesNotMatch(visual.output,/看不了画面|不能看画面|没有画面能力/);
      summary.actualFrames=preview;summary.imagesRead=finished.imagesRead;summary.visualReply=visual.output.slice(0,1600);summary.realBilibiliVisualReading=true;
    }else{
    stage='real_bilibili_automatic_subtitles';
    const result=await send([at('90001'),text('https://www.bilibili.com/video/BV16U4y1879Q 根据你实际读到的字幕，简短总结，并说明依据与未读取的范围。')]);
    const reads=(await ledger.pool.query("SELECT payload FROM life_events WHERE cause=$1 AND kind='bilibili.read' ORDER BY seq",[result.job.id])).rows.map(x=>x.payload);
    assert(reads.some(x=>x.tool==='bili_video_info'&&x.ok));assert(reads.some(x=>x.tool==='bili_subtitle'&&x.ok&&x.coverage==='subtitle_only_not_visual_or_full_audio'));
    assert.match(result.output,/字幕/);assert.match(result.output,/树莓派/);assert.doesNotMatch(result.output,/我(?:已经)?(?:完整)?看完/);
    summary.realAutomaticSubtitles=true;summary.reply=result.output.slice(0,1600);summary.reads=reads;
    }
    stage='real_bilibili_model_tool';
    const query=await send([at('90001'),text('请调用 bili_search 搜索“树莓派入门”，只给我一个实际搜索到的视频标题和链接。')]);
    const searched=(await ledger.pool.query("SELECT payload FROM life_events WHERE cause=$1 AND kind='bilibili.read'",[query.job.id])).rows.map(x=>x.payload);
    assert(searched.some(x=>x.tool==='bili_search'&&x.ok));assert.match(query.output,/bilibili\.com\/video\/BV/);summary.realModelSearchTool=true;
  }else if(memeLearning){
    stage='real_visual_meme_classification';
    await send([at('90001'),text('这张图主要用来表达什么？'),{type:'image',data:{file:'meme'}}]);
    const labels=(await ledger.pool.query('SELECT kind,reusable,privacy_risk FROM life_image_labels')).rows;
    assert.equal(labels.length,1,'must classify after a successful read_image');assert.equal(labels[0].kind,'meme');
    assert.equal((await ledger.pool.query('SELECT count(*)::int AS n FROM life_memes')).rows[0].n,1,'must collect the reusable meme');
    assert(!received.some(x=>x.segments.some(s=>s.type==='image')),'do not echo the just-collected image');
    summary.visionClassifiesAndCollectsMeme=true;summary.doesNotEchoCurrentImage=true;
    stage='real_visual_information_classification';
    await send([at('90001'),text('读取这张报告的主要数据，正常回答信息即可。'),{type:'image',data:{file:'report'}}]);
    assert.equal((await ledger.pool.query("SELECT count(*)::int AS n FROM life_image_labels WHERE kind='informational'")).rows[0].n,1);
    assert.equal((await ledger.pool.query('SELECT count(*)::int AS n FROM life_memes')).rows[0].n,1);
    summary.informationImageNotCollected=true;
    stage='real_scoped_image_reply';
    const before=received.length;
    const reply=await send([at('90001'),text('最后一个问题修好了，测试全绿，终于搞定啦！用一张你收藏的合适表情回应就好，不用文字。')]);
    const sent=received.slice(before);assert.equal(sent.length,1);assert.equal(sent[0].text,'');assert.equal(sent[0].segments.length,1);
    assert.equal(sent[0].segments[0].type,'image');assert.equal(sent[0].segments[0].data.file,'base64://'+readFileSync(join(qq,'meme.png')).toString('base64'));
    const selected=await ledger.derived({id:reply.job.id,conversation:reply.job.conversation},'meme.selected');assert.equal(selected.mode,'image_only');
    assert.equal((await ledger.pool.query("SELECT count(*)::int AS n FROM life_outbox WHERE job_id=$1 AND status='confirmed' AND payload ? 'meme'",[reply.job.id])).rows[0].n,1);
    summary.realImageOnlyReplyConfirmed=true;
    stage='meme_backup_restore';
    const restoreDb=db+'_restore',dump=spawnSync('docker',['exec','napcat-life-postgres-1','pg_dump','-U','life_admin','-d',db,'-Fc','--no-owner','--no-acl'],{maxBuffer:10*1024*1024});assert.equal(dump.status,0);
    await control.pool.query('CREATE DATABASE '+restoreDb);restoreCreated=true;
    const restored=spawnSync('docker',['exec','-i','napcat-life-postgres-1','pg_restore','-U','life_admin','-d',restoreDb,'--no-owner','--no-acl','--exit-on-error'],{input:dump.stdout});assert.equal(restored.status,0);
    const restoreConfig=join(temp,'restore.json');writeFileSync(restoreConfig,JSON.stringify({...raw,database:restoreDb}),{mode:0o600});
    const acl=spawnSync(process.execPath,[join(root,'life-core/dist/admin.js'),'migrate','--config',restoreConfig,'--app-password-file',raw.passwordFile.replace('pg-admin-password','pg-app-password')],{encoding:'utf8'});assert.equal(acl.status,0);
    restoredApp=new Ledger({...databaseConfig(cfg.replace('admin.json','app.json')),database:restoreDb});await restoredApp.check();
    const counts=(await restoredApp.pool.query('SELECT (SELECT max(version) FROM life_migrations) AS schema,(SELECT count(*)::int FROM life_memes) AS memes,(SELECT count(*)::int FROM life_image_labels) AS labels')).rows[0];
    assert.equal(counts.schema,9);assert.equal(counts.memes,1);assert.equal(counts.labels,2);summary.nonemptyMemeBackupRestore=counts;
  }else if(styleLearning){
    stage='context_appropriateness';const failed=await send([text('测试还是全红，有点烦，下一步怎么办？')]);
    assert.doesNotMatch(failed.output,/蓝莓收工|LEGACY_FIXED_PERSONA/);assert(failed.output.length<400);summary.avoidsInappropriateMeme=true;
    const old=(await ledger.session('onebot:90001:group:10001')).id;await send([text('/new')]);
    stage='learned_style_after_reset';const done=await send([text('最后一轮测试也全绿了，今天的活全做完，可以休息了，你怎么说？')]);
    assert.match(done.output,/蓝莓收工/);assert.doesNotMatch(done.output,/LEGACY_FIXED_PERSONA/);assert(done.output.length<160);
    assert.notEqual((await ledger.session('onebot:90001:group:10001')).id,old);summary.learnedExpressionUsed=true;summary.legacyPersonaRemoved=true;summary.shortSessionResetPreservesStyle=true;summary.replyChars=done.output.length;
    stage='style_backup_restore';const restoreDb=db+'_restore';
    const dump=spawnSync('docker',['exec','napcat-life-postgres-1','pg_dump','-U','life_admin','-d',db,'-Fc','--no-owner','--no-acl'],{maxBuffer:10*1024*1024});assert.equal(dump.status,0);
    await control.pool.query('CREATE DATABASE '+restoreDb);restoreCreated=true;
    const restored=spawnSync('docker',['exec','-i','napcat-life-postgres-1','pg_restore','-U','life_admin','-d',restoreDb,'--no-owner','--no-acl','--exit-on-error'],{input:dump.stdout});assert.equal(restored.status,0);
    const restoreConfig=join(temp,'restore.json');writeFileSync(restoreConfig,JSON.stringify({...raw,database:restoreDb}),{mode:0o600});
    const acl=spawnSync(process.execPath,[join(root,'life-core/dist/admin.js'),'migrate','--config',restoreConfig,'--app-password-file',raw.passwordFile.replace('pg-admin-password','pg-app-password')],{encoding:'utf8'});assert.equal(acl.status,0);
    restoredApp=new Ledger({...databaseConfig(cfg.replace('admin.json','app.json')),database:restoreDb});await restoredApp.check();
    const counts=(await restoredApp.pool.query(`SELECT (SELECT max(version) FROM life_migrations) AS schema,(SELECT count(*)::int FROM life_style_rules) AS rules,(SELECT count(*)::int FROM life_style_profiles) AS profiles,(SELECT count(*)::int FROM life_style_evidence) AS evidence,(SELECT count(*)::int FROM life_style_revisions) AS revisions`)).rows[0];
    assert.equal(counts.schema,9);assert(counts.rules>0&&counts.profiles>0&&counts.evidence>=3&&counts.revisions>0);summary.nonemptyStyleBackupRestore=counts;
  }else{
  stage='quiet_history';const quiet=await send([at('999'),text('小林，取餐暗号是橙色松鼠482，等我过去。')]);assert.equal(quiet.output,'');assert.equal(quiet.job.status,'skipped');summary.observedWithoutSending=true;
  stage='real_attention_judge';const judged=await send([text('我先去食堂找小林了，晚点再聊。')]);
  const decision=await ledger.derived({id:judged.job.id,conversation:judged.job.conversation},'attention.decided');
  assert.equal(decision.decision.source,'model','real judge must parse successfully instead of silently falling back');summary.judgeAction=decision.decision.action;
  stage='forward_and_video_vision';const visual=await send([at('90001'),text('请读合并转发，告诉我其中的暗号和前面小林取餐的暗号分别是什么，并用 read_image 查看转发图片及视频抽帧，简短描述实际看到的内容；不要编造声音。'),{type:'forward',data:{id:'fixture-forward'}}]);
  assert.match(visual.output,/蓝色彗星\s*731/);assert.match(visual.output,/橙色松鼠\s*482/);summary.observedContextRecalled=true;
  const normalized=await ledger.derived({id:visual.job.id,conversation:visual.job.conversation},'inbound.normalized');
  assert.equal(normalized.forwards,1);assert.equal(normalized.forwardNodes,2);assert.equal(normalized.videos,1);assert.equal(normalized.images,1);assert.equal(normalized.mediaFailures,0);
  const finished=await ledger.derived({id:visual.job.id,conversation:visual.job.conversation},'turn.finished');assert(finished.imagesRead>=2,'actual vision tools must read shared media');
  summary.normalized={forwards:normalized.forwards,forwardNodes:normalized.forwardNodes,videos:normalized.videos,images:normalized.images};summary.imagesRead=finished.imagesRead;
  }
  const usage=(await ledger.pool.query("SELECT COALESCE(payload->>'purpose','chat') AS purpose,count(*)::int FROM life_events WHERE kind='model.usage' GROUP BY 1")).rows;summary.reportedModelUsage=usage;summary.passed=true;
}catch(error){summary.passed=false;summary.failedStage=stage;summary.reason=(error instanceof Error?error.message:'acceptance_failed').replaceAll(process.env.DEEPSEEK_API_KEY,'[redacted]').slice(0,300);process.exitCode=1;}
finally{
  if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),wait(5000)]);if(child.exitCode===null)child.kill('SIGKILL');}
  ws?.clients.forEach(s=>s.terminate());ws?.close();server?.close();await restoredApp?.close();await runtimeApp?.close();await ledger?.close();if(restoreCreated)await control.pool.query('DROP DATABASE '+db+'_restore WITH (FORCE)');if(created)await control.pool.query('DROP DATABASE '+db+' WITH (FORCE)');await control.close();
  const evidenceName=attentionRecall?'attention-runtime':habitLearning?'habit-runtime':webReading?'web-runtime':bilibiliFrames?'bilibili-frames-runtime':bilibiliReading?'bilibili-runtime':memeLearning?'meme-runtime':styleLearning?'style-runtime':'shared-runtime';
  writeFileSync(join(root,'evidence/'+evidenceName+'.json'),JSON.stringify({...summary,at:new Date().toISOString()},null,2),{mode:0o600});
  if(!summary.passed)writeFileSync(join(root,'evidence/'+evidenceName+'-debug.log'),logs.replaceAll(process.env.DEEPSEEK_API_KEY,'[redacted]'),{mode:0o600});
  rmSync(temp,{recursive:true,force:true});console.log(JSON.stringify(summary));
}
