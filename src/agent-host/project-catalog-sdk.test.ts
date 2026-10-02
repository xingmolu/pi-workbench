import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

it('discovers real SDK history by canonical cwd, including colliding buckets, same names and unavailable projects', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pi-catalog-sdk-')))
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
      import { mkdirSync, writeFileSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs';
      import { join } from 'node:path';
      const { SessionManager } = await import('@earendil-works/pi-coding-agent');
      const { readProjectCatalog } = await import('./src/agent-host/project-catalog.ts');
      const root = ${JSON.stringify(root)}, agentDir = join(root,'agent');
      const a = join(root,'a-b'), b = join(root,'a','b');
      const same1 = join(root,'one','same'), same2 = join(root,'two','same');
      const empty = join(root,'empty'), missing = join(root,'missing');
      for (const cwd of [a,b,same1,same2,empty]) mkdirSync(cwd,{recursive:true});
      const paths = [];
      for (const [index,cwd] of [a,b,same1,same2,missing].entries()) {
        const manager = SessionManager.create(cwd);
        const path = manager.getSessionFile();
        mkdirSync(manager.getSessionDir(),{recursive:true});
        const timestamp = '2026-09-11T00:00:00.000Z';
        writeFileSync(path,[{type:'session',version:3,id:'s'+index,timestamp,cwd},
          {type:'message',id:'u',parentId:null,timestamp,message:{role:'user',content:'title '+index,timestamp:Date.parse(timestamp)}}].map(e=>JSON.stringify(e)).join('\\n')+'\\n');
        paths.push(path);
      }
      assert.equal(SessionManager.create(a).getSessionDir(),SessionManager.create(b).getSessionDir());
      const outside = join(root,'outside'); mkdirSync(outside);
      writeFileSync(join(outside,'outside.jsonl'),readFileSync(paths[0],'utf8').replaceAll(a,outside));
      symlinkSync(outside,join(agentDir,'sessions','linked-bucket'),'dir');
      symlinkSync(join(outside,'outside.jsonl'),join(agentDir,'sessions','linked.jsonl'));
      assert.equal((await SessionManager.listAll(join(agentDir,'sessions'))).length,1);
      const before = paths.map(path=>readFileSync(path,'utf8'));
      const catalog = await readProjectCatalog({manager:SessionManager,agentDir,recentPaths:[empty,a]});
      assert.equal(catalog.projects.length,6);
      assert.equal(catalog.skippedDirectories,1);
      assert.equal(catalog.projects.find(p=>p.path===a).sessions[0].id,'s0');
      assert.equal(catalog.projects.find(p=>p.path===b).sessions[0].id,'s1');
      assert.equal(catalog.projects.filter(p=>p.name==='same').length,2);
      assert.equal(catalog.projects.find(p=>p.path===empty).sessions.length,0);
      assert.equal(catalog.projects.find(p=>p.path===missing).error,'directory-unavailable');
      assert.equal(JSON.stringify(catalog).includes('transcript'),false);
      assert.deepEqual(paths.map(path=>readFileSync(path,'utf8')),before);
      unlinkSync(join(agentDir,'sessions','linked.jsonl'));
      const direct = join(agentDir,'sessions','direct.jsonl');
      writeFileSync(direct,readFileSync(paths[0],'utf8'));
      const directCatalog = await readProjectCatalog({manager:SessionManager,agentDir,recentPaths:[empty,a]});
      assert.equal(directCatalog.projects.find(p=>p.path===a).sessions.some(s=>s.path===direct),true);
      console.log('catalog verified');
    `
      ],
      {
        cwd: resolve('.'),
        env: {
          PATH: process.env.PATH ?? '',
          HOME: join(root, 'home'),
          PI_CODING_AGENT_DIR: join(root, 'agent')
        },
        encoding: 'utf8'
      }
    )
    expect(output).toContain('catalog verified')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
