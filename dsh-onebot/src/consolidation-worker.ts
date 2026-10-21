import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {Ledger,ConsolidationQueue,Consolidator,databaseConfig,MemoryError,LeaseLost} from '@local/qqbot-life';
import {DeepSeekConsolidationModel} from './consolidation-model.js';

interface WorkerConfig {
  enabled:boolean;policyFile:string;healthFile:string;pollMs:number;
  minMessages:number;maxMessages:number;maxAgeMs:number;maxPerHour:number;maxPerDay:number;maxOutputTokens:number;
}
export function readWorkerConfig(file:string):WorkerConfig{
  const raw=JSON.parse(readFileSync(file,'utf8'));
  const value:WorkerConfig={enabled:false,pollMs:30000,minMessages:3,maxMessages:12,maxAgeMs:300000,maxPerHour:2,maxPerDay:12,maxOutputTokens:1500,...raw};
  if(typeof value.enabled!=='boolean'||typeof value.policyFile!=='string'||typeof value.healthFile!=='string'
    ||![value.policyFile,value.healthFile].every(p=>p.startsWith('/')))throw Error('invalid_worker_config');
  for(const [key,min,max] of [['pollMs',1000,300000],['minMessages',1,12],['maxMessages',1,12],['maxAgeMs',0,3600000],
    ['maxPerHour',1,12],['maxPerDay',1,48],['maxOutputTokens',256,2000]] as const){
    if(!Number.isInteger(value[key])||value[key]<min||value[key]>max)throw Error('invalid_worker_config');
  }
  if(value.minMessages>value.maxMessages||value.maxPerHour>value.maxPerDay)throw Error('invalid_worker_config');
  return value;
}
function readPolicy(file:string){
  const p=JSON.parse(readFileSync(file,'utf8'));
  if(typeof p.enabled!=='boolean'||!Array.isArray(p.allowedGroupIds)||!p.allowedGroupIds.every((x:unknown)=>typeof x==='string'&&/^\d+$/.test(x))
    ||!Array.isArray(p.ownerIds)||!p.ownerIds.every((x:unknown)=>typeof x==='string')||!/^\d+$/.test(p.expectedSelfId)
    ||typeof p.databaseConfigFile!=='string'||p.provider!=='deepseek-official')throw Error('invalid_worker_policy');
  const scopes=p.allowedGroupIds.map((id:string)=>`onebot:${p.expectedSelfId}:group:${id}`);
  return {enabled:p.enabled&&p.memory?.enabled===true,scopes,ownerIds:p.ownerIds as string[],personalProfiles:p.memory?.personalProfiles===true,
    databaseFile:p.databaseConfigFile as string,model:p.model as string,styleLearning:p.conversationLearning?.enabled===true,
    attentionLearning:p.attention?.recall?.enabled===true&&p.attention?.recall?.learning===true,identityName:p.conversationLearning?.identityName??'奶鲸'};
}

export async function runWorker(configFile:string,once=false):Promise<void>{
  const initial=readWorkerConfig(configFile),policy=readPolicy(initial.policyFile);
  const ledger=new Ledger(databaseConfig(policy.databaseFile));
  const queue=new ConsolidationQueue(ledger),owner=randomUUID();
  const health:Record<string,unknown>={state:'starting',processed:0,failed:0,startedAt:new Date().toISOString()};
  let closing=false,sleepTimer:NodeJS.Timeout|undefined,wakeSleep:(()=>void)|undefined;
  const stop=()=>{closing=true;clearTimeout(sleepTimer);wakeSleep?.();};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  const write=(state:string,extra:Record<string,unknown>={})=>{
    Object.assign(health,{state,...extra,updatedAt:new Date().toISOString()});
    mkdirSync(dirname(initial.healthFile),{recursive:true,mode:0o700});
    writeFileSync(initial.healthFile,JSON.stringify(health),{mode:0o600});
  };
  try{
    await ledger.check();
    if(![5,6,7,8,9].includes((await ledger.pool.query('SELECT max(version) AS v FROM life_migrations')).rows[0].v))throw Error('consolidation_requires_schema_5_or_later');
    if(policy.styleLearning&&(await ledger.pool.query('SELECT max(version) AS v FROM life_migrations')).rows[0].v<6)throw Error('style_learning_requires_schema_6');
    do{
      let poll=30000;
      try{
        const config=readWorkerConfig(configFile),current=readPolicy(config.policyFile);poll=config.pollMs;
        if(config.policyFile!==initial.policyFile||config.healthFile!==initial.healthFile||current.databaseFile!==policy.databaseFile)throw Error('worker_restart_required');
        const paused=!!(await ledger.pool.query("SELECT key FROM life_settings WHERE key IN ('paused','memory_writes_paused','consolidation_paused') AND value='true'")).rowCount;
        if(!config.enabled||!current.enabled)write('disabled');
        else if(paused)write('paused');
        else{
          const task=await queue.claim(owner,current.scopes,{minMessages:config.minMessages,maxMessages:config.maxMessages,maxAgeMs:config.maxAgeMs,leaseMs:90000});
          if(!task)write('idle');
          else{
            write('processing',{lastError:null});let heartbeatError:unknown;
            const timer=setInterval(()=>{ledger.heartbeat(task.job,90000).catch(error=>{heartbeatError=error;});},20000);
            try{
              const model=new DeepSeekConsolidationModel(current.model,process.env.DEEPSEEK_API_KEY??'',{maxTokens:config.maxOutputTokens,timeoutMs:45000});
              const engine=new Consolidator(queue,{personalProfiles:current.personalProfiles,ownerIds:current.ownerIds,maxPerHour:config.maxPerHour,maxPerDay:config.maxPerDay,styleLearning:current.styleLearning,attentionLearning:current.attentionLearning,identityName:current.identityName});
              const result=await engine.run(task,model,async()=>{
                if(heartbeatError)throw heartbeatError;
                const updated=readWorkerConfig(configFile),p=readPolicy(updated.policyFile);
                return updated.enabled&&p.enabled&&p.databaseFile===policy.databaseFile&&p.scopes.includes(task.job.conversation)
                  &&p.personalProfiles===current.personalProfiles&&p.styleLearning===current.styleLearning&&p.attentionLearning===current.attentionLearning&&p.identityName===current.identityName&&JSON.stringify(p.ownerIds)===JSON.stringify(current.ownerIds);
              });
              health.processed=Number(health.processed)+1;write('idle',{lastResult:result,lastCompletedAt:new Date().toISOString()});
            }catch(error){
              const allowed=['model_budget','scope_disabled','memory_writes_paused','invalid_extraction','extraction_request_failed','input_budget_exceeded'];
              const raw=error instanceof MemoryError?error.code:error instanceof LeaseLost?'lease_lost':error instanceof Error?error.message:'';
              const code=allowed.includes(raw)||raw==='lease_lost'?raw:'consolidation_failed';
              await queue.fail(task,code);
              health.failed=Number(health.failed)+1;write(code==='model_budget'?'budget_wait':'waiting_retry',{lastError:code});
            }finally{clearInterval(timer);}
          }
        }
      }catch{write('error',{lastError:'worker_configuration_or_database_error'});}
      if(once||closing)break;
      await new Promise<void>(done=>{wakeSleep=done;sleepTimer=setTimeout(done,poll);});wakeSleep=undefined;
    }while(!closing);
  }finally{
    clearTimeout(sleepTimer);process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);
    await ledger.close();write('stopped');
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const index=process.argv.indexOf('--config'),file=index>=0?process.argv[index+1]:undefined;
  if(!file)throw Error('worker_config_required');
  runWorker(file,process.argv.includes('--once')).catch(()=>{console.error('Memory consolidation worker failed; inspect local configuration and health.');process.exitCode=1;});
}
