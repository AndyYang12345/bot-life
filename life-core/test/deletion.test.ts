import { describe, it, expect } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

describe('offline channel erasure boundaries', () => {
  it.each([0,1])('removes scoped files and resumes cleanup with %i remaining scopes', remainingScopes => {
    const root=mkdtempSync(join(tmpdir(),'life-delete-'));
    const session='00000000-0000-4000-8000-000000000001';
    const conversation='onebot:100:group:300';
    try {
      for(const path of ['scripts','bin','workspace/media','data/adapter/inbox-spool','data/adapter/event-spool','data/dsh-home/sessions/project/'+session,'data/dsh-home/attachments','data/dsh-home/storages/session_projcache/sessions'])mkdirSync(join(root,path),{recursive:true});
      copyFileSync('../scripts/life-delete',join(root,'scripts/life-delete'));
      const outside=join(root,'private.txt'), media=join(root,'workspace/media/image.png'), link=join(root,'workspace/media/link.png');
      writeFileSync(outside,'private');writeFileSync(media,'image');symlinkSync(outside,link);
      writeFileSync(join(root,'data/dsh-home/attachments/shared'),'retained');
      writeFileSync(join(root,'data/adapter/inbox-spool/a.json'),JSON.stringify({value:{conversation}}));
      writeFileSync(join(root,'data/adapter/inbox-spool/b.json'),JSON.stringify({value:{conversation:'other'}}));
      writeFileSync(join(root,'data/adapter/adapter-state.json'),JSON.stringify({sessions:{'100:group:300':session,'other':'retain'}}));
      const plan={conversation,deletedEvents:3,sessions:[session],orphanPaths:[media,link,outside],remainingScopes};
      writeFileSync(join(root,'plan.json'),JSON.stringify(plan));
      writeFileSync(join(root,'bin/systemctl'),'#!/bin/sh\necho inactive\n');chmodSync(join(root,'bin/systemctl'),0o755);
      writeFileSync(join(root,'scripts/life-admin'),`#!/usr/bin/env python3
import json,sys,pathlib
r=pathlib.Path(__file__).resolve().parents[1]
if sys.argv[1]=='scope-status': print(json.dumps({'events':0}))
else:
 p=json.loads((r/'plan.json').read_text());m=pathlib.Path(sys.argv[sys.argv.index('--manifest')+1]);m.write_text(json.dumps(p));print(json.dumps(p))
`);chmodSync(join(root,'scripts/life-admin'),0o755);
      const env={...process.env,PATH:join(root,'bin')+':'+process.env.PATH};
      const result=spawnSync('python3',[join(root,'scripts/life-delete'),'--conversation',conversation],{encoding:'utf8',env});
      expect(result.status,result.stderr).toBe(0);expect(existsSync(media)).toBe(false);expect(existsSync(outside)).toBe(true);expect(existsSync(link)).toBe(true);
      expect(existsSync(join(root,'data/adapter/inbox-spool/a.json'))).toBe(false);expect(existsSync(join(root,'data/adapter/inbox-spool/b.json'))).toBe(true);
      expect(existsSync(join(root,'data/dsh-home/sessions/project',session))).toBe(false);expect(existsSync(join(root,'data/dsh-home/attachments/shared'))).toBe(remainingScopes>0);
      expect(JSON.parse(readFileSync(join(root,'data/adapter/adapter-state.json'),'utf8')).sessions).toEqual({other:'retain'});
      const manifest=join(root,'data/deletions',readdirSync(join(root,'data/deletions'))[0]!);
      const resumed=spawnSync('python3',[join(root,'scripts/life-delete'),'--resume',manifest],{encoding:'utf8',env});
      expect(resumed.status,resumed.stderr).toBe(0);
    }finally{rmSync(root,{recursive:true,force:true});}
  });
});
