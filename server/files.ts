import {readFile,writeFile,rename,mkdir,readdir,realpath,lstat,copyFile,rm} from 'node:fs/promises';
import {resolve,relative,dirname,join,isAbsolute,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
export class AppError extends Error {constructor(message:string,public statusCode=400){super(message);}}
export const hash=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
export const ignoredDirs=new Set(['node_modules','.git','dist','build','coverage','.next','.superpowers','.workspace-data','.impeccable','_architect']);
export const excluded=(name:string)=>name==='.env'||name.startsWith('.env.')||['.codex','.claude','.ssh','.aws','.npmrc','.pypirc','auth.json','credentials.json'].includes(name)||name.endsWith('.pem')||name.endsWith('.key');
export async function atomicJson(path:string,value:unknown) {
 await mkdir(dirname(path),{recursive:true});
 const temp=path+'.'+randomUUID()+'.tmp';
 try{
  await writeFile(temp,JSON.stringify(value,null,2),{mode:0o600});
  await rename(temp,path);
 }finally{await rm(temp,{force:true}).catch(()=>{});}
}
export async function safePath(root:string,path:string,allowMissing=true):Promise<string> {
 if(!path||isAbsolute(path)||path.includes('\0')||path.split(/[\\/]/).some(p=>p==='..')) throw new AppError('Unsafe project path: '+path);
 const base=await realpath(root);const target=resolve(base,path);
 if(target===base||!target.startsWith(base+sep)) throw new AppError('Path escapes project root');
 const parts=relative(base,target).split(sep);let current=base;
 for(const part of parts) {
  current=join(current,part);
  try { const stat=await lstat(current);if(stat.isSymbolicLink())throw new AppError('Symlink paths are not permitted: '+path); }
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'&&allowMissing)break;throw error;}
 }
 return target;
}
export async function listFiles(root:string):Promise<string[]> {
 const result:string[]=[];
 async function walk(dir:string) {
  for(const entry of await readdir(join(root,dir),{withFileTypes:true})) {
   if(excluded(entry.name)||ignoredDirs.has(entry.name))continue;
   if(entry.isSymbolicLink())continue;
   const path=dir?dir+'/'+entry.name:entry.name;
   if(entry.isDirectory())await walk(path);
   else if(entry.isFile()) {result.push(path);if(result.length>20000)throw new AppError('Project exceeds 20,000 included files. Import a narrower folder.');}
  }
 }
 await walk('');return result.sort();
}
export async function captureFiles(root:string) {
 const files:Record<string,Buffer>={};
 for(const path of await listFiles(root)) {
  const full=await safePath(root,path,false);
  const stat=await lstat(full);
  if(stat.size>20*1024*1024)throw new AppError('File exceeds 20 MB: '+path);
  files[path]=await readFile(full);
 }
 return files;
}
export function hashes(files:Record<string,Buffer|{hash:string}>) {
 return Object.fromEntries(Object.entries(files).map(([path,value])=>[path,Buffer.isBuffer(value)?hash(value):value.hash]));
}
export async function copySnapshot(root:string,dest:string) {
 const files=await captureFiles(root);await mkdir(dest,{recursive:true});
 for(const [path,content] of Object.entries(files)) {
  const full=await safePath(dest,path);await mkdir(dirname(full),{recursive:true});await writeFile(full,content);
 }
 return hashes(files);
}
export async function removeFile(root:string,path:string){await rm(await safePath(root,path),{force:true});}
