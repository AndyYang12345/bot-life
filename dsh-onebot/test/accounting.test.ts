import { describe, it, expect } from 'vitest';
import { modelUsage } from '../src/accounting.js';
describe('provider token accounting',()=>{
  it('preserves disjoint cached/uncached input without estimating money or copying credentials',()=>{
    const data={turn:1,step:2,apiKey:'private',usage:{inputTokens:250,cacheReadTokens:1000,cacheWriteTokens:0,outputTokens:30,totalTokens:1280}};
    expect(modelUsage(data,'deepseek-official','deepseek-flash')).toEqual({turn:1,step:2,provider:'deepseek-official',model:'deepseek-flash',credentialLabel:'qqbot-independent',usage:data.usage});
  });
  it('marks missing, negative or non-integer usage unavailable',()=>{
    for(const usage of [undefined,{inputTokens:1,outputTokens:-1},{inputTokens:1,outputTokens:1.5},{inputTokens:1,outputTokens:2,totalTokens:Infinity}])expect(modelUsage({usage},'p','m')).toBeUndefined();
  });
});
