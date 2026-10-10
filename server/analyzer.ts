import ts from 'typescript';
import {getSchema,PrismaParser,VisitorClassFactory,type Field,type Model} from '@mrleebo/prisma-ast';
import {resolve,relative,basename,dirname} from 'node:path';
import {performance} from 'node:perf_hooks';
import {NodeSchema,GRAPH_SCHEMA_VERSION,type Analysis,type Graph,type ProgramNode,type Source,type Diagnostic,type ProgramEdge} from '../shared/model';
import {captureFiles,captureSourceRevision,isRevisionIncomplete,type CaptureOptions,type CapturedRevision,scanProjectDirectory,hash,AppError} from './files';
const idFor=(key:string)=>hash(key).slice(0,24);
const normalize=(value:string)=>value.replace(/\s+/g,' ').trim();

export const TYPESCRIPT_PIN = '6.0.3';

export function checkCompilerPin(): { pinned: string; installed: string; compatible: boolean } {
 return {
  pinned: TYPESCRIPT_PIN,
  installed: ts.version,
  compatible: ts.version === TYPESCRIPT_PIN,
 };
}

export function isTypeScriptVersionCompatible(range: string, pin = TYPESCRIPT_PIN): boolean {
 const cleaned = range.trim();
 if (cleaned === '*' || cleaned === 'latest' || cleaned === pin) return true;
 const match = cleaned.match(/^[\^~>=<]?\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
 if (match) {
  const major = parseInt(match[1], 10);
  const pinMajor = parseInt(pin.split('.')[0], 10);
  if (cleaned.startsWith('<') && !cleaned.startsWith('<=')) {
   if (major <= pinMajor) return false;
  }
  if (major !== pinMajor && !cleaned.includes('>=')) {
   return false;
  }
 }
 return true;
}

export type InputCategory =
 | 'typescript-source'
 | 'prisma-schema'
 | 'typescript-declaration'
 | 'typescript-config'
 | 'dependency-manifest'
 | 'dependency-lockfile'
 | 'configuration'
 | 'non-analysis-asset';

export type ExclusionCategory =
 | 'ignored-directory'
 | 'sensitive-file'
 | 'declaration'
 | 'non-analysis-asset'
 | 'unsupported-language'
 | 'symlink';

export interface DiscoveredInclusion {
 category: InputCategory;
 reason: string;
 eligible: boolean;
 requiredForResolution: boolean;
 participatesInRevision: boolean;
}

export interface DiscoveredExclusion {
 category: ExclusionCategory;
 reason: string;
}

export interface IncompatibleInputDiagnostic {
 path: string;
 message: string;
 code?: string;
 severity: 'error' | 'warning';
}

export interface AnalysisInputDiscovery {
 compilerPin: { pinned: string; installed: string; compatible: boolean };
 eligibleFiles: string[];
 configuredSourceFiles: string[];
 unconfiguredSourceFiles: string[];
 prismaSchemas: string[];
 configurationFiles: string[];
 manifestFiles: string[];
 lockfiles: string[];
 declarationFiles: string[];
 dependencyInputs: string[];
 trackingInputs: string[];
 inclusions: Record<string, DiscoveredInclusion>;
 exclusions: Record<string, DiscoveredExclusion>;
 incompatibleInputs: IncompatibleInputDiagnostic[];
 denominator: number;
}

export function createParseConfigHost(
 root: string,
 files: Record<string, { hash?: string; text: string } | Buffer | string>
): ts.ParseConfigHost {
 const normRoot = resolve(root).replaceAll('\\', '/').replace(/\/$/, '');
 const getRel = (p: string): string | null => {
  const norm = resolve(p).replaceAll('\\', '/');
  if (norm === normRoot) return '';
  if (norm.startsWith(normRoot + '/')) return norm.slice(normRoot.length + 1);
  return null;
 };
 const getText = (rel: string): string | undefined => {
  const entry = files[rel];
  if (entry === undefined) return undefined;
  if (typeof entry === 'string') return entry;
  if (Buffer.isBuffer(entry)) return entry.toString('utf8');
  return entry.text;
 };

 return {
  useCaseSensitiveFileNames: true,
  fileExists: (filePath: string) => {
   const rel = getRel(filePath);
   if (rel !== null) {
    if (rel in files) return true;
    if (rel.startsWith('node_modules/')) return ts.sys.fileExists(filePath);
    return false;
   }
   return ts.sys.fileExists(filePath);
  },
  readFile: (filePath: string) => {
   const rel = getRel(filePath);
   if (rel !== null) {
    if (rel in files) return getText(rel);
    if (rel.startsWith('node_modules/')) return ts.sys.readFile(filePath);
    return undefined;
   }
   return ts.sys.readFile(filePath);
  },
  directoryExists: (dir: string) => {
   const rel = getRel(dir);
   if (rel !== null) {
    if (rel === '') return true;
    const prefix = rel + '/';
    if (Object.keys(files).some(k => k.startsWith(prefix))) return true;
    if (rel.startsWith('node_modules/') || rel === 'node_modules') return ts.sys.directoryExists(dir);
    return false;
   }
   return ts.sys.directoryExists(dir);
  },
  readDirectory: (
   dir: string,
   extensions: readonly string[],
   excludes: readonly string[] | undefined,
   includes: readonly string[] | undefined,
   depth?: number
  ) => {
   const normDir = resolve(dir).replaceAll('\\', '/').replace(/\/$/, '');
   const relDir = getRel(normDir);
   if (relDir !== null) {
    const dirPrefix = relDir === '' ? '' : relDir + '/';
    const getFileSystemEntries = (d: string) => {
     const normD = resolve(d).replaceAll('\\', '/').replace(/\/$/, '');
     const dRel = getRel(normD);
     const prefix = dRel === null || dRel === '' ? '' : dRel + '/';
     const fileList: string[] = [];
     const dirSet = new Set<string>();
     for (const key of Object.keys(files)) {
      if (prefix === '' || key.startsWith(prefix)) {
       const rest = key.slice(prefix.length);
       const slashIdx = rest.indexOf('/');
       if (slashIdx === -1) {
        fileList.push(rest);
       } else {
        dirSet.add(rest.slice(0, slashIdx));
       }
      }
     }
     return { files: fileList, directories: Array.from(dirSet) };
    };
    return (ts as any).matchFiles(
     normDir,
     extensions,
     excludes,
     includes,
     true,
     normRoot,
     depth,
     getFileSystemEntries,
     (p: string) => p
    );
   }
   return ts.sys.readDirectory(dir, extensions, excludes, includes, depth);
  },
  trace: () => {},
 };
}

export async function discoverAnalysisInputs(
 root: string,
 capturedFiles?: Record<string, Buffer | { hash: string; text: string }>,
 scannedExclusions?: Array<{ path: string; reason: 'ignored-directory' | 'sensitive-file' | 'symlink' }>
): Promise<AnalysisInputDiscovery> {
 const compilerPin = checkCompilerPin();
 let files: Record<string, { hash: string; text: string }>;
 let diskExclusions = scannedExclusions;

 if (capturedFiles) {
  files = Object.fromEntries(
   Object.entries(capturedFiles).map(([path, data]) => [
    path,
    Buffer.isBuffer(data) ? { hash: hash(data), text: data.toString('utf8') } : data,
   ])
  );
 } else {
  let scanResult: { includedFiles: string[]; excludedEntries: Array<{ path: string; reason: 'ignored-directory' | 'sensitive-file' | 'symlink' }> } | undefined;
  try {
   scanResult = await scanProjectDirectory(root);
   diskExclusions = scanResult.excludedEntries;
  } catch {
   diskExclusions = [];
  }
  const captured = await captureFiles(root);
  files = Object.fromEntries(
   Object.entries(captured).map(([path, data]) => [
    path,
    { hash: hash(data), text: data.toString('utf8') },
   ])
  );
 }

 if (!diskExclusions) {
  try {
   const scan = await scanProjectDirectory(root);
   diskExclusions = scan.excludedEntries;
  } catch {
   diskExclusions = [];
  }
 }

 const inclusions: Record<string, DiscoveredInclusion> = {};
 const exclusions: Record<string, DiscoveredExclusion> = {};
 const incompatibleInputs: IncompatibleInputDiagnostic[] = [];

 for (const entry of diskExclusions) {
  exclusions[entry.path] = {
   category: entry.reason,
   reason:
    entry.reason === 'ignored-directory'
     ? `Ignored directory (${entry.path}) excluded from project analysis`
     : entry.reason === 'sensitive-file'
     ? `Sensitive credential or environment file (${entry.path}) excluded for security`
     : `Symbolic link (${entry.path}) excluded to prevent escape or aliasing`,
  };
 }

 const eligibleFiles: string[] = [];
 const prismaSchemas: string[] = [];
 const declarationFiles: string[] = [];
 const configurationFiles: string[] = [];
 const manifestFiles: string[] = [];
 const lockfiles: string[] = [];
 const otherConfigs: string[] = [];

 const allCapturedPaths = Object.keys(files).sort();

 for (const p of allCapturedPaths) {
  if (/\.prisma$/i.test(p)) {
   prismaSchemas.push(p);
   eligibleFiles.push(p);
   inclusions[p] = {
    category: 'prisma-schema',
    reason: 'Eligible Prisma schema for entity and relationship extraction',
    eligible: true,
    requiredForResolution: true,
    participatesInRevision: true,
   };
  } else if (/\.d\.[cm]?ts$/i.test(p)) {
   declarationFiles.push(p);
   inclusions[p] = {
    category: 'typescript-declaration',
    reason: 'TypeScript declaration file (excluded from code structure; required for type resolution)',
    eligible: false,
    requiredForResolution: true,
    participatesInRevision: true,
   };
   exclusions[p] = {
    category: 'declaration',
    reason: 'Declaration file excluded from code-structure analysis',
   };
  } else if (/\.(?:[cm]?ts|tsx)$/i.test(p)) {
   eligibleFiles.push(p);
   inclusions[p] = {
    category: 'typescript-source',
    reason: 'Eligible TypeScript source file for code architecture analysis',
    eligible: true,
    requiredForResolution: true,
    participatesInRevision: true,
   };
  } else if (/(?:^|\/)tsconfig[^/]*\.json$/i.test(p)) {
   configurationFiles.push(p);
   inclusions[p] = {
    category: 'typescript-config',
    reason: 'TypeScript project configuration driving compiler options and references',
    eligible: false,
    requiredForResolution: true,
    participatesInRevision: true,
   };
  } else if (/(?:^|\/)package\.json$/i.test(p)) {
   manifestFiles.push(p);
   inclusions[p] = {
    category: 'dependency-manifest',
    reason: 'Package dependency manifest defining dependencies and runtime metadata',
    eligible: false,
    requiredForResolution: true,
    participatesInRevision: true,
   };
  } else if (/(?:^|\/)(?:package-lock\.json|pnpm-lock\.ya?ml|yarn\.lock|bun\.lockb?)$/i.test(p) || /lock/i.test(p)) {
   lockfiles.push(p);
   inclusions[p] = {
    category: 'dependency-lockfile',
    reason: 'Dependency lockfile pinning exact package versions',
    eligible: false,
    requiredForResolution: true,
    participatesInRevision: true,
   };
  } else if (/\.json$/i.test(p)) {
   otherConfigs.push(p);
   inclusions[p] = {
    category: 'configuration',
    reason: 'Project JSON configuration or data input',
    eligible: false,
    requiredForResolution: true,
    participatesInRevision: true,
   };
  } else {
   inclusions[p] = {
    category: 'non-analysis-asset',
    reason: 'Non-code asset or documentation file not targeted for structural analysis',
    eligible: false,
    requiredForResolution: false,
    participatesInRevision: false,
   };
   exclusions[p] = {
    category: 'non-analysis-asset',
    reason: 'Non-code asset file excluded from structural analysis',
   };
  }
 }

 for (const pkgPath of manifestFiles) {
  try {
   const pkg = JSON.parse(files[pkgPath].text);
   const tsDep = pkg.dependencies?.typescript || pkg.devDependencies?.typescript || pkg.peerDependencies?.typescript;
   if (tsDep && typeof tsDep === 'string') {
    if (!isTypeScriptVersionCompatible(tsDep, TYPESCRIPT_PIN)) {
     incompatibleInputs.push({
      path: pkgPath,
      message: `Project specifies TypeScript "${tsDep}" in ${pkgPath}, which differs from pinned compiler ${TYPESCRIPT_PIN}.`,
      severity: 'warning',
      code: 'incompatible-compiler-version',
     });
    }
   }
  } catch (e) {
   incompatibleInputs.push({
    path: pkgPath,
    message: `Invalid package manifest in ${pkgPath}: ${(e as Error).message}`,
    severity: 'error',
    code: 'invalid-manifest',
   });
  }
 }

 const tsSourceFiles = eligibleFiles.filter(p => !p.endsWith('.prisma'));
 const fullTsPaths = new Set(tsSourceFiles.map(p => resolve(root, p)));
 const configuredSourcesSet = new Set<string>();

 const parseHost = createParseConfigHost(root, files);
 for (const configPath of configurationFiles) {
  const config = ts.parseConfigFileTextToJson(configPath, files[configPath].text);
  if (config.error) {
   incompatibleInputs.push({
    path: configPath,
    message: ts.flattenDiagnosticMessageText(config.error.messageText, ' '),
    severity: 'error',
    code: String(config.error.code),
   });
   continue;
  }
  if (config.config) {
   const configDir = resolve(root, dirname(configPath));
   const configFilePath = resolve(root, configPath);
   const parsed = ts.parseJsonConfigFileContent(config.config, parseHost, configDir, undefined, configFilePath);
   for (const d of parsed.errors) {
    if (d.code !== 18003 && d.code !== 18002) {
     incompatibleInputs.push({
      path: configPath,
      message: ts.flattenDiagnosticMessageText(d.messageText, ' '),
      severity: 'error',
      code: String(d.code),
     });
    }
   }
   for (const fn of parsed.fileNames) {
    const resolvedFn = resolve(fn);
    if (fullTsPaths.has(resolvedFn)) {
     const rel = relative(root, resolvedFn).replaceAll('\\', '/');
     configuredSourcesSet.add(rel);
    }
   }
  }
 }

 const configuredSourceFiles = Array.from(configuredSourcesSet).sort();
 const unconfiguredSourceFiles = tsSourceFiles.filter(p => !configuredSourcesSet.has(p)).sort();

 const dependencyInputs = [
  ...configurationFiles,
  ...manifestFiles,
  ...lockfiles,
  ...declarationFiles,
  ...otherConfigs,
 ].sort();

 const trackingInputs = [
  ...eligibleFiles,
  ...dependencyInputs,
 ].sort();

 return {
  compilerPin,
  eligibleFiles: eligibleFiles.sort(),
  configuredSourceFiles,
  unconfiguredSourceFiles,
  prismaSchemas: prismaSchemas.sort(),
  configurationFiles: configurationFiles.sort(),
  manifestFiles: manifestFiles.sort(),
  lockfiles: lockfiles.sort(),
  declarationFiles: declarationFiles.sort(),
  dependencyInputs,
  trackingInputs,
  inclusions,
  exclusions,
  incompatibleInputs,
  denominator: eligibleFiles.length,
 };
}

export interface AnalyzeOptions {
 capturedRevision?: CapturedRevision | Record<string, Buffer>;
 captureOptions?: CaptureOptions;
}

export class Analyzer {
 public static readonly COMPILER_PIN = TYPESCRIPT_PIN;
 public readonly compilerPin = TYPESCRIPT_PIN;
 public readonly compilerVersion = ts.version;
 public lastDiscovery?: AnalysisInputDiscovery;
 private programs=new Map<string,ts.Program>();
 private sourceCache=new Map<string,{hash:string;source:ts.SourceFile}>();
 private sequence=0;
 async discoverInputs(root:string, capturedFiles?: Record<string, Buffer | { hash: string; text: string }>):Promise<AnalysisInputDiscovery>{
  return discoverAnalysisInputs(resolve(root), capturedFiles);
 }
 async analyze(root:string, options?: AnalyzeOptions):Promise<Analysis>{
  const start=performance.now();root=resolve(root);
  let diskExclusions:Array<{path:string;reason:'ignored-directory'|'sensitive-file'|'symlink'}>=[];
  if(!options?.capturedRevision){
   try{
    const scan=await scanProjectDirectory(root);
    diskExclusions=scan.excludedEntries;
   }catch{
    diskExclusions=[];
   }
  }
  let captured: Record<string, Buffer>;
  let isIncomplete = false;
  let changedPaths: string[] = [];
  if(options?.capturedRevision){
   if('files' in options.capturedRevision && !Buffer.isBuffer((options.capturedRevision as any).files)){
    const rev = options.capturedRevision as CapturedRevision;
    captured = rev.files;
    isIncomplete = Boolean(rev.incomplete);
    changedPaths = rev.changedPaths || [];
   }else{
    captured = options.capturedRevision as Record<string, Buffer>;
    isIncomplete = isRevisionIncomplete(captured);
    changedPaths = (captured as any).changedPaths || [];
   }
  }else{
   captured = await captureFiles(root, options?.captureOptions);
   isIncomplete = isRevisionIncomplete(captured);
   changedPaths = (captured as any).changedPaths || [];
  }
  const files=Object.fromEntries(Object.entries(captured).map(([path,data])=>[path,{hash:Buffer.isBuffer(data)?hash(data):(data as any).hash,text:Buffer.isBuffer(data)?data.toString('utf8'):(data as any).text}]));
  const discovery=await discoverAnalysisInputs(root,captured,diskExclusions);
  this.lastDiscovery=discovery;
  const eligible=discovery.eligibleFiles;
  const revision=hash(discovery.trackingInputs.map(p=>p+':'+files[p].hash).join('\n'));
  const diagnostics:Diagnostic[]=[];let unsupported=0,unresolved=0,analyzed=0;
  if(isIncomplete){
   diagnostics.push({severity:'warning',message:`Source files were modified during capture (${changedPaths.join(', ')||'mixed inputs'}). Revision is incomplete.`,code:'incomplete-revision'});
  }
  for(const item of discovery.incompatibleInputs){
   diagnostics.push({severity:item.severity,message:item.message,path:item.path,code:item.code});
  }
  if(ts.version!==TYPESCRIPT_PIN){
   diagnostics.push({severity:'error',message:`Analyzer compiler is pinned to TypeScript ${TYPESCRIPT_PIN}, but ${ts.version} is installed.`,code:'compiler-pin-mismatch'});
  }
  const nodes=new Map<string,ProgramNode>();const edges=new Map<string,ProgramEdge>();
  const rootId='project';
  nodes.set(rootId,NodeSchema.parse({id:rootId,kind:'system',name:basename(root),provenance:'extracted'}));
  const source=(path:string,startOffset:number,end:number,symbol?:string):Source=>(symbol!==undefined?{path,symbol,start:startOffset,end,line:files[path].text.slice(0,startOffset).split('\n').length,hash:files[path].hash,revision}:{path,start:startOffset,end,line:files[path].text.slice(0,startOffset).split('\n').length,hash:files[path].hash,revision});
  const addEdge=(from:string,to:string,kind:ProgramEdge['kind'],label='',uncertain=false)=>{
   const id=idFor(from+':'+kind+':'+to+':'+label);
   edges.set(id,{id,source:from,target:to,kind,label,provenance:'extracted',uncertain});
  };
  for(const path of eligible){
   const mid=idFor('module:'+path);
   nodes.set(mid,NodeSchema.parse({id:mid,kind:'module',name:path,parentId:rootId,outputPath:path,provenance:'extracted',source:source(path,0,files[path].text.length)}));
  }
  const tsPaths=eligible.filter(p=>/\.tsx?$/.test(p));
  const fullPaths=new Set(tsPaths.map(p=>resolve(root,p)));
  const fallback:ts.CompilerOptions={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,jsx:ts.JsxEmit.ReactJSX,strict:true,skipLibCheck:true,noEmit:true};
  const configs=Object.keys(files).filter(p=>/^tsconfig[^/]*\.json$/.test(basename(p))).sort((a,b)=>b.split('/').length - a.split('/').length);
  const parseHost = createParseConfigHost(root, files);
  const claimedFiles = new Set<string>();
  const settings:{key:string;rootNames:string[];options:ts.CompilerOptions;references?:readonly ts.ProjectReference[]}[]=[];
  for(const path of configs){
   const config=ts.parseConfigFileTextToJson(path,files[path].text);
   if(config.error){diagnostics.push({severity:'error',message:ts.flattenDiagnosticMessageText(config.error.messageText,' '),path});continue;}
   const configDir = resolve(root, dirname(path));
   const configFilePath = resolve(root, path);
   const parsed=ts.parseJsonConfigFileContent(config.config,parseHost,configDir,undefined,configFilePath);
   for(const d of parsed.errors)if(d.code!==18003 && d.code!==18002)diagnostics.push({severity:'error',message:ts.flattenDiagnosticMessageText(d.messageText,' '),path,code:String(d.code)});
   const rootNames=parsed.fileNames.map(p=>resolve(p)).filter(p=>fullPaths.has(p) && !claimedFiles.has(p));
   for(const p of rootNames) claimedFiles.add(p);
   const opts = parsed.options.composite ? { ...parsed.options } : { ...parsed.options, noEmit: true };
   if(rootNames.length || (parsed.projectReferences && parsed.projectReferences.length > 0))settings.push({key:path,rootNames,options:opts,references:parsed.projectReferences});
  }
  const configured=new Set(settings.flatMap(s=>s.rootNames.map(p=>resolve(p))));
  const extra=tsPaths.map(p=>resolve(root,p)).filter(p=>!configured.has(p));
  if(extra.length||!settings.length)settings.push({key:'unconfigured',rootNames:extra,options:fallback});
  if(configs.length&&extra.length)diagnostics.push({severity:'warning',message:'Files outside configured TypeScript projects were analyzed with fallback options.',code:'unconfigured-analysis'});
  const declarations=new Map<ts.Node,string>();
  const declarationKeys=new Map<string,string>();
  const filePrograms=new Map<string,ts.Program>();
  const makeKey=(decl:ts.Node)=>relative(root,decl.getSourceFile().fileName).replaceAll('\\','/')+':'+decl.getStart()+':'+decl.kind;
  const sourceFiles: {sf:ts.SourceFile;program:ts.Program}[]=[];
  const visited=new Set<string>();
  const capturedPaths=Object.keys(files);
  const programHosts=new Map<ts.Program,ts.CompilerHost>();
  for(const setting of settings){
   const host=ts.createCompilerHost(setting.options);
   const originalRead=host.readFile.bind(host);
   const originalFileExists=host.fileExists.bind(host);
   const originalDirectoryExists=host.directoryExists ? host.directoryExists.bind(host) : (d:string)=>ts.sys.directoryExists(d);
   const originalGetDirectories=host.getDirectories ? host.getDirectories.bind(host) : (d:string)=>ts.sys.getDirectories(d);

   const currentDir = setting.key !== 'unconfigured' ? resolve(root, dirname(setting.key)) : resolve(root);
   host.getCurrentDirectory = () => currentDir;
   (host as any).useSourceOfProjectReferenceRedirect = () => true;

   const getRel=(file:string)=>{
    const norm=resolve(currentDir, file).replaceAll('\\','/');
    const normRoot=resolve(root).replaceAll('\\','/').replace(/\/$/,'');
    if(norm===normRoot)return '';
    if(norm.startsWith(normRoot+'/'))return norm.slice(normRoot.length+1);
    return null;
   };

   host.fileExists=(file)=>{
    const rel=getRel(file);
    if(rel!==null){
     if(rel in files)return true;
     if(rel.startsWith('node_modules/'))return originalFileExists(file);
     return false;
    }
    return originalFileExists(file);
   };

   host.readFile=(file)=>{
    const rel=getRel(file);
    if(rel!==null){
     if(rel in files)return files[rel].text;
     if(rel.startsWith('node_modules/'))return originalRead(file);
     return undefined;
    }
    return originalRead(file);
   };

   host.directoryExists=(dir)=>{
    const rel=getRel(dir);
    if(rel!==null){
     if(rel==='')return true;
     const prefix=rel+'/';
     if(capturedPaths.some(k=>k.startsWith(prefix)))return true;
     if(rel.startsWith('node_modules/')||rel==='node_modules')return originalDirectoryExists(dir);
     return false;
    }
    return originalDirectoryExists(dir);
   };

   host.readDirectory=(dir,extensions,excludes,includes,depth)=>{
    return [...parseHost.readDirectory(dir,extensions,excludes,includes,depth)];
   };

   host.getDirectories=(dir)=>{
    const rel=getRel(dir);
    if(rel!==null){
     const prefix=rel===''? '':rel+'/';
     const dirs=new Set<string>();
     for(const k of capturedPaths){
      if(prefix===''||k.startsWith(prefix)){
       const rest=k.slice(prefix.length);
       const slash=rest.indexOf('/');
       if(slash!==-1)dirs.add(rest.slice(0,slash));
      }
     }
     if(rel.startsWith('node_modules/')||rel===''){
      for(const d of originalGetDirectories(dir))dirs.add(d);
     }
     return Array.from(dirs);
    }
    return originalGetDirectories(dir);
   };

   host.getSourceFile=(file,languageVersion)=>{
    const text=host.readFile(file);if(text===undefined)return undefined;
    const digest=hash(text);const old=this.sourceCache.get(file);
    if(old?.hash===digest)return old.source;
    const sf=ts.createSourceFile(file,text,languageVersion,true);this.sourceCache.set(file,{hash:digest,source:sf});return sf;
   };
   const program=ts.createProgram({rootNames:setting.rootNames,options:setting.options,projectReferences:setting.references,host,oldProgram:this.programs.get(setting.key)});
   this.programs.set(setting.key,program);
   programHosts.set(program,host);
   for(const d of [...program.getOptionsDiagnostics(),...program.getSyntacticDiagnostics(),...program.getSemanticDiagnostics()]){
    const diagPath=d.file?relative(root,d.file.fileName).replaceAll('\\','/'):(setting.key!=='unconfigured'?setting.key:undefined);
    if(diagPath&&(!files[diagPath]||diagPath.includes('node_modules/')))continue;
    diagnostics.push({severity:d.category===ts.DiagnosticCategory.Error?'error':'warning',message:ts.flattenDiagnosticMessageText(d.messageText,' '),path:diagPath,line:d.file&&d.start!==undefined?d.file.getLineAndCharacterOfPosition(d.start).line+1:undefined,code:String(d.code)});
   }
   const settingRoots = new Set(setting.rootNames.map(p => resolve(p)));
   for(const sf of program.getSourceFiles()){
    const sfResolved = resolve(sf.fileName);
    if(settingRoots.has(sfResolved) && !visited.has(sfResolved)){
     visited.add(sfResolved);
     sourceFiles.push({sf,program});
     filePrograms.set(sf.fileName,program);
    }
   }
  }
  for(const {sf,program} of sourceFiles){
   const path=relative(root,sf.fileName).replaceAll('\\','/');const checker=program.getTypeChecker();const mid=idFor('module:'+path);
   if((sf as unknown as {parseDiagnostics:ts.Diagnostic[]}).parseDiagnostics.length)throw new AppError('Invalid TypeScript syntax in '+path+'. The last valid graph is retained.');
   const flags=ts.TypeFormatFlags.NoTruncation;
   function functionContract(n:ts.SignatureDeclaration,name:string){
    const signature=checker.getSignatureFromDeclaration(n);
    return name+(signature?checker.signatureToString(signature,n,flags):n.getText(sf).split('{')[0]);
   }
   function shape(n:ts.Node){
    const type=checker.getTypeAtLocation(n);
    return checker.getPropertiesOfType(type).map(p=>{
     const decl=p.valueDeclaration||p.declarations?.[0]||n;
     return p.getName()+(p.flags&ts.SymbolFlags.Optional?'?':'')+': '+checker.typeToString(checker.getTypeOfSymbolAtLocation(p,decl),decl,flags);
    }).sort().join('; ');
   }
   function visit(n:ts.Node,parentId:string,qualified:string){
    let id:string|undefined;let name:string|undefined;let kind:ProgramNode['kind']|undefined;let contract='';
    let enumFields:{name:string;type:string}[]=[];
    if(ts.isClassDeclaration(n)||ts.isInterfaceDeclaration(n)||ts.isTypeAliasDeclaration(n)){
     name=n.name?.text||'default';kind=ts.isClassDeclaration(n)?'class':'interface';contract=shape(n);
     if(ts.isTypeAliasDeclaration(n))contract=checker.typeToString(checker.getTypeAtLocation(n),n,flags|ts.TypeFormatFlags.InTypeAlias);
    }else if(ts.isEnumDeclaration(n)){
     name=n.name.text;kind='enum';contract='enum '+name+' { '+n.members.map(m=>m.getText(sf)).join(', ')+' }';
     enumFields=n.members.map(m=>({name:m.name.getText(sf),type:'enum'}));
    }else if(ts.isModuleDeclaration(n)&&n.name){
     name=n.name.text;kind='module';contract='namespace '+name;
    }else if(ts.isFunctionDeclaration(n)||ts.isMethodDeclaration(n)||ts.isMethodSignature(n)||ts.isConstructorDeclaration(n)||ts.isGetAccessorDeclaration(n)||ts.isSetAccessorDeclaration(n)){
     name=ts.isConstructorDeclaration(n)?'constructor':n.name?.getText(sf)||'default';
     kind='function';contract=functionContract(n,name);
    }else if((ts.isVariableDeclaration(n)||ts.isPropertyDeclaration(n))&&n.initializer&&(ts.isArrowFunction(n.initializer)||ts.isFunctionExpression(n.initializer))){
     name=n.name.getText(sf);kind='function';contract=functionContract(n.initializer,name);
    }else if((ts.isVariableDeclaration(n)||ts.isPropertyDeclaration(n))&&n.initializer&&(ts.isClassDeclaration(n.initializer)||ts.isClassExpression(n.initializer))){
     name=n.name.getText(sf);kind='class';contract=shape(n.initializer);
    }else if(ts.isExportAssignment(n)){
     if(ts.isArrowFunction(n.expression)||ts.isFunctionExpression(n.expression)){
      name='default';kind='function';contract=functionContract(n.expression,name);
     }else if(ts.isClassExpression(n.expression)){
      name=n.expression.name?.text||'default';kind='class';contract=shape(n.expression);
     }
    }
    if(kind&&name){
     const symbolName=qualified?qualified+'.'+name:name;id=idFor(path+':'+kind+':'+symbolName);
     const previous=nodes.get(id);
     const src=source(path,previous?.source?Math.min(previous.source.start,n.getStart(sf)):n.getStart(sf),Math.max(previous?.source?.end||0,n.end),symbolName);
     const mergedContract=previous?.contract&&previous.contract!==contract
      ?(previous.contract.split('\n').includes(contract)?previous.contract:previous.contract+'\n'+contract)
      :contract;
     const mergedFields=enumFields.length?enumFields:(previous?.fields||[]);
     nodes.set(id,NodeSchema.parse({id,kind,name,parentId,provenance:'extracted',contract:mergedContract,fields:mergedFields,source:src,outputPath:path}));
     declarations.set(n,id);declarationKeys.set(makeKey(n),id);
     if((ts.isVariableDeclaration(n)||ts.isPropertyDeclaration(n))&&n.initializer){declarations.set(n.initializer,id);declarationKeys.set(makeKey(n.initializer),id);}
     if(ts.isExportAssignment(n)&&n.expression){declarations.set(n.expression,id);declarationKeys.set(makeKey(n.expression),id);}
     if(ts.isEnumDeclaration(n)){for(const m of n.members){declarations.set(m,id);declarationKeys.set(makeKey(m),id);}}
     const targetNode=((ts.isVariableDeclaration(n)||ts.isPropertyDeclaration(n))&&n.initializer&&(ts.isClassDeclaration(n.initializer)||ts.isClassExpression(n.initializer)))
      ?n.initializer
      :(ts.isExportAssignment(n)&&ts.isClassExpression(n.expression)?n.expression:n);
     ts.forEachChild(targetNode,child=>visit(child,id!,symbolName));
    }else ts.forEachChild(n,child=>visit(child,parentId,qualified));
   }
   visit(sf,mid,'');analyzed++;
  }
  for(const {sf,program} of sourceFiles){
   const path=relative(root,sf.fileName).replaceAll('\\','/');const checker=program.getTypeChecker();const mid=idFor('module:'+path);
   const external=(expression:ts.Expression,decl?:ts.Declaration)=>{
    const text=expression.getText(sf);
    const origin=decl?decl.getSourceFile().fileName.replaceAll('\\','/').replace(/^.*node_modules\//,''):'unresolved';
    const id=idFor('external:'+origin+':'+text);
    if(!nodes.has('external'))nodes.set('external',NodeSchema.parse({id:'external',kind:'system',name:'External / unresolved',provenance:'extracted'}));
    if(!nodes.has(id))nodes.set(id,NodeSchema.parse({id,kind:'function',name:text,parentId:'external',provenance:'extracted',description:decl?'Resolved declaration outside imported source.':'The call target cannot be resolved statically.'}));
    return id;
   };
   function walk(n:ts.Node,owner:string){
    const own=declarations.get(n);if(own)owner=own;
    if((ts.isImportDeclaration(n)||ts.isExportDeclaration(n))&&n.moduleSpecifier&&ts.isStringLiteral(n.moduleSpecifier)){
     const currentHost = programHosts.get(program) || ts.sys;
     const resolved=ts.resolveModuleName(n.moduleSpecifier.text,sf.fileName,program.getCompilerOptions(),currentHost).resolvedModule;
     if(resolved&&fullPaths.has(resolve(resolved.resolvedFileName)))addEdge(mid,idFor('module:'+relative(root,resolved.resolvedFileName).replaceAll('\\','/')),'depends-on');
    }
    if(ts.isCallExpression(n)||ts.isNewExpression(n)){
     let symbol=checker.getSymbolAtLocation(n.expression);
     if(symbol&&(symbol.flags&ts.SymbolFlags.Alias))try{symbol=checker.getAliasedSymbol(symbol);}catch{}
     const decl=symbol?.valueDeclaration||symbol?.declarations?.[0];
     let target=decl?(declarations.get(decl)||declarationKeys.get(makeKey(decl))):undefined;
     if(!target&&symbol?.declarations){
      for(const d of symbol.declarations){
       target=declarations.get(d)||declarationKeys.get(makeKey(d));
       if(target)break;
      }
     }
     const uncertain=!decl;
     if(!target)target=external(n.expression,decl);
     if(uncertain){unresolved++;diagnostics.push({severity:'warning',message:'Unresolved call: '+n.expression.getText(sf),path,line:sf.getLineAndCharacterOfPosition(n.getStart()).line+1});}
     addEdge(owner,target,'calls','',uncertain);
    }
    if((ts.isClassDeclaration(n)||ts.isClassExpression(n)||ts.isInterfaceDeclaration(n))&&n.heritageClauses)for(const clause of n.heritageClauses)for(const t of clause.types){
     let sym=checker.getSymbolAtLocation(t.expression);
     if(sym&&(sym.flags&ts.SymbolFlags.Alias))sym=checker.getAliasedSymbol(sym);
     const decl=clause.token===ts.SyntaxKind.ExtendsKeyword?(sym?.valueDeclaration||sym?.declarations?.[0]):sym?.declarations?.[0];
     let target=decl&&(declarations.get(decl)||declarationKeys.get(makeKey(decl)));
     if(!target&&sym?.declarations){
      for(const d of sym.declarations){
       target=declarations.get(d)||declarationKeys.get(makeKey(d));
       if(target)break;
      }
     }
     if(target)addEdge(owner,target,clause.token===ts.SyntaxKind.ExtendsKeyword?'inherits':'implements');
    }
    ts.forEachChild(n,c=>walk(c,owner));
   }
   walk(sf,mid);
   const occurrence=new Map<string,number>();
   function workflow(functionNode:ts.Node,owner:string){
    let body:ts.ConciseBody|undefined;
    if((ts.isVariableDeclaration(functionNode)||ts.isPropertyDeclaration(functionNode))&&functionNode.initializer&&(ts.isArrowFunction(functionNode.initializer)||ts.isFunctionExpression(functionNode.initializer)))body=functionNode.initializer.body;
    else if(ts.isExportAssignment(functionNode)&&functionNode.expression&&(ts.isArrowFunction(functionNode.expression)||ts.isFunctionExpression(functionNode.expression)))body=(functionNode.expression as ts.ArrowFunction|ts.FunctionExpression).body;
    else if(ts.isFunctionLike(functionNode)&&'body' in functionNode)body=(functionNode as ts.FunctionDeclaration).body;
    if(!body)return;
    type Exit={id:string;kind:ProgramEdge['kind']};
    const step=(n:ts.Node,type:ProgramNode['stepType'],label:string)=>{
     const key=owner+':'+type+':'+normalize(n.getText(sf));const count=occurrence.get(key)||0;occurrence.set(key,count+1);
     const id=idFor(key+':'+count);
     nodes.set(id,NodeSchema.parse({id,kind:'step',name:label.slice(0,100),parentId:owner,provenance:'extracted',stepType:type,description:n.getText(sf),source:source(path,n.getStart(sf),n.end)}));
     return id;
    };
    const connect=(incoming:Exit[],id:string)=>incoming.forEach(e=>addEdge(e.id,id,e.kind));
    function sequence(statements:readonly ts.Statement[],incoming:Exit[]):Exit[]{
     let exits=incoming;
     for(const stmt of statements){
      if(ts.isBlock(stmt)){exits=sequence(stmt.statements,exits);continue;}
      const type=ts.isIfStatement(stmt)?'condition':ts.isForStatement(stmt)||ts.isForOfStatement(stmt)||ts.isForInStatement(stmt)||ts.isWhileStatement(stmt)||ts.isDoStatement(stmt)?'loop':ts.isReturnStatement(stmt)?'return':ts.isThrowStatement(stmt)?'throw':ts.isTryStatement(stmt)?'try':ts.isExpressionStatement(stmt)&&ts.isCallExpression(stmt.expression)?'call':ts.isSwitchStatement(stmt)||ts.isBreakStatement(stmt)||ts.isContinueStatement(stmt)?'opaque':'operation';
      const label=ts.isIfStatement(stmt)?stmt.expression.getText(sf):stmt.getText(sf);
      const id=step(stmt,type,label);connect(exits,id);
      if(type==='opaque'||type==='try'){unsupported++;diagnostics.push({severity:'warning',message:'Workflow contains a source-backed block whose execution paths are not fully reconstructed.',path,line:sf.getLineAndCharacterOfPosition(stmt.getStart()).line+1});}
      if(ts.isIfStatement(stmt)){
       const a=sequence(ts.isBlock(stmt.thenStatement)?stmt.thenStatement.statements:[stmt.thenStatement],[{id,kind:'true'}]);
       const b=stmt.elseStatement?sequence(ts.isBlock(stmt.elseStatement)?stmt.elseStatement.statements:[stmt.elseStatement],[{id,kind:'false'}]):[{id,kind:'false' as const}];
       exits=[...a,...b];
      }else if(type==='loop'){
       const body=(stmt as ts.IterationStatement).statement;
       const ends=sequence(ts.isBlock(body)?body.statements:[body],[{id,kind:'true'}]);
       ends.forEach(e=>addEdge(e.id,id,'next','repeat',true));
       exits=[{id,kind:'false'}];
      }else exits=type==='return'||type==='throw'?[]:[{id,kind:'next'}];
     }return exits;
    }
    if(ts.isBlock(body))sequence(body.statements,[]);
    else step(body,'return','return '+body.getText(sf));
   }
   function flows(n:ts.Node){const id=declarations.get(n);if(id&&nodes.get(id)?.kind==='function'&&!ts.isArrowFunction(n)&&!ts.isFunctionExpression(n))workflow(n,id);ts.forEachChild(n,flows);}
   flows(sf);
  }
  for(const path of eligible.filter(p=>p.endsWith('.prisma'))){
   try{
    const parser=new PrismaParser({nodeLocationTracking:'full'});
    const Visitor=VisitorClassFactory(parser);
    const schema=getSchema(files[path].text,{parser,visitor:new Visitor()});
    const models=schema.list.filter((block):block is Model=>block.type==='model');
    const modelsByName=new Map(models.map(model=>[model.name,model]));
    const mid=idFor('module:'+path);
    const attr=(field:Field,name:string)=>field.attributes?.find(a=>a.name===name);
    const arg=(attribute:ReturnType<typeof attr>,key:string):any=>{
     const a=attribute?.args?.map(a=>a.value).find((v:any)=>v&&typeof v==='object'&&v.type==='keyValue'&&v.key===key) as any;
     return a?.value;
    };
    const strings=(value:any):string[]=>typeof value==='string'?[value]:Array.isArray(value)?value.flatMap(strings):value?.type==='array'?value.args.flatMap(strings):[];
    for(const model of models){
     const id=idFor('entity:'+path+':'+model.name);
     const fields=model.properties.filter((p):p is Field=>p.type==='field');
     const foreign=new Set(fields.flatMap(f=>strings(arg(attr(f,'relation'),'fields'))));
     const compound=new Set(model.properties.filter(p=>p.type==='attribute'&&p.name==='id').flatMap((p:any)=>strings(p.args?.[0]?.value)));
     const location=model.location;const startOffset=location?.startOffset??files[path].text.indexOf('model '+model.name);
     const end=(location?.endOffset??startOffset)+1;
     const mapped=model.properties.find(p=>p.type==='attribute'&&p.name==='map') as any;
     nodes.set(id,NodeSchema.parse({id,kind:'entity',name:model.name,parentId:mid,provenance:'extracted',source:source(path,startOffset,end,model.name),outputPath:path,
      contract:JSON.stringify(model.properties.filter(p=>p.type==='field'||p.type==='attribute').map((p:any)=>({name:p.name,fieldType:p.fieldType,optional:p.optional,array:p.array,attributes:p.attributes,args:p.args})),(key,value)=>key==='location'||key==='comment'?undefined:value),
      description:mapped?'Database name: '+mapped.args?.[0]?.value:'',
      fields:fields.map(f=>({name:f.name,type:String(f.fieldType)+(f.array?'[]':''),optional:!!f.optional,key:attr(f,'id')||compound.has(f.name)?'PK':foreign.has(f.name)?'FK':attr(f,'unique')?'UNIQUE':modelsByName.has(String(f.fieldType))?'RELATION':'',mappedName:attr(f,'map')?.args?.[0]?.value as string|undefined}))
     }));
    }
    for(const model of models){
     for(const f of model.properties.filter((p):p is Field=>p.type==='field')){
      if(!modelsByName.has(String(f.fieldType)))continue;
      const other=String(f.fieldType);
      const inverse=modelsByName.get(other)!.properties.find((p):p is Field=>p.type==='field'&&String(p.fieldType)===model.name);
      const relation=attr(f,'relation');const foreign=strings(arg(relation,'fields'));
      const named=relation?.args?.[0]?.value;const group=typeof named==='string'?named:'';
      const pair=[model.name,other].sort().join(':')+(model.name===other?':'+f.name:'');
      const id=idFor('relation:'+path+':'+pair+':'+group);
      if(!edges.has(id)||foreign.length)edges.set(id,{id,source:idFor('entity:'+path+':'+model.name),target:idFor('entity:'+path+':'+other),kind:'relates-to',label:(inverse?.array?'many':'one')+' → '+(f.array?'many':f.optional?'zero or one':'one')+(foreign.length?' · '+foreign.join(', '):''),provenance:'extracted',uncertain:!inverse});
     }
    }
    for(const block of schema.list)if(block.type==='enum')nodes.set(idFor('enum:'+path+':'+block.name),NodeSchema.parse({id:idFor('enum:'+path+':'+block.name),kind:'enum',name:block.name,parentId:mid,provenance:'extracted',fields:block.enumerators.filter(p=>p.type==='enumerator').map(p=>({name:p.name,type:'enum'}))}));
    analyzed++;
   }catch(error){diagnostics.push({severity:'error',message:'Prisma parse failed: '+(error as Error).message,path});}
  }
  const dedup=Array.from(new Map(diagnostics.map(d=>[JSON.stringify(d),d])).values());
  const graph:Graph={schemaVersion:GRAPH_SCHEMA_VERSION,nodes:Array.from(nodes.values()).sort((a,b)=>a.id.localeCompare(b.id)),edges:Array.from(edges.values()).sort((a,b)=>a.id.localeCompare(b.id)),requirements:[]};
  const isCurrent = !isIncomplete && !dedup.some(d=>d.severity!=='info');
  const status: 'current' | 'partial' = isCurrent ? 'current' : 'partial';
  return {revision,sequence:++this.sequence,analyzedAt:new Date().toISOString(),status,graph,files,durationMs:performance.now()-start,quality:{eligibleFiles:eligible.length,analyzedFiles:analyzed,unresolvedReferences:unresolved,unsupportedConstructs:unsupported,inferredItems:0,prismaValidation:eligible.some(p=>p.endsWith('.prisma'))?'unavailable':'not-applicable',diagnostics:dedup}};
 }
}
