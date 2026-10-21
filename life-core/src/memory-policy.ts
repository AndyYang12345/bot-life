import { createHash } from 'node:crypto';

export class MemoryError extends Error { constructor(readonly code: string) { super(code); } }
export function bounded(value: unknown, limit: number, code: string): string {
  if (typeof value !== 'string' || !value.trim() || [...value].length>limit) throw new MemoryError(code);
  return value.normalize('NFKC').toWellFormed().replaceAll('\0','\uFFFD').trim();
}
export function terms(text: string): string[] {
  const value=text.normalize('NFKC').toLowerCase();
  const result=new Set<string>(value.match(/[a-z0-9][a-z0-9_-]*/g)??[]);
  for(const run of value.match(/[\p{Script=Han}]+/gu)??[]) {
    const chars=[...run];
    for(let n=0;n<chars.length-1;n++)result.add(chars[n]!+chars[n+1]!);
    for(const char of chars)result.add(char);
  }
  return [...result].slice(0,400);
}
export const fingerprint=(value: unknown):string=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function containsSecret(text:string):boolean {
  return /\bsk-[a-zA-Z0-9_-]{12,}|-----BEGIN[^\n]*PRIVATE KEY|(?:api.?key|access.?token|密钥|密码)\s*[:=：]\s*\S{8,}/i.test(text);
}
export function instructionLike(text:string):boolean {
  return /(?:忽略|绕过|覆盖).{0,12}(?:规则|指令|限制|提示词)|系统提示|system\s*prompt|你(?:现在|以后|必须|应该).{0,12}(?:是|扮演|遵守)|(?:ignore|override).{0,30}(?:instruction|system|rule)/i.test(text);
}
export function questionLike(text:string):boolean {
  return /[?？]|什么|哪[个种里些]|多少|为啥|怎么|谁|啥|(?:吗|呢)[。.!！]?$|^(?:如何|能否|是否|why\b|what\b|who\b|how\b|can\s+you)/i.test(text.trim());
}
export function selfReport(text:string):boolean {
  return /我(?:喜欢|不喜欢|偏好|叫|是|在|习惯|常用|不吃|爱吃|的.{0,8}(?:是|叫))|\bI\s+(?:like|prefer|am|use)\b/i.test(text);
}

/** Conservative first-slice gate, not a complete personal-data classifier. */
export function shareable(text:string,category:string):boolean {
  if(containsSecret(text)||instructionLike(text)||questionLike(text))return false;
  if(/私聊|私下|秘密|隐私|保密|不要.{0,6}(?:说|告诉|分享)|别.{0,6}(?:说|告诉|分享)|(?:只|仅).{0,8}(?:本群|这个群)|今天|这次|刚才|住址|地址|住在|电话|手机|身份证|邮箱|密码|密钥|账号|病|诊断|医疗|性取向|性癖|宗教|信仰|政治|党派|婚姻|恋爱|伴侣|收入|工资|借款|银行|家庭|家人|公司|学校|群里|群内|private|secret|only.{0,12}(?:here|group)|\b\d{7,}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}|https?:\/\//i.test(text))return false;
  return category==='preference'?/我(?:喜欢|不喜欢|偏好|常用|不吃|爱吃)|\bI\s+(?:like|prefer|use)\b/i.test(text)
    :category==='communication'&&/我(?:喜欢|偏好|习惯).{0,35}(?:回复|回答|交流|称呼|说话|简短|详细)|\bI\s+prefer.{0,35}(?:repl|answer|brief|detail)/i.test(text);
}
