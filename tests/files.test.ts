import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,readdir,truncate,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {captureFiles,copySnapshot,hash,hashes,listFiles,removeFile,safePath} from '../server/files';

// Pause actual I/O at the access boundary to reproduce concurrent path replacement.
const race=vi.hoisted(()=>({before:undefined as undefined|((operation:string,path:string)=>Promise<void>),
 after:undefined as undefined|((operation:string,path:string)=>Promise<void>)}));
vi.mock('node:fs/promises',async(importOriginal)=>{
 const fs=await importOriginal<typeof import('node:fs/promises')>();
 return {...fs,...Object.fromEntries(['readFile','writeFile','open','mkdir','rm','realpath','readdir','lstat'].map(operation=>[operation,async(...args:unknown[])=>{
  await race.before?.(operation,String(args[0]));
  const result=await (fs[operation as keyof typeof fs] as (...args:unknown[])=>unknown)(...args);
  await race.after?.(operation,String(args[0]));
  return result;
 }]))};
});

let dir:string,root:string;
beforeEach(async()=>{
 dir=await mkdtemp(join(tmpdir(),'architect-files-'));
 root=join(dir,'project');await mkdir(root);
});
afterEach(async()=>{race.before=undefined;race.after=undefined;await rm(dir,{recursive:true,force:true});});

describe('project path boundary',()=>{
 it.each(['','.', '..','../project-other/file.ts','src/../../outside','/outside','src\0/file',
  'C:/outside','C:outside','\\\\host\\share\\file','src\\file.ts','./src/file.ts','src//file.ts','src/./file.ts','src/'])('rejects unsafe or noncanonical path %j',async(path)=>{
  await expect(safePath(root,path)).rejects.toThrow();
  await expect(removeFile(root,path)).rejects.toThrow();
 });
 it('resolves canonical paths, allows new files explicitly, and rejects missing reads',async()=>{
  await mkdir(join(root,'src'));await writeFile(join(root,'src','a.ts'),'a');
  expect(await safePath(root,'src/a.ts',false)).toBe(join(root,'src','a.ts'));
  expect(await safePath(root,'new/file.ts')).toBe(join(root,'new','file.ts'));
  await expect(safePath(root,'new/file.ts',false)).rejects.toMatchObject({code:'ENOENT'});
  await expect(safePath(root,'src/a.ts/child')).rejects.toThrow();
 });
 it('rejects file, directory, dangling, and internal symlinks without deleting their targets',async()=>{
  const sibling=join(dir,'project-other');await mkdir(sibling);await writeFile(join(sibling,'file.ts'),'outside');
  await writeFile(join(root,'local.ts'),'inside');
  await symlink(sibling,join(root,'escape'),'dir');
  await symlink(join(sibling,'file.ts'),join(root,'linked.ts'));
  await symlink(join(dir,'absent'),join(root,'dangling'));
  await symlink(join(root,'local.ts'),join(root,'internal.ts'));
  for(const path of ['escape/file.ts','escape/new.ts','linked.ts','dangling/new.ts','internal.ts']){
   await expect(safePath(root,path)).rejects.toThrow('Symlink');
   await expect(removeFile(root,path)).rejects.toThrow('Symlink');
  }
  expect(await listFiles(root)).toEqual(['local.ts']);
  expect(Object.keys(await captureFiles(root))).toEqual(['local.ts']);
  expect(await readFile(join(sibling,'file.ts'),'utf8')).toBe('outside');
 });
 it('anchors an approved root alias to its canonical directory',async()=>{
  const alias=join(dir,'alias');await symlink(root,alias,'dir');
  await writeFile(join(root,'a.ts'),'a');
  expect(await safePath(alias,'a.ts',false)).toBe(join(root,'a.ts'));
  expect(await listFiles(alias)).toEqual(['a.ts']);
 });
});

describe('captured bytes and inputs',()=>{
 it('preserves binary, empty, Unicode, and prototype-named files in independent snapshots',async()=>{
  const content:Record<string,Buffer>=Object.fromEntries([
   ['binary.bin',Buffer.from([0,255,128,13,10])],['empty.ts',Buffer.alloc(0)],
   ['unicode.ts',Buffer.from('\uFEFF// café 😀\r\n')],['__proto__',Buffer.from('prototype')],['constructor',Buffer.from('constructor')],
  ]);
  for(const [path,bytes] of Object.entries(content))await writeFile(join(root,path),bytes);
  const captured=await captureFiles(root);
  expect(Object.keys(captured).sort()).toEqual(['__proto__','binary.bin','constructor','empty.ts','unicode.ts']);
  expect(hashes(captured)['empty.ts']).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const dest=join(dir,'snapshot');const copiedHashes=await copySnapshot(root,dest);
  for(const [path,bytes] of Object.entries(content)){
   expect(captured[path]).toEqual(bytes);
   expect(await readFile(join(dest,path))).toEqual(bytes);
   const digest=createHash('sha256').update(bytes).digest('hex');
   expect(hash(bytes)).toBe(digest);expect(copiedHashes[path]).toBe(digest);
  }
  await writeFile(join(dest,'unicode.ts'),'changed');
  expect(await readFile(join(root,'unicode.ts'))).toEqual(content['unicode.ts']);
 });
 it('retains source, declarations, configuration and dependency manifests while excluding generated and private inputs',async()=>{
  const included=['src/main.ts','src/types.d.ts','schema.prisma','tsconfig.json','package.json','package-lock.json','pnpm-lock.yaml','yarn.lock','README.md'];
  const omitted=['node_modules/pkg/index.d.ts','dist/output.ts','build/output.ts','coverage/report.json','.git/config',
   'src/.env','src/.env.local','.codex/auth.json','.aws/credentials','.ssh/id_rsa','.npmrc','.pypirc','credentials.json','auth.json','tls.pem','tls.key','_architect/task.md'];
  for(const path of [...included,...omitted]){
   await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),'fixture');
  }
  expect(await listFiles(root)).toEqual([...included].sort());
  const dest=join(dir,'snapshot');await copySnapshot(root,dest);
  expect(await listFiles(dest)).toEqual([...included].sort());
  expect((await readdir(dest)).sort()).toEqual(['README.md','package-lock.json','package.json','pnpm-lock.yaml','schema.prisma','src','tsconfig.json','yarn.lock']);
 });
 it('reflects additions and deletions without changing older captures',async()=>{
  await writeFile(join(root,'old.ts'),'old');const first=await captureFiles(root);
  await removeFile(root,'old.ts');await removeFile(root,'missing.ts');await writeFile(join(root,'new.ts'),'new');
  const next=await captureFiles(root);
  expect(Object.keys(next)).toEqual(['new.ts']);expect(next['new.ts']).toEqual(Buffer.from('new'));
  expect(first['old.ts']).toEqual(Buffer.from('old'));
  const dest=join(dir,'snapshot');await copySnapshot(root,dest);expect(await readdir(dest)).toEqual(['new.ts']);
 });
 it('fails closed on oversized files',async()=>{
  const path=join(root,'large.bin');await writeFile(path,'');await truncate(path,20*1024*1024+1);
  await expect(captureFiles(root)).rejects.toThrow('20 MB');
  await expect(copySnapshot(root,join(dir,'snapshot'))).rejects.toThrow('20 MB');
 });
});

describe('snapshot destination boundary',()=>{
 it('rejects reused destinations without overwriting or retaining unrelated files',async()=>{
  await writeFile(join(root,'a.ts'),'source');const dest=join(dir,'snapshot');await mkdir(dest);
  await writeFile(join(dest,'a.ts'),'existing');await writeFile(join(dest,'deleted.ts'),'stale');
  await expect(copySnapshot(root,dest)).rejects.toThrow();
  expect(await readFile(join(dest,'a.ts'),'utf8')).toBe('existing');
  expect(await readFile(join(dest,'deleted.ts'),'utf8')).toBe('stale');
 });
 it('rejects overlapping roots including aliases before creating snapshot files',async()=>{
  await writeFile(join(root,'a.ts'),'source');const alias=join(dir,'alias');await symlink(root,alias,'dir');
  for(const dest of [root,join(root,'nested'),alias,join(alias,'nested'),dir])await expect(copySnapshot(root,dest)).rejects.toThrow();
  expect(await readdir(root)).toEqual(['a.ts']);
 });
 it('accepts a separate existing empty directory and sibling-prefix root',async()=>{
  await writeFile(join(root,'a.ts'),'source');const dest=join(dir,'project-other');await mkdir(dest);
  await copySnapshot(root,dest);expect(await readFile(join(dest,'a.ts'),'utf8')).toBe('source');
 });
});

describe('concurrent path replacement',()=>{
 it.each(['before capture','during destination traversal'])('rejects a source renamed into the destination ancestry %s',async(timing)=>{
  await writeFile(join(root,'a.ts'),'inside');
  const moved=join(dir,'snapshot');const dest=join(moved,'nested');let replaced=false;
  race.before=async(operation,path)=>{
   if(!replaced&&((timing==='before capture'&&operation==='readdir'&&path.startsWith('/proc/self/fd/'))||
    (timing==='during destination traversal'&&operation==='mkdir'&&path.endsWith('/snapshot')))){
    replaced=true;await rename(root,moved);
   }
  };
  await expect(copySnapshot(root,dest)).rejects.toThrow('Snapshot roots must be separate');
  expect(replaced).toBe(true);
  expect(await readdir(moved)).toEqual(['a.ts']);
  expect(await readFile(join(moved,'a.ts'),'utf8')).toBe('inside');
 });
 it('rejects an empty pinned source renamed to the destination',async()=>{
  const dest=join(dir,'snapshot');let replaced=false;
  race.before=async(operation,path)=>{
   if(!replaced&&operation==='readdir'&&path.startsWith('/proc/self/fd/')){
    replaced=true;await rename(root,dest);
   }
  };
  await expect(copySnapshot(root,dest)).rejects.toThrow('Snapshot roots must be separate');
  expect(replaced).toBe(true);
  expect(await readdir(dest)).toEqual([]);
 });
 it('rejects a pinned destination moved beneath the source before copying entries',async()=>{
  await writeFile(join(root,'a.ts'),'inside');
  const dest=join(dir,'snapshot');await mkdir(dest);let reads=0,replaced=false;
  race.before=async(operation,path)=>{
   if(operation==='readdir'&&path.startsWith('/proc/self/fd/')&&++reads===2){
    replaced=true;await rename(dest,join(root,'snapshot'));
   }
  };
  await expect(copySnapshot(root,dest)).rejects.toThrow('Snapshot roots must be separate');
  expect(replaced).toBe(true);
  expect(await readdir(join(root,'snapshot'))).toEqual([]);
  expect(await readFile(join(root,'a.ts'),'utf8')).toBe('inside');
 });
 it('never writes into the original project when the destination moves immediately before a write',async()=>{
  await writeFile(join(root,'a.ts'),'inside');
  const dest=join(dir,'snapshot');await mkdir(dest);let replaced=false;
  race.before=async(operation,path)=>{
   if(!replaced&&operation==='writeFile'&&path.startsWith('/proc/self/fd/')&&path.endsWith('/a.ts')){
    replaced=true;await rename(dest,join(root,'snapshot'));
   }
  };
  const result=copySnapshot(root,dest);
  await expect(result).rejects.toThrow();
  expect(replaced).toBe(true);
  expect(await readdir(join(root,'snapshot'))).toEqual([]);
  expect(await readFile(join(root,'a.ts'),'utf8')).toBe('inside');
 });
 it.each(['enumeration','capture','snapshot','deletion'])('rejects root replacement after canonical resolution during %s',async(operation)=>{
  await writeFile(join(root,'a.ts'),'inside');
  const outside=join(dir,'outside');await mkdir(outside);await writeFile(join(outside,'a.ts'),'outside');
  const dest=join(dir,'snapshot');let replaced=false;
  race.after=async(action,path)=>{
   if(!replaced&&action==='realpath'&&path===root){
    replaced=true;await rename(root,join(dir,'original'));await symlink(outside,root,'dir');
   }
  };
  const result=operation==='enumeration'?listFiles(root):operation==='capture'?captureFiles(root):
   operation==='snapshot'?copySnapshot(root,dest):removeFile(root,'a.ts');
  await expect(result).rejects.toThrow();expect(replaced).toBe(true);
  expect(await readFile(join(outside,'a.ts'),'utf8')).toBe('outside');
  expect(await readFile(join(dir,'original','a.ts'),'utf8')).toBe('inside');
  if(operation==='snapshot')await expect(readFile(join(dest,'a.ts'))).rejects.toMatchObject({code:'ENOENT'});
 });
 it.each(['enumeration','capture','snapshot','deletion'])('uses the original pinned root after replacement during %s',async(operation)=>{
  await writeFile(join(root,'a.ts'),'inside');
  const outside=join(dir,'outside');await mkdir(outside);await writeFile(join(outside,'a.ts'),'outside');
  const dest=join(dir,'snapshot');let replaced=false;
  race.before=async(action,path)=>{
   if(!replaced&&((operation==='deletion'&&action==='lstat'&&path.endsWith('/a.ts'))||
    (operation!=='deletion'&&action==='readdir'&&path.startsWith('/proc/self/fd/')))){
    replaced=true;await rename(root,join(dir,'original'));await symlink(outside,root,'dir');
   }
  };
  if(operation==='enumeration')expect(await listFiles(root)).toEqual(['a.ts']);
  else if(operation==='capture')expect((await captureFiles(root))['a.ts']).toEqual(Buffer.from('inside'));
  else if(operation==='snapshot'){
   await copySnapshot(root,dest);expect(await readFile(join(dest,'a.ts'),'utf8')).toBe('inside');
  }else{
   await removeFile(root,'a.ts');await expect(readFile(join(dir,'original','a.ts'))).rejects.toMatchObject({code:'ENOENT'});
  }
  expect(replaced).toBe(true);expect(await readFile(join(outside,'a.ts'),'utf8')).toBe('outside');
 });
 it.each([['enumeration',listFiles],['capture',captureFiles]] as const)('rejects a replaced directory during %s',async(_name,operation)=>{
  await mkdir(join(root,'nested'));await writeFile(join(root,'nested','a.ts'),'inside');
  const outside=join(dir,'outside');await mkdir(outside);await writeFile(join(outside,'a.ts'),'outside');
  let replaced=false;
  race.before=async(action,path)=>{
   if(!replaced&&action==='open'&&path.endsWith('/nested')){
    replaced=true;const {rename}=await import('node:fs/promises');
    await rename(join(root,'nested'),join(root,'old-nested'));await symlink(outside,join(root,'nested'),'dir');
   }
  };
  await expect(operation(root)).rejects.toThrow();expect(replaced).toBe(true);
 });
 it('never captures an outside file substituted immediately before opening it',async()=>{
  const outside=join(dir,'outside.ts');await writeFile(outside,'outside');await writeFile(join(root,'a.ts'),'inside');
  let replaced=false;
  race.before=async(operation,path)=>{
   if(!replaced&&['open','readFile'].includes(operation)&&path.endsWith('/a.ts')){
    replaced=true;await rm(join(root,'a.ts'));await symlink(outside,join(root,'a.ts'));
   }
  };
  await expect(captureFiles(root)).rejects.toThrow();expect(replaced).toBe(true);
 });
 it('never copies through a directory link added immediately before parent creation',async()=>{
  await mkdir(join(root,'nested'));await writeFile(join(root,'nested','a.ts'),'inside');
  const outside=join(dir,'outside');await mkdir(outside);const dest=join(dir,'snapshot');
  let replaced=false;
  race.before=async(operation,path)=>{
   if(!replaced&&operation==='mkdir'&&path.endsWith('/nested')){
    replaced=true;await symlink(outside,join(dest,'nested'),'dir');
   }
  };
  await expect(copySnapshot(root,dest)).rejects.toThrow();expect(replaced).toBe(true);
  expect(await readdir(outside)).toEqual([]);
 });
 it('keeps deletion inside the pinned parent when its pathname is replaced',async()=>{
  await mkdir(join(root,'nested'));await writeFile(join(root,'nested','a.ts'),'inside');
  const outside=join(dir,'outside');await mkdir(outside);await writeFile(join(outside,'a.ts'),'outside');
  let replaced=false;
  race.before=async(operation,path)=>{
   if(!replaced&&operation==='rm'&&path.endsWith('/a.ts')){
    replaced=true;
    const {rename}=await import('node:fs/promises');
    await rename(join(root,'nested'),join(root,'old-nested'));await symlink(outside,join(root,'nested'),'dir');
   }
  };
  await removeFile(root,'nested/a.ts');expect(replaced).toBe(true);
  expect(await readFile(join(outside,'a.ts'),'utf8')).toBe('outside');
 });
});
