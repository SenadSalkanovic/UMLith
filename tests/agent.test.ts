import {it,expect} from 'vitest';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {ProjectStore} from '../server/store';
import {SyncService} from '../server/sync';
import {JobService} from '../server/jobs';
import {sandboxAvailable} from '../server/sandbox';
it.each([false,true])('runs a fake coding agent in isolation with fragmented output=%s and brings actual changes back for review',async(fragmentOutput)=>{
 if(!await sandboxAvailable())return;
 const dir=await mkdtemp(join(tmpdir(),'architect-agent-'));const store=new ProjectStore(dir);
 const p=await store.create({name:'Agent'});
 await writeFile(join(p.root,'main.ts'),'export function value(): number { return 1; }\n');
 const sync=new SyncService(store,{watch:false});
 const jobs=new JobService(store,sync,{executable:process.execPath,prefixArgs:[resolve('tests/fake-agent.cjs')]});
 try{
  await sync.start(p.id);
  const job=await jobs.create(p.id,{task:'Update value',scope:['main.ts'],settings:{model:JSON.stringify({original:join(p.root,'main.ts'),fragmentOutput})}});
  await expect.poll(async()=> (await jobs.get(p.id,job.id)).status,{timeout:15000}).toBe('review');
  const result=await jobs.get(p.id,job.id);
  expect(result.report?.passed).toBe(true);
  expect(result.report?.changes[0].after).toContain('return 2');
  expect(await readFile(join(p.root,'main.ts'),'utf8')).toContain('return 1');
  const output=result.events.map(e=>e.message).join('');
  expect(output).toContain('original-write-blocked');
  expect(output).not.toContain('original-write-succeeded');
  await jobs.apply(p.id,job.id);
  expect(await readFile(join(p.root,'main.ts'),'utf8')).toContain('return 2');
 }finally{await jobs.close();await sync.close();await rm(dir,{recursive:true,force:true});}
});
