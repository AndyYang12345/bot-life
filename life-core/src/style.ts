import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {Ledger} from './ledger.js';
import type {Job} from './ledger.js';
import {containsSecret,instructionLike,fingerprint} from './memory-policy.js';

export interface StyleSource {id:string;speaker:string;text:string;at:string}
export interface StyleProposal {
  expression:string;function:string;meaning:string;context:string;avoid:string;confidence:number;
  evidence:{event_id:string;quote:string}[];
}
export interface StyleInput {events:StyleSource[];existing:{expression:string;function:string;meaning:string;context:string}[]}
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const privateData=/https?:\/\/|\b\d{7,}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:住址|身份证|手机号码|密码|密钥|病历|诊断|银行账户)/i;
const optout=/(?:不要|别|不许).{0,8}(?:学习|模仿|记住|记录|保存)|(?:忘记|删除).{0,8}(?:记忆|偏好|资料)/;
const teaching=/(?:请|以后|必须).{0,12}(?:这样说|这么说|回答|说话)|(?:学会|模仿|照着).{0,16}(?:说话|口头禅|句式)|提示词/;
const safe=(text:string)=>!containsSecret(text)&&!instructionLike(text)&&!privateData.test(text)&&!optout.test(text)&&!teaching.test(text);

/** Only direct top-level human text. Never descend into quoted/forwarded/card
 * content; a human's own comment on an attachment remains eligible. */
export function ordinaryStyleText(payload:any):string {
  if(payload?.post_type==='message_sent'||payload?.self_id!==undefined&&String(payload?.user_id)===String(payload.self_id))return '';
  const text=typeof payload?.text==='string'?payload.text:typeof payload?.message==='string'?payload.message
    :Array.isArray(payload?.message)?payload.message.filter((s:any)=>s?.type==='text').map((s:any)=>String(s.data?.text??'')).join(''):'';
  const value=text.normalize('NFKC').trim();
  return value&&value.length<=300&&!value.startsWith('/')&&safe(value)?value:'';
}
export function parseStyleProposals(value:unknown,input:StyleInput|undefined):{rules:StyleProposal[];rejected:number}{
  if(value===undefined)return {rules:[],rejected:0};
  if(!input||!Array.isArray(value)||value.length>2)throw Error('invalid_style_extraction');
  const sources=new Map(input.events.map(e=>[e.id,e.text.normalize('NFKC')])),rules:StyleProposal[]=[];let rejected=0;
  const keys=['expression','function','meaning','context','avoid','confidence','evidence'];
  for(const r of value){
    const text=(v:unknown,max:number,empty=false)=>typeof v==='string'&&(empty||v.trim().length>0)&&v.length<=max;
    if(!object(r)||Object.keys(r).some(k=>!keys.includes(k))||!text(r.expression,24)||!/^[a-z][a-z0-9_]{0,31}$/.test(r.function??'')
      ||!text(r.meaning,100)||!text(r.context,160)||!text(r.avoid,100,true)||typeof r.confidence!=='number'||!Number.isFinite(r.confidence)||r.confidence<0||r.confidence>1
      ||!safe([r.expression,r.meaning,r.context,r.avoid].join('\n'))||!Array.isArray(r.evidence)||r.evidence.length<1||r.evidence.length>4
      ||r.evidence.some((e:any)=>!object(e)||Object.keys(e).some(k=>!['event_id','quote'].includes(k))||!uuid.test(e.event_id??'')||!text(e.quote,160)
        ||!sources.get(e.event_id)?.includes(e.quote.normalize('NFKC').trim())||!e.quote.normalize('NFKC').includes(r.expression.normalize('NFKC').trim()))){rejected++;continue;}
    rules.push({...r,expression:r.expression.normalize('NFKC').trim()} as StyleProposal);
  }
  return {rules,rejected};
}

export class StyleStore {
  constructor(readonly ledger:Ledger){}
  private async sourceRows(c:PoolClient,job:Job,ids?:string[]){
    return (await c.query(`SELECT e.id,e.actor,e.payload,e.seq,e.recorded_at FROM life_events e
      JOIN life_events anchor ON anchor.id=$1 AND anchor.conversation=$2 JOIN life_conversations s ON s.key=e.conversation
      JOIN life_jobs j ON j.id=e.id WHERE e.conversation=$2 AND e.kind='inbound.message' AND e.seq<=anchor.seq
      AND e.seq>GREATEST(s.memory_floor_seq,s.style_floor_seq) AND j.status IN ('done','skipped') AND e.recorded_at>now()-interval '7 days'
      AND ($3::uuid[] IS NULL OR e.id=ANY($3::uuid[])) ORDER BY e.seq DESC LIMIT 60`,[job.id,job.conversation,ids??null])).rows;
  }
  async input(job:Job,maxChars=3400):Promise<StyleInput|undefined>{
    if(maxChars<500)return;
    return this.ledger.withJob(job,async c=>{
      if((await c.query("SELECT key FROM life_settings WHERE key='style_learning_paused' AND value='true'")).rowCount)return;
      const rows=(await this.sourceRows(c,job)).map(r=>({...r,text:ordinaryStyleText(r.payload)})).filter(r=>r.text).slice(0,16).reverse();
      if(rows.length<4)return;
      const speakers=new Map<string,string>();
      const events=rows.map(r=>{if(!speakers.has(r.actor))speakers.set(r.actor,'speaker_'+(speakers.size+1));return {id:r.id,speaker:speakers.get(r.actor)!,text:r.text.slice(0,160),at:new Date(r.recorded_at).toISOString()};});
      const existing=(await c.query(`SELECT expression,function,meaning,context FROM life_style_rules WHERE conversation=$1
        AND status IN ('candidate','active') ORDER BY last_seen_at DESC LIMIT 4`,[job.conversation])).rows;
      const input:StyleInput={events,existing};
      while(input.events.length>4&&JSON.stringify(input).length>maxChars)input.events.shift();
      return JSON.stringify(input).length<=maxChars?input:undefined;
    });
  }
  async apply(job:Job,input:StyleInput,rules:StyleProposal[]):Promise<{observed:number;active:number;rejected:number}>{
    return this.ledger.withJob(job,async(c,append)=>{
      if((await c.query("SELECT key FROM life_settings WHERE key IN ('paused','memory_writes_paused','consolidation_paused','style_learning_paused') AND value='true'")).rowCount)throw Error('memory_writes_paused');
      // Revalidate every source at commit, not just the model's in-memory input.
      const rows=await this.sourceRows(c,job,input.events.map(e=>e.id)),byId=new Map(rows.map(r=>[r.id,{...r,text:ordinaryStyleText(r.payload)}]));
      const valid=input.events.filter(e=>byId.get(e.id)?.text.includes(e.text));
      const parsed=parseStyleProposals(rules,{events:valid,existing:input.existing});
      let observed=0,active=0;
      for(const r of parsed.rules){
        const hash=fingerprint([r.expression.toLowerCase(),r.function]);
        let row=(await c.query('SELECT * FROM life_style_rules WHERE conversation=$1 AND fingerprint=$2 FOR UPDATE',[job.conversation,hash])).rows[0];
        if(row?.status==='suppressed')continue;
        const fresh=!row;
        if(!row){row=(await c.query(`INSERT INTO life_style_rules(id,conversation,fingerprint,expression,function,meaning,context,avoid,confidence,status,last_seen_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'candidate',$10) RETURNING *`,[randomUUID(),job.conversation,hash,r.expression,r.function,r.meaning,r.context,r.avoid,Math.min(r.confidence,0.95),byId.get(r.evidence[0]!.event_id)!.recorded_at])).rows[0];}
        let added=0;
        for(const proof of r.evidence){const source=byId.get(proof.event_id)!;
          const inserted=await c.query('INSERT INTO life_style_evidence(rule_id,event_id,quote,actor) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[row.id,proof.event_id,r.expression,source.actor]);added+=inserted.rowCount??0;}
        if(!fresh&&!added)continue;
        const support=(await c.query(`SELECT count(*)::int AS messages,count(DISTINCT p.actor)::int AS speakers,max(e.recorded_at) AS last_seen
          FROM life_style_evidence p JOIN life_events e ON e.id=p.event_id WHERE p.rule_id=$1 AND e.recorded_at>now()-interval '28 days'`,[row.id])).rows[0];
        const status=support.messages>=3&&support.speakers>=2&&r.confidence>=0.75?'active':'candidate';
        const revision=fresh?1:row.revision+1;
        // Without new independent examples, repeated extraction cannot rewrite
        // meanings or refresh age. Existing active rules never demote by replay.
        const nextStatus=row.status==='active'&&support.messages>=3&&support.speakers>=2?row.status:status;
        const canChange=row.status!=='active'||r.evidence.length>=3&&new Set(r.evidence.map(e=>byId.get(e.event_id)!.actor)).size>=2&&r.confidence>=0.75;
        const meaning=canChange?r.meaning:row.meaning,context=canChange?r.context:row.context,avoid=canChange?r.avoid:row.avoid,confidence=canChange?Math.min(r.confidence,0.95):row.confidence;
        await c.query(`UPDATE life_style_rules SET meaning=$2,context=$3,avoid=$4,confidence=$5,status=$6,revision=$7,last_seen_at=$8,updated_at=now() WHERE id=$1`,
          [row.id,meaning,context,avoid,confidence,nextStatus,revision,support.last_seen]);
        await c.query('INSERT INTO life_style_revisions(rule_id,revision,payload) VALUES($1,$2,$3)',[row.id,revision,{expression:r.expression,function:r.function,meaning,context,avoid,status:nextStatus,confidence,supportMessages:support.messages,supportSpeakers:support.speakers}]);
        observed++;if(nextStatus==='active')active++;
      }
      if(valid.length>=4){
        const lengths=valid.map(e=>[...e.text].length).sort((a,b)=>a-b),speakers=new Set(valid.map(e=>byId.get(e.id)!.actor));
        const toSeq=rows.reduce((n,r)=>BigInt(r.seq)>n?BigInt(r.seq):n,0n);
        await c.query(`INSERT INTO life_style_profiles(conversation,sample_count,speaker_count,median_chars,emoji_rate,source_ids,to_seq)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(conversation) DO UPDATE SET revision=life_style_profiles.revision+1,
          sample_count=EXCLUDED.sample_count,speaker_count=EXCLUDED.speaker_count,median_chars=EXCLUDED.median_chars,
          emoji_rate=EXCLUDED.emoji_rate,source_ids=EXCLUDED.source_ids,to_seq=EXCLUDED.to_seq,updated_at=now()
          WHERE life_style_profiles.to_seq<EXCLUDED.to_seq`,[job.conversation,valid.length,speakers.size,lengths[Math.floor(lengths.length/2)],valid.filter(e=>/\p{Extended_Pictographic}/u.test(e.text)).length/valid.length,valid.map(e=>e.id),String(toSeq)]);
      }
      await append('style.observed',{observed,active,rejected:parsed.rejected,sampleCount:valid.length});
      return {observed,active,rejected:parsed.rejected};
    });
  }
  async context(job:Job):Promise<Record<string,unknown>>{
    return this.ledger.withJob(job,async c=>{
      if((await c.query("SELECT key FROM life_settings WHERE key='style_learning_paused' AND value='true'")).rowCount)return {state:'paused',expressions:[]};
      const p=(await c.query(`SELECT p.sample_count,p.speaker_count,p.median_chars,p.emoji_rate,p.revision FROM life_style_profiles p
        JOIN life_events anchor ON anchor.id=$1 AND anchor.conversation=p.conversation WHERE p.conversation=$2 AND p.to_seq<=anchor.seq AND p.updated_at>now()-interval '7 days'`,[job.id,job.conversation])).rows[0];
      const recent=(await c.query(`SELECT o.payload->>'text' AS text FROM life_outbox o JOIN life_events e ON e.id=o.job_id
        JOIN life_events anchor ON anchor.id=$1 WHERE e.conversation=$2 AND e.seq<anchor.seq AND o.status='confirmed' ORDER BY e.seq DESC,o.part DESC LIMIT 4`,[job.id,job.conversation])).rows.map(r=>r.text??'').join('\n').normalize('NFKC');
      const rows=(await c.query(`SELECT r.expression,r.function,r.meaning,r.context,r.avoid,r.confidence,r.revision,
        count(p.event_id)::int AS examples,count(DISTINCT p.actor)::int AS speakers FROM life_style_rules r
        JOIN life_style_evidence p ON p.rule_id=r.id JOIN life_events e ON e.id=p.event_id JOIN life_events anchor ON anchor.id=$1
        WHERE r.conversation=$2 AND r.status='active' AND r.last_seen_at>now()-interval '14 days' AND e.seq<=anchor.seq AND r.last_seen_at<=anchor.recorded_at AND e.recorded_at>now()-interval '28 days'
        GROUP BY r.id HAVING count(p.event_id)>=3 AND count(DISTINCT p.actor)>=2 ORDER BY r.last_seen_at DESC LIMIT 8`,[job.id,job.conversation])).rows;
      const expressions=rows.filter(r=>!recent.includes(r.expression.normalize('NFKC'))).slice(0,4);
      const avoidExpressions=(await c.query("SELECT expression FROM life_style_rules WHERE conversation=$1 AND status='suppressed' ORDER BY updated_at DESC LIMIT 10",[job.conversation])).rows.map(r=>r.expression);
      return {state:'learning',rhythm:p&&p.sample_count>=8&&p.speaker_count>=2?{samples:p.sample_count,speakers:p.speaker_count,typicalHumanChars:p.median_chars,emojiRate:p.emoji_rate}:null,expressions,avoidExpressions};
    });
  }
}
