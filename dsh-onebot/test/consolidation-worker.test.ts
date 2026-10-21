import {it,expect} from 'vitest';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Ledger,databaseConfig} from '@local/qqbot-life';

const adminConfig=process.env.LIFE_TEST_ADMIN_CONFIG;
it.skipIf(!adminConfig)('starts the actual consolidation worker on the latest migrated schema without making a model request',async()=>{
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),directory=mkdtempSync(join(tmpdir(),'habit-worker-schema-'));
  const name='qqbot_worker_schema_'+process.pid,control=new Ledger(databaseConfig(adminConfig!));let created=false,ledger:Ledger|undefined;
  try{
    await control.pool.query('CREATE DATABASE '+name);created=true;
    const raw=JSON.parse(readFileSync(adminConfig!,'utf8')),config=join(directory,'db.json'),policy=join(directory,'policy.json'),health=join(directory,'health.json'),worker=join(directory,'worker.json');
    writeFileSync(config,JSON.stringify({...raw,database:name}),{mode:0o600});
    const migrated=spawnSync(process.execPath,[join(root,'life-core/dist/admin.js'),'migrate','--config',config,'--app-password-file',raw.passwordFile.replace('pg-admin-password','pg-app-password')],{encoding:'utf8'});
    expect(migrated.status,migrated.stderr).toBe(0);
    writeFileSync(policy,JSON.stringify({enabled:true,allowedGroupIds:['10001'],ownerIds:[],expectedSelfId:'90001',provider:'deepseek-official',model:'deepseek-flash',databaseConfigFile:config,memory:{enabled:true}}),{mode:0o600});
    writeFileSync(worker,JSON.stringify({enabled:false,policyFile:policy,healthFile:health}),{mode:0o600});
    const run=spawnSync(process.execPath,[join(root,'dsh-onebot/dist/consolidation-worker.js'),'--config',worker,'--once'],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},timeout:10000});
    expect(run.status,run.stderr).toBe(0);expect(JSON.parse(readFileSync(health,'utf8'))).toMatchObject({state:'stopped',processed:0,failed:0});
    ledger=new Ledger({...databaseConfig(adminConfig!),database:name});
    expect((await ledger.pool.query('SELECT count(*)::int AS n FROM life_memory_calls')).rows[0].n).toBe(0);
  }finally{await ledger?.close();if(created)await control.pool.query('DROP DATABASE '+name+' WITH (FORCE)');await control.close();rmSync(directory,{recursive:true,force:true});}
});
