import { z } from 'zod';
import {
  GraphSchema,
  LayoutSchema,
  ScopedLayoutsSchema,
  AnalysisSchema,
  AnalysisStatusSchema,
  DiagnosticSchema,
  QualitySchema,
  StaleEvidenceSchema,
  GraphDeltaSchema,
  GraphUpdateSchema,
  BindingReviewRecordSchema,
  DivergenceReportSchema,
  type Graph,
  type GraphInput,
  type Layout,
  type Project,
  type Analysis,
  type GraphDelta,
  type GraphUpdate,
  type BindingReviewRecord,
  type DivergenceReport,
} from './model';

export const CreateProjectRequestSchema = z.object({
  name: z.string().trim().min(1, 'Project name is required'),
  description: z.string().default(''),
  target: z.string().default('TypeScript application'),
  root: z.string().optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const UpdateSpecificationRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative().optional(),
  expected: z.number().int().nonnegative().optional(),
  graph: z.unknown(),
}).superRefine((data, ctx) => {
  if (data.expectedRevision === undefined && data.expected === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['expectedRevision'],
      message: 'Expected specification revision must be a nonnegative safe integer',
    });
  }
  const result = GraphSchema.safeParse(data.graph);
  if (!result.success) {
    for (const issue of result.error.issues) {
      ctx.addIssue({
        ...issue,
        path: ['graph', ...issue.path],
      });
    }
  }
}).transform(data => ({
  expectedRevision: (data.expectedRevision ?? data.expected)!,
  graph: GraphSchema.parse(data.graph),
}));
export type UpdateSpecificationRequest = {
  expectedRevision: number;
  graph: Graph;
};

export const UpdateLayoutRequestSchema = z.union([
  z.object({
    layout: LayoutSchema,
    view: z.string().trim().min(1, 'View must not be blank').optional(),
  }),
  LayoutSchema.transform(layout => ({ layout, view: undefined })),
]);
export type UpdateLayoutRequest = {
  layout: Layout;
  view?: string;
};

export const ProjectIdParamSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9-]+$/, 'Invalid project ID'),
});
export type ProjectIdParam = z.infer<typeof ProjectIdParamSchema>;

export const ChecksSchema = z.record(
  z.string(),
  z.object({
    command: z.string(),
    args: z.array(z.string()),
  })
);

export const ProjectSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9-]+$/),
  name: z.string(),
  description: z.string(),
  target: z.string(),
  root: z.string(),
  managed: z.boolean(),
  createdAt: z.string(),
  specRevision: z.number().int().nonnegative(),
  specification: GraphSchema,
  layout: LayoutSchema,
  analysis: AnalysisSchema.optional(),
  layoutRevision: z.number().int().nonnegative().optional(),
  scopedLayouts: ScopedLayoutsSchema.optional(),
  checks: ChecksSchema,
});

export const ProjectListResponseSchema = z.array(ProjectSchema);

export const RevisionRecordSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  createdAt: z.string(),
  graph: GraphSchema,
});
export type RevisionRecord = z.infer<typeof RevisionRecordSchema>;
export const RevisionHistoryResponseSchema = z.array(RevisionRecordSchema);

export const LayoutResponseSchema = z.object({
  layout: LayoutSchema,
  layoutRevision: z.number().int().nonnegative().default(0),
  scopedLayouts: ScopedLayoutsSchema.default({}),
});
export type LayoutResponse = z.infer<typeof LayoutResponseSchema>;

export const ApiErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  statusCode: z.number().int(),
  projectId: z.string().optional(),
  expectedRevision: z.number().int().optional(),
  currentRevision: z.number().int().optional(),
  issues: z.array(z.any()).optional(),
});
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

export const StartAnalysisRequestSchema = z.object({
  async: z.boolean().optional(),
  root: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
}).optional().default({});
export type StartAnalysisRequest = z.infer<typeof StartAnalysisRequestSchema>;

export const ImportQualityReportCoverageSchema = z.object({
  eligibleFiles: z.number().int().nonnegative(),
  analyzedFiles: z.number().int().nonnegative(),
  ratio: z.number().nonnegative(),
  percentage: z.number().nonnegative(),
  isFullyCovered: z.boolean(),
});

export const ImportQualityReportBreakdownSchema = z.object({
  compilerDiagnostics: z.number().int().nonnegative(),
  parserDiagnostics: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
  info: z.number().int().nonnegative(),
  opaqueConstructs: z.number().int().nonnegative(),
  unresolvedReferences: z.number().int().nonnegative(),
  inferredInterpretations: z.number().int().nonnegative(),
});

export const ImportQualityReportCountsSchema = z.object({
  eligibleFiles: z.number().int().nonnegative(),
  analyzedFiles: z.number().int().nonnegative(),
  unresolvedReferences: z.number().int().nonnegative(),
  unsupportedConstructs: z.number().int().nonnegative(),
  inferredItems: z.number().int().nonnegative(),
  diagnostics: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
});

export const ImportQualityReportSchema = z.object({
  revision: z.string(),
  status: AnalysisStatusSchema,
  eligibleFiles: z.number().int().nonnegative(),
  analyzedFiles: z.number().int().nonnegative(),
  unresolvedReferences: z.number().int().nonnegative(),
  unsupportedConstructs: z.number().int().nonnegative(),
  inferredItems: z.number().int().nonnegative(),
  prismaValidation: z.enum(['passed', 'failed', 'unavailable', 'not-applicable']),
  diagnostics: z.array(DiagnosticSchema),
  behavioralLimitStatement: z.string(),
  limitStatement: z.string(),
  coverage: ImportQualityReportCoverageSchema,
  breakdown: ImportQualityReportBreakdownSchema,
  counts: ImportQualityReportCountsSchema,
  quality: QualitySchema,
});
export type ImportQualityReportResponse = z.infer<typeof ImportQualityReportSchema>;

export const AnalysisStatusResponseSchema = z.object({
  projectId: z.string(),
  status: AnalysisStatusSchema,
  revision: z.string().nullable().optional(),
  sequence: z.number().int().nonnegative().optional(),
  analyzedAt: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  quality: QualitySchema.optional(),
  staleEvidence: StaleEvidenceSchema.optional(),
  diagnostics: z.array(DiagnosticSchema).optional(),
  error: z.string().optional(),
  message: z.string().optional(),
});
export type AnalysisStatusResponse = z.infer<typeof AnalysisStatusResponseSchema>;

export const AnalysisSnapshotResponseSchema = AnalysisSchema;
export type AnalysisSnapshotResponse = Analysis;

export const AnalysisResponseSchema = z.object({
  analysis: AnalysisSchema,
  report: ImportQualityReportSchema.optional(),
  status: AnalysisStatusSchema.optional(),
  revision: z.string().optional(),
  sequence: z.number().int().nonnegative().optional(),
});
export type AnalysisResponse = z.infer<typeof AnalysisResponseSchema>;

export const SseReadyEventSchema = z.object({
  event: z.literal('ready').optional(),
  projectId: z.string().optional(),
  status: z.literal('connected'),
  analysisStatus: AnalysisStatusSchema.optional(),
  revision: z.string().nullable().optional(),
  sequence: z.number().int().nonnegative().optional(),
  lastEventId: z.string().nullable().optional(),
  reconnected: z.boolean().optional(),
});
export type SseReadyEvent = z.infer<typeof SseReadyEventSchema>;

export const SseStatusEventSchema = z.object({
  event: z.literal('status').optional(),
  type: z.literal('status').optional(),
  projectId: z.string(),
  status: AnalysisStatusSchema,
  revision: z.string().nullable().optional(),
  sequence: z.number().int().nonnegative().optional(),
  diagnostics: z.array(DiagnosticSchema).optional(),
  quality: QualitySchema.optional(),
  staleEvidence: StaleEvidenceSchema.optional(),
  message: z.string().optional(),
  timestamp: z.string().optional(),
});
export type SseStatusEvent = z.infer<typeof SseStatusEventSchema>;

export const SseDeltaEventSchema = z.object({
  event: z.literal('delta').optional(),
  type: z.literal('analysis').optional(),
  projectId: z.string(),
  schemaVersion: z.literal(1),
  revision: z.string(),
  baseRevision: z.string().nullable(),
  sequence: z.number().int().nonnegative(),
  baseSequence: z.number().int().nonnegative(),
  status: AnalysisStatusSchema,
  delta: GraphDeltaSchema,
  quality: QualitySchema,
  diagnostics: z.array(DiagnosticSchema),
  analyzedAt: z.string(),
  durationMs: z.number().nonnegative(),
  staleEvidence: StaleEvidenceSchema.optional(),
  update: GraphUpdateSchema.optional(),
});
export type SseDeltaEvent = z.infer<typeof SseDeltaEventSchema>;

export const SseDiagnosticsEventSchema = z.object({
  event: z.literal('diagnostics').optional(),
  type: z.literal('diagnostics').optional(),
  projectId: z.string(),
  revision: z.string().nullable().optional(),
  sequence: z.number().int().nonnegative().optional(),
  diagnostics: z.array(DiagnosticSchema),
  quality: QualitySchema.optional(),
});
export type SseDiagnosticsEvent = z.infer<typeof SseDiagnosticsEventSchema>;

export const AcceptBindingRequestSchema = z.object({
  nodeId: z.string().min(1, 'nodeId is required'),
  candidateId: z.string().min(1, 'candidateId is required'),
  expectedRevision: z.number().int().nonnegative().optional(),
  preserveBaseline: z.boolean().default(true),
});
export type AcceptBindingRequest = z.infer<typeof AcceptBindingRequestSchema>;

export const BindingReviewsResponseSchema = z.object({
  projectId: z.string(),
  records: z.array(BindingReviewRecordSchema),
});
export type BindingReviewsResponse = z.infer<typeof BindingReviewsResponseSchema>;

export const SseBindingReviewEventSchema = z.object({
  event: z.literal('binding-review').optional(),
  type: z.literal('binding-review').optional(),
  projectId: z.string(),
  records: z.array(BindingReviewRecordSchema),
  timestamp: z.string().optional(),
});
export type SseBindingReviewEvent = z.infer<typeof SseBindingReviewEventSchema>;

export const DivergenceReportResponseSchema = z.object({
  success: z.boolean(),
  projectId: z.string().optional(),
  report: DivergenceReportSchema,
});
export type DivergenceReportResponse = z.infer<typeof DivergenceReportResponseSchema>;

export const SseDivergenceEventSchema = z.object({
  event: z.literal('divergence').optional(),
  type: z.literal('divergence').optional(),
  projectId: z.string(),
  report: DivergenceReportSchema,
  timestamp: z.string().optional(),
});
export type SseDivergenceEvent = z.infer<typeof SseDivergenceEventSchema>;
