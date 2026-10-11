import { z } from 'zod';
import { AnalysisStatusSchema, GRAPH_SCHEMA_VERSION, GraphSchema, QualitySchema, StaleEvidenceSchema } from './model';
import { ChecksSchema, ProjectSchema } from './api';

export const HANDOFF_SCHEMA_VERSION = 1;
export const HANDOFF_FILES = {
  manifest: 'manifest.json', specification: 'specification.json',
  architecture: 'ARCHITECTURE.md', task: 'AGENT_TASK.md', importReport: 'IMPORT_REPORT.json',
} as const;

function isProjectPath(path: string): boolean {
  return !!path.trim() && !path.includes('\\') && !path.includes('\0') && !/^[a-z]:/i.test(path)
    && path.split('/').every(part => !!part && part !== '.' && part !== '..');
}
// Analyzer messages can contain OS errors or compiler paths outside the project.
function portableAnalysisMessage(message: string): string {
  return /(?:^|[\s"'`(:=])(?:\/|[a-z]:[\\/]|\\\\)/i.test(message)
    ? 'Local filesystem details omitted from this portable analysis report.' : message;
}
const HandoffStaleEvidenceSchema = StaleEvidenceSchema.transform(evidence => {
  const paths = evidence.paths.filter(isProjectPath);
  return {...evidence, paths, scope: paths.length === evidence.paths.length ? evidence.scope : 'all' as const,
    reason: portableAnalysisMessage(evidence.reason)};
});
const HandoffQualitySchema = QualitySchema.transform(quality => ({...quality,
  diagnostics: quality.diagnostics.map(diagnostic => {
    const {path, line, ...details} = diagnostic;
    const message = portableAnalysisMessage(diagnostic.message);
    return path !== undefined && !isProjectPath(path) ? {...details, message} : {...diagnostic, message};
  }),
}));
// Scope follows the existing verifier: exact files, trailing-slash directories, or the included project.
const ScopeEntrySchema = z.string().refine(value => value === '.' || isProjectPath(value.endsWith('/') ? value.slice(0, -1) : value), {
  message: 'Scope must be "." or a canonical project-relative file or directory prefix',
});
const SourceRevisionSchema = z.string().refine(value => !!value.trim()).nullable();
const HandoffGraphSchema = GraphSchema.safeExtend({schemaVersion: z.literal(GRAPH_SCHEMA_VERSION)}).superRefine((graph, ctx) => {
  graph.nodes.forEach((node, index) => {
    const paths: [string | undefined, (string | number)[]][] = [
      [node.source?.path, ['source', 'path']], [node.baseline?.source?.path, ['baseline', 'source', 'path']],
      ...node.fields.map((field, i): [string | undefined, (string | number)[]] => [field.source?.path, ['fields', i, 'source', 'path']]),
    ];
    for (const [path, keys] of paths) if (path !== undefined && !isProjectPath(path))
      ctx.addIssue({code: 'custom', path: ['nodes', index, ...keys], message: 'Source bindings must use canonical project-relative paths'});
    if (node.outputPath && !ScopeEntrySchema.safeParse(node.outputPath).success)
      ctx.addIssue({code: 'custom', path: ['nodes', index, 'outputPath'], message: 'Output boundary must use a canonical project-relative scope'});
  });
});

export const HandoffManifestSchema = z.object({
  schemaVersion: z.literal(HANDOFF_SCHEMA_VERSION),
  projectId: ProjectSchema.shape.id, revision: ProjectSchema.shape.specRevision,
  sourceRevision: SourceRevisionSchema,
  files: z.object({
    manifest: z.literal(HANDOFF_FILES.manifest), specification: z.literal(HANDOFF_FILES.specification),
    architecture: z.literal(HANDOFF_FILES.architecture), task: z.literal(HANDOFF_FILES.task),
    importReport: z.literal(HANDOFF_FILES.importReport),
  }).strict(),
}).strict();

export const HandoffSpecificationSchema = z.object({
  schemaVersion: z.literal(HANDOFF_SCHEMA_VERSION),
  project: ProjectSchema.pick({id: true, name: true, target: true, description: true}).strict(),
  revision: ProjectSchema.shape.specRevision, graph: HandoffGraphSchema,
  task: z.string().min(1).max(30000).refine(value => !!value.trim()),
  scope: z.array(ScopeEntrySchema).min(1), checks: ChecksSchema,
  // This revision describes captured analysis, never a claim about newer saved files or baselines.
  sourceRevision: SourceRevisionSchema, analysisStatus: AnalysisStatusSchema.nullable(),
  staleEvidence: HandoffStaleEvidenceSchema.optional(),
}).strict().superRefine((spec, ctx) => {
  if (spec.analysisStatus === null && spec.sourceRevision !== null)
    ctx.addIssue({code: 'custom', path: ['sourceRevision'], message: 'Source revision requires analysis metadata'});
  if (spec.sourceRevision === null && spec.analysisStatus !== null && spec.analysisStatus !== 'stale')
    ctx.addIssue({code: 'custom', path: ['sourceRevision'], message: 'Analysis requires a captured source revision'});
  if (spec.analysisStatus === 'stale' && !spec.staleEvidence)
    ctx.addIssue({code: 'custom', path: ['staleEvidence'], message: 'Stale analysis must identify outdated evidence'});
  if ((spec.analysisStatus === null || spec.analysisStatus === 'current') && spec.staleEvidence)
    ctx.addIssue({code: 'custom', path: ['staleEvidence'], message: 'Absent or current analysis cannot contain outdated evidence'});
});

export const HandoffPackageSchema = z.object({
  manifest: HandoffManifestSchema, specification: HandoffSpecificationSchema,
  architecture: z.string().min(1), task: z.string().min(1),
  importReport: z.union([HandoffQualitySchema, z.object({message: z.literal('No source has been analyzed.')}).strict()]),
}).strict().superRefine((bundle, ctx) => {
  const {manifest, specification: spec} = bundle;
  for (const [key, expected] of [['projectId', spec.project.id], ['revision', spec.revision], ['sourceRevision', spec.sourceRevision]] as const)
    if (manifest[key] !== expected) ctx.addIssue({code: 'custom', path: ['manifest', key], message: 'Manifest must match specification metadata'});
  if ((spec.analysisStatus === null) !== ('message' in bundle.importReport))
    ctx.addIssue({code: 'custom', path: ['importReport'], message: 'Import report must match analysis availability'});
});

export type HandoffManifest = z.infer<typeof HandoffManifestSchema>;
export type HandoffSpecification = z.infer<typeof HandoffSpecificationSchema>;
export type HandoffPackage = z.infer<typeof HandoffPackageSchema>;
