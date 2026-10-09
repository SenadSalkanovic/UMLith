import { z } from 'zod';
import {
  GraphSchema,
  LayoutSchema,
  ScopedLayoutsSchema,
  AnalysisSchema,
  type Graph,
  type GraphInput,
  type Layout,
  type Project,
  type Analysis,
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
