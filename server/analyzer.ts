import ts from 'typescript';
import {
 getSchema,
 PrismaParser,
 VisitorClassFactory,
 type Field,
 type Model,
 type Enum as PrismaEnum,
 type PrismaAstConfig,
 type Schema as PrismaSchemaAst,
} from '@mrleebo/prisma-ast';
import {constants} from 'node:fs';
import {access,mkdtemp,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,relative,basename,dirname,join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {NodeSchema,GRAPH_SCHEMA_VERSION,type Analysis,type Graph,type ProgramNode,type Source,type Diagnostic,type ProgramEdge,type KeyDefinition,type Quality,QualitySchema} from '../shared/model';
import {captureFiles,captureSourceRevision,isRevisionIncomplete,type CaptureOptions,type CapturedRevision,scanProjectDirectory,hash,AppError,copySnapshot} from './files';
import {runSandbox,sandboxAvailable,type SandboxExecutor} from './sandbox';
const idFor=(key:string)=>hash(key).slice(0,24);
const normalize=(value:string)=>value.replace(/\s+/g,' ').trim();

export const TYPESCRIPT_PIN = '6.0.3';
export const BEHAVIORAL_LIMIT_STATEMENT = 'File coverage must not be presented as proof of behavioral completeness.';

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

export const PRISMA_PARSER_CONFIG: PrismaAstConfig['parser'] = Object.freeze({
 nodeLocationTracking: 'full',
});
export const DEFAULT_PRISMA_PARSER_CONFIG = PRISMA_PARSER_CONFIG;
export type PrismaParserConfig = PrismaAstConfig['parser'];

export function createPrismaParser(
 config: PrismaAstConfig['parser'] = PRISMA_PARSER_CONFIG
): PrismaParser {
 return new PrismaParser(config);
}

export interface PrismaParseResult {
 schema?: PrismaSchemaAst;
 diagnostics: Diagnostic[];
}

export function parsePrismaSchema(
 path: string,
 text: string,
 config: PrismaAstConfig['parser'] = PRISMA_PARSER_CONFIG
): PrismaParseResult {
 const parser = createPrismaParser(config);
 const Visitor = VisitorClassFactory(parser);
 const visitor = new Visitor();
 try {
  const schema = getSchema(text, { parser, visitor });
  return { schema, diagnostics: [] };
 } catch (error: any) {
  const errList = (parser.errors && parser.errors.length > 0) ? parser.errors : [error];
  const diagnostics: Diagnostic[] = errList.map((err: any) => {
   const rawMessage = (err as Error)?.message || String(err);
   let line: number | undefined = undefined;
   if (err?.token?.startLine && Number.isInteger(err.token.startLine) && err.token.startLine > 0) {
    line = err.token.startLine;
   } else if (err?.previousToken?.startLine && Number.isInteger(err.previousToken.startLine) && err.previousToken.startLine > 0) {
    line = err.previousToken.startLine;
   } else if (typeof err?.token?.startOffset === 'number' && !Number.isNaN(err.token.startOffset)) {
    line = Math.max(1, text.slice(0, err.token.startOffset).split('\n').length);
   }
   return {
    severity: 'error' as const,
    message: 'Prisma parse failed: ' + rawMessage,
    path,
    ...(line !== undefined ? { line } : {}),
    code: 'prisma-parse-error',
   };
  });
  return { diagnostics };
 }
}

export const SCHEMA_DERIVED_NOTICE =
 'Schema-derived definition; database state is unverified. Verifying an actual database requires a later, explicit introspection connection.';

export function extractPrismaDefault(attribute: any): string | undefined {
 if (!attribute || !attribute.args || !attribute.args.length) return undefined;
 const first = attribute.args[0];
 const val = first?.value !== undefined ? first.value : first;
 if (val === undefined || val === null) return undefined;
 if (typeof val === 'object' && val.type === 'function') {
  const params = Array.isArray(val.params)
   ? val.params.map((p: any) => (typeof p === 'string' ? p.replace(/^"|"$/g, '') : String(p))).join(', ')
   : '';
  return `${val.name}(${params})`;
 }
 if (typeof val === 'string') {
  if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
   return val.slice(1, -1);
  }
  return val;
 }
 if (typeof val === 'number' || typeof val === 'boolean') {
  return String(val);
 }
 return String(val);
}

export function extractPrismaMapping(attribute: any): string | undefined {
 if (!attribute || !attribute.args || !attribute.args.length) return undefined;
 const first = attribute.args[0];
 let val = first?.value !== undefined ? first.value : first;
 if (val && typeof val === 'object' && val.type === 'keyValue') {
  val = val.value;
 }
 if (typeof val === 'string') {
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
   if (val.length >= 2) return val.slice(1, -1);
  }
  return val;
 }
 return undefined;
}

export function extractAttributeFieldList(attribute: any): string[] {
 if (!attribute || !attribute.args || !attribute.args.length) return [];
 for (const argItem of attribute.args) {
  const val = argItem?.value !== undefined ? argItem.value : argItem;
  if (val?.type === 'array' && Array.isArray(val.args)) {
   return val.args.map((x: any) => {
    if (typeof x === 'string') return x;
    if (x && typeof x === 'object' && typeof x.name === 'string') return x.name;
    return String(x);
   });
  }
  if (val?.type === 'keyValue' && val.key === 'fields') {
   const innerVal = val.value;
   if (innerVal?.type === 'array' && Array.isArray(innerVal.args)) {
    return innerVal.args.map((x: any) => {
     if (typeof x === 'string') return x;
     if (x && typeof x === 'object' && typeof x.name === 'string') return x.name;
     return String(x);
    });
   }
  }
 }
 return [];
}

export function extractAttributeArgumentValue(attribute: any, key: string): string | undefined {
 if (!attribute || !attribute.args) return undefined;
 for (const argItem of attribute.args) {
  const val = argItem?.value !== undefined ? argItem.value : argItem;
  if (val?.type === 'keyValue' && val.key === key) {
   let raw = val.value;
   if (typeof raw === 'string') {
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
     if (raw.length >= 2) return raw.slice(1, -1);
    }
    return raw;
   }
   return String(raw);
  }
 }
 return undefined;
}

export function extractPrismaKeysAndIndexes(model: Model): {
 compositeKeys: KeyDefinition[];
 indexes: KeyDefinition[];
 compositeIdFields: string[];
 singleIdFields: string[];
 compositeUniqueFields: string[];
 singleUniqueFields: string[];
} {
 const compositeKeys: KeyDefinition[] = [];
 const indexes: KeyDefinition[] = [];
 const compositeIdFields: string[] = [];
 const singleIdFields: string[] = [];
 const compositeUniqueFields: string[] = [];
 const singleUniqueFields: string[] = [];

 const attributes = model.properties.filter((p): p is any => p.type === 'attribute');

 for (const attr of attributes) {
  if (attr.name === 'id') {
   const fieldList = extractAttributeFieldList(attr);
   const name = extractAttributeArgumentValue(attr, 'name');
   const map = extractAttributeArgumentValue(attr, 'map');
   if (fieldList.length > 1) {
    compositeKeys.push({
     fields: fieldList,
     type: 'PK',
     ...(name ? { name } : {}),
     ...(map ? { mappedName: map } : {}),
    });
    compositeIdFields.push(...fieldList);
   } else if (fieldList.length === 1) {
    singleIdFields.push(fieldList[0]);
   }
  } else if (attr.name === 'unique') {
   const fieldList = extractAttributeFieldList(attr);
   const name = extractAttributeArgumentValue(attr, 'name');
   const map = extractAttributeArgumentValue(attr, 'map');
   if (fieldList.length > 1) {
    compositeKeys.push({
     fields: fieldList,
     type: 'UNIQUE',
     ...(name ? { name } : {}),
     ...(map ? { mappedName: map } : {}),
    });
    compositeUniqueFields.push(...fieldList);
   } else if (fieldList.length === 1) {
    singleUniqueFields.push(fieldList[0]);
   }
  } else if (attr.name === 'index') {
   const fieldList = extractAttributeFieldList(attr);
   const name = extractAttributeArgumentValue(attr, 'name');
   const map = extractAttributeArgumentValue(attr, 'map');
   if (fieldList.length > 0) {
    indexes.push({
     fields: fieldList,
     type: 'INDEX',
     ...(name ? { name } : {}),
     ...(map ? { mappedName: map } : {}),
    });
   }
  }
 }

 return {
  compositeKeys,
  indexes,
  compositeIdFields,
  singleIdFields,
  compositeUniqueFields,
  singleUniqueFields,
 };
}

export function extractPrismaRelationName(attribute: any): string | undefined {
 if (!attribute || !attribute.args || !attribute.args.length) return undefined;
 const namedArg = extractAttributeArgumentValue(attribute, 'name');
 if (namedArg) return namedArg;
 const first = attribute.args[0];
 const val = first?.value !== undefined ? first.value : first;
 if (typeof val === 'string') {
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
   if (val.length >= 2) return val.slice(1, -1);
  }
  return val;
 }
 return undefined;
}

export function extractPrismaRelationFields(attribute: any): {
 fields: string[];
 references: string[];
 name?: string;
 map?: string;
} {
 if (!attribute || !attribute.args) {
  return { fields: [], references: [] };
 }
 const name = extractPrismaRelationName(attribute);
 const map = extractAttributeArgumentValue(attribute, 'map');

 const extractList = (key: string): string[] => {
  for (const argItem of attribute.args) {
   const val = argItem?.value !== undefined ? argItem.value : argItem;
   if (val?.type === 'keyValue' && val.key === key) {
    const innerVal = val.value;
    if (innerVal?.type === 'array' && Array.isArray(innerVal.args)) {
     return innerVal.args.map((x: any) => {
      const str = typeof x === 'string' ? x : (x && typeof x === 'object' && typeof x.name === 'string') ? x.name : String(x);
      if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
       return str.length >= 2 ? str.slice(1, -1) : str;
      }
      return str;
     });
    }
   }
  }
  return [];
 };

 const fields = extractList('fields');
 const references = extractList('references');

 return {
  fields,
  references,
  ...(name ? { name } : {}),
  ...(map ? { map } : {}),
 };
}

export function findPrismaInverseRelationField(
 model: Model,
 field: Field,
 modelsByName: Map<string, Model>
): { inverse?: Field; ambiguous: boolean } {
 const targetModel = modelsByName.get(String(field.fieldType));
 if (!targetModel) {
  return { inverse: undefined, ambiguous: false };
 }
 const fieldRelAttr = field.attributes?.find((a: any) => a.name === 'relation');
 const fieldRelName = extractPrismaRelationName(fieldRelAttr);

 const candidates = targetModel.properties.filter(
  (p): p is Field =>
   p.type === 'field' &&
   String(p.fieldType) === model.name &&
   !(model.name === targetModel.name && p.name === field.name)
 );

 if (candidates.length === 0) {
  return { inverse: undefined, ambiguous: false };
 }

 if (fieldRelName) {
  const matching = candidates.filter((p) => {
   const rel = p.attributes?.find((a: any) => a.name === 'relation');
   return extractPrismaRelationName(rel) === fieldRelName;
  });
  if (matching.length === 1) {
   return { inverse: matching[0], ambiguous: false };
  }
  if (matching.length > 1) {
   return { inverse: matching[0], ambiguous: true };
  }
  return { inverse: undefined, ambiguous: false };
 }

 const matchingUnnamed = candidates.filter((p) => {
  const rel = p.attributes?.find((a: any) => a.name === 'relation');
  return !extractPrismaRelationName(rel);
 });

 if (matchingUnnamed.length === 1) {
  return { inverse: matchingUnnamed[0], ambiguous: false };
 }
 if (matchingUnnamed.length > 1) {
  return { inverse: matchingUnnamed[0], ambiguous: true };
 }

 return { inverse: undefined, ambiguous: false };
}

export function computePrismaRelationCardinality(
 field: Field,
 inverse?: Field
): 'one → many' | 'many → one' | 'many → many' | 'one → one' | 'one → zero or one' {
 if (field.array && inverse?.array) {
  return 'many → many';
 }
 if (inverse?.array) {
  return 'many → one';
 }
 if (field.array) {
  return 'one → many';
 }
 if (field.optional) {
  return 'one → zero or one';
 }
 return 'one → one';
}

export function findPrismaBlockEnd(text: string, startOffset: number): number {
 const openBrace = text.indexOf('{', startOffset);
 if (openBrace === -1) return startOffset;
 let depth = 0;
 let inString = false;
 let inLineComment = false;
 let inBlockComment = false;
 for (let i = openBrace; i < text.length; i++) {
  const ch = text[i];
  const next = text[i + 1];
  if (inLineComment) {
   if (ch === '\n') inLineComment = false;
   continue;
  }
  if (inBlockComment) {
   if (ch === '*' && next === '/') {
    inBlockComment = false;
    i++;
   }
   continue;
  }
  if (ch === '/' && next === '/') {
   inLineComment = true;
   i++;
   continue;
  }
  if (ch === '/' && next === '*') {
   inBlockComment = true;
   i++;
   continue;
  }
  if (ch === '"' && text[i - 1] !== '\\') {
   inString = !inString;
   continue;
  }
  if (!inString) {
   if (ch === '{') {
    depth++;
   } else if (ch === '}') {
    depth--;
    if (depth === 0) {
     return i + 1;
    }
   }
  }
 }
 return text.length;
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

export type PrismaValidationStatus = 'passed' | 'failed' | 'unavailable' | 'not-applicable';

export interface PrismaValidationResult {
 status: PrismaValidationStatus;
 reason?: string;
 output?: string;
 exitCode?: number;
 diagnostics: Diagnostic[];
}

export interface PrismaValidationOptions {
 timeoutMs?: number;
 schemaPaths?: string[];
 sandboxExecutor?: SandboxExecutor;
}

export async function resolveProjectPrismaValidator(root: string): Promise<string | null> {
 const resolvedRoot = resolve(root);
 const candidate = join(resolvedRoot, 'node_modules', '.bin', 'prisma');
 try {
  await access(candidate, constants.F_OK);
  return candidate;
 } catch {
  if (process.platform === 'win32') {
   const candidateCmd = join(resolvedRoot, 'node_modules', '.bin', 'prisma.cmd');
   try {
    await access(candidateCmd, constants.F_OK);
    return candidateCmd;
   } catch {}
  }
  return null;
 }
}

export async function validatePrismaSchemaInIsolation(
 root: string,
 options?: PrismaValidationOptions
): Promise<PrismaValidationResult> {
 const resolvedRoot = resolve(root);

 let schemas = options?.schemaPaths;
 if (!schemas) {
  try {
   const discovery = await discoverAnalysisInputs(resolvedRoot);
   schemas = discovery.prismaSchemas;
  } catch {
   schemas = [];
  }
 }
 if (!schemas || schemas.length === 0) {
  return {
   status: 'not-applicable',
   diagnostics: [],
  };
 }

 const validator = await resolveProjectPrismaValidator(resolvedRoot);
 if (!validator) {
  return {
   status: 'unavailable',
   reason: 'Project-version Prisma validator is not available (node_modules/.bin/prisma not found). Global Prisma CLI will not be substituted.',
   diagnostics: [],
  };
 }

 const isolated = await sandboxAvailable();
 if (!isolated) {
  return {
   status: 'unavailable',
   reason: 'Bubblewrap isolation is unavailable. Original project files cannot be protected during integrated execution.',
   diagnostics: [],
  };
 }

 const isolatedDir = await mkdtemp(join(tmpdir(), 'architect-prisma-val-'));
 try {
  await copySnapshot(resolvedRoot, isolatedDir);

  const origNodeModules = join(resolvedRoot, 'node_modules');
  const destNodeModules = join(isolatedDir, 'node_modules');
  try {
   await access(origNodeModules, constants.F_OK);
   await symlink(origNodeModules, destNodeModules, 'dir');
  } catch {}

  const isolatedValidator = join(destNodeModules, '.bin', 'prisma');
  const timeoutMs = options?.timeoutMs ?? 30000;

  let combinedOutput = '';
  let allPassed = true;
  let exitCode = 0;

  for (const schemaPath of schemas) {
   const args = ['validate', '--schema', schemaPath];
   const res = options?.sandboxExecutor
    ? await options.sandboxExecutor(isolatedValidator, args, isolatedDir, {
       writable: true,
       network: false,
       timeoutMs,
       env: {
        PATH: process.env.PATH,
        HOME: isolatedDir,
        TMPDIR: '/tmp',
        CI: '1',
        NODE_ENV: 'test',
       },
      })
    : await runSandbox(isolatedValidator, args, isolatedDir, {
       writable: true,
       network: false,
       timeoutMs,
       env: {
        PATH: process.env.PATH,
        HOME: isolatedDir,
        TMPDIR: '/tmp',
        CI: '1',
        NODE_ENV: 'test',
       },
      });

   combinedOutput += (combinedOutput ? '\n' : '') + res.output;
   if (res.code !== 0) {
    allPassed = false;
    exitCode = res.code;
    break;
   }
  }

  if (allPassed) {
   return {
    status: 'passed',
    output: combinedOutput,
    exitCode: 0,
    diagnostics: [],
   };
  } else {
   const errorMsg = combinedOutput.trim() || `Exit code ${exitCode}`;
   return {
    status: 'failed',
    output: combinedOutput,
    exitCode,
    reason: 'Project-version Prisma validation failed.',
    diagnostics: [
     {
      severity: 'error',
      message: 'Project-version Prisma validation failed: ' + errorMsg,
      code: 'prisma-validation',
     },
    ],
   };
  }
 } catch (error: any) {
  const msg = error?.message || String(error);
  return {
   status: 'failed',
   output: msg,
   exitCode: -1,
   reason: 'Project-version Prisma validation encountered an error: ' + msg,
   diagnostics: [
    {
     severity: 'error',
     message: 'Project-version Prisma validation failed: ' + msg,
     code: 'prisma-validation',
    },
   ],
  };
 } finally {
  await rm(isolatedDir, { recursive: true, force: true }).catch(() => {});
 }
}

export interface InvalidationRecord {
 scope: 'broader' | 'local';
 reason: string;
 changedInputs: string[];
 nonlocalInputs: string[];
 timestamp: string;
}

export interface IncrementalAnalysisInfo {
 isWarm: boolean;
 scope: 'broader' | 'local';
 changedInputs: string[];
 nonlocalInputs: string[];
 affectedFiles: string[];
 invalidationReason?: string;
 reusedPrograms: string[];
 rebuiltPrograms: string[];
}

export interface AnalyzeOptions {
 capturedRevision?: CapturedRevision | Record<string, Buffer>;
 captureOptions?: CaptureOptions;
 prismaParserConfig?: PrismaAstConfig['parser'];
 validatePrisma?: boolean;
 prismaValidationOptions?: PrismaValidationOptions;
 inferredItems?: number;
 aiInferences?: Array<{ id?: string; kind?: string; description?: string }>;
 invalidate?: boolean;
 invalidationReason?: string;
}

export class Analyzer {
 public static readonly COMPILER_PIN = TYPESCRIPT_PIN;
 public static readonly PRISMA_PARSER_CONFIG = PRISMA_PARSER_CONFIG;
 public static readonly SCHEMA_DERIVED_NOTICE = SCHEMA_DERIVED_NOTICE;
 public static readonly BEHAVIORAL_LIMIT_STATEMENT = BEHAVIORAL_LIMIT_STATEMENT;
 public readonly compilerPin = TYPESCRIPT_PIN;
 public readonly compilerVersion = ts.version;
 public readonly prismaParserConfig: PrismaAstConfig['parser'];
 public lastDiscovery?: AnalysisInputDiscovery;
 public lastPrismaValidation?: PrismaValidationResult;
 public lastAnalysis?: Analysis;
 public lastReport?: ImportQualityReport;
 public lastChangedInputs: string[] = [];
 public lastAffectedFiles: string[] = [];
 public lastInvalidation?: InvalidationRecord;
 public lastInvalidationReason?: string;
 public lastIncrementalInfo?: IncrementalAnalysisInfo;
 private builderPrograms=new Map<string,ts.SemanticDiagnosticsBuilderProgram>();
 private programs=new Map<string,ts.Program>();
 private sourceCache=new Map<string,{hash:string;source:ts.SourceFile}>();
 private lastFiles?: Record<string, { hash: string; text: string }>;
 private sequence=0;

 constructor(options?: { prismaParserConfig?: PrismaAstConfig['parser'] }) {
  this.prismaParserConfig = options?.prismaParserConfig
   ? { ...PRISMA_PARSER_CONFIG, ...options.prismaParserConfig }
   : PRISMA_PARSER_CONFIG;
 }

 public getBuilderProgram(key = 'unconfigured'): ts.SemanticDiagnosticsBuilderProgram | undefined {
  return this.builderPrograms.get(key);
 }

 public getBuilderPrograms(): ReadonlyMap<string, ts.SemanticDiagnosticsBuilderProgram> {
  return this.builderPrograms;
 }

 public invalidate(reason = 'Explicit broader invalidation', paths: string[] = []): void {
  this.builderPrograms.clear();
  this.programs.clear();
  this.sourceCache.clear();
  this.lastInvalidationReason = reason;
  this.lastInvalidation = {
   scope: 'broader',
   reason,
   changedInputs: paths,
   nonlocalInputs: paths,
   timestamp: new Date().toISOString(),
  };
 }

 public getAffectedClosure(changedPaths: string[], targetGraph?: Graph): string[] {
  const g = targetGraph || this.lastAnalysis?.graph;
  const result = new Set<string>(changedPaths.map(p => p.replace(/\\/g, '/')));
  if (!g) return Array.from(result).sort();

  const modulePathsById = new Map<string, string>();
  for (const n of g.nodes) {
   if (n.kind === 'module' && n.outputPath) {
    modulePathsById.set(n.id, n.outputPath.replace(/\\/g, '/'));
   }
  }

  const nodeModulePath = new Map<string, string>();
  for (const n of g.nodes) {
   if (n.kind === 'module' && n.outputPath) {
    nodeModulePath.set(n.id, n.outputPath.replace(/\\/g, '/'));
   } else if (n.parentId && modulePathsById.has(n.parentId)) {
    nodeModulePath.set(n.id, modulePathsById.get(n.parentId)!);
   } else if (n.source?.path) {
    nodeModulePath.set(n.id, n.source.path.replace(/\\/g, '/'));
   }
  }

  let expanded = true;
  while (expanded) {
   expanded = false;
   for (const e of g.edges) {
    const targetMod = nodeModulePath.get(e.target);
    const sourceMod = nodeModulePath.get(e.source);
    if (targetMod && sourceMod && result.has(targetMod) && !result.has(sourceMod)) {
     result.add(sourceMod);
     expanded = true;
    }
   }
  }

  return Array.from(result).sort();
 }

 async discoverInputs(root:string, capturedFiles?: Record<string, Buffer | { hash: string; text: string }>):Promise<AnalysisInputDiscovery>{
  return discoverAnalysisInputs(resolve(root), capturedFiles);
 }
 async validatePrisma(root:string, options?: PrismaValidationOptions):Promise<PrismaValidationResult>{
  const res = await validatePrismaSchemaInIsolation(root, options);
  this.lastPrismaValidation = res;
  return res;
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
  const prevFiles = this.lastFiles;
  let isWarm = false;
  let changedInputs: string[] = [];
  let nonlocalInputs: string[] = [];
  let isBroaderInvalidation = false;

  const isNonlocal = (p: string): boolean => {
   return (
    discovery.dependencyInputs.includes(p) ||
    (this.lastDiscovery?.dependencyInputs.includes(p) ?? false) ||
    /tsconfig[^/]*\.json$/i.test(p) ||
    /package\.json$/i.test(p) ||
    /lock/i.test(p) ||
    /\.d\.[cm]?ts$/i.test(p) ||
    (/\.json$/i.test(p) && !p.endsWith('.prisma'))
   );
  };

  if (prevFiles) {
   isWarm = true;
   const currKeys = new Set(Object.keys(files));
   const prevKeys = new Set(Object.keys(prevFiles));

   for (const k of currKeys) {
    if (!prevKeys.has(k) || files[k].hash !== prevFiles[k].hash) {
     changedInputs.push(k);
     if (isNonlocal(k)) nonlocalInputs.push(k);
    }
   }
   for (const k of prevKeys) {
    if (!currKeys.has(k)) {
     changedInputs.push(k);
     if (isNonlocal(k)) nonlocalInputs.push(k);
    }
   }
   changedInputs.sort();
   nonlocalInputs.sort();
  } else {
   changedInputs = Object.keys(files).sort();
  }

  if (options?.invalidate || nonlocalInputs.length > 0) {
   isBroaderInvalidation = true;
   const reason = options?.invalidationReason || (
    nonlocalInputs.length > 0
     ? 'Broader invalidation triggered by nonlocal input change: ' + nonlocalInputs.join(', ')
     : 'Explicit broader invalidation requested'
   );
   this.invalidate(reason, nonlocalInputs.length > 0 ? nonlocalInputs : changedInputs);
  } else if (prevFiles) {
   const currKeys = new Set(Object.keys(files));
   for (const k of Object.keys(prevFiles)) {
    if (!currKeys.has(k)) {
     this.sourceCache.delete(k);
     this.sourceCache.delete(resolve(root, k));
    }
   }
   this.lastInvalidation = {
    scope: 'local',
    reason: 'Warm incremental update of local inputs: ' + changedInputs.join(', '),
    changedInputs,
    nonlocalInputs: [],
    timestamp: new Date().toISOString(),
   };
   this.lastInvalidationReason = undefined;
  }
  const diagnostics:Diagnostic[]=[];let unsupported=0,unresolved=0,analyzed=0;
  const unsupportedLocations=new Set<string>();
  const recordUnsupported=(locKey:string,d:Diagnostic)=>{
   if(!unsupportedLocations.has(locKey)){
    unsupportedLocations.add(locKey);
    unsupported++;
    diagnostics.push(d);
   }
  };
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
  const reusedPrograms: string[] = [];
  const rebuiltPrograms: string[] = [];
  const builderAffectedFiles = new Set<string>();

  for(const setting of settings){
   const host=ts.createIncrementalCompilerHost(setting.options);
   const origGetSourceFile=host.getSourceFile.bind(host);
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
    const rel = getRel(file);
    if(rel !== null && rel in files){
     const text = files[rel].text;
     const digest = files[rel].hash || hash(text);
     const old = this.sourceCache.get(file);
     if(old && old.hash === digest){
      if((old.source as any).version === undefined){
       (old.source as any).version = digest;
      }
      return old.source;
     }
     const sf = ts.createSourceFile(file, text, languageVersion, true);
     (sf as any).version = digest;
     this.sourceCache.set(file, { hash: digest, source: sf });
     return sf;
    }
    const text=host.readFile(file);
    if(text===undefined)return undefined;
    const digest=hash(text);
    const old=this.sourceCache.get(file);
    if(old && old.hash===digest){
     if((old.source as any).version === undefined){
      (old.source as any).version = digest;
     }
     return old.source;
    }
    const sf=origGetSourceFile(file, languageVersion) || ts.createSourceFile(file, text, languageVersion, true);
    (sf as any).version = digest;
    this.sourceCache.set(file, { hash: digest, source: sf });
    return sf;
   };

   const oldBuilder = this.builderPrograms.get(setting.key);
   if(oldBuilder){
    reusedPrograms.push(setting.key);
   }else{
    rebuiltPrograms.push(setting.key);
   }

   const builder = ts.createSemanticDiagnosticsBuilderProgram(
    setting.rootNames,
    setting.options,
    host,
    oldBuilder,
    undefined,
    setting.references
   );
   this.builderPrograms.set(setting.key, builder);
   const program = builder.getProgram();
   this.programs.set(setting.key, program);
   programHosts.set(program, host);

   let aff;
   while((aff = builder.getSemanticDiagnosticsOfNextAffectedFile())){
    if(aff.affected){
     const fn = (aff.affected as ts.SourceFile).fileName || (aff.affected as any).fileName;
     if(fn){
      const rel = relative(root, fn).replaceAll('\\', '/');
      if(files[rel]){
       builderAffectedFiles.add(rel);
      }
     }
    }
   }

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
   function isErrorType(type: ts.Type | undefined, visited = new Set<ts.Type>()): boolean {
    if (!type || visited.has(type)) return false;
    visited.add(type);
    if ((type as any).intrinsicName === 'error') return true;
    if ((type.flags & ts.TypeFlags.Any) && (type as any).intrinsicName === 'error') return true;
    if (type.isUnionOrIntersection()) {
     return type.types.some(t => isErrorType(t, visited));
    }
    const typeArgs = checker.getTypeArguments?.(type as ts.TypeReference) || (type as ts.TypeReference).typeArguments;
    if (typeArgs && typeArgs.some(t => isErrorType(t, visited))) return true;
    const aliasArgs = type.aliasTypeArguments;
    if (aliasArgs && aliasArgs.some(t => isErrorType(t, visited))) return true;
    return false;
   }
   function checkSignatureUnresolved(sig: ts.Signature, declNode: ts.Node, symbolName: string) {
    const retType = checker.getReturnTypeOfSignature(sig);
    if (isErrorType(retType)) {
     unresolved++;
     diagnostics.push({
      severity: 'error',
      message: `Unresolved return type in contract for ${symbolName}`,
      path,
      line: sf.getLineAndCharacterOfPosition(declNode.getStart(sf)).line + 1,
      code: 'unresolved-type',
     });
    }
    for (const p of sig.parameters) {
     const decl = p.valueDeclaration || p.declarations?.[0] || declNode;
     const pt = checker.getTypeOfSymbolAtLocation(p, decl);
     if (isErrorType(pt)) {
      unresolved++;
      diagnostics.push({
       severity: 'error',
       message: `Unresolved parameter type in contract for ${symbolName} (${p.getName()})`,
       path,
       line: sf.getLineAndCharacterOfPosition(decl.getStart(sf)).line + 1,
       code: 'unresolved-type',
      });
     }
    }
    for (const tp of sig.typeParameters || []) {
     const constraint = checker.getBaseConstraintOfType(tp);
     if (constraint && isErrorType(constraint)) {
      unresolved++;
      diagnostics.push({
       severity: 'error',
       message: `Unresolved generic constraint in contract for ${symbolName} (${tp.symbol?.getName() || 'type parameter'})`,
       path,
       line: sf.getLineAndCharacterOfPosition(declNode.getStart(sf)).line + 1,
       code: 'unresolved-type',
      });
     }
     const def = (tp as any).getDefault ? (tp as any).getDefault() : undefined;
     if (def && isErrorType(def)) {
      unresolved++;
      diagnostics.push({
       severity: 'error',
       message: `Unresolved default type parameter in contract for ${symbolName} (${tp.symbol?.getName() || 'type parameter'})`,
       path,
       line: sf.getLineAndCharacterOfPosition(declNode.getStart(sf)).line + 1,
       code: 'unresolved-type',
      });
     }
    }
   }
   function functionContract(n:ts.SignatureDeclaration,name:string,symbolName:string){
    const signature=checker.getSignatureFromDeclaration(n);
    if(signature){
     checkSignatureUnresolved(signature,n,symbolName);
     return name+checker.signatureToString(signature,n,flags);
    }
    return name+n.getText(sf).split('{')[0];
   }
   function shape(n:ts.Node,symbolName:string){
    const type=checker.getTypeAtLocation(n);
    const members: string[] = [];
    if(ts.isInterfaceDeclaration(n)||ts.isTypeAliasDeclaration(n)){
     for(const sig of checker.getSignaturesOfType(type, ts.SignatureKind.Call)){
      checkSignatureUnresolved(sig, n, symbolName);
      members.push(checker.signatureToString(sig, n, flags));
     }
     for(const sig of checker.getSignaturesOfType(type, ts.SignatureKind.Construct)){
      checkSignatureUnresolved(sig, n, symbolName);
      members.push('new ' + checker.signatureToString(sig, n, flags));
     }
    }
    for(const info of checker.getIndexInfosOfType(type)){
     if(isErrorType(info.keyType) || isErrorType(info.type)){
      unresolved++;
      diagnostics.push({
       severity: 'error',
       message: `Unresolved index signature type in contract for ${symbolName}`,
       path,
       line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
       code: 'unresolved-type',
      });
     }
     const keyStr = info.keyType ? checker.typeToString(info.keyType, n, flags) : 'string';
     members.push(`[key: ${keyStr}]: ${checker.typeToString(info.type, n, flags)}`);
    }
    for(const p of checker.getPropertiesOfType(type)){
     const decl=p.valueDeclaration||p.declarations?.[0]||n;
     const propType=checker.getTypeOfSymbolAtLocation(p,decl);
     if(isErrorType(propType)){
      unresolved++;
      diagnostics.push({
       severity: 'error',
       message: `Unresolved property type in contract for ${symbolName} (${p.getName()})`,
       path,
       line: sf.getLineAndCharacterOfPosition(decl.getStart(sf)).line + 1,
       code: 'unresolved-type',
      });
     }
     for(const sig of checker.getSignaturesOfType(propType, ts.SignatureKind.Call)){
      checkSignatureUnresolved(sig, decl, symbolName + '.' + p.getName());
     }
     for(const sig of checker.getSignaturesOfType(propType, ts.SignatureKind.Construct)){
      checkSignatureUnresolved(sig, decl, symbolName + '.' + p.getName());
     }
     members.push(p.getName()+(p.flags&ts.SymbolFlags.Optional?'?':'')+': '+checker.typeToString(propType,decl,flags));
    }
    if((ts.isClassDeclaration(n)||ts.isInterfaceDeclaration(n))&&n.heritageClauses){
     for(const clause of n.heritageClauses){
      for(const t of clause.types){
       const heritageType=checker.getTypeAtLocation(t);
       if(isErrorType(heritageType)){
        unresolved++;
        diagnostics.push({
         severity: 'error',
         message: `Unresolved base type in contract for ${symbolName} (${t.expression.getText(sf)})`,
         path,
         line: sf.getLineAndCharacterOfPosition(t.getStart(sf)).line + 1,
         code: 'unresolved-type',
        });
       }
      }
     }
    }
    return members.sort().join('; ');
   }
   function visit(n:ts.Node,parentId:string,qualified:string){
    let id:string|undefined;let name:string|undefined;let kind:ProgramNode['kind']|undefined;let contract='';
    let enumFields:{name:string;type:string}[]=[];
    if(ts.isClassDeclaration(n)||ts.isInterfaceDeclaration(n)||ts.isTypeAliasDeclaration(n)){
     name=n.name?.text||'default';kind=ts.isClassDeclaration(n)?'class':'interface';
     const symbolName=qualified?qualified+'.'+name:name;
     contract=shape(n,symbolName);
     if(ts.isTypeAliasDeclaration(n)){
      const aliasType=checker.getTypeAtLocation(n);
      if(isErrorType(aliasType)){
       unresolved++;
       diagnostics.push({
        severity: 'error',
        message: `Unresolved type alias in contract for ${symbolName}`,
        path,
        line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
        code: 'unresolved-type',
       });
      }
      contract=checker.typeToString(aliasType,n,flags|ts.TypeFormatFlags.InTypeAlias);
     }
    }else if(ts.isEnumDeclaration(n)){
     name=n.name.text;kind='enum';contract='enum '+name+' { '+n.members.map(m=>m.getText(sf)).join(', ')+' }';
     enumFields=n.members.map(m=>({name:m.name.getText(sf),type:'enum'}));
    }else if(ts.isModuleDeclaration(n)&&n.name){
     name=n.name.text;kind='module';contract='namespace '+name;
    }else if(ts.isFunctionDeclaration(n)||ts.isMethodDeclaration(n)||ts.isMethodSignature(n)||ts.isConstructorDeclaration(n)||ts.isGetAccessorDeclaration(n)||ts.isSetAccessorDeclaration(n)){
     name=ts.isConstructorDeclaration(n)?'constructor':n.name?.getText(sf)||'default';
     const symbolName=qualified?qualified+'.'+name:name;
     kind='function';contract=functionContract(n,name,symbolName);
    }else if((ts.isVariableDeclaration(n)||ts.isPropertyDeclaration(n))&&n.initializer&&(ts.isArrowFunction(n.initializer)||ts.isFunctionExpression(n.initializer))){
     name=n.name.getText(sf);kind='function';
     const symbolName=qualified?qualified+'.'+name:name;
     contract=functionContract(n.initializer,name,symbolName);
    }else if((ts.isVariableDeclaration(n)||ts.isPropertyDeclaration(n))&&n.initializer&&(ts.isClassDeclaration(n.initializer)||ts.isClassExpression(n.initializer))){
     name=n.name.getText(sf);kind='class';
     const symbolName=qualified?qualified+'.'+name:name;
     contract=shape(n.initializer,symbolName);
    }else if(ts.isExportAssignment(n)){
     if(ts.isArrowFunction(n.expression)||ts.isFunctionExpression(n.expression)){
      name='default';kind='function';
      const symbolName=qualified?qualified+'.'+name:name;
      contract=functionContract(n.expression,name,symbolName);
     }else if(ts.isClassExpression(n.expression)){
      name=n.expression.name?.text||'default';kind='class';
      const symbolName=qualified?qualified+'.'+name:name;
      contract=shape(n.expression,symbolName);
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
   function isErrorType(type: ts.Type | undefined, visited = new Set<ts.Type>()): boolean {
    if (!type || visited.has(type)) return false;
    visited.add(type);
    if ((type as any).intrinsicName === 'error') return true;
    if ((type.flags & ts.TypeFlags.Any) && (type as any).intrinsicName === 'error') return true;
    if (type.isUnionOrIntersection()) {
     return type.types.some(t => isErrorType(t, visited));
    }
    const typeArgs = checker.getTypeArguments?.(type as ts.TypeReference) || (type as ts.TypeReference).typeArguments;
    if (typeArgs && typeArgs.some(t => isErrorType(t, visited))) return true;
    const aliasArgs = type.aliasTypeArguments;
    if (aliasArgs && aliasArgs.some(t => isErrorType(t, visited))) return true;
    return false;
   }
   const external=(expression:ts.Expression,decl?:ts.Declaration)=>{
    const text=expression.getText(sf);
    const origin=decl?decl.getSourceFile().fileName.replaceAll('\\','/').replace(/^.*node_modules\//,''):'unresolved';
    const id=idFor('external:'+origin+':'+text);
    if(!nodes.has('external'))nodes.set('external',NodeSchema.parse({id:'external',kind:'system',name:'External / unresolved',provenance:'extracted'}));
    if(!nodes.has(id))nodes.set(id,NodeSchema.parse({id,kind:'function',name:text,parentId:'external',provenance:'extracted',description:decl?'Resolved declaration outside imported source.':'The call target cannot be resolved statically.'}));
    return id;
   };
   function unwrapParentheses(expr: ts.Expression): ts.Expression {
    while(ts.isParenthesizedExpression(expr)){
     expr=expr.expression;
    }
    return expr;
   }
   function isDynamicPropertyCall(call: ts.CallExpression): boolean {
    const expr = unwrapParentheses(call.expression);
    if(ts.isElementAccessExpression(expr)){
     if(!ts.isStringLiteral(expr.argumentExpression)){
      return true;
     }
     const receiverType = checker.getTypeAtLocation(unwrapParentheses(expr.expression));
     if(receiverType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)){
      return true;
     }
     const sym = checker.getSymbolAtLocation(expr.argumentExpression);
     if(!sym){
      return true;
     }
     return false;
    }
    if(ts.isPropertyAccessExpression(expr)){
     const receiverType = checker.getTypeAtLocation(unwrapParentheses(expr.expression));
     if(receiverType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)){
      return true;
     }
    }
    return false;
   }
   function isDynamicEvaluation(n: ts.CallExpression | ts.NewExpression): { reason: string; code: string } | undefined {
    const expr = unwrapParentheses(n.expression);
    if (ts.isIdentifier(expr)) {
     if (expr.text === 'eval') {
      return { reason: 'Dynamic code evaluation via eval', code: 'unsupported-eval' };
     }
     if (expr.text === 'Function') {
      return { reason: 'Dynamic code evaluation via Function constructor', code: 'unsupported-eval' };
     }
    }
    if (ts.isPropertyAccessExpression(expr)) {
     if (expr.name.text === 'eval') {
      return { reason: 'Dynamic code evaluation via eval', code: 'unsupported-eval' };
     }
     if (expr.name.text === 'Function') {
      return { reason: 'Dynamic code evaluation via Function constructor', code: 'unsupported-eval' };
     }
    }
    return undefined;
   }
   function resolveAliasSymbol(sym: ts.Symbol | undefined): ts.Symbol | undefined {
    let current = sym;
    while(current && (current.flags & ts.SymbolFlags.Alias)){
     try{
      const next = checker.getAliasedSymbol(current);
      if(!next || next === current) break;
      current = next;
     }catch{
      break;
     }
    }
    if(current && current.declarations?.[0] && ts.isExportAssignment(current.declarations[0])){
     const ea = current.declarations[0] as ts.ExportAssignment;
     if(ea.expression && !ts.isClassExpression(ea.expression) && !ts.isArrowFunction(ea.expression) && !ts.isFunctionExpression(ea.expression)){
      const exprSym = checker.getSymbolAtLocation(ea.expression);
      if(exprSym){
       current = exprSym;
       while(current && (current.flags & ts.SymbolFlags.Alias)){
        try{
         const next = checker.getAliasedSymbol(current);
         if(!next || next === current) break;
         current = next;
        }catch{
         break;
        }
       }
      }
     }
    }
    return current;
   }
   function walk(n:ts.Node,owner:string){
    const own=declarations.get(n);if(own)owner=own;
    if((ts.isImportDeclaration(n)||ts.isExportDeclaration(n))&&n.moduleSpecifier&&ts.isStringLiteral(n.moduleSpecifier)){
     const currentHost = programHosts.get(program) || ts.sys;
     const resolved=ts.resolveModuleName(n.moduleSpecifier.text,sf.fileName,program.getCompilerOptions(),currentHost).resolvedModule;
     if(resolved&&fullPaths.has(resolve(resolved.resolvedFileName))){
      addEdge(mid,idFor('module:'+relative(root,resolved.resolvedFileName).replaceAll('\\','/')),'depends-on');
     }else if(!resolved){
      unresolved++;
      diagnostics.push({
       severity:'error',
       message:'Unresolved import target: '+n.moduleSpecifier.text,
       path,
       line:sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1,
       code:'unresolved-import'
      });
     }
    }
    if(ts.isCallExpression(n)||ts.isNewExpression(n)){
     const dynEval=isDynamicEvaluation(n);
     const isDynProp=ts.isCallExpression(n) && isDynamicPropertyCall(n);
     if(dynEval){
      const locKey=path+':'+n.getStart(sf);
      recordUnsupported(locKey,{
       severity:'warning',
       message:dynEval.reason+': '+n.getText(sf),
       path,
       line:sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1,
       code:dynEval.code
      });
     }else if(isDynProp){
      const locKey=path+':'+n.getStart(sf);
      recordUnsupported(locKey,{
       severity:'warning',
       message:'Dynamic property call cannot be resolved statically: '+n.expression.getText(sf),
       path,
       line:sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1,
       code:'unsupported-dispatch'
      });
     }else{
      const callExpr = unwrapParentheses(n.expression);
      let symbol=checker.getSymbolAtLocation(callExpr);
      if(!symbol && ts.isElementAccessExpression(callExpr) && ts.isStringLiteral(callExpr.argumentExpression)){
       symbol=checker.getSymbolAtLocation(callExpr.argumentExpression);
      }
      symbol = resolveAliasSymbol(symbol);
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
      if(uncertain){
       unresolved++;
       diagnostics.push({
        severity:'warning',
        message:'Unresolved call: '+n.expression.getText(sf),
        path,
        line:sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1,
        code:'unresolved-call'
       });
      }
      addEdge(owner,target,'calls','',uncertain);
     }
    }
    if((ts.isClassDeclaration(n)||ts.isClassExpression(n)||ts.isInterfaceDeclaration(n))&&n.heritageClauses)for(const clause of n.heritageClauses)for(const t of clause.types){
     let sym=checker.getSymbolAtLocation(t.expression);
     sym = resolveAliasSymbol(sym);
     const decl=clause.token===ts.SyntaxKind.ExtendsKeyword?(sym?.valueDeclaration||sym?.declarations?.[0]):sym?.declarations?.[0];
     let target=decl&&(declarations.get(decl)||declarationKeys.get(makeKey(decl)));
     if(!target&&sym?.declarations){
      for(const d of sym.declarations){
       target=declarations.get(d)||declarationKeys.get(makeKey(d));
       if(target)break;
      }
     }
     if(target){
      addEdge(owner,target,clause.token===ts.SyntaxKind.ExtendsKeyword?'inherits':'implements');
     }else{
      const heritageType=checker.getTypeAtLocation(t);
      if((!sym||!decl) && !isErrorType(heritageType)){
       unresolved++;
       diagnostics.push({
        severity:'error',
        message:'Unresolved '+(clause.token===ts.SyntaxKind.ExtendsKeyword?'inheritance':'implementation')+' target: '+t.expression.getText(sf),
        path,
        line:sf.getLineAndCharacterOfPosition(t.getStart(sf)).line+1,
        code:'unresolved-target'
       });
      }
     }
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
    type SequenceResult={exits:Exit[];throws:Exit[]};
    const step=(n:ts.Node,type:ProgramNode['stepType'],label:string,startPos?:number,endPos?:number)=>{
     const key=owner+':'+type+':'+normalize(n.getText(sf));const count=occurrence.get(key)||0;occurrence.set(key,count+1);
     const id=idFor(key+':'+count);
     const sStart=startPos??n.getStart(sf);
     const sEnd=endPos??n.end;
     const desc=sf.text.slice(sStart,sEnd);
     nodes.set(id,NodeSchema.parse({id,kind:'step',name:label.slice(0,100),parentId:owner,provenance:'extracted',stepType:type,description:desc,source:source(path,sStart,sEnd)}));
     return id;
    };
    const connect=(incoming:Exit[],id:string)=>incoming.forEach(e=>addEdge(e.id,id,e.kind));
    function sequence(statements:readonly ts.Statement[],incoming:Exit[]):SequenceResult{
     let currentExits=incoming;
     const allThrows:Exit[]=[];
     for(const stmt of statements){
      if(ts.isBlock(stmt)){
       const blockRes=sequence(stmt.statements,currentExits);
       currentExits=blockRes.exits;
       allThrows.push(...blockRes.throws);
       continue;
      }
      if(ts.isIfStatement(stmt)){
       const label=stmt.expression.getText(sf);
       const id=step(stmt,'condition',label);
       connect(currentExits,id);
       const thenStmts=ts.isBlock(stmt.thenStatement)?stmt.thenStatement.statements:[stmt.thenStatement];
       const thenRes=sequence(thenStmts,[{id,kind:'true'}]);
       allThrows.push(...thenRes.throws);
       let elseExits:Exit[]=[];
       if(stmt.elseStatement){
        const elseStmts=ts.isBlock(stmt.elseStatement)?stmt.elseStatement.statements:[stmt.elseStatement];
        const elseRes=sequence(elseStmts,[{id,kind:'false'}]);
        elseExits=elseRes.exits;
        allThrows.push(...elseRes.throws);
       }else{
        elseExits=[{id,kind:'false'}];
       }
       currentExits=[...thenRes.exits,...elseExits];
       continue;
      }
      if(ts.isForStatement(stmt)||ts.isForOfStatement(stmt)||ts.isForInStatement(stmt)||ts.isWhileStatement(stmt)||ts.isDoStatement(stmt)){
       const label=stmt.getText(sf);
       const id=step(stmt,'loop',label);
       connect(currentExits,id);
       const bodyStmt=(stmt as ts.IterationStatement).statement;
       const bodyStmts=ts.isBlock(bodyStmt)?bodyStmt.statements:[bodyStmt];
       const bodyRes=sequence(bodyStmts,[{id,kind:'true'}]);
       allThrows.push(...bodyRes.throws);
       bodyRes.exits.forEach(e=>addEdge(e.id,id,e.kind));
       currentExits=[{id,kind:'false'}];
       continue;
      }
      if(ts.isTryStatement(stmt)){
       const id=step(stmt.tryBlock,'try','try',stmt.getStart(sf),stmt.tryBlock.end);
       connect(currentExits,id);
       const tryRes=sequence(stmt.tryBlock.statements,[{id,kind:'next'}]);
       if(stmt.catchClause){
        const catchVar=stmt.catchClause.variableDeclaration;
        const catchLabel=catchVar?'catch ('+catchVar.getText(sf)+')':'catch';
        const catchId=step(stmt.catchClause,'operation',catchLabel,stmt.catchClause.getStart(sf),stmt.catchClause.end);
        if(tryRes.throws.length>0){
         tryRes.throws.forEach(t=>addEdge(t.id,catchId,'exception','Failure'));
        }else{
         addEdge(id,catchId,'exception','Failure');
        }
        const catchStmts=stmt.catchClause.block.statements;
        const catchRes=sequence(catchStmts,[{id:catchId,kind:'next'}]);
        allThrows.push(...catchRes.throws);
        if(stmt.finallyBlock){
         const finallyRes=sequence(stmt.finallyBlock.statements,[...tryRes.exits,...catchRes.exits]);
         currentExits=finallyRes.exits;
         allThrows.push(...finallyRes.throws);
        }else{
         currentExits=[...tryRes.exits,...catchRes.exits];
        }
       }else if(stmt.finallyBlock){
        const finallyRes=sequence(stmt.finallyBlock.statements,tryRes.exits);
        currentExits=finallyRes.exits;
        allThrows.push(...tryRes.throws,...finallyRes.throws);
       }else{
        currentExits=tryRes.exits;
        allThrows.push(...tryRes.throws);
       }
       continue;
      }
      if(ts.isThrowStatement(stmt)){
       const label=stmt.getText(sf);
       const id=step(stmt,'throw',label);
       connect(currentExits,id);
       allThrows.push({id,kind:'exception'});
       currentExits=[];
       continue;
      }
      if(ts.isReturnStatement(stmt)){
       const label=stmt.getText(sf);
       const id=step(stmt,'return',label);
       connect(currentExits,id);
       currentExits=[];
       continue;
      }
      function getUnsupportedStatementInfo(s: ts.Statement): { reason: string; code: string; locStart: number } | undefined {
       if(ts.isSwitchStatement(s)){
        return { reason: 'Switch statement execution paths are not fully reconstructed', code: 'unsupported-switch', locStart: s.getStart(sf) };
       }
       if(ts.isBreakStatement(s)){
        return { reason: 'Break statement jump is not supported in structured workflows', code: 'unsupported-jump', locStart: s.getStart(sf) };
       }
       if(ts.isContinueStatement(s)){
        return { reason: 'Continue statement jump is not supported in structured workflows', code: 'unsupported-jump', locStart: s.getStart(sf) };
       }
       if(ts.isWithStatement(s)){
        return { reason: 'With statement is not supported in structured workflows', code: 'unsupported-with', locStart: s.getStart(sf) };
       }
       if(ts.isLabeledStatement(s)){
        return { reason: 'Labeled statement jump is not supported in structured workflows', code: 'unsupported-labeled', locStart: s.getStart(sf) };
       }
       if(ts.isDebuggerStatement(s)){
        return { reason: 'Debugger statement is not supported in structured workflows', code: 'unsupported-debugger', locStart: s.getStart(sf) };
       }
       let dynamicInfo: { reason: string; code: string; locStart: number } | undefined;
       function checkNode(node: ts.Node){
        if(dynamicInfo) return;
        if(ts.isCallExpression(node) || ts.isNewExpression(node)){
         const dyn = isDynamicEvaluation(node);
         if(dyn){
          dynamicInfo = { reason: dyn.reason, code: dyn.code, locStart: node.getStart(sf) };
          return;
         }
         if(ts.isCallExpression(node) && isDynamicPropertyCall(node)){
          dynamicInfo = { reason: 'Dynamic property call cannot be resolved statically: ' + node.expression.getText(sf), code: 'unsupported-dispatch', locStart: node.getStart(sf) };
          return;
         }
        }
        ts.forEachChild(node, checkNode);
       }
       checkNode(s);
       return dynamicInfo;
      }
      const unsupportedInfo=getUnsupportedStatementInfo(stmt);
      const isCall=!unsupportedInfo&&ts.isExpressionStatement(stmt)&&(ts.isCallExpression(stmt.expression)||(ts.isAwaitExpression(stmt.expression)&&ts.isCallExpression(stmt.expression.expression)));
      const isOpaque=!!unsupportedInfo;
      const type:ProgramNode['stepType']=isCall?'call':isOpaque?'opaque':'operation';
      const label=stmt.getText(sf);
      const id=step(stmt,type,label);
      connect(currentExits,id);
      if(type==='opaque'){
       const locKey=path+':'+(unsupportedInfo?unsupportedInfo.locStart:stmt.getStart(sf));
       recordUnsupported(locKey,{
        severity:'warning',
        message:'Workflow contains a source-backed block whose execution paths are not fully reconstructed'+(unsupportedInfo?': '+unsupportedInfo.reason:'.'),
        path,
        line:sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line+1,
        code:unsupportedInfo?unsupportedInfo.code:'unsupported-construct'
       });
      }
      currentExits=[{id,kind:'next'}];
     }
     return {exits:currentExits,throws:allThrows};
    }
    if(ts.isBlock(body))sequence(body.statements,[]);
    else step(body,'return','return '+body.getText(sf));
   }
   function flows(n:ts.Node){const id=declarations.get(n);if(id&&nodes.get(id)?.kind==='function'&&!ts.isArrowFunction(n)&&!ts.isFunctionExpression(n))workflow(n,id);ts.forEachChild(n,flows);}
   flows(sf);
  }
  const prismaConfig = options?.prismaParserConfig ?? this.prismaParserConfig;
  for(const path of eligible.filter(p=>p.endsWith('.prisma'))){
   const parseRes = parsePrismaSchema(path, files[path]?.text ?? '', prismaConfig);
   if(parseRes.diagnostics.length > 0){
    for(const d of parseRes.diagnostics) diagnostics.push(d);
    continue;
   }
   const schema = parseRes.schema;
   if(!schema){
    diagnostics.push({severity:'error',message:'Prisma schema AST is unavailable after parse',path,code:'prisma-parse-error'});
    continue;
   }
   try{
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
     const {
      compositeKeys,
      indexes,
      compositeIdFields,
      singleIdFields,
      compositeUniqueFields,
      singleUniqueFields,
     } = extractPrismaKeysAndIndexes(model);
     const compositeIdSet = new Set(compositeIdFields);
     const singleIdSet = new Set(singleIdFields);
     const compositeUniqueSet = new Set(compositeUniqueFields);
     const singleUniqueSet = new Set(singleUniqueFields);

     const location=model.location;const startOffset=location?.startOffset??files[path].text.indexOf('model '+model.name);
     const blockEnd=findPrismaBlockEnd(files[path].text,startOffset);
     const end=blockEnd > startOffset ? blockEnd : (location?.endOffset??startOffset)+1;
     const mapped=model.properties.find(p=>p.type==='attribute'&&p.name==='map') as any;
     const modelMappedName=extractPrismaMapping(mapped);
     const modelText=files[path].text.slice(startOffset,end);
     const extractedFields=fields.map(f=>{
      const escapedName=f.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const re=new RegExp('(^|\\n)[ \\t]*('+escapedName+')\\b');
      const match=re.exec(modelText);
      let fieldSource:Source|undefined=undefined;
      if(match){
       const matchStart=match.index+match[1].length;
       const nameStart=modelText.indexOf(match[2],matchStart);
       let lineEnd=modelText.indexOf('\n',nameStart);
       if(lineEnd===-1)lineEnd=modelText.length;
       const fStart=startOffset+nameStart;
       const fEnd=startOffset+lineEnd;
       fieldSource=source(path,fStart,fEnd,`${model.name}.${f.name}`);
      }
      let key = '';
      if(attr(f,'id') || singleIdSet.has(f.name)){
       key = 'PK';
      }else if(compositeIdSet.has(f.name)){
       key = 'PK (composite)';
      }else if(compositeUniqueSet.has(f.name)){
       key = 'UNIQUE (composite)';
      }else if(foreign.has(f.name)){
       key = 'FK';
      }else if(attr(f,'unique') || singleUniqueSet.has(f.name)){
       key = 'UNIQUE';
      }else if(modelsByName.has(String(f.fieldType))){
       key = 'RELATION';
      }
      return {
       name:f.name,
       type:String(f.fieldType)+(f.array?'[]':''),
       optional:!!f.optional,
       key,
       mappedName:extractPrismaMapping(attr(f,'map')),
       defaultValue:extractPrismaDefault(attr(f,'default')),
       source:fieldSource,
      };
     });
     const nodePayload:any = {
      id,kind:'entity',name:model.name,parentId:mid,provenance:'extracted',source:source(path,startOffset,end,model.name),outputPath:path,
      contract:JSON.stringify(model.properties.filter(p=>p.type==='field'||p.type==='attribute').map((p:any)=>({name:p.name,fieldType:p.fieldType,optional:p.optional,array:p.array,attributes:p.attributes,args:p.args})),(key,value)=>key==='location'||key==='comment'?undefined:value),
      description:modelMappedName?'Database name: '+modelMappedName+' · '+SCHEMA_DERIVED_NOTICE:SCHEMA_DERIVED_NOTICE,
      instructions:SCHEMA_DERIVED_NOTICE,
      fields:extractedFields,
     };
     if(modelMappedName){
      nodePayload.mappedName=modelMappedName;
     }
     if(compositeKeys.length>0){
      nodePayload.compositeKeys=compositeKeys;
     }
     if(indexes.length>0){
      nodePayload.indexes=indexes;
     }
     nodes.set(id,NodeSchema.parse(nodePayload));
    }
    for(const model of models){
     for(const f of model.properties.filter((p):p is Field=>p.type==='field')){
      const relAttr = attr(f, 'relation');
      const isKnownModel = modelsByName.has(String(f.fieldType));
      if (!isKnownModel && !relAttr) continue;

      const other = String(f.fieldType);
      const targetModel = modelsByName.get(other);

      const location = model.location;
      const startOffset = location?.startOffset ?? files[path].text.indexOf('model ' + model.name);
      const blockEnd = findPrismaBlockEnd(files[path].text, startOffset);
      const end = blockEnd > startOffset ? blockEnd : (location?.endOffset ?? startOffset) + 1;
      const modelText = files[path].text.slice(startOffset, end);
      const escapedName = f.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('(^|\\n)[ \\t]*(' + escapedName + ')\\b');
      const match = re.exec(modelText);
      let fLine: number | undefined = undefined;
      if (match) {
       const matchStart = match.index + match[1].length;
       const nameStart = modelText.indexOf(match[2], matchStart);
       const fStart = startOffset + nameStart;
       fLine = files[path].text.slice(0, fStart).split('\n').length;
      }

      if (!targetModel) {
       unresolved++;
       diagnostics.push({
        severity: 'error',
        message: `Unresolved relation target model '${other}' on field '${model.name}.${f.name}'`,
        path,
        line: fLine,
        code: 'unresolved-relation',
       });
       const id = idFor('relation:' + path + ':' + model.name + ':' + other + ':' + f.name);
       edges.set(id, {
        id,
        source: idFor('entity:' + path + ':' + model.name),
        target: idFor('entity:' + path + ':' + other),
        kind: 'relates-to',
        label: 'relates-to',
        provenance: 'extracted',
        uncertain: true,
       });
       continue;
      }

      const { inverse, ambiguous } = findPrismaInverseRelationField(model, f, modelsByName);
      const relInfo = extractPrismaRelationFields(relAttr);
      const foreign = relInfo.fields;
      const referenced = relInfo.references;
      const group = relInfo.name ?? '';

      if (ambiguous) {
       diagnostics.push({
        severity: 'error',
        message: `Ambiguous relation between '${model.name}' and '${other}' on field '${model.name}.${f.name}': multiple matching relation fields found without distinguishing relation names`,
        path,
        line: fLine,
        code: 'unresolved-relation',
       });
      }

      let hasBrokenFields = false;
      for (const fk of foreign) {
       const hasLocal = model.properties.some(p => p.type === 'field' && p.name === fk);
       if (!hasLocal) {
        unresolved++;
        hasBrokenFields = true;
        diagnostics.push({
         severity: 'error',
         message: `Unresolved foreign key field '${fk}' on model '${model.name}' in relation '${model.name}.${f.name}'`,
         path,
         line: fLine,
         code: 'unresolved-relation',
        });
       }
      }

      for (const ref of referenced) {
       const hasTarget = targetModel.properties.some(p => p.type === 'field' && p.name === ref);
       if (!hasTarget) {
        unresolved++;
        hasBrokenFields = true;
        diagnostics.push({
         severity: 'error',
         message: `Unresolved referenced field '${ref}' on model '${other}' in relation '${model.name}.${f.name}'`,
         path,
         line: fLine,
         code: 'unresolved-relation',
        });
       }
      }

      const pair = [model.name, other].sort().join(':') + (model.name === other && !group ? ':' + f.name : '');
      const id = idFor('relation:' + path + ':' + pair + ':' + group);
      const cardinality = computePrismaRelationCardinality(f, inverse);
      const edgeLabel = cardinality + (foreign.length ? ' · ' + foreign.join(', ') : '');
      const isUncertain = !inverse || ambiguous || hasBrokenFields;

      if (!edges.has(id) || foreign.length) {
       edges.set(id, {
        id,
        source: idFor('entity:' + path + ':' + model.name),
        target: idFor('entity:' + path + ':' + other),
        kind: 'relates-to',
        label: edgeLabel,
        provenance: 'extracted',
        uncertain: isUncertain,
       });
      }
     }
    }
    for(const block of schema.list)if(block.type==='enum'){
     const enumLoc=block.location;
     const startOffset=enumLoc?.startOffset??files[path].text.indexOf('enum '+block.name);
     const blockEnd=findPrismaBlockEnd(files[path].text,startOffset);
     const end=blockEnd > startOffset ? blockEnd : (enumLoc?.endOffset??startOffset)+1;
     const enumText=files[path].text.slice(startOffset,end);
     const enumId=idFor('enum:'+path+':'+block.name);
     const enumMappedAttr=block.enumerators.find((p:any)=>p.type==='attribute'&&p.name==='map');
     const enumMappedName=extractPrismaMapping(enumMappedAttr);
     const enumeratorFields=block.enumerators.filter((p:any)=>p.type==='enumerator').map((p:any)=>{
      const escapedName=p.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const re=new RegExp('(^|\\n)[ \\t]*('+escapedName+')\\b');
      const match=re.exec(enumText);
      let enumSource:Source|undefined=undefined;
      if(match){
       const matchStart=match.index+match[1].length;
       const nameStart=enumText.indexOf(match[2],matchStart);
       let lineEnd=enumText.indexOf('\n',nameStart);
       if(lineEnd===-1)lineEnd=enumText.length;
       const eStart=startOffset+nameStart;
       const eEnd=startOffset+lineEnd;
       enumSource=source(path,eStart,eEnd,`${block.name}.${p.name}`);
      }
      const memberMapped=extractPrismaMapping(p.attributes?.find((a:any)=>a.name==='map'));
      return {name:p.name,type:'enum',source:enumSource,mappedName:memberMapped};
     });
     const enumPayload:any = {
      id:enumId,
      kind:'enum',
      name:block.name,
      parentId:mid,
      provenance:'extracted',
      outputPath:path,
      source:source(path,startOffset,end,block.name),
      description:enumMappedName?'Database name: '+enumMappedName+' · '+SCHEMA_DERIVED_NOTICE:SCHEMA_DERIVED_NOTICE,
      instructions:SCHEMA_DERIVED_NOTICE,
      fields:enumeratorFields,
     };
     if(enumMappedName){
      enumPayload.mappedName=enumMappedName;
     }
     nodes.set(enumId,NodeSchema.parse(enumPayload));
    }
    analyzed++;
   }catch(error){
    diagnostics.push({severity:'error',message:'Prisma schema extraction failed: '+(error as Error).message,path,code:'prisma-extract-error'});
   }
  }
  const prismaFiles = eligible.filter(p => p.endsWith('.prisma'));
  let prismaValidationStatus: PrismaValidationStatus = 'not-applicable';
  if (prismaFiles.length === 0) {
   prismaValidationStatus = 'not-applicable';
  } else if (options?.validatePrisma === false) {
   prismaValidationStatus = 'unavailable';
  } else {
   const valRes = await validatePrismaSchemaInIsolation(root, {
    schemaPaths: prismaFiles,
    ...options?.prismaValidationOptions,
   });
   this.lastPrismaValidation = valRes;
   prismaValidationStatus = valRes.status;
   if (valRes.status === 'failed') {
    diagnostics.push(...valRes.diagnostics);
   }
  }
  const dedup=Array.from(new Map(diagnostics.map(d=>[JSON.stringify(d),d])).values());
  const graph:Graph={schemaVersion:GRAPH_SCHEMA_VERSION,nodes:Array.from(nodes.values()).sort((a,b)=>a.id.localeCompare(b.id)),edges:Array.from(edges.values()).sort((a,b)=>a.id.localeCompare(b.id)),requirements:[]};
  const isCurrent = !isIncomplete && !dedup.some(d=>d.severity!=='info');
  const status: 'current' | 'partial' = isCurrent ? 'current' : 'partial';
  const inferredCount = Math.max(
   0,
   typeof options?.inferredItems === 'number' ? Math.floor(options.inferredItems) : 0,
   Array.isArray(options?.aiInferences) ? options.aiInferences.length : 0
  );
  const result: Analysis = {
   revision,
   sequence: ++this.sequence,
   analyzedAt: new Date().toISOString(),
   status,
   graph,
   files,
   durationMs: performance.now() - start,
   quality: {
    eligibleFiles: eligible.length,
    analyzedFiles: analyzed,
    unresolvedReferences: unresolved,
    unsupportedConstructs: unsupported,
    inferredItems: inferredCount,
    prismaValidation: prismaValidationStatus,
    diagnostics: dedup,
   },
  };

  const dependentClosure = this.getAffectedClosure(changedInputs, this.lastAnalysis?.graph);
  const allAffected = new Set<string>([...changedInputs, ...builderAffectedFiles, ...dependentClosure]);
  const affectedFiles = Array.from(allAffected).filter(p => !!files[p]).sort();

  this.lastChangedInputs = changedInputs.sort();
  this.lastAffectedFiles = affectedFiles;
  this.lastFiles = files;
  this.lastIncrementalInfo = {
   isWarm: isWarm && !isBroaderInvalidation,
   scope: isBroaderInvalidation ? 'broader' : 'local',
   changedInputs: this.lastChangedInputs,
   nonlocalInputs: nonlocalInputs.sort(),
   affectedFiles,
   invalidationReason: this.lastInvalidationReason,
   reusedPrograms,
   rebuiltPrograms,
  };

  this.lastAnalysis = result;
  this.lastReport = generateImportQualityReport(result);
  return result;
 }

 public generateQualityReport(analysis?: Analysis): ImportQualityReport {
  const target = analysis ?? this.lastAnalysis;
  if (!target) {
   throw new AppError('No analysis available to generate quality report');
  }
  return generateImportQualityReport(target);
 }

 public async analyzeAndReport(
  root: string,
  options?: AnalyzeOptions
 ): Promise<{ analysis: Analysis; report: ImportQualityReport }> {
  const analysis = await this.analyze(root, options);
  const report = this.generateQualityReport(analysis);
  return { analysis, report };
 }
}

export interface ImportQualityReportCoverage {
 eligibleFiles: number;
 analyzedFiles: number;
 ratio: number;
 percentage: number;
 isFullyCovered: boolean;
}

export interface ImportQualityReportBreakdown {
 compilerDiagnostics: number;
 parserDiagnostics: number;
 errors: number;
 warnings: number;
 info: number;
 opaqueConstructs: number;
 unresolvedReferences: number;
 inferredInterpretations: number;
}

export interface ImportQualityReportCounts {
 eligibleFiles: number;
 analyzedFiles: number;
 unresolvedReferences: number;
 unsupportedConstructs: number;
 inferredItems: number;
 diagnostics: number;
 errors: number;
 warnings: number;
}

export interface ImportQualityReport {
 revision: string;
 status: 'updating' | 'current' | 'partial' | 'stale';
 eligibleFiles: number;
 analyzedFiles: number;
 unresolvedReferences: number;
 unsupportedConstructs: number;
 inferredItems: number;
 prismaValidation: PrismaValidationStatus;
 diagnostics: Diagnostic[];
 behavioralLimitStatement: string;
 limitStatement: string;
 coverage: ImportQualityReportCoverage;
 breakdown: ImportQualityReportBreakdown;
 counts: ImportQualityReportCounts;
 quality: Quality;
}

export function generateImportQualityReport(
 analysisOrQuality: Analysis | { quality: Quality; revision?: string; status?: Analysis['status'] }
): ImportQualityReport {
 const q = analysisOrQuality.quality;
 QualitySchema.parse(q);
 const revision = 'revision' in analysisOrQuality && analysisOrQuality.revision !== undefined ? analysisOrQuality.revision : '';
 const status = 'status' in analysisOrQuality && analysisOrQuality.status !== undefined ? analysisOrQuality.status : 'current';

 const ratio = q.eligibleFiles > 0 ? q.analyzedFiles / q.eligibleFiles : (q.analyzedFiles === 0 ? 1 : 0);
 const errors = q.diagnostics.filter(d => d.severity === 'error').length;
 const warnings = q.diagnostics.filter(d => d.severity === 'warning').length;
 const info = q.diagnostics.filter(d => d.severity === 'info').length;

 const parserDiagnostics = q.diagnostics.filter(d =>
  d.code === 'prisma-parse-error' ||
  d.code === 'incomplete-revision' ||
  d.code === 'prisma-validation' ||
  d.message.toLowerCase().includes('parse') ||
  d.message.toLowerCase().includes('syntax')
 ).length;

 const compilerDiagnostics = q.diagnostics.length - parserDiagnostics;

 return {
  revision,
  status,
  eligibleFiles: q.eligibleFiles,
  analyzedFiles: q.analyzedFiles,
  unresolvedReferences: q.unresolvedReferences,
  unsupportedConstructs: q.unsupportedConstructs,
  inferredItems: q.inferredItems,
  prismaValidation: q.prismaValidation,
  diagnostics: q.diagnostics,
  behavioralLimitStatement: BEHAVIORAL_LIMIT_STATEMENT,
  limitStatement: BEHAVIORAL_LIMIT_STATEMENT,
  coverage: {
   eligibleFiles: q.eligibleFiles,
   analyzedFiles: q.analyzedFiles,
   ratio,
   percentage: Math.round(ratio * 100),
   isFullyCovered: q.eligibleFiles > 0 && q.analyzedFiles === q.eligibleFiles,
  },
  breakdown: {
   compilerDiagnostics,
   parserDiagnostics,
   errors,
   warnings,
   info,
   opaqueConstructs: q.unsupportedConstructs,
   unresolvedReferences: q.unresolvedReferences,
   inferredInterpretations: q.inferredItems,
  },
  counts: {
   eligibleFiles: q.eligibleFiles,
   analyzedFiles: q.analyzedFiles,
   unresolvedReferences: q.unresolvedReferences,
   unsupportedConstructs: q.unsupportedConstructs,
   inferredItems: q.inferredItems,
   diagnostics: q.diagnostics.length,
   errors,
   warnings,
  },
  quality: q,
 };
}

export function formatImportQualityReport(report: ImportQualityReport): string {
 const lines: string[] = [];
 lines.push('# Import Quality Report');
 lines.push('');
 lines.push(`- **Status**: ${report.status}`);
 lines.push(`- **Revision**: ${report.revision || '(none)'}`);
 lines.push(`- **File Coverage**: ${report.analyzedFiles} / ${report.eligibleFiles} (${report.coverage.percentage}%)`);
 lines.push(`- **Diagnostics**: ${report.diagnostics.length} (${report.breakdown.errors} errors, ${report.breakdown.warnings} warnings)`);
 lines.push(`- **Unresolved References**: ${report.unresolvedReferences}`);
 lines.push(`- **Unsupported Constructs**: ${report.unsupportedConstructs}`);
 lines.push(`- **AI Inferences**: ${report.inferredItems}`);
 lines.push(`- **Prisma Validation**: ${report.prismaValidation}`);
 lines.push('');
 lines.push(`> [!IMPORTANT]`);
 lines.push(`> **Notice**: ${report.behavioralLimitStatement}`);
 lines.push('');
 return lines.join('\n');
}
