import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

describe('startup readiness',()=>{
  const clean:(()=>Promise<void>|void)[]=[];
  afterEach(async()=>{for(const f of clean.reverse())await f();clean.length=0;});
  async function fixture(online:boolean,token='configured',account='100'){
    const root=mkdtempSync(join(tmpdir(),'onebot-ready-'));clean.push(()=>rmSync(root,{recursive:true,force:true}));
    const server=createServer((req,res)=>{
      if(req.headers.authorization!=='Bearer '+token){res.writeHead(403);res.end();return;}
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({retcode:0,data:req.url==='/get_status'?{online}:{user_id:account}}));
    });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));clean.push(()=>new Promise<void>(r=>server.close(()=>r())));
    const address=server.address();if(!address||typeof address==='string')throw Error();
    const config=join(root,'onebot.json');writeFileSync(config,JSON.stringify({network:{httpServers:[{enable:true,token:'configured'}]}}));
    const policy=join(root,'policy.json');writeFileSync(policy,JSON.stringify({httpUrl:'http://127.0.0.1:'+address.port,onebotConfigFile:config,stateDir:root,expectedSelfId:'100'}));return policy;
  }
  async function run(policy:string):Promise<{code:number|null;text:string}>{
    const child=spawn('python3',['../scripts/wait-onebot','--policy',policy,'--once']);let text='';child.stdout.on('data',x=>text+=x);
    return new Promise(r=>child.on('exit',code=>r({code,text})));
  }
  it('does not treat an available API as an online QQ account',async()=>{const r=await run(await fixture(false));expect(r.code).toBe(1);expect(r.text).toContain('waiting_qq_login');});
  it('requires both online state and the expected account',async()=>{const r=await run(await fixture(true));expect(r.code).toBe(0);expect(r.text).toContain('ready');});
  it('fails closed on authentication failure and account mismatch',async()=>{
    expect((await run(await fixture(true,'different'))).code).toBe(2);
    const r=await run(await fixture(true,'configured','999'));expect(r.code).toBe(2);expect(r.text).toContain('account_mismatch');
  });
});
