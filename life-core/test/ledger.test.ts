import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { Ledger, LeaseLost, Spool, databaseConfig } from '../src/index.js';
import type { Inbound, Job } from '../src/index.js';

const configFile = process.env.LIFE_TEST_ADMIN_CONFIG;
describe.skipIf(!configFile)('isolated real PostgreSQL acceptance', () => {
  let admin: Ledger, app: Ledger, control: Ledger, root: string, testConfig: string;
  const dbName = 'qqbot_life_test_' + process.pid;
  const input = (key = randomUUID(), conversation = 'test:account:group:a'): Inbound => ({ key, conversation, actor: 'u1', occurredAt: new Date().toISOString(), payload: { text: 'sample' } });
  async function claim(): Promise<Job> { return (await app.claim(randomUUID()))!; }
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'life-acceptance-'));
    const base = databaseConfig(configFile!); control = new Ledger(base);
    await control.pool.query('CREATE DATABASE ' + dbName);
    const raw = JSON.parse(readFileSync(configFile!, 'utf8'));
    testConfig = join(root, 'admin.json'); writeFileSync(testConfig, JSON.stringify({ ...raw, database: dbName }), { mode: 0o600 });
    const migration = spawnSync(process.execPath, ['dist/admin.js','migrate','--config',testConfig,'--app-password-file',raw.passwordFile.replace('pg-admin-password','pg-app-password')], { encoding: 'utf8' });
    expect(migration.status, migration.stderr).toBe(0);
    admin = new Ledger({ ...base, database: dbName });
    app = new Ledger({ ...databaseConfig(configFile!.replace('admin.json','app.json')), database: dbName });
    await app.check();
  });
  beforeEach(async () => {
    await admin.pool.query('TRUNCATE life_events,life_jobs,life_outbox,life_event_media,life_blobs,life_session_links,life_conversations,life_rates,life_legacy_seen CASCADE');
    await admin.pool.query("DELETE FROM life_settings WHERE key<>'paused'; UPDATE life_settings SET value='false' WHERE key='paused'");
  });
  afterAll(async () => {
    await app?.close(); await admin?.close();
    if (control) { await control.pool.query('DROP DATABASE IF EXISTS ' + dbName + ' WITH (FORCE)'); await control.close(); }
    if (root) rmSync(root, { recursive: true, force: true });
  });
  it('commits each input and its job once under concurrent duplicate ingestion', async () => {
    const x = input(); const results = await Promise.all(Array.from({ length: 8 }, () => app.ingest(x)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await admin.pool.query('SELECT count(*)::int AS n FROM life_events')).rows[0].n).toBe(1);
    expect((await admin.pool.query('SELECT count(*)::int AS n FROM life_jobs')).rows[0].n).toBe(1);
  });
  it('rolls the input back when enqueue fails', async () => {
    await admin.pool.query("CREATE FUNCTION fail_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$; CREATE TRIGGER fail_job BEFORE INSERT ON life_jobs FOR EACH ROW EXECUTE FUNCTION fail_job()");
    try { await expect(app.ingest(input())).rejects.toThrow(); expect((await admin.pool.query('SELECT count(*)::int AS n FROM life_events')).rows[0].n).toBe(0); }
    finally { await admin.pool.query('DROP TRIGGER fail_job ON life_jobs; DROP FUNCTION fail_job()'); }
  });
  it('stores invalid JSONB characters safely without blocking later inputs', async () => {
    await app.ingest({ ...input('invalid'), payload: { text: 'a\0b\uD800' } }); await app.ingest(input('next'));
    const row=(await admin.pool.query("SELECT payload FROM life_events WHERE dedup_key='invalid'")).rows[0];
    expect(row.payload.text).toBe('a\uFFFDb\uFFFD'); expect((await claim()).payload).toEqual({text:'a\uFFFDb\uFFFD'});
  });
  it('uses leases and keeps each conversation serial across concurrent workers', async () => {
    await app.ingest(input('a1','a')); await app.ingest(input('a2','a')); await app.ingest(input('b1','b'));
    const jobs = (await Promise.all([claim(),claim(),claim(),claim()])).filter(Boolean);
    expect(jobs).toHaveLength(2); expect(new Set(jobs.map(j => j.conversation)).size).toBe(2);
    const a = jobs.find(j => j.conversation === 'a')!; await app.complete(a);
    const next = await claim(); expect(next.conversation).toBe('a'); expect(next.id).not.toBe(a.id);
  });
  it('fences an expired owner from producing answers or sending', async () => {
    await app.ingest(input()); const old = await app.claim(randomUUID(), 50); await new Promise(r => setTimeout(r, 75));
    const replacement = await claim(); expect(replacement.id).toBe(old!.id);
    await expect(app.prepare(old!, 'stale')).rejects.toBeInstanceOf(LeaseLost);
    await expect(app.heartbeat(old!)).rejects.toBeInstanceOf(LeaseLost);
    await app.prepare(replacement, 'new'); expect((await app.outbox(replacement))[0]!.payload.text).toBe('new');
  });
  it('retains a completed answer and pending sends across database-client restarts', async () => {
    await app.ingest(input()); const first = await app.claim(randomUUID(), 50);
    await app.prepare(first!, 'already generated'); await new Promise(r => setTimeout(r, 75));
    const restarted = new Ledger({ ...databaseConfig(configFile!.replace('admin.json','app.json')), database: dbName });
    try { const second = (await restarted.claim(randomUUID()))!; expect(second.phase).toBe('ready'); expect((await restarted.outbox(second))[0]!.payload.text).toBe('already generated'); }
    finally { await restarted.close(); }
  });
  it('does not resend a dispatch interrupted by an actual killed worker process', async () => {
    await app.ingest(input());
    const raw = JSON.parse(readFileSync(testConfig,'utf8'));
    writeFileSync(testConfig.replace('admin.json','app.json'), JSON.stringify({ ...raw, user: 'life_app', passwordFile: raw.passwordFile.replace('pg-admin-password','pg-app-password') }), { mode: 0o600 });
    const child = spawn(process.execPath, ['--input-type=module','-e', `
      import { Ledger, databaseConfig } from './dist/index.js';
      import { randomUUID } from 'node:crypto';
      const l=new Ledger({...databaseConfig(process.argv[1]),database:process.argv[2]});
      const j=await l.claim(randomUUID(),300); await l.prepare(j,'crash boundary');
      await l.dispatch(j,(await l.outbox(j))[0].id); process.stdout.write('READY\\n');
      setInterval(()=>{},1000);
    `, testConfig.replace('admin.json','app.json'), dbName], { stdio: ['ignore','pipe','pipe'] });
    // Store only a pointer to the existing secret file in this fixture config.
    await new Promise<void>((resolve,reject) => {
      const timer=setTimeout(()=>reject(Error('child_timeout')),5000);
      child.stdout.on('data',data=>{ if(String(data).includes('READY')) {clearTimeout(timer);resolve();} });
      child.on('exit',code=>{if(code) {clearTimeout(timer);reject(Error('child_failed'));}});
    });
    child.kill('SIGKILL'); await new Promise<void>(r=>child.on('exit',()=>r())); await new Promise(r=>setTimeout(r,350));
    const recovered = await claim(); const out = await app.outbox(recovered);
    expect(out[0]!.status).toBe('unknown'); expect(await app.dispatch(recovered,out[0]!.id)).toBe(false); await app.complete(recovered);
  });
  it('does not duplicate already confirmed chunks after partial completion', async () => {
    await app.ingest(input()); const j=await app.claim(randomUUID(),100); await app.prepare(j!,'x'.repeat(2500));
    const out=await app.outbox(j!); await app.dispatch(j!,out[0]!.id); await app.delivered(j!,out[0]!.id,'confirmed','platform-id');
    await new Promise(r=>setTimeout(r,125)); const recovered=await claim();
    expect((await app.outbox(recovered)).map(o=>o.status)).toEqual(['confirmed','pending']);
  });
  it('enforces hourly budgets atomically and makes retry reservations idempotent', async () => {
    const results=await Promise.all(Array.from({length:8},(_,n)=>app.reserve('a',String(n),3)));
    expect(results.filter(Boolean)).toHaveLength(3);
    const token=results.findIndex(Boolean); expect(await app.reserve('a',String(token),3)).toBe(true);
    expect(await app.reserve('b','other',3)).toBe(true);
  });
  it('imports existing session/seen data only once without re-enqueuing historical messages', async () => {
    await app.importLegacy({ seen:['s'],sessions:{c:'session1'},paused:true,rates:{} });
    expect(await app.ingest(input('onebot:s'))).toBe(false); expect(await app.paused()).toBe(true); expect((await app.session('onebot:c')).id).toBe('session1');
    await app.pause(false); await app.importLegacy({seen:[],sessions:{},paused:true,rates:{}}); expect(await app.paused()).toBe(false);
  });
  it('shares external request quotas across groups and client restarts, including rolling daily limits',async()=>{
    await app.ingest(input('ext-a','a'));await app.ingest(input('ext-b','b'));const a=await claim(),b=await claim();
    const limits={hour:3,day:4};
    const first=await Promise.all(Array.from({length:6},(_,n)=>app.reserveExternal(n%2?a:b,'external:web','request-'+n,limits)));
    expect(first.filter(Boolean)).toHaveLength(3);
    await admin.pool.query("UPDATE life_rates SET at=now()-interval '2 hours' WHERE bucket='external:web'");
    const restarted=new Ledger({...databaseConfig(configFile!.replace('admin.json','app.json')),database:dbName});
    try{
      expect(await restarted.reserveExternal(a,'external:web','fourth',limits)).toBe(true);
      expect(await restarted.reserveExternal(b,'external:web','fifth',limits)).toBe(false);
      expect(await restarted.reserveExternal(a,'external:web','fourth',limits)).toBe(false);
    }finally{await restarted.close();}
  });
  it('blocks external reservations on pause or a lost lease',async()=>{
    await app.ingest(input());const job=await claim();await app.pause(true);
    expect(await app.reserveExternal(job,'external:web','paused',{hour:2,day:3})).toBe(false);
    await app.pause(false);await admin.pool.query("UPDATE life_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[job.id]);
    await expect(app.reserveExternal(job,'external:web','expired',{hour:2,day:3})).rejects.toBeInstanceOf(LeaseLost);
    expect((await admin.pool.query("SELECT count(*)::int AS n FROM life_rates WHERE bucket='external:web'")).rows[0].n).toBe(0);
  });
  it('keeps runtime events immutable and prevents runtime schema/role escalation', async () => {
    await app.ingest(input());
    await expect(app.pool.query("UPDATE life_events SET payload='{}'")).rejects.toThrow();
    await expect(app.pool.query('DELETE FROM life_events')).rejects.toThrow();
    await expect(app.pool.query('CREATE TABLE intrusion(id int)')).rejects.toThrow();
    await expect(app.pool.query('SET ROLE life_admin')).rejects.toThrow();
  });
  it('reapplies runtime session-link permissions when migrating an ACL-free restore',async()=>{
    await admin.pool.query('REVOKE INSERT ON life_session_links FROM life_app');
    const raw=JSON.parse(readFileSync(testConfig,'utf8'));
    const r=spawnSync(process.execPath,['dist/admin.js','migrate','--config',testConfig,'--app-password-file',raw.passwordFile.replace('pg-admin-password','pg-app-password')],{encoding:'utf8'});
    expect(r.status,r.stderr).toBe(0);await app.ingest(input());const j=await claim();await app.setSession(j,'restored-session');expect((await app.session(j.conversation)).id).toBe('restored-session');
  });
  it('reports scoped token usage without mixing cache hits or exposing a credential',async()=>{
    await app.ingest(input('usage','a'));const j=await claim();
    await app.capture({key:'usage1',conversation:'a',cause:j.id,kind:'model.usage',payload:{provider:'p',model:'m',credentialLabel:'qqbot-independent',usage:{inputTokens:10,cacheReadTokens:100,outputTokens:5,totalTokens:115}}});
    await app.append(j,'web.requested',{operation:'web_search',requestId:'test-web'});
    await app.append(j,'web.completed',{operation:'web_search',requestId:'test-web',ok:true,producedResult:true});
    const r=spawnSync(process.execPath,['dist/admin.js','usage','--config',testConfig,'--conversation','a'],{encoding:'utf8'});
    expect(r.status,r.stderr).toBe(0);const result=JSON.parse(r.stdout);expect(result.rows[0]).toMatchObject({uncachedInputTokens:'10',cacheReadTokens:'100',outputTokens:'5',reportedTotalTokens:'115'});expect(result.currencyCost).toBe('not_calculated');
    expect(result.webRequests).toEqual([{operation:'web_search',reserved:1,succeeded:1,nonempty:1,failed:0}]);
  });
  it('exports only the selected scope with restrictive file permissions', async () => {
    await app.ingest(input('a','a')); await app.ingest(input('b','b'));
    const output=join(root,'export.json');
    const r=spawnSync(process.execPath,['dist/admin.js','export','--config',testConfig,'--conversation','a','--output',output],{encoding:'utf8'});
    expect(r.status,r.stderr).toBe(0); const data=JSON.parse(readFileSync(output,'utf8'));
    expect(data.events.map((e:any)=>e.conversation)).toEqual(['a']); expect(statSync(output).mode&0o777).toBe(0o600);
  });
  it('orders original images by receipt, ignores quote repeats, future images and other scopes',async()=>{
    const store=async(key:string,scope:string,hash:string,role:string)=>{
      await app.ingest(input(key,scope));const j=await claim();await app.linkMedia(j,[{hash:hash.repeat(64),path:'/media/'+key,bytes:1,mime:'image/png',role}]);await app.complete(j);return j;
    };
    await store('pixel','a','a','message:0');await store('cup','a','b','message:0');await store('quoted-pixel','a','a','quote:pixel:0');await store('private','b','c','message:0');
    await app.ingest(input('question','a'));const question=await claim();await store('future','b','d','message:0');
    expect((await app.recentMedia(question)).map(m=>m.hash)).toEqual(['a'.repeat(64),'b'.repeat(64)]);
    expect((await app.recentMedia(question,1)).map(m=>m.hash)).toEqual(['b'.repeat(64)]);
  });
  it('does not recall images from before a reset even when inputs were ingested in a batch',async()=>{
    await app.ingest(input('picture','a'));const picture=await claim();await app.linkMedia(picture,[{hash:'a'.repeat(64),path:'/media/picture',bytes:1,mime:'image/png',role:'message'}]);await app.complete(picture);
    await app.ingest(input('reset','a'));await app.ingest(input('after-reset','a'));
    const reset=await claim();await app.setSession(reset,null,true);await app.complete(reset);
    const question=await claim();expect(await app.recentMedia(question)).toEqual([]);
  });
  it('restores bounded observed history and attention decisions without crossing scope, reset or receipt order',async()=>{
    const store=async(key:string,scope:string,body:string,quiet=true)=>{
      await app.ingest(input(key,scope));const j=await claim();await app.append(j,'inbound.normalized',{body});
      await app.append(j,'attention.decided',{mode:'attention',decision:{action:quiet?'observe':'speak'}},j.id+':decision');
      if(!quiet){await app.prepare(j,'answer');const out=(await app.outbox(j))[0]!;await app.dispatch(j,out.id);await app.delivered(j,out.id,'confirmed','receipt');}
      await app.complete(j,quiet?'skipped':'done');return j;
    };
    await store('old','a','before reset');await app.ingest(input('reset','a'));const reset=await claim();await app.setSession(reset,null,true);await app.complete(reset);
    await store('observed','a','unanswered statement');await store('elsewhere','b','private group data');
    const spoken=await store('spoken','a','question',false);
    await app.ingest(input('anchor','a'));const anchor=await claim();await store('future','b','future');
    const context=await app.conversationContext(anchor);
    expect(context.messages.map(m=>m.body)).toEqual(['unanswered statement','question']);expect(context.lastSpokenAt).toBeTruthy();
    expect(context.botReplies.map(r=>r.body)).toEqual(['answer']);expect(JSON.stringify(context.botReplies)).not.toContain('private group data');
    expect(await app.derived(spoken,'attention.decided')).toEqual({mode:'attention',decision:{action:'speak'}});
    expect(await app.derived({...spoken,conversation:'b'},'attention.decided')).toBeUndefined();
    await app.complete(anchor);
    for(let n=0;n<10;n++)await store('limit'+n,'a','z'.repeat(900));
    await app.ingest(input('bounded','a'));const bounded=await claim();const history=await app.conversationContext(bounded);
    expect(history.messages).toHaveLength(8);expect(history.messages.every(m=>m.body.length===700)).toBe(true);
  });
  it('deletes scoped data and sessions while retaining media shared by another scope', async () => {
    await app.ingest(input('a','a')); await app.ingest(input('b','b')); const a=await claim(), b=await claim();
    const ref={hash:'a'.repeat(64),path:'/test/shared.png',bytes:2,mime:'image/png',role:'message'};
    await app.linkMedia(a,[ref]); await app.linkMedia(b,[ref]); await app.setSession(a,'session-a'); await app.complete(a); await app.complete(b); await app.pause(true);
    const r=spawnSync(process.execPath,['dist/admin.js','delete','--config',testConfig,'--conversation','a'],{encoding:'utf8'});
    expect(r.status,r.stderr).toBe(0); const result=JSON.parse(r.stdout); expect(result.sessions).toEqual(['session-a']); expect(result.orphanPaths).toEqual([]);
    expect((await admin.pool.query("SELECT * FROM life_events WHERE conversation='a'")).rowCount).toBe(0);
    expect((await admin.pool.query("SELECT * FROM life_events WHERE conversation='b'")).rowCount).toBeGreaterThan(0);
    expect((await app.session('a')).id).toBeNull();
  });
});

describe('durable local handoff',()=>{
  it('survives a failed database commit and replays in receive order without replacing duplicates',async()=>{
    const root=mkdtempSync(join(tmpdir(),'life-spool-')); const s=new Spool<{key:string;body:string}>(root);
    try {
      s.put({key:'z',body:'first'});s.put({key:'a',body:'second'});s.put({key:'z',body:'duplicate'});
      await expect(s.drain(async()=>{throw Error('database_down');})).rejects.toThrow(); expect(s.count()).toBe(2);
      const values:string[]=[];await new Spool<{key:string;body:string}>(root).drain(async v=>{values.push(v.body);});
      expect(values).toEqual(['first','second']);expect(s.count()).toBe(0);
    } finally {rmSync(root,{recursive:true,force:true});}
  });
});
