import {writeFile,rename,mkdir,readdir,realpath,lstat,rm,open,type FileHandle} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,relative,dirname,basename,join,isAbsolute,sep,parse} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
export class AppError extends Error {constructor(message:string,public statusCode=400){super(message);}}
export const hash=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
export const ignoredDirs=new Set(['node_modules','.git','dist','build','coverage','.next','.superpowers','.workspace-data','.impeccable','_architect']);
export const excluded=(name:string)=>name==='.env'||name.startsWith('.env.')||['.codex','.claude','.ssh','.aws','.npmrc','.pypirc','auth.json','credentials.json'].includes(name)||name.endsWith('.pem')||name.endsWith('.key');
export function isPathExcluded(path:string):boolean {
 if(!path) return false;
 const parts=path.replace(/\\/g,'/').split('/').filter(Boolean);
 return parts.some(part=>excluded(part)||ignoredDirs.has(part));
}
export function getExclusionReason(path:string):'ignored-directory'|'sensitive-file'|null {
 if(!path) return null;
 const parts=path.replace(/\\/g,'/').split('/').filter(Boolean);
 for(const part of parts){
  if(ignoredDirs.has(part))return 'ignored-directory';
  if(excluded(part))return 'sensitive-file';
 }
 return null;
}
export async function atomicJson(path:string,value:unknown) {
 await mkdir(dirname(path),{recursive:true});
 const temp=path+'.'+randomUUID()+'.tmp';
 try{
  await writeFile(temp,JSON.stringify(value,null,2),{mode:0o600});
  await rename(temp,path);
 }finally{await rm(temp,{force:true}).catch(()=>{});}
}
function projectParts(path:string) {
 // Project keys are canonical, portable relative paths with slash separators.
 if(!path||isAbsolute(path)||/^[a-z]:/i.test(path)||path.includes('\\')||path.includes('\0')||path.split('/').some(p=>!p||p==='.'||p==='..')) throw new AppError('Unsafe project path: '+path);
 return path.split('/');
}
// Descriptor paths pin ancestors; pathname validation alone cannot prevent symlink races.
// shortcut: descriptor-relative access needs procfs/devfd support, add native openat support before enabling other platforms.
const descriptor=(directory:FileHandle,name='')=>join(process.platform==='linux'?'/proc/self/fd':'/dev/fd',String(directory.fd),name);
const directoryFlags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW;
async function inDirectory<T>(directory:FileHandle,parts:string[],create:boolean,action:(directory:FileHandle)=>Promise<T>,validate?:(directory:FileHandle)=>Promise<void>):Promise<T> {
 if(validate)await validate(directory);
 if(!parts.length)return action(directory);
 const path=descriptor(directory,parts[0]);
 if(create)try{await mkdir(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 const child=await open(path,directoryFlags);
 try{return await inDirectory(child,parts.slice(1),create,action,validate);}finally{await child.close();}
}
async function inRoot<T>(root:string,action:(directory:FileHandle,base:string)=>Promise<T>):Promise<T> {
 const base=await realpath(root);const prefix=parse(base).root;
 const directory=await open(prefix,directoryFlags);
 try{return await inDirectory(directory,base.slice(prefix.length).split(sep).filter(Boolean),false,rootDirectory=>action(rootDirectory,base));}finally{await directory.close();}
}
async function inParent<T>(directory:FileHandle,path:string,create:boolean,action:(path:string)=>Promise<T>,validate?:(directory:FileHandle)=>Promise<void>):Promise<T> {
 const parts=projectParts(path);
 return inDirectory(directory,parts.slice(0,-1),create,parent=>action(descriptor(parent,parts[parts.length-1])),validate);
}
async function containsDirectory(ancestor:FileHandle,directory:FileHandle):Promise<boolean> {
 const identity=await ancestor.stat({bigint:true});
 async function check(current:FileHandle):Promise<boolean> {
  const stat=await current.stat({bigint:true});
  if(stat.dev===identity.dev&&stat.ino===identity.ino)return true;
  // Keep /.. literal: path.join would remove the descriptor before the kernel resolves it.
  const parent=await open(descriptor(current)+'/..',directoryFlags);
  try{
   const parentStat=await parent.stat({bigint:true});
   if(stat.dev===parentStat.dev&&stat.ino===parentStat.ino)return false;
   return await check(parent);
  }finally{await parent.close();}
 }
 return check(directory);
}
export async function safePath(root:string,path:string,allowMissing=true):Promise<string> {
 // This validates a pathname now; use the handle-based operations below for actual project I/O.
 projectParts(path);
 const base=await realpath(root);const target=resolve(base,path);
 const rel=relative(base,target);
 if(!rel||rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)) throw new AppError('Path escapes project root');
 const parts=relative(base,target).split(sep);let current=base;
 for(const part of parts) {
  current=join(current,part);
  try { const stat=await lstat(current);if(stat.isSymbolicLink())throw new AppError('Symlink paths are not permitted: '+path); }
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'&&allowMissing)break;throw error;}
 }
 return target;
}
async function walkFiles(directory:FileHandle):Promise<string[]> {
 const result:string[]=[];
 async function walk(parent:FileHandle,dir:string) {
  for(const entry of await readdir(descriptor(parent),{withFileTypes:true})) {
   if(excluded(entry.name)||ignoredDirs.has(entry.name))continue;
   if(entry.isSymbolicLink())continue;
   const path=dir?dir+'/'+entry.name:entry.name;
   projectParts(path);
   if(entry.isDirectory())await inDirectory(parent,[entry.name],false,child=>walk(child,path));
   else if(entry.isFile()) {result.push(path);if(result.length>20000)throw new AppError('Project exceeds 20,000 included files. Import a narrower folder.');}
  }
 }
 await walk(directory,'');return result.sort();
}
export async function listFiles(root:string):Promise<string[]> {return inRoot(root,walkFiles);}
export async function scanProjectDirectory(root:string):Promise<{
 includedFiles:string[];
 excludedEntries:Array<{path:string;reason:'ignored-directory'|'sensitive-file'|'symlink'}>;
}> {
 return inRoot(root,async directory=>{
  const included:string[]=[];
  const excludedList:Array<{path:string;reason:'ignored-directory'|'sensitive-file'|'symlink'}>=[];
  async function walk(parent:FileHandle,dir:string) {
   for(const entry of await readdir(descriptor(parent),{withFileTypes:true})){
    const path=dir?dir+'/'+entry.name:entry.name;
    if(entry.isSymbolicLink()){excludedList.push({path,reason:'symlink'});continue;}
    if(ignoredDirs.has(entry.name)){excludedList.push({path,reason:'ignored-directory'});continue;}
    if(excluded(entry.name)){excludedList.push({path,reason:'sensitive-file'});continue;}
    projectParts(path);
    if(entry.isDirectory())await inDirectory(parent,[entry.name],false,child=>walk(child,path));
    else if(entry.isFile()){
     included.push(path);
     if(included.length>20000)throw new AppError('Project exceeds 20,000 included files. Import a narrower folder.');
    }
   }
  }
  await walk(directory,'');
  return {includedFiles:included.sort(),excludedEntries:excludedList.sort((a,b)=>a.path.localeCompare(b.path))};
 });
}
async function captureDirectory(directory:FileHandle) {
 // File names such as __proto__ must remain ordinary captured entries.
 const files:Record<string,Buffer>=Object.create(null);
 // Source, configuration, manifests and lockfiles retain bytes; analyzers choose eligible source from this capture.
 for(const path of await walkFiles(directory)) {
  files[path]=await inParent(directory,path,false,async full=>{
   const file=await open(full,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
   try{
    const stat=await file.stat();
    if(!stat.isFile())throw new AppError('Not a regular project file: '+path);
    if(stat.size>20*1024*1024)throw new AppError('File exceeds 20 MB: '+path);
    const content=await file.readFile();
    if(content.length>20*1024*1024)throw new AppError('File exceeds 20 MB: '+path);
    return content;
   }finally{await file.close();}
  });
 }
 return files;
}
export async function captureFiles(root:string) {return inRoot(root,captureDirectory);}
export function hashes(files:Record<string,Buffer|{hash:string}>) {
 return Object.fromEntries(Object.entries(files).map(([path,value])=>[path,Buffer.isBuffer(value)?hash(value):value.hash]));
}
export async function copySnapshot(root:string,dest:string) {
 return inRoot(root,async(source,root)=>{
 // Resolve a new destination through its existing ancestor before creating it.
 let ancestor=resolve(dest);const missing:string[]=[];
 while(true){
  try{dest=join(await realpath(ancestor),...missing);break;}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;missing.unshift(basename(ancestor));ancestor=dirname(ancestor);}
 }
 const inside=(base:string,path:string)=>{const rel=relative(base,path);return !rel||rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel);};
 if(inside(root,dest)||inside(dest,root))throw new AppError('Snapshot roots must be separate');
 const files=await captureDirectory(source);
 // Renames can invalidate pathname separation while the source handle remains pinned.
 const outsideSource=async(directory:FileHandle)=>{
  if(await containsDirectory(source,directory))throw new AppError('Snapshot roots must be separate');
 };
 const prefix=parse(dest).root;const directory=await open(prefix,directoryFlags);
 try{await inDirectory(directory,dest.slice(prefix.length).split(sep).filter(Boolean),true,async target=>{
  const separate=async(parent:FileHandle)=>{
   await outsideSource(parent);
   if(await containsDirectory(target,source))throw new AppError('Snapshot roots must be separate');
  };
  await separate(target);
  if((await readdir(descriptor(target))).length)throw new AppError('Snapshot destination must be empty');
  for(const [path,content] of Object.entries(files))await inParent(target,path,true,async full=>{
   try{
    await writeFile(full,content,{flag:'wx'});
    await separate(target);
   }catch(error){
    await rm(full,{force:true}).catch(()=>{});
    throw error;
   }
  },separate);
 },outsideSource);}finally{await directory.close();}
 return hashes(files);
 });
}
export async function removeFile(root:string,path:string){
 projectParts(path);
 return inRoot(root,async directory=>{
 try{await inParent(directory,path,false,async full=>{
  try{if((await lstat(full)).isSymbolicLink())throw new AppError('Symlink paths are not permitted: '+path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  await rm(full,{force:true});
 });}catch(error){
  const code=(error as NodeJS.ErrnoException).code;
  if(code==='ELOOP'||code==='ENOTDIR')throw new AppError('Symlink or non-directory paths are not permitted: '+path);
  if(code!=='ENOENT')throw error;
 }
 });
}
