import {describe,it,expect,vi} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DeepSeekConsolidationModel,tokenUsage} from '../src/consolidation-model.js';
import {readWorkerConfig} from '../src/consolidation-worker.js';

const input={events:[{id:'fixture',text:'我喜欢乌龙茶，平时不加糖。',at:'2026-10-20T00:00:00Z'}],existing:[]};
describe('bounded background model client',()=>{
  it('uses the official JSON endpoint, disables thinking and exposes no tool or search capability',async()=>{
    const mock=vi.fn(async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"memories":[]}'}}],
      usage:{prompt_tokens:100,prompt_cache_hit_tokens:60,completion_tokens:10,total_tokens:110}})));
    const client=new DeepSeekConsolidationModel('deepseek-flash','fixture-private-key',{fetch:mock as typeof fetch,maxTokens:1200});
    const result=await client.extract(input);expect(result).toMatchObject({content:'{"memories":[]}',usage:{inputTokens:40,cacheReadTokens:60,outputTokens:10,totalTokens:110}});
    expect(mock.mock.calls[0]![0]).toBe('https://api.deepseek.com/chat/completions');
    const request=(mock.mock.calls[0] as unknown as [string,RequestInit])[1],body=JSON.parse(request.body as string);
    expect(request.redirect).toBe('error');expect(body).toMatchObject({model:'deepseek-flash',thinking:{type:'disabled'},max_tokens:1200,response_format:{type:'json_object'}});
    expect(body.tools).toBeUndefined();expect(body.messages[1].content).toBe(JSON.stringify(input));expect(JSON.stringify(body)).not.toContain('fixture-private-key');
  });
  it('preserves billing for incomplete/empty JSON so it cannot silently disappear from usage',async()=>{
    const mock=vi.fn(async()=>new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{"mem'}}],
      usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}})));
    expect(await new DeepSeekConsolidationModel('deepseek-flash','fixture-key',{fetch:mock as typeof fetch}).extract(input)).toEqual({content:'',usage:{inputTokens:20,cacheReadTokens:0,outputTokens:10,totalTokens:30}});
  });
  it('only requests evidence-based group language learning when that bounded input is explicitly enabled',async()=>{
    const mock=vi.fn(async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"memories":[],"styles":[]}'}}]})));
    const model=new DeepSeekConsolidationModel('deepseek-flash','fixture-key',{fetch:mock as typeof fetch});
    await model.extract({...input,style:{events:[{id:'fixture',speaker:'speaker_1',text:'短表达',at:'2026-10-21T00:00:00Z'}],existing:[]}});
    const body=JSON.parse((mock.mock.calls[0] as unknown as [string,RequestInit])[1].body as string);
    expect(body.messages[0].content).toContain('style.events');expect(body.messages[0].content).toContain('不同说话者');expect(body.tools).toBeUndefined();
  });
  it('does not reflect API error bodies or network credentials in errors',async()=>{
    const mock=vi.fn(async()=>new Response('private-error-body-secret',{status:401}));
    await expect(new DeepSeekConsolidationModel('deepseek-flash','fixture-key',{fetch:mock as typeof fetch}).extract(input)).rejects.toThrow('consolidation_http_401');
    const bad=vi.fn(async()=>{throw Error('Bearer private-credential');});
    await expect(new DeepSeekConsolidationModel('deepseek-flash','fixture-key',{fetch:bad as typeof fetch}).extract(input)).rejects.toThrow('consolidation_network_error');
  });
  it('caps input, streamed response size, output and provider/model selection',async()=>{
    const mock=vi.fn(async()=>new Response('x'.repeat(128001)));
    const client=new DeepSeekConsolidationModel('deepseek-flash','fixture-key',{fetch:mock as typeof fetch});
    await expect(client.extract(input)).rejects.toThrow('consolidation_response_too_large');
    await expect(client.extract({...input,events:[{...input.events[0]!,text:'x'.repeat(14000)}]})).rejects.toThrow('extraction_input_too_large');
    expect(()=>new DeepSeekConsolidationModel('unapproved','fixture-key')).toThrow();
    expect(()=>new DeepSeekConsolidationModel('deepseek-flash','fixture-key',{maxTokens:10000})).toThrow();
  });
  it('rejects missing, negative, non-integer and impossible cached token accounting',()=>{
    for(const value of [undefined,{prompt_tokens:1,completion_tokens:-1,total_tokens:0},{prompt_tokens:1.5,completion_tokens:1,total_tokens:2},
      {prompt_tokens:10,prompt_cache_hit_tokens:11,completion_tokens:1,total_tokens:11}])expect(tokenUsage(value)).toBeUndefined();
  });
  it('defaults to disabled and validates batching and budget configuration',()=>{
    const temp=mkdtempSync(join(tmpdir(),'worker-config-')),path=join(temp,'config.json');
    try{
      const base={policyFile:'/fixture/policy.json',healthFile:'/fixture/health.json'};
      writeFileSync(path,JSON.stringify(base));expect(readWorkerConfig(path)).toMatchObject({enabled:false,maxPerHour:2,maxPerDay:12,minMessages:3});
      for(const patch of [{maxPerHour:100},{maxPerDay:1},{minMessages:13},{maxAgeMs:-1},{enabled:'yes'},{policyFile:'relative'}]){
        writeFileSync(path,JSON.stringify({...base,...patch}));expect(()=>readWorkerConfig(path)).toThrow('invalid_worker_config');
      }
    }finally{rmSync(temp,{recursive:true,force:true});}
  });
});
