import {describe,it,expect} from 'vitest';
import {mkdtempSync,readFileSync,rmSync,statSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {aliasSignal,LocalEmbedding,validateRecall,writeAliasSnapshot} from '../src/attention-recall.js';
import {immediateDecision} from '../src/attention.js';
import type {MessageEvent} from '../src/types.js';
import type {Normalized} from '../src/inbound.js';
const event=(text:string):MessageEvent=>({post_type:'message',message_type:'group',self_id:'bot',user_id:'u',group_id:'g',message_id:'m',time:1,message:[{type:'text',data:{text}}]});
const normalized:Normalized={body:'',images:0,quotes:0,mediaFailures:0,forwards:0,forwardNodes:0,videos:0,truncated:false,media:[],references:[],links:[]};
describe('local attention recall',()=>{
  it('distinguishes vocatives from discussing the bot and ignores forwarded or other-recipient names',()=>{
    for(const text of ['小鲸鲸','小鲸鲸，在吗？','喂，小鲸鲸你怎么看','小鲸鲸帮我看看'])expect(aliasSignal(event(text),['小鲸鲸']).kind).toBe('call');
    for(const text of ['小鲸鲸刚才说了什么','你觉得小鲸鲸怎么样','小鲸鲸，刚才又说错了'])expect(aliasSignal(event(text),['小鲸鲸']).kind).toBe('mention');
    for(const text of ['“小鲸鲸，在吗”','小鲸鲸，不要回复'])expect(aliasSignal(event(text),['小鲸鲸']).kind).toBe('none');
    expect(aliasSignal({...event('小鲸鲸，在吗'),message:[{type:'at',data:{qq:'other'}},{type:'text',data:{text:'小鲸鲸，在吗'}}]},['小鲸鲸']).kind).toBe('none');
    expect(aliasSignal({...event(''),message:[{type:'forward',data:{content:'小鲸鲸，在吗'}}]},['小鲸鲸']).kind).toBe('none');
    expect(aliasSignal(event('a.*b'),['.*']).kind).toBe('none');expect(aliasSignal(event('chatbot工具'),['chat']).kind).toBe('none');
  });
  it('bypasses the judge for clear calls but only wakes the judge for mentions or semantic matches',()=>{
    const e=event('小鲸鲸，在吗'),last=new Date().toISOString();
    expect(immediateDecision('attention',e,normalized,last)?.reason).toBe('cooldown');
    expect(immediateDecision('attention',e,normalized,last,20000,Date.now(),{kind:'call'})).toMatchObject({action:'speak',reason:'local_alias_call'});
    for(const kind of ['mention','semantic'] as const)expect(immediateDecision('attention',e,normalized,last,20000,Date.now(),{kind})).toBeUndefined();
  });
  it('validates executable paths, bounded thresholds and CPU/CUDA selection',()=>{
    expect(()=>validateRecall({enabled:true,embedding:{enabled:true,python:'/python',server:'/server',cacheDir:'/models',device:'cuda'}})).not.toThrow();
    for(const patch of [{threshold:1.1},{device:'remote'},{python:'python'},{timeoutMs:999999},{url:'https://example.org'}])expect(()=>validateRecall({enabled:true,embedding:{enabled:true,python:'/python',server:'/server',cacheDir:'/models',...patch} as any})).toThrow();
  });
  it('writes a private scoped configuration snapshot without evidence or raw conversations',()=>{
    const root=mkdtempSync(join(tmpdir(),'alias-config-'));
    try{writeAliasSnapshot(root,'fixture:group:a','奶鲸',{aliases:['小鲸鲸'],version:'小鲸鲸:1'});
      const path=join(root,'attention',createHash('sha256').update('fixture:group:a').digest('hex')+'.json');
      expect(JSON.parse(readFileSync(path,'utf8')).aliases).toEqual(['小鲸鲸']);expect(statSync(path).mode&0o777).toBe(0o600);
    }finally{rmSync(root,{recursive:true,force:true});}
  });
});
const root=resolve('..'),python=join(root,'data/attention/venv/bin/python'),server=join(root,'attention_backend/server.py');
it.skipIf(!existsSync(python))('runs the actual offline Chinese ONNX model and keeps unrelated messages out of semantic recall',async()=>{
  const embedding=new LocalEmbedding({enabled:true,python,server,cacheDir:join(root,'data/attention/models'),threshold:0.64,margin:0.1});
  try{await embedding.warmup();expect(embedding.state).toBe('ready');
    expect((await embedding.recall('你刚才说的那个怎么操作',['先安装系统再配置网络'])).kind).toBe('semantic');
    expect((await embedding.recall('我晚饭吃了火锅',['先安装系统再配置网络'])).kind).toBe('none');
  }finally{embedding.close();}
},35000);
