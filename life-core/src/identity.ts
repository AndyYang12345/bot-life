import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Job } from './ledger.js';
import { bounded,MemoryError } from './memory-policy.js';

/** Channel-supplied identity. Display names never participate in the identity key. */
export interface IdentityInput { realm:string; platform:string; userId:string; displayName?:string; allowProfileSharing?:boolean }
export interface Person { id:string; realm:string; platform:string; platform_user_id:string }

export async function observeIdentity(c:PoolClient,input:IdentityInput,conversation:string,actor:string):Promise<void>{
  const realm=bounded(input.realm,120,'invalid_identity_realm'),platform=bounded(input.platform,40,'invalid_platform');
  const userId=bounded(input.userId,120,'invalid_platform_user');
  if(userId!==actor)throw new MemoryError('identity_actor_mismatch');
  const scope=(await c.query('SELECT identity_realm,identity_platform FROM life_conversations WHERE key=$1 FOR UPDATE',[conversation])).rows[0];
  if(scope.identity_realm&&scope.identity_realm!==realm)throw new MemoryError('identity_realm_mismatch');
  if(scope.identity_platform&&scope.identity_platform!==platform)throw new MemoryError('identity_platform_mismatch');
  await c.query('UPDATE life_conversations SET identity_realm=$2,profile_sharing=$3,identity_platform=$4 WHERE key=$1 AND identity_realm IS NULL',[conversation,realm,input.allowProfileSharing===true,platform]);
  const person=(await c.query(`INSERT INTO life_people(id,realm,platform,platform_user_id) VALUES($1,$2,$3,$4)
    ON CONFLICT(realm,platform,platform_user_id) DO UPDATE SET last_seen=now() RETURNING id`,[randomUUID(),realm,platform,userId])).rows[0];
  await c.query(`INSERT INTO life_conversation_people(conversation,person_id) VALUES($1,$2)
    ON CONFLICT(conversation,person_id) DO UPDATE SET last_seen=now()`,[conversation,person.id]);
  const alias=typeof input.displayName==='string'?input.displayName.normalize('NFKC').toWellFormed().replaceAll('\0','\uFFFD').trim().slice(0,80):'';
  if(alias)await c.query(`INSERT INTO life_person_aliases(person_id,conversation,name) VALUES($1,$2,$3)
    ON CONFLICT(person_id,conversation,name) DO UPDATE SET last_seen=now()`,[person.id,conversation,alias]);
}

/** Resolve the source event actor through the trusted conversation realm. */
export async function personForJob(c:Pick<PoolClient,'query'>,job:Job):Promise<Person|undefined>{
  return (await c.query(`SELECT p.id,p.realm,p.platform,p.platform_user_id FROM life_people p
    JOIN life_conversation_people cp ON cp.person_id=p.id
    JOIN life_conversations conv ON conv.key=cp.conversation AND conv.identity_realm=p.realm AND conv.identity_platform=p.platform
    JOIN life_events e ON e.id=$1 AND e.conversation=conv.key AND e.actor=p.platform_user_id
    WHERE conv.key=$2 LIMIT 1`,[job.id,job.conversation])).rows[0];
}

export async function personProfile(c:PoolClient,job:Job):Promise<Record<string,unknown>|null>{
  const p=await personForJob(c,job);if(!p)return null;
  const aliases=(await c.query('SELECT name FROM life_person_aliases WHERE person_id=$1 AND conversation=$2 ORDER BY last_seen DESC,name LIMIT 12',[p.id,job.conversation])).rows.map(r=>r.name);
  return {person_id:p.id,platform:p.platform,platform_user_id:p.platform_user_id,display_name:aliases[0]??p.platform_user_id,aliases};
}

export async function invalidatePersonSessions(c:PoolClient,conversation:string,personId?:string|null):Promise<void>{
  await c.query(`UPDATE life_conversations SET session_id=NULL,generation=generation+1,memory_epoch=memory_epoch+1,
    memory_floor_seq=COALESCE((SELECT max(seq) FROM life_events e WHERE e.conversation=life_conversations.key),0)
    WHERE key=$1 OR ($2::uuid IS NOT NULL AND key IN (SELECT conversation FROM life_conversation_people WHERE person_id=$2))`,[conversation,personId??null]);
}
