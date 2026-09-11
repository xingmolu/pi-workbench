import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

it('isolates actual SDK canonical colliding buckets without changing source v3 files', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-project-sessions-sdk-'))
  const agentDir = join(root, 'agent')
  mkdirSync(join(root, 'home'))
  try {
    const output = execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      import { mkdirSync, readFileSync, writeFileSync, utimesSync, unlinkSync } from 'node:fs';
      import { join } from 'node:path';
      const { SessionManager, getAgentDir } = await import('@earendil-works/pi-coding-agent');
      const root = ${JSON.stringify(root)};
      const agentDir = ${JSON.stringify(agentDir)};
      assert.equal(getAgentDir(), agentDir);
      const a = join(root, 'a-b'), b = join(root, 'a', 'b');
      mkdirSync(a, {recursive:true}); mkdirSync(b, {recursive:true});
      const bucket = cwd => join(agentDir, 'sessions', '--' + cwd.replace(/^[/\\\\]/, '').replace(/[/\\\\:]/g, '-') + '--');
      assert.equal(bucket(a), bucket(b));
      assert.equal(SessionManager.create(a).getSessionDir(), bucket(a));
      mkdirSync(bucket(a), {recursive:true});
      const usage = {input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
      function seed(cwd, id, timestamp) {
        const path = join(bucket(cwd), id + '.jsonl');
        const entries = [
          {type:'session',version:3,id,timestamp,cwd},
          {type:'message',id:id+'u',parentId:null,timestamp,message:{role:'user',content:id+' question',timestamp:Date.parse(timestamp)}},
          {type:'message',id:id+'a',parentId:id+'u',timestamp,message:{role:'assistant',content:[{type:'text',text:id+' answer'}],api:'openai-responses',provider:'openai',model:'fixture',usage,stopReason:'stop',timestamp:Date.parse(timestamp)}}
        ];
        writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\\n')+'\\n');
        utimesSync(path,new Date(timestamp),new Date(timestamp));
        return path;
      }
      const pa = seed(a,'project-a','2026-09-10T00:00:00.000Z');
      const pb = seed(b,'project-b','2026-09-11T00:00:00.000Z');
      const snapshots = [pa,pb].map(p => readFileSync(p,'utf8'));
      assert.equal((await SessionManager.list(a,bucket(a))).length,2);
      assert.equal(SessionManager.continueRecent(a,bucket(a)).getSessionId(),'project-b');
      const { listProjectSessions, continueProjectSession, requireProjectSessionPath, assertProjectSession } = await import('./src/agent-host/project-sessions.ts');
      const listed = await listProjectSessions(SessionManager,a,bucket(a));
      assert.deepEqual(listed.map(s=>s.id),['project-a']);
      assert.equal((await continueProjectSession(SessionManager,a,bucket(a))).getSessionId(),'project-a');
      assert.equal((await continueProjectSession(SessionManager,b,bucket(b))).getSessionId(),'project-b');
      assert.throws(()=>requireProjectSessionPath(listed,a,pb), /会话不属于当前工作区/);
      assert.throws(()=>assertProjectSession(SessionManager.open(pb,bucket(a)),a,a), /会话不属于当前工作区/);
      assert.throws(()=>assertProjectSession(SessionManager.open(pa,bucket(a)),a,b), /会话不属于当前工作区/);
      assert.deepEqual([pa,pb].map(p=>readFileSync(p,'utf8')), snapshots);
      unlinkSync(pa);
      const fresh = await continueProjectSession(SessionManager,a,bucket(a));
      assert.equal(fresh.getCwd(),a);
      assert.equal(fresh.getSessionDir(),bucket(a));
      assert.notEqual(fresh.getSessionId(),'project-b');
      assert.equal(fresh.buildSessionContext().messages.length,0);
      assert.equal(readFileSync(pb,'utf8'),snapshots[1]);
      console.log('canonical isolation verified');
    `
      ],
      {
        cwd: resolve('.'),
        env: {
          PATH: process.env.PATH ?? '',
          HOME: join(root, 'home'),
          PI_CODING_AGENT_DIR: agentDir
        },
        encoding: 'utf8'
      }
    )
    expect(output).toContain('canonical isolation verified')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
