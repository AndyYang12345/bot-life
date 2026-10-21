import {spawn} from 'node:child_process';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,renameSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join} from 'node:path';
import {validAlias} from '@local/qqbot-life';
import {segments,textOf} from './inbound.js';
import type {MessageEvent} from './types.js';

export interface EmbeddingConfig {enabled:boolean;python:string;server:string;cacheDir:string;device?:'cpu'|'cuda';threshold?:number;margin?:number;contextThreshold?:number;timeoutMs?:number}
export interface RecallConfig {enabled:boolean;learning?:boolean;maxPerHour?:number;embedding?:EmbeddingConfig}
export interface RecallSignal {kind:'call'|'mention'|'semantic'|'none';alias?:string;positive?:number;negative?:number;context?:number;elapsedMs?:number;error?:string}
export function validateRecall(value:RecallConfig|undefined):void{
  if(value===undefined)return;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['enabled','learning','maxPerHour','embedding'].includes(k))||typeof value.enabled!=='boolean'
    ||value.learning!==undefined&&typeof value.learning!=='boolean'||value.maxPerHour!==undefined&&(!Number.isSafeInteger(value.maxPerHour)||value.maxPerHour<0||value.maxPerHour>40))throw Error('invalid_recall_config');
  const e=value.embedding;if(e===undefined)return;
  if(!e||typeof e!=='object'||Array.isArray(e)||typeof e.enabled!=='boolean'||Object.keys(e).some(k=>!['enabled','python','server','cacheDir','device','threshold','margin','contextThreshold','timeoutMs'].includes(k))
    ||!['python','server','cacheDir'].every(k=>typeof e[k as keyof EmbeddingConfig]==='string'&&isAbsolute(e[k as keyof EmbeddingConfig] as string))
    ||e.device!==undefined&&!['cpu','cuda'].includes(e.device)||e.timeoutMs!==undefined&&(!Number.isSafeInteger(e.timeoutMs)||e.timeoutMs<100||e.timeoutMs>10000)
    ||[e.threshold,e.margin,e.contextThreshold].some(n=>n!==undefined&&(typeof n!=='number'||!Number.isFinite(n)||n<0||n>1)))throw Error('invalid_embedding_config');
}
/** Match direct human text only. Literal aliases cannot inject regex or code. */
export function aliasSignal(event:MessageEvent,aliases:readonly string[]):RecallSignal{
  const parts=segments(event.message),at=parts.filter(s=>s.type==='at').map(s=>String(s.data.qq));
  if(at.some(id=>id!=='all'&&id!==String(event.self_id)))return {kind:'none'};
  const text=textOf(event.message).normalize('NFKC').toLowerCase().slice(0,600);
  if(!text||/^(?:>|["“「『`])/.test(text)||/(?:不用|不要|别).{0,4}(?:回复|回答|接话)/.test(text))return {kind:'none'};
  for(const alias of [...new Set(aliases)].filter(validAlias).sort((a,b)=>b.length-a.length)){
    if(!text.includes(alias))continue;
    const escaped=alias.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const vocative=new RegExp('^(?:(?:喂|嘿|诶|欸|请问)[,，!！、\\s]*)?'+escaped+'(?:[,，、:：!！?？\\s]+|(?:你|在吗|在不在|帮我|帮忙|能不能|可不可以|怎么看|怎么想|说句话|出来))');
    const thirdPerson=new RegExp(escaped+'[,，、:：!！?？\\s]*(?:刚才|昨天|今天|之前|上次|好像|居然|竟然|是不是|怎么又|说过|说了|的(?:回复|回答|功能))');
    if((text===alias||vocative.test(text))&&!thirdPerson.test(text))return {kind:'call',alias};
    // Substrings inside a Latin word are not addressing a short English alias.
    if(/^[a-z0-9_-]+$/.test(alias)&&!new RegExp('(?:^|[^a-z0-9_-])'+escaped+'(?:$|[^a-z0-9_-])').test(text))continue;
    return {kind:'mention',alias};
  }
  return {kind:'none'};
}
export function writeAliasSnapshot(stateDir:string,conversation:string,identity:string,state:{aliases:string[];version:string}):void{
  const folder=join(stateDir,'attention');mkdirSync(folder,{recursive:true,mode:0o700});
  const path=join(folder,createHash('sha256').update(conversation).digest('hex')+'.json');
  const tmp=path+'.tmp';writeFileSync(tmp,JSON.stringify({schema:1,identity,aliases:state.aliases,version:state.version,updatedAt:new Date().toISOString()}),{mode:0o600});renameSync(tmp,path);
}
type Scores={model:string;dimensions:number;device:string;positive:number;negative:number;context:number;elapsed_ms:number};
/** No socket, inherited credentials, remote endpoint, shell, or model download. */
export class LocalEmbedding {
  private child?:ChildProcessWithoutNullStreams;
  private pending=new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
  private warming?:Promise<void>;private retryAt=0;private stopped=false;
  state='not_started';
  constructor(private config:EmbeddingConfig){}
  private start():void{
    if(this.stopped||this.child)return;
    const c=spawn(this.config.python,[this.config.server,'--cache-dir',this.config.cacheDir,'--device',this.config.device??'cpu'],{
      cwd:dirname(this.config.server),env:{PATH:dirname(this.config.python)+':/usr/bin:/bin',LANG:'C.UTF-8',TZ:'Asia/Shanghai',HOME:dirname(this.config.cacheDir),
        HF_HUB_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1',TOKENIZERS_PARALLELISM:'false',PYTHONUNBUFFERED:'1'},stdio:'pipe'});
    this.child=c;
    const fail=()=>{
      if(this.child!==c)return;this.child=undefined;this.state='unavailable';this.retryAt=Date.now()+60000;
      for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('embedding_unavailable'));}this.pending.clear();
    };
    c.on('error',fail);c.on('exit',fail);c.stderr.on('data',()=>{});
    const lines=createInterface({input:c.stdout});
    lines.on('line',line=>{
      if(line.length>8000){c.kill();return;}
      try{const data=JSON.parse(line),p=this.pending.get(data.id);if(!p)return;this.pending.delete(data.id);clearTimeout(p.timer);
        if(data.ok&&data.result?.dimensions===512&&data.result?.model==='BAAI/bge-small-zh-v1.5')p.resolve(data.result);else p.reject(Error('embedding_invalid_response'));
      }catch{c.kill();}
    });
  }
  private request(value:Record<string,unknown>,timeout:number):Promise<any>{
    this.start();const c=this.child;if(!c)return Promise.reject(Error('embedding_unavailable'));
    if(this.pending.size>=2)return Promise.reject(Error('embedding_busy'));
    const id=randomUUID();return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('embedding_timeout'));c.kill();},timeout);
      this.pending.set(id,{resolve,reject,timer});c.stdin.write(JSON.stringify({...value,id})+'\n',error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(Error('embedding_unavailable'));}});
    });
  }
  async warmup():Promise<void>{
    if(this.state==='ready')return;if(this.warming)return this.warming;if(this.stopped||Date.now()<this.retryAt)throw Error('embedding_unavailable');
    this.state='loading';this.warming=this.request({ping:true},30000).then(()=>{this.state='ready';}).finally(()=>{this.warming=undefined;});return this.warming;
  }
  async recall(text:string,context:readonly string[]):Promise<RecallSignal>{
    if(!text.trim())return {kind:'none'};
    try{
      if(this.state!=='ready'){void this.warmup().catch(()=>{});return {kind:'none',error:'embedding_warming'};}
      const scores:Scores=await this.request({text:text.slice(0,600),context:context.slice(-2).map(s=>s.slice(0,800))},this.config.timeoutMs??1500);
      if(![scores.positive,scores.negative,scores.context,scores.elapsed_ms].every(Number.isFinite)||[scores.positive,scores.negative,scores.context].some(n=>n< -1.01||n>1.01))throw Error('embedding_invalid_scores');
      const relevant=scores.positive>=(this.config.threshold??0.64)&&scores.positive-scores.negative>=(this.config.margin??0.10)
        ||context.length>0&&scores.context>=(this.config.contextThreshold??0.70)&&scores.context-scores.negative>=(this.config.margin??0.10);
      return {kind:relevant?'semantic':'none',positive:scores.positive,negative:scores.negative,context:scores.context,elapsedMs:scores.elapsed_ms};
    }catch{return {kind:'none',error:'embedding_unavailable'};}
  }
  close():void{this.stopped=true;this.child?.kill();}
}
