import {describe,it,expect,vi} from 'vitest';
import {DeepSeekWebClient,WebReader,WebReadError,webTools,publicAddress,publicWebUrl,validatePublicPage} from '../src/web.js';

const job={id:'job-a',conversation:'group-a',owner:'owner',phase:'generating' as const,attempts:1,payload:{}};
const signal=()=>new AbortController().signal;
const page={provider:'deepseek-tools' as const,coverage:'page_markdown' as const,url:'https://example.com/article',title:'Actual article',retrieved_at:'2026-10-21T00:00:00Z',content:'x'.repeat(1600),source_truncated:false};
const search={provider:'deepseek-tools' as const,coverage:'search_snippets' as const,retrieved_at:'2026-10-21T00:00:00Z',sources:[],truncated:false};
const setup=()=>{
  const client={search:vi.fn().mockResolvedValue(search),page:vi.fn().mockResolvedValue({...page})};
  const ledger={withJob:vi.fn().mockImplementation(async(_job,fn)=>fn()),reserveExternal:vi.fn().mockResolvedValue(true),append:vi.fn().mockResolvedValue('event'),paused:vi.fn().mockResolvedValue(false)};
  return {client,ledger,reader:new WebReader(client,ledger)};
};
describe('public web reads',()=>{
  it('rejects private, mapped, unusual numeric and credential-bearing destinations',async()=>{
    for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.0.1','192.0.2.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1'])expect(publicAddress(address),address).toBe(false);
    expect(publicAddress('8.8.8.8')).toBe(true);
    for(const url of ['file:///etc/passwd','http://2130706433/a','http://0x7f000001/a','http://[::ffff:7f00:1]/a','http://localhost/a','https://example.com:6099/a','https://u:p@example.com/a','https://example.com/?access_token=PRIVATE_SECRET_123','https://thing.local/a'])expect(()=>publicWebUrl(url),url).toThrow(WebReadError);
    const resolver=vi.fn().mockResolvedValue([{address:'8.8.8.8',family:4},{address:'10.1.0.1',family:4}]);
    await expect(validatePublicPage('https://example.com',signal(),resolver)).rejects.toThrow('web_private_address');
  });
  it('sends the dedicated key only to the fixed official API, not page origins',async()=>{
    const transport=vi.fn().mockResolvedValue(new Response(JSON.stringify({title:'Article',content:'Actual body'})));
    const client=new DeepSeekWebClient('PRIVATE_KEY',transport,async()=>[{address:'8.8.8.8',family:4}]);
    expect(await client.page('https://example.com/article#anchor',signal())).toMatchObject({content:'Actual body',url:'https://example.com/article'});
    expect(transport).toHaveBeenCalledOnce();const [url,options]=transport.mock.calls[0]!;
    expect(url).toBe('https://api.deepseek.com/v1/tools/fetch');expect(options.redirect).toBe('error');expect(options.headers).toEqual({Authorization:'Bearer PRIVATE_KEY','Content-Type':'application/json'});
    expect(JSON.parse(options.body)).toEqual({url:'https://example.com/article'});
    expect(JSON.stringify(await client.search('',signal()).catch(e=>e.message))).not.toContain('PRIVATE_KEY');expect(transport).toHaveBeenCalledOnce();
  });
  it('does not submit private DNS destinations, secrets or cancelled requests to the provider',async()=>{
    const transport=vi.fn();const client=new DeepSeekWebClient('key',transport,async()=>[{address:'127.0.0.1',family:4}]);
    await expect(client.page('https://example.com/a',signal())).rejects.toThrow('web_private_address');
    await expect(client.search('my token sk-abcdefghijklmnopqrst',signal())).rejects.toThrow('invalid_web_query');
    const abort=new AbortController();abort.abort();await expect(client.search('query',abort.signal)).rejects.toThrow();expect(transport).not.toHaveBeenCalled();
  });
  it('bounds and filters search sources, dates and summaries without fetching result pages',async()=>{
    const results=[{url:'http://127.0.0.1/private'},...Array.from({length:8},(_,n)=>({url:'https://example.com/'+n,title:'a'.repeat(300),summary:'x'.repeat(1200),date:n?'2026-01-01':'invalid'}))];
    const transport=vi.fn().mockResolvedValue(new Response(JSON.stringify({results})));const client=new DeepSeekWebClient('key',transport);
    const result=await client.search('official documentation',signal());expect(result.sources).toHaveLength(5);expect(result.sources[0]!.snippet).toHaveLength(800);expect(result.sources[0]!.published_at).toBeNull();expect(result.truncated).toBe(true);expect(transport).toHaveBeenCalledOnce();
    expect(JSON.parse(transport.mock.calls[0]![1].body)).toEqual({query:'official documentation',count:5,need_content:false});
  });
  it('treats empty search, HTTP failure and oversized responses distinctly and hides provider errors',async()=>{
    const transport=vi.fn().mockResolvedValueOnce(new Response('{"results":[]}')).mockResolvedValueOnce(new Response('PRIVATE_PROVIDER_HEADERS',{status:403}))
      .mockResolvedValueOnce(new Response('x'.repeat(2*1024*1024+1)));
    const client=new DeepSeekWebClient('key',transport);
    expect((await client.search('a',signal())).sources).toEqual([]);
    await expect(client.search('a',signal())).rejects.toThrow('web_access_denied');
    await expect(client.search('a',signal())).rejects.toThrow('web_response_too_large');
  });
  it('paginates a single snapshot without repeat charges and never shares its cache between jobs',async()=>{
    const {client,ledger,reader}=setup();
    const first=await reader.read(job,'web_fetch',{url:page.url,limit:500},signal());expect(first.result).toMatchObject({start:0,next_start:500,truncated:true,cached:false});
    const next=await reader.read(job,'web_fetch',{url:page.url,start:500,limit:500},signal());expect(next.result).toMatchObject({start:500,next_start:1000,cached:true});
    expect(client.page).toHaveBeenCalledOnce();expect(ledger.reserveExternal).toHaveBeenCalledOnce();
    expect(await reader.read({...job,id:'other',conversation:'group-b'},'web_fetch',{url:page.url,start:500},signal())).toMatchObject({error:'web_page_snapshot_expired_start_at_zero'});
    expect(await reader.read({...job,id:'other',conversation:'group-b'},'web_fetch',{url:page.url},signal())).toMatchObject({ok:true});expect(client.page).toHaveBeenCalledTimes(2);
  });
  it('keeps source truncation visible even when the cached prefix has been consumed',async()=>{
    const {client,reader}=setup();client.page.mockResolvedValue({...page,content:'x'.repeat(501),source_truncated:true});
    const result=await reader.read(job,'web_fetch',{url:page.url,limit:1000},signal());expect(result.result).toMatchObject({next_start:null,source_truncated:true,truncated:true,total_chars:501});
  });
  it('requires a current job and rejects model scope/header/config overrides',async()=>{
    const {client,reader}=setup();let current:typeof job|undefined;const tool=webTools(reader,()=>current)[0]!;
    const execution={signal:signal(),callId:'call'} as any;
    expect(await tool.execute({query:'a'},execution)).toMatchObject({error:'no_active_turn'});current=job;
    for(const key of ['conversation','headers','apiKey','toString'])expect(await tool.execute({query:'a',[key]:'b'},execution)).toMatchObject({error:'unknown_web_argument'});
    expect(client.search).not.toHaveBeenCalled();
  });
  it('enforces per-turn, global and paused budgets without network, and hides revoked-lease errors',async()=>{
    const {client,ledger,reader}=setup();ledger.reserveExternal.mockResolvedValueOnce(false);
    expect(await reader.read(job,'web_search',{query:'a'},signal())).toMatchObject({error:'web_request_budget'});expect(client.search).not.toHaveBeenCalled();
    ledger.paused.mockResolvedValueOnce(true);expect(await reader.read(job,'web_search',{query:'a'},signal())).toMatchObject({error:'web_paused'});
    for(let n=0;n<4;n++)expect(await reader.read(job,'web_search',{query:'a'},signal())).toMatchObject({ok:true});
    expect(await reader.read(job,'web_search',{query:'a'},signal())).toMatchObject({error:'web_turn_budget'});
    ledger.withJob.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error('SQL_PRIVATE'));
    expect(await reader.read({...job,id:'new'},'web_search',{query:'a'},signal())).toMatchObject({error:'web_read_failed'});
  });
  it('does not return a result after cancellation and records safe failure accounting',async()=>{
    const {client,ledger,reader}=setup(),controller=new AbortController();
    client.search.mockImplementationOnce(async()=>{controller.abort();return search;});
    expect(await reader.read(job,'web_search',{query:'a'},controller.signal)).toMatchObject({error:'cancelled'});
    expect(ledger.append.mock.calls.some(c=>c[1]==='web.completed'&&c[2].ok===false)).toBe(true);
  });
  it('honors the active habit gate before spending a provider request',async()=>{
    const {client,ledger}=setup(),gate=vi.fn().mockResolvedValue(false),reader=new WebReader(client,ledger,{hour:20,day:100},gate);
    expect(await reader.read(job,'web_search',{query:'latest version'},signal())).toMatchObject({error:'web_requires_user_request'});
    expect(gate).toHaveBeenCalledWith(job);expect(client.search).not.toHaveBeenCalled();expect(ledger.reserveExternal).not.toHaveBeenCalled();
  });
});
