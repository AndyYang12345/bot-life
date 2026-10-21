import {describe,it,expect,vi} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BiliClient,BiliReader,biliTools,biliToolNames} from '../src/bilibili.js';
import {textLinks,sharedLink} from '../src/cards.js';
import {ImageToolGuard} from '../src/safety.js';

const job={id:'j',conversation:'trusted',owner:'w',phase:'generating' as const,attempts:1,payload:{}};
const signal=()=>new AbortController().signal;
const setup=()=>{
  const client={call:vi.fn().mockResolvedValue({ok:true,result:{coverage:'metadata_only'},error:null})};
  const ledger={withJob:vi.fn().mockImplementation(async(_j,fn)=>fn()),reserve:vi.fn().mockResolvedValue(true),append:vi.fn()};
  return {client,ledger,reader:new BiliReader(client,ledger)};
};
describe('Bilibili scoped reads',()=>{
  it('preserves ?p= and identifies bare BV without duplicating a URL',()=>{
    const url='https://www.bilibili.com/video/BV1xx411c7mD?p=2&share=qq';
    expect(textLinks(url+' BV1xx411c7mD')).toEqual([{platform:'bilibili',videoId:'BV1xx411c7mD',url:'https://www.bilibili.com/video/BV1xx411c7mD?p=2'}]);
    expect(sharedLink(url+'&p=3')).toBeUndefined();
  });
  it('requires an active job, rejects model config overrides and bounds calls',async()=>{
    const {client,ledger,reader}=setup();let active:typeof job|undefined;
    const tool=biliTools(reader,()=>active)[0]!;
    const execution={signal:signal(),callId:'a'} as any;
    expect(await tool.execute({target:'BV1xx411c7mD'},execution)).toMatchObject({error:'no_active_turn'});active=job;
    expect(await tool.execute({target:'BV1xx411c7mD',credentials:'evil'},execution)).toMatchObject({error:'unknown_bilibili_argument'});
    for(let i=0;i<6;i++)expect(await reader.read(job,'bili_video_info',{target:'BV1xx411c7mD'},signal())).toMatchObject({ok:true});
    expect(await reader.read(job,'bili_video_info',{target:'BV1xx411c7mD'},signal())).toMatchObject({error:'bilibili_turn_budget'});
    expect(client.call).toHaveBeenCalledTimes(6);expect(ledger.reserve.mock.calls[0]?.[0]).toBe('trusted:bilibili');
  });
  it('stops on exhausted hourly budget or revoked lease and rechecks after network',async()=>{
    const {client,ledger,reader}=setup();ledger.reserve.mockResolvedValueOnce(false);
    expect(await reader.read(job,'bili_video_info',{target:'BV1xx411c7mD'},signal())).toMatchObject({error:'bilibili_hour_budget'});expect(client.call).not.toHaveBeenCalled();
    ledger.withJob.mockRejectedValueOnce(Error('PRIVATE_SQL'));
    expect(await reader.read(job,'bili_video_info',{target:'BV1xx411c7mD'},signal())).toMatchObject({error:'bilibili_read_unavailable'});expect(client.call).not.toHaveBeenCalled();
    ledger.withJob.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error('lost'));
    expect(await reader.read(job,'bili_video_info',{target:'BV1xx411c7mD'},signal())).toMatchObject({error:'bilibili_read_unavailable'});expect(ledger.append).not.toHaveBeenCalled();
  });
  it('previews only the first shared Bilibili link with the same call budget',async()=>{
    const {client,reader}=setup();const context=await reader.preview(job,[{platform:'web',url:'https://example.com'},{platform:'bilibili',url:'first'},{platform:'bilibili',url:'second'}],signal());
    expect(client.call.mock.calls.map(c=>c.slice(0,2))).toEqual([['bili_video_info',{target:'first'}],['bili_subtitle',{target:'first'}]]);expect(context).toContain('不可信');
    const controller=new AbortController();controller.abort();expect(await reader.read(job,'bili_search',{keyword:'a'},controller.signal)).toMatchObject({error:'cancelled'});
  });
  it('publishes verified preview images to the active job and removes base64 from model results',async()=>{
    const {client,ledger}=setup(),publish=vi.fn(async(_job,frames)=>frames.map((f:any)=>({at:f.at,path:'/sandbox/frame.jpg'})));
    client.call.mockResolvedValueOnce({ok:true,result:{coverage:'six_sampled_frames_not_full_video_or_audio',frames:Array.from({length:6},(_,n)=>({at:n,jpeg_base64:'/9j/'}))} as any,error:null});
    const reader=new BiliReader(client,ledger,40,publish),result=await reader.read(job,'bili_video_preview',{target:'BV1xx411c7mD'},signal());
    expect(result.ok).toBe(true);expect(JSON.stringify(result)).not.toContain('jpeg_base64');expect((result.result as any).frames).toHaveLength(6);expect((result.result as any).frames[0]).toEqual({at:0,path:'/sandbox/frame.jpg'});expect(publish.mock.calls[0]?.[0]).toEqual(job);
    client.call.mockResolvedValueOnce({ok:true,result:{frames:[{path:'/etc/passwd'}]} as any,error:null});
    expect(await reader.read(job,'bili_video_preview',{target:'BV1xx411c7mD'},signal())).toMatchObject({error:'bilibili_invalid_frames'});expect(publish).toHaveBeenCalledOnce();
  });
  it('extends the image allowlist without resetting the image read budget or allowing outside files',()=>{
    const temp=mkdtempSync(join(tmpdir(),'bili-frame-guard-')),a=join(temp,'a.jpg'),b=join(temp,'b.jpg');
    writeFileSync(a,'image');writeFileSync(b,'image');
    try{
      const guard=new ImageToolGuard(temp,1);guard.reset([a]);expect(guard.check('read_image',{file_path:a})).toBeUndefined();
      guard.extend([b,'/etc/passwd']);expect(guard.check('read_image',{file_path:b})).toContain('budget');expect(guard.check('read_image',{file_path:'/etc/passwd'})).toContain('outside');
    }finally{rmSync(temp,{recursive:true,force:true});}
  });
  it('uses a real subprocess MCP handshake, rejects extra tools and does not inherit API keys',async()=>{
    const temp=mkdtempSync(join(tmpdir(),'bili-mcp-test-')),server=join(temp,'server.mjs');
    writeFileSync(server,`import readline from 'node:readline';
      for await(const line of readline.createInterface({input:process.stdin})){
        const p=JSON.parse(line);if(p.id===undefined)continue;
        let result=p.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fixture',version:'1'}}:
          p.method==='tools/list'?{tools:${JSON.stringify(biliToolNames)}.map(name=>({name}))}:
          {structuredContent:{ok:true,result:{hasKey:!!process.env.DEEPSEEK_API_KEY,hasCookie:!!process.env.SESSDATA},error:null}};
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:p.id,result})+'\\n');
      }`);
    const client=new BiliClient({enabled:true,python:process.execPath,server,credentials:join(temp,'private.json')},1000);
    vi.stubEnv('DEEPSEEK_API_KEY','PRIVATE');vi.stubEnv('SESSDATA','PRIVATE_COOKIE');
    try{
      expect(await client.call('bili_search',{keyword:'x'},signal())).toMatchObject({ok:true,result:{hasKey:false,hasCookie:false}});
      client.close();writeFileSync(server,readFixture(server));
      expect(await client.call('bili_search',{keyword:'x'},signal())).toMatchObject({error:'bilibili_inventory_rejected'});
    }finally{client.close();vi.unstubAllEnvs();rmSync(temp,{recursive:true,force:true});}
  });
  it('kills a stalled MCP and supports a new process after cancellation or timeout',async()=>{
    const temp=mkdtempSync(join(tmpdir(),'bili-mcp-stall-')),server=join(temp,'stall.mjs');
    writeFileSync(server,'process.stdin.resume();');
    const client=new BiliClient({enabled:true,python:process.execPath,server,credentials:join(temp,'private.json')},150);
    try{
      expect(await client.call('bili_search',{keyword:'x'},signal())).toMatchObject({error:'bilibili_timeout'});
      const controller=new AbortController();const call=client.call('bili_search',{keyword:'x'},controller.signal);
      setTimeout(()=>controller.abort(),20);expect(await call).toMatchObject({error:'cancelled'});
      expect(await client.call('bili_search',{keyword:'x'},signal())).toMatchObject({error:'bilibili_timeout'});
    }finally{client.close();rmSync(temp,{recursive:true,force:true});}
  });
});
import {readFileSync} from 'node:fs';
function readFixture(path:string){return readFileSync(path,'utf8').replace(JSON.stringify(biliToolNames),JSON.stringify([...biliToolNames,'bili_upload']));}
