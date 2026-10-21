import {afterEach,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {MemeFiles,memeTools,memeBundle,validateMemes,observeMemeOnly} from '../src/meme-tools.js';
import type {Normalized} from '../src/inbound.js';
import type {MemeTurn} from '../src/meme-tools.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jResAAAAASUVORK5CYII=','base64');
const hash=createHash('sha256').update(png).digest('hex'),mime='image/png';
const label={kind:'meme',description:'开心的卡通猫',tags:['开心'],use_when:'庆祝',avoid_when:'坏消息',confidence:0.95,reusable:true,privacy_risk:false};
const exec=()=>({callId:'fixture',signal:new AbortController().signal}) as any;
let root='';afterEach(()=>{if(root)rmSync(root,{recursive:true,force:true});root='';});
function fixture(){root=mkdtempSync(join(tmpdir(),'meme-files-'));const media=join(root,'media');mkdirSync(media);const path=join(media,hash+'.png');writeFileSync(path,png);return {media,path,files:new MemeFiles(media)};}
describe('private image asset transport',()=>{
  it('collects into a separate per-group cache and sends bytes without exposing local host paths',async()=>{
    const {path,files}=fixture();const a=await files.collect('group-a',{path,hash,mime}),b=await files.collect('group-b',{path,hash,mime});
    expect(a).not.toBe(b);expect(readFileSync(a)).toEqual(png);
    expect(await files.image('group-a',{path,hash,mime})).toEqual({type:'image',data:{file:'base64://'+png.toString('base64')}});
  });
  it('rejects paths outside media, path substitutions, wrong hashes and files with false image types',async()=>{
    const {files,path}=fixture(),outside=join(root,hash+'.png');writeFileSync(outside,png);
    await expect(files.image('g',{path:outside,hash,mime})).rejects.toThrow('unsafe_meme_path');
    writeFileSync(path,'tampered');await expect(files.image('g',{path,hash,mime})).rejects.toThrow('meme_content_mismatch');
    const bad=Buffer.from('not an image'),h=createHash('sha256').update(bad).digest('hex'),p=join(files.mediaRoot,h+'.png');writeFileSync(p,bad);
    await expect(files.image('g',{path:p,hash:h,mime})).rejects.toThrow('meme_content_mismatch');
    await expect(files.image('g',{path,hash:'../../bad',mime})).rejects.toThrow('invalid_meme_asset');
  });
  it('rejects a collection directory redirected outside the sandbox',async()=>{
    const {files,path,media}=fixture(),outside=join(root,'outside');mkdirSync(outside);symlinkSync(outside,join(media,'memes'));
    await expect(files.collect('g',{path,hash,mime})).rejects.toThrow('unsafe_meme_path');
  });
});
describe('visual evidence and scoped intent tools',()=>{
  function bound(path:string):MemeTurn{return {job:{id:'event',conversation:'group-a',owner:'worker',phase:'pending',attempts:1,payload:{}},
    images:[{hash,path,mime,collectable:true}],readImages:new Set(),choices:[],assessments:new Map()};}
  it('requires an actual successful visual read and a current-image hash before classification',async()=>{
    const {files,path}=fixture(),turn=bound(path),classify=vi.fn().mockResolvedValue({kind:'meme',collected:true});
    const tool=memeTools({classify} as any,files,()=>turn)[0]!;
    const args={...label,image_hash:hash,reply_needed:false};
    expect(await tool.execute(args,exec())).toMatchObject({error:'read_image_required'});expect(classify).not.toHaveBeenCalled();
    turn.readImages.add(path);
    expect(await tool.execute({...args,conversation:'other'},exec())).toMatchObject({error:'unknown_meme_argument'});
    expect(await tool.execute({...args,image_hash:'b'.repeat(64)},exec())).toMatchObject({error:'image_not_current'});
    expect(await tool.execute(args,exec())).toMatchObject({ok:true,result:{collected:true}});
    expect(classify.mock.calls[0]).toEqual([turn.job,hash,label,true]);expect(turn.assessments.get(hash)?.replyNeeded).toBe(false);
  });
  it('only offers current same-group candidates and rechecks the selected pixels',async()=>{
    const {files,path}=fixture(),turn=bound(path),id='candidate',select=vi.fn().mockResolvedValue({id,hash,mode:'image_only'}),delivery=vi.fn().mockResolvedValue({path,mime,bytes:png.length});
    const tool=memeTools({select,delivery} as any,files,()=>turn)[1]!;
    expect(await tool.execute({meme_id:id,mode:'image_only'},exec())).toMatchObject({error:'meme_not_offered'});
    turn.choices=[{id,hash,...label}];
    expect(await tool.execute({meme_id:id,mode:'image_only'},exec())).toMatchObject({error:'read_image_required'});
    turn.readImages.add(files.path(turn.job.conversation,hash,mime));
    expect(await tool.execute({meme_id:id,mode:'image_only'},exec())).toMatchObject({ok:true});
    expect(select.mock.calls[0]).toEqual([turn.job,id,'image_only',300000]);
  });
  it('rejects malformed config and treats descriptions as template-safe data',()=>{
    validateMemes({enabled:true,cooldownMs:300000});
    for(const value of [{enabled:true,cooldownMs:0},{enabled:'yes'},{enabled:true,path:'/etc/passwd'}])expect(()=>validateMemes(value as any)).toThrow();
    const text=memeBundle([],[{id:'m',hash,...label,description:'{{literal}}',local_path:'/media/m.png'}]);
    expect(text).not.toContain('{{');expect(JSON.parse(text.split('\n')[1]!).choices[0].description).toBe('{{literal}}');
  });
  it('observes casual meme-only posts but keeps direct requests and unread/information images responsive',()=>{
    const turn=bound('/media/a.png'),decision={action:'speak' as const,source:'rule',reason:'media_requires_full_turn'};
    const input:Normalized={body:'image',images:1,quotes:0,forwards:0,forwardNodes:0,videos:0,mediaFailures:0,truncated:false,media:[],references:[],links:[]};
    expect(observeMemeOnly('attention',decision,'',input,turn)).toBe(false);
    turn.assessments.set(hash,{kind:'meme',replyNeeded:false});
    expect(observeMemeOnly('attention',decision,'',input,turn)).toBe(true);
    for(const check of [()=>observeMemeOnly('attention',{...decision,reason:'directly_addressed'},'',input,turn),
      ()=>observeMemeOnly('attention',decision,'帮我看一下',input,turn),()=>observeMemeOnly('replyAll',decision,'',input,turn),
      ()=>observeMemeOnly('attention',decision,'',{...input,mediaFailures:1},turn),()=>observeMemeOnly('attention',decision,'',input,turn,true)])expect(check()).toBe(false);
    turn.assessments.set(hash,{kind:'informational',replyNeeded:false});expect(observeMemeOnly('attention',decision,'',input,turn)).toBe(false);
  });
});
