import ts from 'typescript';
import {isBuiltin} from 'node:module';
import {dirname,join,relative,isAbsolute} from 'node:path';
import type {ValidationIssue} from '../shared/model';

function imports(path:string,text:string){
 const source=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true);
 const result=new Set<string>();
 const literal=(node:ts.Node|undefined)=>{if(node&&ts.isStringLiteralLike(node))result.add(node.text);};
 const visit=(node:ts.Node)=>{
  if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node))literal(node.moduleSpecifier);
  else if(ts.isImportEqualsDeclaration(node)&&ts.isExternalModuleReference(node.moduleReference))literal(node.moduleReference.expression);
  else if(ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument))literal(node.argument.literal);
  else if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(node.expression)&&node.expression.text==='require'))literal(node.arguments[0]);
  ts.forEachChild(node,visit);
 };
 visit(source);return result;
}
function manifest(files:Record<string,Buffer>,path:string):any{
 let directory=dirname(path);
 while(true){
  const key=directory==='.'?'package.json':directory+'/package.json';
  if(files[key]){
   const value=JSON.parse(files[key].toString('utf8'));
   if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Package manifest must be an object');
   return value;
  }
  if(directory==='.')return {};
  directory=dirname(directory);
 }
}
function declared(value:any,name:string){
 return value.name===name||['dependencies','devDependencies','peerDependencies','optionalDependencies'].some(key=>value[key]&&typeof value[key]==='object'&&Object.hasOwn(value[key],name));
}
export function dependencyIssues(root:string,before:Record<string,Buffer>,after:Record<string,Buffer>):ValidationIssue[]{
 const issues:ValidationIssue[]=[];
 const options=new Map<string,ts.CompilerOptions>();
 for(const [path,text] of Object.entries(after)){
  if(!/\.[cm]?[jt]sx?$/.test(path))continue;
  let current:any,previous:any;
  try{current=manifest(after,path);previous=manifest(before,path);}catch(error){issues.push({code:'dependency-manifest',path,message:'Cannot verify dependency declarations: '+(error as Error).message});continue;}
  const oldImports=imports(path,before[path]?.toString('utf8')||'');
  for(const module of imports(path,text.toString('utf8'))){
   if(module.startsWith('.')||module.startsWith('/')||isBuiltin(module)||/^[a-z]+:/i.test(module))continue;
   const name=module.startsWith('@')?module.split('/').slice(0,2).join('/'):module.split('/')[0];
   if(declared(current,name))continue;
   const file=join(root,path);const config=ts.findConfigFile(dirname(file),ts.sys.fileExists);
   let compiler:ts.CompilerOptions={};
   if(config){
    if(!options.has(config)){const loaded=ts.readConfigFile(config,ts.sys.readFile);options.set(config,ts.parseJsonConfigFileContent(loaded.config||{},ts.sys,dirname(config)).options);}
    compiler=options.get(config)!;
   }
   const resolved=ts.resolveModuleName(module,file,compiler,ts.sys).resolvedModule?.resolvedFileName;
   if(resolved){const local=relative(root,resolved);if(!isAbsolute(local)&&local!=='..'&&!local.startsWith('../')&&!local.split(/[\\/]/).includes('node_modules'))continue;}
   if(!oldImports.has(module)||declared(previous,name))issues.push({code:'undeclared-dependency',path,message:'Imported package is not declared in the nearest package manifest: '+name});
  }
 }
 return issues;
}
