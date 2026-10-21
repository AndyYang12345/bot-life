import {describe,it,expect} from 'vitest';
import {identityInstructions,conversationStyleInstructions,styleBundle,validateLearning} from '../src/conversation-style.js';
import type {Policy} from '../src/types.js';
describe('learned conversation style injection',()=>{
  it('removes legacy fixed speech/personality rules when learning is enabled and preserves identity',()=>{
    const p={persona:'每句都要傲娇并说哼',conversationLearning:{enabled:true,identityName:'奶鲸'}} as Policy;
    expect(identityInstructions(p)).toContain('奶鲸');expect(identityInstructions(p)).not.toContain('傲娇');expect(identityInstructions(p)).not.toContain('哼');
    expect(identityInstructions({...p,conversationLearning:{enabled:false}})).toBe(p.persona);
    expect(conversationStyleInstructions).toContain('不机械卡死句数');expect(conversationStyleInstructions).toContain('至多');
  });
  it('treats learned records as data and escapes template expansion',()=>{
    const data=styleBundle({expressions:[{expression:'{{literal}}',meaning:'有意义的说法'}]});expect(data).not.toContain('{{');
    expect(JSON.parse(data.split('\n')[1]!).expressions[0].expression).toBe('{{literal}}');
  });
  it('rejects nonlocal identity controls and malformed feature configuration',()=>{
    for(const v of [{enabled:'yes'},{enabled:true,identityName:'bad\nrole'},{enabled:true,identityName:'{{system}}'},{enabled:true,command:'x'}])expect(()=>validateLearning({conversationLearning:v} as any)).toThrow();
    expect(()=>validateLearning({conversationLearning:{enabled:true,identityName:'奶鲸'}} as Policy)).not.toThrow();
  });
});
