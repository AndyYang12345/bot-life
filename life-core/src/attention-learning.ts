import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {Ledger} from './ledger.js';
import type {Job} from './ledger.js';
import {ordinaryStyleText} from './style.js';

export interface AliasEvent {id:string;speaker:string;text:string;directed:boolean;at:string}
export interface AliasInput {identity:string;events:AliasEvent[];existing:{alias:string;status:string}[]}
export interface AliasProposal {alias:string;confidence:number;evidence:{event_id:string;quote:string}[]}
export function validAlias(value:unknown):value is string {
  return typeof value==='string'&&value===value.normalize('NFKC').trim().toLowerCase()&&/^[\p{L}\p{N}·_-]{2,16}$/u.test(value)
    &&!['机器人','大家','你们','我们','他们','她们','同学','老师','助手','老婆','老公','bot','ai'].includes(value);
}
export function parseAliasProposals(value:unknown,input:AliasInput|undefined):{aliases:AliasProposal[];rejected:number}{
  if(value===undefined)return {aliases:[],rejected:0};
  if(!input||!Array.isArray(value)||value.length>3)throw Error('invalid_alias_extraction');
  const events=new Map(input.events.map(e=>[e.id,e.text])),aliases:AliasProposal[]=[];let rejected=0;
  for(const raw of value){
    if(!raw||typeof raw!=='object'||Object.keys(raw).some(k=>!['alias','confidence','evidence'].includes(k))
      ||!validAlias(raw.alias)||typeof raw.confidence!=='number'||!Number.isFinite(raw.confidence)||raw.confidence<0||raw.confidence>1
      ||!Array.isArray(raw.evidence)||!raw.evidence.length||raw.evidence.length>4
      ||raw.evidence.some((e:any)=>!e||Object.keys(e).some(k=>!['event_id','quote'].includes(k))||typeof e.quote!=='string'||!e.quote.trim()||e.quote.length>160
        ||!events.get(e.event_id)?.includes(e.quote)||!e.quote.toLowerCase().includes(raw.alias))){rejected++;continue;}
    if(raw.alias!==input.identity.normalize('NFKC').toLowerCase())aliases.push(raw);
  }
  return {aliases,rejected};
}

/** Only same-group human evidence can teach a literal name. No executable regex. */
export class AttentionStore {
  constructor(private ledger:Ledger){}
  private async rows(c:PoolClient,job:Job){
    const rows=(await c.query(`SELECT e.id,e.actor,e.payload,e.recorded_at,n.payload AS normalized FROM life_events e
      JOIN life_events anchor ON anchor.id=$1 AND anchor.conversation=$2 JOIN life_conversations conv ON conv.key=e.conversation
      JOIN life_jobs j ON j.id=e.id LEFT JOIN LATERAL (SELECT payload FROM life_events WHERE cause=e.id AND kind='inbound.normalized' ORDER BY seq DESC LIMIT 1) n ON true
      WHERE e.conversation=$2 AND e.kind='inbound.message' AND e.seq<=anchor.seq AND e.seq>GREATEST(conv.memory_floor_seq,conv.attention_floor_seq)
      AND j.status IN ('done','skipped') AND e.recorded_at>now()-interval '7 days' ORDER BY e.seq DESC LIMIT 80`,[job.id,job.conversation])).rows;
    return rows.map(r=>{
      const text=ordinaryStyleText(r.payload),self=String(r.payload?.self_id??'');
      const segments=Array.isArray(r.payload?.message)?r.payload.message:[];
      const at=segments.filter((s:any)=>s?.type==='at').map((s:any)=>String(s.data?.qq));
      const elsewhere=at.some((id:string)=>id!=='all'&&id!==self);
      const directed=!elsewhere&&(at.includes(self)||Array.isArray(r.normalized?.references)&&r.normalized.references.some((ref:any)=>String(ref.senderId)===self));
      return {...r,text:elsewhere?'':text,directed};
    }).filter(r=>r.text);
  }
  async input(job:Job,identity:string,maxChars=2600):Promise<AliasInput|undefined>{
    if(maxChars<600)return;
    return this.ledger.withJob(job,async c=>{
      if((await c.query("SELECT key FROM life_settings WHERE key='attention_learning_paused' AND value='true'")).rowCount)return;
      const rows=(await this.rows(c,job)).slice(0,20).reverse();if(rows.length<3)return;
      const speakers=new Map<string,string>();
      const events=rows.map(r=>{if(!speakers.has(r.actor))speakers.set(r.actor,'speaker_'+(speakers.size+1));return {id:r.id,speaker:speakers.get(r.actor)!,text:r.text.slice(0,160),directed:r.directed,at:new Date(r.recorded_at).toISOString()};});
      const existing=(await c.query('SELECT alias,status FROM life_attention_aliases WHERE conversation=$1 ORDER BY last_seen_at DESC LIMIT 16',[job.conversation])).rows;
      const input:AliasInput={identity,events,existing};
      while(input.events.length>3&&JSON.stringify(input).length>maxChars)input.events.shift();
      return JSON.stringify(input).length<=maxChars?input:undefined;
    });
  }
  async apply(job:Job,input:AliasInput,proposals:AliasProposal[]):Promise<Record<string,number>>{
    return this.ledger.withJob(job,async(c,append)=>{
      if((await c.query("SELECT key FROM life_settings WHERE key IN ('paused','memory_writes_paused','consolidation_paused','attention_learning_paused') AND value='true'")).rowCount)throw Error('memory_writes_paused');
      const sources=await this.rows(c,job),byId=new Map(sources.map(r=>[r.id,r]));
      const verified={...input,events:input.events.filter(e=>byId.get(e.id)?.text.includes(e.text))};
      const parsed=parseAliasProposals(proposals,verified);let observed=0,active=0;
      for(const p of parsed.aliases){
        let row=(await c.query('SELECT * FROM life_attention_aliases WHERE conversation=$1 AND alias=$2 FOR UPDATE',[job.conversation,p.alias])).rows[0];
        if(row?.status==='suppressed')continue;
        const fresh=!row;
        if(!row){
          if(Number((await c.query('SELECT count(*) AS n FROM life_attention_aliases WHERE conversation=$1',[job.conversation])).rows[0].n)>=32)continue;
          row=(await c.query(`INSERT INTO life_attention_aliases(id,conversation,alias,status,confidence,last_seen_at) VALUES($1,$2,$3,'candidate',$4,$5) RETURNING *`,
            [randomUUID(),job.conversation,p.alias,Math.min(p.confidence,0.95),byId.get(p.evidence[0]!.event_id)!.recorded_at])).rows[0];
        }
        let added=0;
        for(const proof of p.evidence){const source=byId.get(proof.event_id)!;
          added+=(await c.query('INSERT INTO life_attention_evidence(alias_id,event_id,actor,quote,directed) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[row.id,proof.event_id,source.actor,proof.quote,source.directed])).rowCount??0;}
        if(!fresh&&!added)continue;
        const support=(await c.query(`SELECT count(*)::int AS messages,count(DISTINCT ev.actor)::int AS speakers,count(*) FILTER(WHERE ev.directed)::int AS directed,max(e.recorded_at) AS last_seen
          FROM life_attention_evidence ev JOIN life_events e ON e.id=ev.event_id WHERE ev.alias_id=$1 AND e.recorded_at>now()-interval '28 days'`,[row.id])).rows[0];
        const status=support.messages>=3&&support.directed>=1&&(support.speakers>=2||support.directed>=2)&&p.confidence>=0.85?'active':'candidate';
        const next=row.status==='active'?row.status:status,revision=fresh?1:row.revision+1;
        await c.query('UPDATE life_attention_aliases SET status=$2,confidence=$3,revision=$4,last_seen_at=$5,updated_at=now() WHERE id=$1',[row.id,next,Math.min(p.confidence,0.95),revision,support.last_seen]);
        await c.query('INSERT INTO life_attention_revisions(alias_id,revision,payload) VALUES($1,$2,$3)',[row.id,revision,{alias:p.alias,status:next,...support}]);
        observed++;if(next==='active')active++;
      }
      const result={observed,active,rejected:parsed.rejected};await append('attention.aliases_learned',result);return result;
    });
  }
  async context(job:Job):Promise<{aliases:string[];version:string}>{
    return this.ledger.withJob(job,async c=>{
      const rows=(await c.query(`SELECT a.alias,a.revision FROM life_attention_aliases a JOIN life_events anchor ON anchor.id=$1
        WHERE a.conversation=$2 AND a.status='active' AND a.last_seen_at>now()-interval '14 days' AND a.last_seen_at<=anchor.recorded_at
        AND (SELECT count(*) FROM life_attention_evidence p JOIN life_events e ON e.id=p.event_id WHERE p.alias_id=a.id AND e.seq<=anchor.seq AND e.recorded_at>now()-interval '28 days')>=3
        ORDER BY a.alias LIMIT 16`,[job.id,job.conversation])).rows;
      return {aliases:rows.map(r=>r.alias),version:rows.map(r=>r.alias+':'+r.revision).join('|')};
    });
  }
}
