import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {Ledger} from './ledger.js';
import type {Job} from './ledger.js';
import {containsSecret,instructionLike} from './memory-policy.js';

export interface ImageLabel {
  kind:'meme'|'informational'|'mixed'|'uncertain';description:string;tags:string[];
  use_when:string;avoid_when:string;confidence:number;reusable:boolean;privacy_risk:boolean;
}
export interface MemeChoice {id:string;hash:string;description:string;tags:string[];use_when:string;avoid_when:string}
export interface MemeSelection {id:string;hash:string;mode:'image_only'|'with_text'}
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const hashPattern=/^[a-f0-9]{64}$/;
const fields=['kind','description','tags','use_when','avoid_when','confidence','reusable','privacy_risk'];
export function validateImageLabel(value:unknown):ImageLabel {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid_image_label');
  const v=value as Record<string,any>;
  if(Object.keys(v).some(k=>!fields.includes(k))||!['meme','informational','mixed','uncertain'].includes(v.kind)
    ||!['description','use_when','avoid_when'].every(k=>typeof v[k]==='string'&&v[k].length<=(k==='description'?160:120))
    ||!v.description.trim()||!Array.isArray(v.tags)||v.tags.length>5||v.tags.some((s:unknown)=>typeof s!=='string'||!s.trim()||s.length>16)
    ||typeof v.confidence!=='number'||!Number.isFinite(v.confidence)||v.confidence<0||v.confidence>1
    ||typeof v.reusable!=='boolean'||typeof v.privacy_risk!=='boolean')throw Error('invalid_image_label');
  const text=[v.description,v.use_when,v.avoid_when,...v.tags].join('\n');
  if(containsSecret(text)||instructionLike(text)||/https?:\/\/|\b\d{7,}\b|(?:身份证|手机号码|密码|密钥|住址)/i.test(text))throw Error('unsafe_image_label');
  return v as ImageLabel;
}

/** Classification and selection only. No model-controlled paths or transport. */
export class MemeStore {
  constructor(readonly ledger:Ledger){}
  private async writable(c:PoolClient){
    if((await c.query("SELECT key FROM life_settings WHERE key IN ('paused','memory_writes_paused','meme_learning_paused') AND value='true'")).rowCount)throw Error('meme_learning_paused');
  }
  async classify(job:Job,hash:string,label:ImageLabel,collectable:boolean):Promise<{kind:string;collected:boolean;memeId?:string;reason?:string}>{
    validateImageLabel(label);if(!hashPattern.test(hash))throw Error('invalid_image_hash');
    return this.ledger.withJob(job,async(c,append)=>{
      await this.writable(c);
      const source=(await c.query(`SELECT b.bytes,b.mime FROM life_event_media m JOIN life_blobs b ON b.hash=m.hash
        JOIN life_events e ON e.id=m.event_id WHERE m.event_id=$1 AND e.conversation=$2 AND m.hash=$3
        AND (m.role='message' OR m.role ~ '^message:[0-9]+$')`,[job.id,job.conversation,hash])).rows[0];
      if(!source||!['image/png','image/jpeg','image/gif','image/webp'].includes(source.mime))throw Error('image_source_not_current');
      await c.query(`INSERT INTO life_image_labels(event_id,hash,kind,description,tags,use_when,avoid_when,confidence,reusable,privacy_risk)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,[job.id,hash,label.kind,label.description,label.tags,label.use_when,label.avoid_when,label.confidence,label.reusable,label.privacy_risk]);
      const stored=(await c.query('SELECT * FROM life_image_labels WHERE event_id=$1 AND hash=$2',[job.id,hash])).rows[0]!;
      const result:{kind:string;collected:boolean;memeId?:string;reason?:string}={kind:stored.kind,collected:false};
      // First visual assessment wins on retries; a second call cannot turn a private photo into an asset.
      if(!collectable||stored.kind!=='meme'||stored.confidence<0.85||!stored.reusable||stored.privacy_risk||Number(source.bytes)>4*1024*1024){result.reason='not_reusable_meme';}
      else{
        const existing=(await c.query('SELECT id,status FROM life_memes WHERE conversation=$1 AND hash=$2',[job.conversation,hash])).rows[0];
        if(existing){result.collected=existing.status==='active';result.memeId=existing.id;result.reason=existing.status==='active'?'deduplicated':'suppressed';}
        else{
          const quota=(await c.query(`SELECT count(*)::int AS n,COALESCE(sum(b.bytes),0)::bigint AS bytes FROM life_memes m JOIN life_blobs b ON b.hash=m.hash WHERE m.conversation=$1`,[job.conversation])).rows[0];
          if(quota.n>=100||Number(quota.bytes)+Number(source.bytes)>100*1024*1024)result.reason='library_full';
          else{result.memeId=randomUUID();result.collected=true;
            await c.query(`INSERT INTO life_memes(id,conversation,hash,source_id,description,tags,use_when,avoid_when,status)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,'active')`,[result.memeId,job.conversation,hash,job.id,stored.description,stored.tags,stored.use_when,stored.avoid_when]);}
        }
      }
      await append('image.classified',{hash,...result});return result;
    });
  }
  private async available(c:PoolClient,job:Job,id?:string){
    return (await c.query(`SELECT m.id,m.hash,m.description,m.tags,m.use_when,m.avoid_when,b.path,b.bytes,b.mime
      FROM life_memes m JOIN life_blobs b ON b.hash=m.hash JOIN life_events source ON source.id=m.source_id
      JOIN life_events anchor ON anchor.id=$1 AND anchor.conversation=m.conversation
      WHERE m.conversation=$2 AND m.status='active' AND source.seq<anchor.seq AND ($3::uuid IS NULL OR m.id=$3)
      AND NOT EXISTS(SELECT 1 FROM life_outbox o JOIN life_jobs j ON j.id=o.job_id
        WHERE j.conversation=$2 AND o.payload->'meme'->>'id'=m.id::text AND o.status IN ('pending','dispatching','confirmed','unknown')
        AND o.updated_at>now()-interval '24 hours')
      ORDER BY m.created_at DESC LIMIT 100`,[job.id,job.conversation,id??null])).rows;
  }
  async choices(job:Job,query=''):Promise<MemeChoice[]>{
    return this.ledger.withJob(job,async c=>{
      await this.writable(c);
      const tokens=[...new Set((query.normalize('NFKC').toLowerCase().slice(0,1500).match(/[\p{L}\p{N}]{2,}/gu)??[])
        .flatMap(word=>/\p{Script=Han}/u.test(word)?Array.from({length:word.length-1},(_,i)=>word.slice(i,i+2)):[word]))].slice(0,150);
      return (await this.available(c,job)).map(({path,bytes,mime,...m})=>m)
        .map((m,index)=>({m,index,score:tokens.reduce((n,t)=>n+Number((m.description+' '+m.tags.join(' ')+' '+m.use_when).toLowerCase().includes(t)),0)}))
        .sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,16).map(x=>x.m);
    });
  }
  async select(job:Job,id:string,mode:MemeSelection['mode'],cooldownMs=300000):Promise<MemeSelection>{
    if(!uuid.test(id)||!['image_only','with_text'].includes(mode))throw Error('invalid_meme_selection');
    return this.ledger.withJob(job,async(c,append)=>{
      await this.writable(c);
      const previous=(await c.query("SELECT payload FROM life_events WHERE cause=$1 AND kind='meme.selected' ORDER BY seq DESC LIMIT 1",[job.id])).rows[0]?.payload;
      if(previous){if(previous.id!==id||previous.mode!==mode)throw Error('one_meme_per_turn');return previous;}
      const row=(await this.available(c,job,id))[0];if(!row)throw Error('meme_not_available');
      // Unknown sends count too: never retry an image whose receipt was lost.
      if((await c.query(`SELECT o.id FROM life_outbox o JOIN life_jobs j ON j.id=o.job_id WHERE j.conversation=$1 AND o.payload ? 'meme'
        AND o.status IN ('pending','dispatching','confirmed','unknown') AND o.updated_at>now()-$2*interval '1 millisecond' LIMIT 1`,[job.conversation,cooldownMs])).rowCount)throw Error('meme_cooldown');
      const selected={id:row.id,hash:row.hash,mode};await append('meme.selected',selected);return selected;
    });
  }
  async delivery(job:Job,selection:{id:string;hash:string}):Promise<{path:string;bytes:number;mime:string}>{
    if(!uuid.test(selection.id)||!hashPattern.test(selection.hash))throw Error('invalid_meme_selection');
    return this.ledger.withJob(job,async c=>{
      await this.writable(c);
      const row=(await c.query(`SELECT b.path,b.bytes,b.mime FROM life_memes m JOIN life_blobs b ON b.hash=m.hash
        WHERE m.conversation=$1 AND m.id=$2 AND m.hash=$3 AND m.status='active'`,[job.conversation,selection.id,selection.hash])).rows[0];
      if(!row)throw Error('meme_not_available');return row;
    });
  }
}
