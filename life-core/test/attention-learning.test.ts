import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Ledger,AttentionStore,Consolidator,ConsolidationQueue,parseAliasProposals,validAlias,databaseConfig} from '../src/index.js';
import type {Job,AliasInput,AliasProposal} from '../src/index.js';
const config=process.env.LIFE_TEST_ADMIN_CONFIG;
describe('literal alias proposal contract',()=>{
  it('rejects executable patterns, vague common words, forged sources and unknown fields',()=>{
    for(const value of ['.*','a|b','ai','机器人','你','ABC','名字\n命令'])expect(validAlias(value)).toBe(false);
    const input:AliasInput={identity:'奶鲸',existing:[],events:[{id:randomUUID(),speaker:'s1',text:'小鲸鲸在吗',directed:true,at:new Date().toISOString()}]};
    const proposal={alias:'小鲸鲸',confidence:0.9,evidence:[{event_id:input.events[0]!.id,quote:'小鲸鲸'}]};
    expect(parseAliasProposals([proposal],input).aliases).toHaveLength(1);
    for(const patch of [{alias:'.*'},{pattern:'evil'},{evidence:[{event_id:randomUUID(),quote:'小鲸鲸'}]}])expect(parseAliasProposals([{...proposal,...patch}],input).aliases).toEqual([]);
  });
});
describe.skipIf(!config)('attention learning with real PostgreSQL',()=>{
  const db='qqbot_attention_'+process.pid,A='onebot:bot:group:a',B='onebot:bot:group:b';
  let control:Ledger,admin:Ledger,app:Ledger,store:AttentionStore,root:string,file:string;
  const run=(...args:string[])=>spawnSync(process.execPath,['dist/admin.js',...args,'--config',file],{encoding:'utf8'});
  async function post(text:string,actor='u1',scope=A,directed=true,done=true):Promise<Job>{
    await app.ingest({key:randomUUID(),conversation:scope,actor,occurredAt:new Date().toISOString(),payload:{self_id:'bot',user_id:actor,message:[...(directed?[{type:'at',data:{qq:'bot'}}]:[]),{type:'text',data:{text}}]}});
    const job=(await app.claim(randomUUID()))!;if(done)await app.complete(job);return job;
  }
  async function sample(directed=true){for(let i=0;i<4;i++)await post('小鲸鲸，帮我看看第'+i+'个问题',i%2?'u2':'u1',A,directed);}
  const proposals=(input:AliasInput):AliasProposal[]=>[{alias:'小鲸鲸',confidence:0.92,evidence:input.events.filter(e=>e.text.includes('小鲸鲸')).slice(-4).map(e=>({event_id:e.id,quote:'小鲸鲸'}))}];
  beforeAll(async()=>{
    root=mkdtempSync(join(tmpdir(),'attention-test-'));control=new Ledger(databaseConfig(config!));await control.pool.query('CREATE DATABASE '+db);
    const raw=JSON.parse(readFileSync(config!,'utf8'));file=join(root,'admin.json');writeFileSync(file,JSON.stringify({...raw,database:db}),{mode:0o600});
    expect(run('migrate','--app-password-file',raw.passwordFile.replace('pg-admin-password','pg-app-password')).status).toBe(0);
    admin=new Ledger({...databaseConfig(config!),database:db});app=new Ledger({...databaseConfig(config!.replace('admin.json','app.json')),database:db});store=new AttentionStore(app);
  });
  beforeEach(async()=>{await admin.pool.query('TRUNCATE life_events,life_conversations,life_rates CASCADE');await admin.pool.query("UPDATE life_settings SET value='false'");});
  afterAll(async()=>{await app?.close();await admin?.close();if(control){await control.pool.query('DROP DATABASE '+db+' WITH (FORCE)');await control.close();}if(root)rmSync(root,{recursive:true,force:true});});
  it('requires real bot-directed evidence before activation and deduplicates repeated learning',async()=>{
    await sample(false);let job=await post('当前问题','u1',A,false,false),input=(await store.input(job,'奶鲸'))!;
    expect((await store.apply(job,input,proposals(input))).active).toBe(0);await app.complete(job);
    await post('小鲸鲸，你在吗','u2');job=await post('新的问题','u1',A,false,false);input=(await store.input(job,'奶鲸'))!;
    expect((await store.apply(job,input,proposals(input))).active).toBe(1);expect((await store.context(job)).aliases).toEqual(['小鲸鲸']);
    const before=(await admin.pool.query('SELECT revision FROM life_attention_aliases')).rows[0].revision;
    await store.apply(job,input,proposals(input));expect((await admin.pool.query('SELECT revision FROM life_attention_aliases')).rows[0].revision).toBe(before);
  });
  it('never trusts forwarded, own, other-recipient or foreign-group evidence',async()=>{
    await sample();const foreign=await post('小鲸鲸，另一个群','u2',B);let job=await post('当前问题','u1',A,false,false);
    const input=(await store.input(job,'奶鲸'))!;expect(input.events.some(e=>e.id===foreign.id)).toBe(false);
    expect((await store.apply(job,{...input,events:[...input.events,{id:foreign.id,text:'小鲸鲸，另一个群',speaker:'s',directed:true,at:new Date().toISOString()}]},[{alias:'小鲸鲸',confidence:0.99,evidence:[{event_id:foreign.id,quote:'小鲸鲸'}]}])).rejected).toBe(1);
    await store.apply(job,input,proposals(input));await app.complete(job);job=await post('本群问题','u1',B,false,false);expect((await store.context(job)).aliases).toEqual([]);
  });
  it('checks pause, lease, aging, suppression and reset watermarks',async()=>{
    await sample();let job=await post('当前问题','u1',A,false,false),input=(await store.input(job,'奶鲸'))!;await store.apply(job,input,proposals(input));await app.complete(job);
    expect(run('attention-pause').status).toBe(0);job=await post('现在呢','u1',A,false,false);expect(await store.input(job,'奶鲸')).toBeUndefined();await expect(store.apply(job,input,proposals(input))).rejects.toThrow('memory_writes_paused');await app.complete(job);
    expect(run('attention-resume').status).toBe(0);const id=(await admin.pool.query('SELECT id FROM life_attention_aliases')).rows[0].id;
    expect(run('attention-suppress','--conversation',A,'--alias-id',id).status).toBe(0);job=await post('现在呢','u1',A,false,false);expect((await store.context(job)).aliases).toEqual([]);await app.complete(job);
    expect(run('attention-reset','--conversation',A).status).toBe(0);job=await post('继续','u1',A,false,false);expect(await store.input(job,'奶鲸')).toBeUndefined();
    await admin.pool.query("UPDATE life_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[job.id]);await expect(store.context(job)).rejects.toThrow('lease_lost');
  });
  it('combines AI alias extraction with the existing single consolidation call',async()=>{
    await sample();const queue=new ConsolidationQueue(app),task=(await queue.claim(randomUUID(),[A],{minMessages:1,maxMessages:12,maxAgeMs:0,leaseMs:60000}))!;
    const extractor={provider:'fixture',model:'fixture',extract:vi.fn(async(i:any)=>({content:JSON.stringify({memories:[],aliases:proposals(i.attention)})}))};
    const result=await new Consolidator(queue,{personalProfiles:false,ownerIds:[],maxPerHour:2,maxPerDay:12,attentionLearning:true}).run(task,extractor);
    expect(result).toMatchObject({written:0,attention:{active:1}});expect(extractor.extract).toHaveBeenCalledTimes(1);
    expect((await admin.pool.query('SELECT count(*)::int AS n FROM life_memory_calls')).rows[0].n).toBe(1);
  });
  it('bootstraps an alias-only snapshot once without reprocessing personal facts',async()=>{
    await sample();expect(JSON.parse(run('attention-bootstrap','--conversation',A).stdout).queued).toBe(true);
    expect(JSON.parse(run('attention-bootstrap','--conversation',A).stdout).reason).toBe('already_requested');
    const queue=new ConsolidationQueue(app),task=(await queue.claim(randomUUID(),[A],{minMessages:1,maxMessages:12,maxAgeMs:0,leaseMs:60000}))!;
    expect(task.sourceIds).toEqual([]);
    const extractor={provider:'fixture',model:'fixture',extract:vi.fn(async(i:any)=>{expect(i.events).toEqual([]);return {content:JSON.stringify({memories:[],aliases:proposals(i.attention)})};})};
    const result=await new Consolidator(queue,{personalProfiles:false,ownerIds:[],maxPerHour:2,maxPerDay:12,attentionLearning:true}).run(task,extractor);
    expect(result).toMatchObject({written:0,attention:{active:1}});expect(extractor.extract).toHaveBeenCalledTimes(1);
  });
  it('exports, deletes and protects immutable history',async()=>{
    await sample();const job=await post('当前问题','u1',A,false,false),input=(await store.input(job,'奶鲸'))!;await store.apply(job,input,proposals(input));await app.complete(job);
    const output=join(root,'export.json');expect(run('export','--conversation',A,'--output',output).status).toBe(0);const data=JSON.parse(readFileSync(output,'utf8'));
    expect(data.attentionAliases).toHaveLength(1);expect(data.attentionEvidence).toHaveLength(4);expect(data.attentionRevisions).toHaveLength(1);
    await expect(app.pool.query('DELETE FROM life_attention_aliases')).rejects.toThrow();await expect(app.pool.query("UPDATE life_attention_revisions SET payload='{}'")).rejects.toThrow();
    await app.pause(true);expect(run('delete','--conversation',A).status).toBe(0);expect((await admin.pool.query('SELECT count(*)::int AS n FROM life_attention_aliases')).rows[0].n).toBe(0);
  });
});
