import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
import {Ledger,databaseConfig,habitSettings} from '@local/qqbot-life';
import type {Policy} from './types.js';
import {OneBotClient} from './client.js';
import {attentionJudgeLimit} from './attention.js';

export function messageText(payload:any):string{
  if(typeof payload.text==='string')return payload.text;
  if(typeof payload.message==='string')return payload.message;
  return Array.isArray(payload.message)?payload.message.map((s:any)=>{
    if(s.type==='text')return String(s.data?.text??'');
    if(s.type==='at')return String(s.data?.qq)===String(payload.self_id)?'@奶鲸 ':'@成员 ';
    return ({reply:'[引用消息] ',image:'[图片] ',video:'[视频] ',forward:'[合并转发] ',json:'[分享卡片] ',record:'[语音] ',file:'[文件] '} as Record<string,string>)[s.type]??'[附件] ';
  }).join('').trim():'';
}
const traceKinds=new Set(['inbound.normalizing','inbound.normalized','job.claimed','attention.match_started','attention.matched','attention.embedding_started','attention.embedding_completed',
  'attention.recalled','attention.recall_throttled','attention.judge_started','attention.decided','attention.judge_failed','attention.skipped','turn.started','assistant.output','turn.failure',
  'bilibili.read','web.requested','web.completed','outbound.dispatching','outbound.confirmed','outbound.failed','outbound.unknown','outbound.cancelled','job.done','job.skipped','job.failed','job.retry','model.usage','model.usage_unavailable','habit.saved','habit.revoked']);
export function publicTrace(kind:string,payload:any):Record<string,unknown>{
  const keys=['reason','error','mode','decision','kind','alias','aliases','positive','negative','context','elapsedMs','device','model','tool','ok','operation','usage','purpose','provider','setting','value','scope','revision'];
  const value:Record<string,unknown>={};for(const k of keys)if(payload?.[k]!==undefined)value[k]=payload[k];
  if(kind==='inbound.normalized')for(const k of ['images','videos','forwards','forwardNodes','truncated','mediaFailures','mediaErrors'])if(payload?.[k]!==undefined)value[k]=payload[k];
  return value;
}
export function permittedRequest(host:string|undefined,origin:string|undefined,fetchSite:string|undefined,port:number):boolean{
  const hosts=[`127.0.0.1:${port}`,`localhost:${port}`];
  return !!host&&hosts.includes(host)&&(!origin||origin===`http://${host}`)&&fetchSite!=='cross-site';
}
export async function startMonitor(policyFile:string,port=6100){
  if(!Number.isSafeInteger(port)||port<1024||port>65535)throw Error('invalid_monitor_port');
  const policy=()=>JSON.parse(readFileSync(policyFile,'utf8')) as Policy;
  const initial=policy(),ledger=new Ledger(databaseConfig(initial.databaseConfigFile)),root=fileURLToPath(new URL('../../monitor-web/',import.meta.url));
  const allowed=()=>{const p=policy();return [...p.allowedGroupIds.map(id=>`onebot:${p.expectedSelfId}:group:${id}`),...p.allowedPrivateIds.map(id=>`onebot:${p.expectedSelfId}:private:${id}`)];};
  const groupNames=new Map<string,string>();let lastNames=0;
  async function names(){
    if(Date.now()-lastNames<120000)return;lastNames=Date.now();
    try{const p=policy(),local=JSON.parse(readFileSync(p.onebotConfigFile,'utf8')),http=local.network.httpServers.find((x:any)=>x.enable),ws=local.network.websocketServers.find((x:any)=>x.enable);
      const client=new OneBotClient(p.httpUrl,p.wsUrl,http.token,ws.token),rows=await client.api<any[]>('get_group_list');
      for(const r of rows)groupNames.set(String(r.group_id),String(r.group_name));
    }catch{/* Database monitoring remains available while QQ is offline. */}
  }
  const health=()=>{try{const raw=JSON.parse(readFileSync(join(policy().stateDir,'health.json'),'utf8'));return Object.fromEntries(['connected','qqOnline','database','embeddingState','embeddingDevice','recallEnabled','startedAt','updatedAt','failed'].map(k=>[k,raw[k]]));}catch{return {connected:false,qqOnline:false,database:false};}};
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const json=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    if(!permittedRequest(req.headers.host,req.headers.origin,req.headers['sec-fetch-site'] as string|undefined,port)){json(403,{error:'local_same_origin_required'});return;}
    if(req.method!=='GET'){json(405,{error:'monitor_is_read_only'});return;}
    try{
      const url=new URL(req.url??'/',`http://127.0.0.1:${port}`),p=policy(),scopes=allowed();
      const files:Record<string,[string,string]>={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css']};
      if(files[url.pathname]){const [file,mime]=files[url.pathname]!;res.writeHead(200,{'Content-Type':mime+'; charset=utf-8'});res.end(readFileSync(join(root,file)));return;}
      if(url.pathname==='/api/overview'){
        await names();
        const rows=(await ledger.pool.query(`SELECT c.key,(SELECT count(*)::int FROM life_jobs j WHERE j.conversation=c.key) AS messages,
          (SELECT count(*)::int FROM life_jobs j WHERE j.conversation=c.key AND j.status IN ('pending','running')) AS pending,
          (SELECT max(recorded_at) FROM life_events e WHERE e.conversation=c.key) AS updated FROM life_conversations c WHERE key=ANY($1::text[])`,[scopes])).rows;
        const base=(await ledger.pool.query("SELECT setting,value,revision,updated_at FROM life_habits WHERE realm=$1 AND scope='global' AND status='active' ORDER BY setting",['onebot:'+p.expectedSelfId])).rows;
        const settings=base.map(r=>({...r,behavior:(habitSettings[r.setting as keyof typeof habitSettings] as Record<string,string>)?.[r.value]??''}));
        const tasks=(await ledger.pool.query("SELECT status,count(*)::int AS count FROM life_memory_tasks WHERE conversation=ANY($1::text[]) GROUP BY status",[scopes])).rows;
        json(200,{health:health(),groups:scopes.map((key,index)=>{const r=rows.find(r=>r.key===key);return {key,name:groupNames.get(key.split(':').at(-1)!)??`会话 ${index+1}`,messages:r?.messages??0,pending:r?.pending??0,updated:r?.updated};}),
          self:{unified:p.habits?.unifiedPersona===true,settings},tasks,budgets:{shared:p.maxPerHour,judge:attentionJudgeLimit(p.maxPerHour),recall:p.attention?.recall?.maxPerHour??6},at:new Date().toISOString()});return;
      }
      const conversation=url.searchParams.get('conversation');if(!conversation||!scopes.includes(conversation)){json(404,{error:'conversation_not_allowed'});return;}
      if(url.pathname==='/api/messages'){
        const before=url.searchParams.get('before');if(before&&!/^\d{1,18}$/.test(before)){json(400,{error:'invalid_cursor'});return;}
        const rows=(await ledger.pool.query(`SELECT e.id,e.seq::text,e.actor,e.occurred_at,e.recorded_at,e.payload,j.status,j.phase,j.error,
          (SELECT payload->'decision' FROM life_events d WHERE cause=e.id AND kind='attention.decided' ORDER BY seq DESC LIMIT 1) AS decision,
          (SELECT payload->>'reason' FROM life_events d WHERE cause=e.id AND kind='attention.skipped' ORDER BY seq DESC LIMIT 1) AS skipped,
          (SELECT left(payload->>'body',3600) FROM life_events d WHERE cause=e.id AND kind='inbound.normalized' ORDER BY seq DESC LIMIT 1) AS "normalizedBody",
          (SELECT json_agg(json_build_object('id',o.id,'text',o.payload->>'text','status',o.status,'at',o.updated_at) ORDER BY o.part) FROM life_outbox o WHERE o.job_id=e.id) AS replies
          FROM life_events e JOIN life_jobs j ON j.id=e.id WHERE e.conversation=$1 AND e.kind='inbound.message'
          AND ($2::bigint IS NULL OR e.seq<$2) ORDER BY e.seq DESC LIMIT 60`,[conversation,before??null])).rows;
        const rates=Number((await ledger.pool.query("SELECT count(*) AS n FROM life_rates WHERE bucket=$1 AND at>now()-interval '1 hour'",[conversation+':turns'])).rows[0].n);
        json(200,{messages:rows.reverse().map(r=>({id:r.id,seq:r.seq,sender:String(r.payload.sender?.card||r.payload.sender?.nickname||'成员'),owner:p.ownerIds.includes(r.actor),text:messageText(r.payload),at:r.occurred_at??r.recorded_at,
          status:r.status,phase:r.phase,error:r.error,decision:r.decision,skipped:r.skipped,normalizedBody:r.normalizedBody,replies:r.replies??[]})),budgetUsed:rates});return;
      }
      if(url.pathname==='/api/trace'){
        const id=url.searchParams.get('id');if(!id||!/^[a-f0-9-]{36}$/i.test(id)){json(400,{error:'invalid_event_id'});return;}
        const source=(await ledger.pool.query('SELECT e.id,j.status,j.phase,j.error FROM life_events e JOIN life_jobs j ON j.id=e.id WHERE e.id=$1 AND e.conversation=$2',[id,conversation])).rows[0];
        if(!source){json(404,{error:'message_not_found'});return;}
        const rows=(await ledger.pool.query('SELECT kind,recorded_at,payload FROM life_events WHERE cause=$1 AND conversation=$2 ORDER BY seq LIMIT 250',[id,conversation])).rows;
        const trace=rows.filter(r=>traceKinds.has(r.kind)).map(r=>({kind:r.kind,at:r.recorded_at,data:publicTrace(r.kind,r.payload)}));
        const totals={input:0,cache:0,output:0,calls:0};for(const e of trace)if(e.kind==='model.usage'){const u=e.data.usage as any;totals.calls++;totals.input+=u?.inputTokens??0;totals.cache+=u?.cacheReadTokens??0;totals.output+=u?.outputTokens??0;}
        json(200,{source,events:trace,tokens:totals});return;
      }
      json(404,{error:'not_found'});
    }catch{json(503,{error:'monitor_temporarily_unavailable'});}
  });
  await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',done);});
  return {server,close:async()=>{await new Promise<void>(r=>server.close(()=>r()));await ledger.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const args=process.argv.slice(2),file=args[args.indexOf('--policy')+1],port=args.includes('--port')?Number(args[args.indexOf('--port')+1]):6100;
  if(!args.includes('--policy')||!file)throw Error('policy_required');
  startMonitor(file,port).then(app=>{const stop=()=>{void app.close().then(()=>process.exit(0));};process.once('SIGTERM',stop);process.once('SIGINT',stop);console.log('Local monitor ready.');})
    .catch(()=>{console.error('Local monitor failed to start.');process.exitCode=1;});
}
