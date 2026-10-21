import { fingerprint,shareable } from './memory-policy.js';

export interface Preference {content:string;summary:string;slot:string;category:'preference'|'communication';quote:string}

/** Only complete, simple first-person statements. Complex/inferred claims stay with the agent. */
export function explicitPreference(text:string):Preference|null{
  const source=text.normalize('NFKC').trim();
  if(source.length>160||/[\n\r;；，,]/.test(source)||/但是|不过|可是|如果|假如|比如|举例|测试|他说|她说|你说|他喜欢|她喜欢|你喜欢|别人|有人|并非|不是真的|开玩笑|扮演/.test(source))return null;
  const match=/^(?:(?:请)?(?:记住|记一下)[：:\s]*)?(我(?:不喜欢|喜欢|偏好|常用|不吃|爱吃|习惯).+?)[。.!！~～]*$/.exec(source);
  if(!match)return null;
  const quote=match[1]!,category=/回复|回答|交流|称呼|说话|简短|详细/.test(quote)?'communication':'preference';
  if(!shareable(source,category))return null;
  const normalized=quote.replace(/^我/,'本人').replace(/^(本人(?:不喜欢|喜欢|偏好))(?:喝|吃)/,'$1').replace(/[。.!！~～]+$/,'');
  return {content:normalized+'。',summary:normalized.slice(0,80),slot:'self-preference:'+fingerprint(normalized).slice(0,20),category,quote};
}
