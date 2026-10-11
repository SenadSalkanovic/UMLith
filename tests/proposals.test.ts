import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  GRAPH_SCHEMA_VERSION,
  emptyGraph,
  DesignProposalSchema,
  getProposalBaseRevision,
  type Graph,
  type DesignProposal,
  type ProgramNode,
  type ProgramEdge,
  type Project,
} from '../shared/model';
import { ProjectStore } from '../server/store';
import { SyncService } from '../server/sync';
import { JobService } from '../server/jobs';
import { validateProposal } from '../server/proposals';
import { sandboxAvailable } from '../server/sandbox';

describe('T065: Validate architecture, ER, and workflow proposal payloads', () => {
  describe('Proposal schema definitions and explanation separation', () => {
    it('defines proposal schema with graph, explanation, questions, and base revisions', () => {
      const graph: Graph = {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        nodes: [
          {
            id: 'mod-1',
            kind: 'module',
            name: 'AuthModule',
            policy: 'editable',
            provenance: 'human',
            contract: '',
            description: 'Handles authentication',
            instructions: '',
            outputPath: 'src/auth.ts',
            fields: [],
            requiredChecks: [],
          },
        ],
        edges: [],
        requirements: [],
      };

      const validPayload: DesignProposal = {
        graph,
        explanation: 'Refactors auth module to decouple token generation from verification.',
        questions: ['Should token expiration remain configurable?'],
        sourceRevision: 'rev-abc-123',
        baseRevision: 1,
        intendedBaseRevision: 1,
      };

      const parsed = DesignProposalSchema.parse(validPayload);
      expect(parsed.explanation).toBe(validPayload.explanation);
      expect(parsed.questions).toEqual(validPayload.questions);
      expect(parsed.sourceRevision).toBe('rev-abc-123');
      expect(getProposalBaseRevision(parsed)).toBe(1);
    });

    it('defaults questions to empty array if omitted', () => {
      const graph = emptyGraph();
      const parsed = DesignProposalSchema.parse({
        graph,
        explanation: 'Initial empty proposal',
      });
      expect(parsed.questions).toEqual([]);
      expect(parsed.explanation).toBe('Initial empty proposal');
    });

    it('rejects missing or blank explanation', () => {
      const graph = emptyGraph();
      expect(() =>
        DesignProposalSchema.parse({
          graph,
          explanation: '   ',
        })
      ).toThrow();

      expect(() =>
        DesignProposalSchema.parse({
          graph,
        })
      ).toThrow();
    });
  });

  describe('Concrete Scenario 1: Submit valid architecture, ER, and workflow proposals', () => {
    it('submits a valid architecture proposal with systems, modules, classes, and interfaces', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'arch-prop-'));
      const store = new ProjectStore(dir);
      try {
        const project = await store.create({ name: 'ArchProject' });

        const archGraph: Graph = {
          schemaVersion: GRAPH_SCHEMA_VERSION,
          nodes: [
            {
              id: 'sys-core',
              kind: 'system',
              name: 'CoreSystem',
              policy: 'editable',
              provenance: 'ai',
              contract: '',
              description: 'Core backend system',
              instructions: '',
              outputPath: '',
              fields: [],
              requiredChecks: [],
            },
            {
              id: 'mod-users',
              kind: 'module',
              name: 'UserManagement',
              parentId: 'sys-core',
              policy: 'editable',
              provenance: 'ai',
              contract: '',
              description: 'User management module',
              instructions: '',
              outputPath: 'src/users.ts',
              fields: [],
              requiredChecks: [],
            },
            {
              id: 'iface-user-svc',
              kind: 'interface',
              name: 'IUserService',
              parentId: 'mod-users',
              policy: 'editable',
              provenance: 'ai',
              contract: 'interface IUserService { getUser(id: string): User; }',
              description: 'Contract for user operations',
              instructions: '',
              outputPath: 'src/users.ts',
              fields: [],
              requiredChecks: [],
            },
            {
              id: 'cls-user-svc',
              kind: 'class',
              name: 'UserService',
              parentId: 'mod-users',
              policy: 'editable',
              provenance: 'ai',
              contract: 'class UserService implements IUserService',
              description: 'Implementation of user service',
              instructions: '',
              outputPath: 'src/users.ts',
              fields: [],
              requiredChecks: [],
            },
          ],
          edges: [
            {
              id: 'edge-impl',
              source: 'cls-user-svc',
              target: 'iface-user-svc',
              kind: 'implements',
              provenance: 'ai',
              uncertain: true,
              label: '',
            },
          ],
          requirements: [],
        };

        const proposal: DesignProposal = {
          graph: archGraph,
          explanation: 'Proposes explicit system/module layering and user service interface.',
          questions: [],
          baseRevision: project.specRevision,
        };

        const result = validateProposal(project, proposal);
        expect(result.valid).toBe(true);
        expect(result.diagnostics).toEqual([]);
        expect(result.proposal).toBeDefined();

        // Stored intent must not be mutated
        const stored = await store.get(project.id);
        expect(stored.specRevision).toBe(0);
        expect(stored.specification.nodes.length).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('submits a valid ER proposal with entities, fields, keys, and relates-to edges', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'er-prop-'));
      const store = new ProjectStore(dir);
      try {
        const project = await store.create({ name: 'ERProject' });

        const erGraph: Graph = {
          schemaVersion: GRAPH_SCHEMA_VERSION,
          nodes: [
            {
              id: 'ent-user',
              kind: 'entity',
              name: 'User',
              policy: 'editable',
              provenance: 'ai',
              contract: '',
              description: 'User entity table',
              instructions: '',
              outputPath: 'prisma/schema.prisma',
              fields: [
                { name: 'id', type: 'String', key: 'PK', optional: false },
                { name: 'email', type: 'String', key: 'UNIQUE', optional: false },
                { name: 'profileId', type: 'String', key: 'FK', optional: true },
              ],
              requiredChecks: [],
            },
            {
              id: 'ent-profile',
              kind: 'entity',
              name: 'Profile',
              policy: 'editable',
              provenance: 'ai',
              contract: '',
              description: 'User profile table',
              instructions: '',
              outputPath: 'prisma/schema.prisma',
              fields: [
                { name: 'id', type: 'String', key: 'PK', optional: false },
                { name: 'bio', type: 'String', key: '', optional: true },
              ],
              requiredChecks: [],
            },
            {
              id: 'enum-role',
              kind: 'enum',
              name: 'Role',
              policy: 'editable',
              provenance: 'ai',
              contract: '',
              description: 'User access levels',
              instructions: '',
              outputPath: 'prisma/schema.prisma',
              fields: [
                { name: 'ADMIN', type: 'String', key: '', optional: false },
                { name: 'USER', type: 'String', key: '', optional: false },
              ],
              requiredChecks: [],
            },
          ],
          edges: [
            {
              id: 'rel-user-profile',
              source: 'ent-user',
              target: 'ent-profile',
              kind: 'relates-to',
              provenance: 'ai',
              uncertain: true,
              label: '1:1',
            },
          ],
          requirements: [],
        };

        const proposal: DesignProposal = {
          graph: erGraph,
          explanation: 'Adds User and Profile entities with one-to-one relationship and Role enum.',
          questions: [],
          baseRevision: project.specRevision,
        };

        const result = validateProposal(project, proposal);
        expect(result.valid).toBe(true);
        expect(result.diagnostics).toEqual([]);

        // Stored intent remains intact
        const stored = await store.get(project.id);
        expect(stored.specRevision).toBe(0);
        expect(stored.specification.nodes.length).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('submits a valid workflow proposal with functions, control-flow steps, and branching edges', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'wf-prop-'));
      const store = new ProjectStore(dir);
      try {
        const project = await store.create({ name: 'WorkflowProject' });

        const wfGraph: Graph = {
          schemaVersion: GRAPH_SCHEMA_VERSION,
          nodes: [
            {
              id: 'fn-login',
              kind: 'function',
              name: 'loginUser',
              policy: 'editable',
              provenance: 'ai',
              contract: 'function loginUser(email: string, pass: string): Promise<Session>',
              description: 'Authenticates user and returns session',
              instructions: '',
              outputPath: 'src/auth.ts',
              inputs: 'email, pass',
              outputs: 'Session',
              rules: 'Check password hash',
              errors: 'InvalidCredentialsError',
              scenarios: ['Given valid email and pass, returns Session'],
              fields: [],
              requiredChecks: [],
            },
            {
              id: 'step-verify',
              kind: 'step',
              name: 'verifyPassword',
              parentId: 'fn-login',
              stepType: 'condition',
              policy: 'editable',
              provenance: 'ai',
              contract: '',
              description: 'Checks password hash',
              instructions: '',
              outputPath: 'src/auth.ts',
              fields: [],
              requiredChecks: [],
            },
            {
              id: 'step-success',
              kind: 'step',
              name: 'createSession',
              parentId: 'fn-login',
              stepType: 'return',
              policy: 'editable',
              provenance: 'ai',
              contract: '',
              description: 'Returns created session',
              instructions: '',
              outputPath: 'src/auth.ts',
              fields: [],
              requiredChecks: [],
            },
            {
              id: 'step-fail',
              kind: 'step',
              name: 'throwInvalid',
              parentId: 'fn-login',
              stepType: 'throw',
              policy: 'editable',
              provenance: 'ai',
              contract: '',
              description: 'Throws InvalidCredentialsError',
              instructions: '',
              outputPath: 'src/auth.ts',
              fields: [],
              requiredChecks: [],
            },
          ],
          edges: [
            {
              id: 'edge-true',
              source: 'step-verify',
              target: 'step-success',
              kind: 'true',
              provenance: 'ai',
              uncertain: true,
              label: 'Valid credentials',
            },
            {
              id: 'edge-false',
              source: 'step-verify',
              target: 'step-fail',
              kind: 'false',
              provenance: 'ai',
              uncertain: true,
              label: 'Invalid credentials',
            },
          ],
          requirements: [],
        };

        const proposal: DesignProposal = {
          graph: wfGraph,
          explanation: 'Models detailed loginUser control flow with conditional password check.',
          questions: ['Should account lockout count attempts?'],
          baseRevision: project.specRevision,
        };

        const result = validateProposal(project, proposal);
        expect(result.valid).toBe(true);
        expect(result.diagnostics).toEqual([]);

        // Stored intent remains intact
        const stored = await store.get(project.id);
        expect(stored.specRevision).toBe(0);
        expect(stored.specification.nodes.length).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('submits a combined proposal covering all three views simultaneously', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'combined-prop-'));
      const store = new ProjectStore(dir);
      try {
        const project = await store.create({ name: 'CombinedProject' });

        const combinedGraph: Graph = {
          schemaVersion: GRAPH_SCHEMA_VERSION,
          nodes: [
            // Architecture: Module
            {
              id: 'mod-app',
              kind: 'module',
              name: 'AppModule',
              policy: 'editable',
              provenance: 'ai',
              contract: '',
              description: 'Main application module',
              instructions: '',
              outputPath: 'src/app.ts',
              fields: [],
              requiredChecks: [],
            },
            // Architecture: Function in Module
            {
              id: 'fn-save',
              kind: 'function',
              name: 'saveUserData',
              parentId: 'mod-app',
              policy: 'editable',
              provenance: 'ai',
              contract: 'function saveUserData(u: User): Promise<void>',
              description: 'Saves user data',
              instructions: '',
              outputPath: 'src/app.ts',
              fields: [],
              requiredChecks: [],
            },
            // Workflow: Step inside Function
            {
              id: 'step-write',
              kind: 'step',
              name: 'persistRecord',
              parentId: 'fn-save',
              stepType: 'operation',
              policy: 'editable',
              provenance: 'ai',
              contract: '',
              description: 'Persists user record to database',
              instructions: '',
              outputPath: 'src/app.ts',
              fields: [],
              requiredChecks: [],
            },
            // ER: Entity
            {
              id: 'ent-user',
              kind: 'entity',
              name: 'User',
              policy: 'editable',
              provenance: 'ai',
              contract: '',
              description: 'Database entity',
              instructions: '',
              outputPath: 'prisma/schema.prisma',
              fields: [{ name: 'id', type: 'String', key: 'PK', optional: false }],
              requiredChecks: [],
            },
          ],
          edges: [
            // Cross-view edge: step writes entity
            {
              id: 'edge-write',
              source: 'step-write',
              target: 'ent-user',
              kind: 'writes',
              provenance: 'ai',
              uncertain: true,
              label: '',
            },
          ],
          requirements: [],
        };

        const proposal: DesignProposal = {
          graph: combinedGraph,
          explanation: 'Integrates architecture module, workflow function step, and ER user entity.',
          questions: [],
          baseRevision: project.specRevision,
        };

        const result = validateProposal(project, proposal);
        expect(result.valid).toBe(true);
        expect(result.diagnostics).toEqual([]);

        // Stored intent remains intact
        const stored = await store.get(project.id);
        expect(stored.specRevision).toBe(0);
        expect(stored.specification.nodes.length).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('Concrete Scenario 2: Submit malformed graphs and proposals based on stale specifications', () => {
    it('rejects malformed graph with dangling edge references', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'malformed-dangling-'));
      const store = new ProjectStore(dir);
      try {
        const project = await store.create({ name: 'MalformedTest' });

        const malformedPayload = {
          graph: {
            schemaVersion: 1,
            nodes: [
              {
                id: 'mod-1',
                kind: 'module',
                name: 'Mod1',
                policy: 'editable',
                provenance: 'ai',
                contract: '',
                description: '',
                instructions: '',
                outputPath: '',
                fields: [],
                requiredChecks: [],
              },
            ],
            edges: [
              {
                id: 'bad-edge',
                source: 'mod-1',
                target: 'non-existent-target',
                kind: 'calls',
                provenance: 'ai',
                label: '',
              },
            ],
            requirements: [],
          },
          explanation: 'Proposes invalid edge',
          questions: [],
        };

        const result = validateProposal(project, malformedPayload);
        expect(result.valid).toBe(false);
        const refDiag = result.diagnostics.find(d => d.code === 'reference' || d.code === 'schema');
        expect(refDiag).toBeDefined();
        expect(refDiag?.message).toContain('Missing edge endpoint');

        // Stored intent cannot mutate
        const stored = await store.get(project.id);
        expect(stored.specRevision).toBe(0);
        expect(stored.specification.nodes.length).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects malformed graph with containment cycles', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'cycle-test-'));
      const store = new ProjectStore(dir);
      try {
        const project = await store.create({ name: 'CycleTest' });

        const malformedPayload = {
          graph: {
            schemaVersion: 1,
            nodes: [
              {
                id: 'sys-a',
                kind: 'system',
                name: 'SysA',
                parentId: 'sys-b',
                policy: 'editable',
                provenance: 'ai',
                contract: '',
                description: '',
                instructions: '',
                outputPath: '',
                fields: [],
                requiredChecks: [],
              },
              {
                id: 'sys-b',
                kind: 'system',
                name: 'SysB',
                parentId: 'sys-a',
                policy: 'editable',
                provenance: 'ai',
                contract: '',
                description: '',
                instructions: '',
                outputPath: '',
                fields: [],
                requiredChecks: [],
              },
            ],
            edges: [],
            requirements: [],
          },
          explanation: 'Cyclic containment',
          questions: [],
        };

        const result = validateProposal(project, malformedPayload);
        expect(result.valid).toBe(false);
        const cycleDiag = result.diagnostics.find(d => d.code === 'containment');
        expect(cycleDiag).toBeDefined();
        expect(cycleDiag?.message).toContain('Containment cycle');

        // Stored intent cannot mutate
        const stored = await store.get(project.id);
        expect(stored.specRevision).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects malformed workflow where steps lack owning function or have invalid branches', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'malformed-wf-'));
      const store = new ProjectStore(dir);
      try {
        const project = await store.create({ name: 'MalformedWf' });

        const malformedWfPayload = {
          graph: {
            schemaVersion: 1,
            nodes: [
              {
                id: 'step-orphan',
                kind: 'step',
                name: 'OrphanStep',
                stepType: 'return',
                policy: 'editable',
                provenance: 'ai',
                contract: '',
                description: '',
                instructions: '',
                outputPath: '',
                fields: [],
                requiredChecks: [],
              },
            ],
            edges: [],
            requirements: [],
          },
          explanation: 'Orphan step',
          questions: [],
        };

        const result = validateProposal(project, malformedWfPayload);
        expect(result.valid).toBe(false);
        const wfDiag = result.diagnostics.find(d => d.code === 'containment' || d.code === 'workflow');
        expect(wfDiag).toBeDefined();
        expect(wfDiag?.message).toContain('Workflow steps require exactly one containment parent');

        // Stored intent cannot mutate
        const stored = await store.get(project.id);
        expect(stored.specRevision).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects proposals based on a stale specification revision', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'stale-spec-'));
      const store = new ProjectStore(dir);
      try {
        const project = await store.create({ name: 'StaleSpecProject' });
        // Update project specification to revision 2
        await store.updateSpec(project.id, 0, {
          schemaVersion: 1,
          nodes: [
            {
              id: 'node-human-1',
              kind: 'module',
              name: 'HumanModule',
              policy: 'editable',
              provenance: 'human',
              contract: '',
              description: 'Human intent',
              instructions: '',
              outputPath: 'src/mod.ts',
              fields: [],
              requiredChecks: [],
            },
          ],
          edges: [],
          requirements: [],
        });

        const currentProject = await store.get(project.id);
        expect(currentProject.specRevision).toBe(1);

        // Advance again to revision 2
        await store.updateSpec(project.id, 1, currentProject.specification);
        const advancedProject = await store.get(project.id);
        expect(advancedProject.specRevision).toBe(2);

        // AI proposal based on stale revision 1
        const staleProposal: DesignProposal = {
          graph: {
            schemaVersion: 1,
            nodes: [
              {
                id: 'node-human-1',
                kind: 'module',
                name: 'HumanModule',
                policy: 'editable',
                provenance: 'ai',
                contract: '',
                description: 'Updated description from stale baseline',
                instructions: '',
                outputPath: 'src/mod.ts',
                fields: [],
                requiredChecks: [],
              },
            ],
            edges: [],
            requirements: [],
          },
          explanation: 'Stale proposal prepared against older specification revision',
          questions: [],
          baseRevision: 1, // Stale! Current is 2
        };

        const result = validateProposal(advancedProject, staleProposal);
        expect(result.valid).toBe(false);
        const staleDiag = result.diagnostics.find(d => d.code === 'stale-spec');
        expect(staleDiag).toBeDefined();
        expect(staleDiag?.message).toContain('Proposal is based on stale specification revision 1; current revision is 2');

        // Stored intent must not be mutated
        const stored = await store.get(project.id);
        expect(stored.specRevision).toBe(2);
        expect(stored.specification.nodes[0].description).toBe('Human intent');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('warns when proposal was prepared against an outdated source revision', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'stale-src-'));
      const store = new ProjectStore(dir);
      try {
        const project = await store.create({ name: 'StaleSourceProject' });
        // Mock analysis on project
        project.analysis = {
          revision: 'rev-current-456',
          sequence: 1,
          analyzedAt: new Date().toISOString(),
          status: 'current',
          durationMs: 50,
          quality: {
            eligibleFiles: 1,
            analyzedFiles: 1,
            unresolvedReferences: 0,
            unsupportedConstructs: 0,
            inferredItems: 0,
            prismaValidation: 'not-applicable',
            diagnostics: [],
          },
          files: {},
          graph: emptyGraph(),
        };

        const proposal: DesignProposal = {
          graph: emptyGraph(),
          explanation: 'Proposal against older source revision',
          questions: [],
          sourceRevision: 'rev-outdated-123',
          baseRevision: project.specRevision,
        };

        const result = validateProposal(project, proposal);
        // Valid from a hard error perspective, but warning present for stale source
        expect(result.valid).toBe(true);
        const warning = result.diagnostics.find(d => d.code === 'stale-source');
        expect(warning).toBeDefined();
        expect(warning?.severity).toBe('warning');
        expect(warning?.message).toContain('Proposal was prepared against source revision rev-outdated-123');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('Protection policies and change scope validation', () => {
    it('rejects proposal that attempts to modify or delete a frozen-implementation item', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'frozen-impl-'));
      const store = new ProjectStore(dir);
      try {
        const project = await store.create({ name: 'FrozenTest' });
        const frozenNode: ProgramNode = {
          id: 'fn-frozen',
          kind: 'function',
          name: 'computeHash',
          policy: 'frozen-implementation',
          provenance: 'human',
          contract: 'function computeHash(s: string): string',
          description: 'Calculates hash',
          instructions: '',
          outputPath: 'src/hash.ts',
          source: {
            path: 'src/hash.ts',
            start: 0,
            end: 50,
            line: 1,
            hash: 'hash1',
            revision: 'rev1',
          },
          baseline: {
            text: 'export function computeHash(s: string): string { return ""; }',
            source: {
              path: 'src/hash.ts',
              start: 0,
              end: 50,
              line: 1,
              hash: 'hash1',
              revision: 'rev1',
            },
          },
          fields: [],
          requiredChecks: [],
        };

        await store.updateSpec(project.id, 0, {
          schemaVersion: 1,
          nodes: [frozenNode],
          edges: [],
          requirements: [],
        });

        const updatedProject = await store.get(project.id);

        // 1. Attempt modification
        const modifyProposal: DesignProposal = {
          graph: {
            schemaVersion: 1,
            nodes: [
              {
                ...frozenNode,
                description: 'AI wants to change this description',
              },
            ],
            edges: [],
            requirements: [],
          },
          explanation: 'Attempts to modify frozen implementation',
          questions: [],
          baseRevision: updatedProject.specRevision,
        };

        const modResult = validateProposal(updatedProject, modifyProposal);
        expect(modResult.valid).toBe(false);
        const policyDiag = modResult.diagnostics.find(d => d.code === 'policy');
        expect(policyDiag?.message).toContain('Proposal modifies a frozen implementation item: computeHash');

        // 2. Attempt deletion
        const deleteProposal: DesignProposal = {
          graph: emptyGraph(),
          explanation: 'Attempts to delete frozen implementation',
          questions: [],
          baseRevision: updatedProject.specRevision,
        };

        const delResult = validateProposal(updatedProject, deleteProposal);
        expect(delResult.valid).toBe(false);
        const delDiag = delResult.diagnostics.find(d => d.code === 'policy');
        expect(delDiag?.message).toContain('Proposal deletes a protected frozen-implementation item: computeHash');

        // Stored intent remains intact
        const stored = await store.get(project.id);
        expect(stored.specification.nodes[0].description).toBe('Calculates hash');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects proposal that attempts to modify contract of a frozen-contract item', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'frozen-contract-'));
      const store = new ProjectStore(dir);
      try {
        const project = await store.create({ name: 'FrozenContractTest' });
        const frozenContractNode: ProgramNode = {
          id: 'iface-api',
          kind: 'interface',
          name: 'IApiClient',
          policy: 'frozen-contract',
          provenance: 'human',
          contract: 'interface IApiClient { get(): void; }',
          description: 'Declared client interface',
          instructions: '',
          outputPath: 'src/api.ts',
          baseline: {
            contract: 'interface IApiClient { get(): void; }',
          },
          fields: [],
          requiredChecks: [],
        };

        await store.updateSpec(project.id, 0, {
          schemaVersion: 1,
          nodes: [frozenContractNode],
          edges: [],
          requirements: [],
        });

        const updatedProject = await store.get(project.id);

        const modContractProposal: DesignProposal = {
          graph: {
            schemaVersion: 1,
            nodes: [
              {
                ...frozenContractNode,
                contract: 'interface IApiClient { get(): void; post(): void; }',
              },
            ],
            edges: [],
            requirements: [],
          },
          explanation: 'Attempts to alter frozen contract interface',
          questions: [],
          baseRevision: updatedProject.specRevision,
        };

        const result = validateProposal(updatedProject, modContractProposal);
        expect(result.valid).toBe(false);
        const diag = result.diagnostics.find(d => d.code === 'policy');
        expect(diag?.message).toContain('Proposal modifies a frozen contract item: IApiClient');

        // Stored intent remains intact
        const stored = await store.get(project.id);
        expect(stored.specification.nodes[0].contract).toBe('interface IApiClient { get(): void; }');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects new AI nodes attempting to set frozen policies or invent source evidence', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'ai-node-rules-'));
      const store = new ProjectStore(dir);
      try {
        const project = await store.create({ name: 'AINodeRules' });

        // AI proposes new node with policy 'frozen-implementation' and fake source
        const invalidAINodePayload: DesignProposal = {
          graph: {
            schemaVersion: 1,
            nodes: [
              {
                id: 'ai-fake-node',
                kind: 'function',
                name: 'fakeFunction',
                policy: 'frozen-implementation',
                provenance: 'ai',
                contract: 'function fakeFunction(): void',
                description: 'AI hallucinated frozen policy',
                instructions: '',
                outputPath: 'src/fake.ts',
                source: {
                  path: 'src/fake.ts',
                  start: 0,
                  end: 20,
                  line: 1,
                  hash: 'fakehash',
                  revision: 'fakerev',
                },
                baseline: {
                  text: 'function fakeFunction() {}',
                  source: {
                    path: 'src/fake.ts',
                    start: 0,
                    end: 20,
                    line: 1,
                    hash: 'fakehash',
                    revision: 'fakerev',
                  },
                },
                fields: [],
                requiredChecks: [],
              },
            ],
            edges: [],
            requirements: [],
          },
          explanation: 'AI invents frozen node and source',
          questions: [],
          baseRevision: project.specRevision,
        };

        const result = validateProposal(project, invalidAINodePayload);
        expect(result.valid).toBe(false);

        const policyDiag = result.diagnostics.find(
          d => d.code === 'policy' && d.message.toLowerCase().includes('new nodes must be editable')
        );
        expect(policyDiag).toBeDefined();

        const provDiag = result.diagnostics.find(
          d => d.code === 'provenance' && d.message.includes('cannot invent source evidence')
        );
        expect(provDiag).toBeDefined();

        // Stored intent remains intact
        const stored = await store.get(project.id);
        expect(stored.specification.nodes.length).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('enforces task change scope on proposed changes', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'scope-test-'));
      const store = new ProjectStore(dir);
      try {
        const project = await store.create({ name: 'ScopeTest' });

        await store.updateSpec(project.id, 0, {
          schemaVersion: 1,
          nodes: [
            {
              id: 'mod-users',
              kind: 'module',
              name: 'UsersModule',
              policy: 'editable',
              provenance: 'human',
              contract: '',
              description: 'Users',
              instructions: '',
              outputPath: 'src/users/index.ts',
              source: {
                path: 'src/users/index.ts',
                start: 0,
                end: 10,
                line: 1,
                hash: 'h1',
                revision: 'r1',
              },
              fields: [],
              requiredChecks: [],
            },
            {
              id: 'mod-billing',
              kind: 'module',
              name: 'BillingModule',
              policy: 'editable',
              provenance: 'human',
              contract: '',
              description: 'Billing',
              instructions: '',
              outputPath: 'src/billing/index.ts',
              source: {
                path: 'src/billing/index.ts',
                start: 0,
                end: 10,
                line: 1,
                hash: 'h2',
                revision: 'r1',
              },
              fields: [],
              requiredChecks: [],
            },
          ],
          edges: [],
          requirements: [],
        });

        const currentProject = await store.get(project.id);

        // Scope only permits src/users/
        const outOfScopeProposal: DesignProposal = {
          graph: {
            schemaVersion: 1,
            nodes: [
              currentProject.specification.nodes[0],
              {
                ...currentProject.specification.nodes[1],
                description: 'Modified billing module',
              },
            ],
            edges: [],
            requirements: [],
          },
          explanation: 'Modifies billing while scope is users',
          questions: [],
          baseRevision: currentProject.specRevision,
        };

        const result = validateProposal(currentProject, outOfScopeProposal, {
          scope: ['src/users/'],
        });
        expect(result.valid).toBe(false);
        const scopeDiag = result.diagnostics.find(d => d.code === 'scope');
        expect(scopeDiag).toBeDefined();
        expect(scopeDiag?.message).toContain('Change to "BillingModule" is outside the approved task scope');

        // When proposal restricts edits to in-scope items, it passes
        const inScopeProposal: DesignProposal = {
          graph: {
            schemaVersion: 1,
            nodes: [
              {
                ...currentProject.specification.nodes[0],
                description: 'Modified users module',
              },
              currentProject.specification.nodes[1],
            ],
            edges: [],
            requirements: [],
          },
          explanation: 'Modifies only users module',
          questions: [],
          baseRevision: currentProject.specRevision,
        };

        const inScopeResult = validateProposal(currentProject, inScopeProposal, {
          scope: ['src/users/'],
        });
        expect(inScopeResult.valid).toBe(true);

        // Stored intent remains intact
        const stored = await store.get(project.id);
        expect(stored.specification.nodes[0].description).toBe('Users');
        expect(stored.specification.nodes[1].description).toBe('Billing');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('End-to-End Fake Agent Integration (R35)', () => {
    it('executes fake agent design task, brings valid proposal to review, and preserves stored intent until acceptance', async () => {
      if (!(await sandboxAvailable())) return;
      const dir = await mkdtemp(join(tmpdir(), 'fake-agent-design-'));
      const store = new ProjectStore(dir);
      const p = await store.create({ name: 'AgentDesignTest' });

      // Add initial module to specification
      await store.updateSpec(p.id, 0, {
        schemaVersion: 1,
        nodes: [
          {
            id: 'mod-init',
            kind: 'module',
            name: 'InitialModule',
            policy: 'editable',
            provenance: 'human',
            contract: '',
            description: 'Original human description',
            instructions: '',
            outputPath: 'src/main.ts',
            fields: [],
            requiredChecks: [],
          },
        ],
        edges: [],
        requirements: [],
      });

      const sync = new SyncService(store, { watch: false });
      const jobs = new JobService(store, sync, {
        executable: process.execPath,
        prefixArgs: [resolve('tests/fake-agent.cjs')],
      });

      try {
        await sync.start(p.id);

        const job = await jobs.create(p.id, {
          task: 'Clarify module purpose',
          scope: ['.'],
          kind: 'design',
          settings: {
            model: JSON.stringify({ mode: 'design' }),
          },
        });

        await expect.poll(async () => (await jobs.get(p.id, job.id)).status, { timeout: 15000 }).toBe('review');

        const reviewJob = await jobs.get(p.id, job.id);
        expect(reviewJob.status).toBe('review');
        expect(reviewJob.proposal).toBeDefined();
        expect(reviewJob.proposal?.explanation).toBe('Clarifies purpose');
        expect(reviewJob.proposal?.graph.nodes[0].description).toBe('Proposed description');

        // Acceptance criterion: Stored intent is NOT mutated while in proposal review!
        const beforeAccept = await store.get(p.id);
        expect(beforeAccept.specRevision).toBe(1);
        expect(beforeAccept.specification.nodes[0].description).toBe('Original human description');
        expect(beforeAccept.specification.nodes[0].provenance).toBe('human');

        // Accept the proposal explicitly
        const accepted = await jobs.acceptProposal(p.id, job.id);
        expect(accepted.specRevision).toBe(2);
        expect(accepted.specification.nodes[0].description).toBe('Proposed description');
        expect(accepted.specification.nodes[0].provenance).toBe('ai');

        const completedJob = await jobs.get(p.id, job.id);
        expect(completedJob.status).toBe('applied');
      } finally {
        await jobs.close();
        await sync.close();
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('fails fake agent design task with malformed proposal and leaves stored intent unchanged', async () => {
      if (!(await sandboxAvailable())) return;
      const dir = await mkdtemp(join(tmpdir(), 'fake-agent-malformed-'));
      const store = new ProjectStore(dir);
      const p = await store.create({ name: 'MalformedAgentTest' });

      await store.updateSpec(p.id, 0, {
        schemaVersion: 1,
        nodes: [
          {
            id: 'mod-1',
            kind: 'module',
            name: 'Original',
            policy: 'editable',
            provenance: 'human',
            contract: '',
            description: 'Original text',
            instructions: '',
            outputPath: 'src/main.ts',
            fields: [],
            requiredChecks: [],
          },
        ],
        edges: [],
        requirements: [],
      });

      const sync = new SyncService(store, { watch: false });
      const jobs = new JobService(store, sync, {
        executable: process.execPath,
        prefixArgs: [resolve('tests/fake-agent.cjs')],
      });

      try {
        await sync.start(p.id);

        const job = await jobs.create(p.id, {
          task: 'Attempt malformed proposal',
          scope: ['.'],
          kind: 'design',
          settings: {
            model: JSON.stringify({ mode: 'design', designMode: 'malformed' }),
          },
        });

        await expect.poll(async () => (await jobs.get(p.id, job.id)).status, { timeout: 15000 }).toBe('failed');

        const failedJob = await jobs.get(p.id, job.id);
        expect(failedJob.error).toBeDefined();

        // Stored intent must be completely unchanged
        const stored = await store.get(p.id);
        expect(stored.specRevision).toBe(1);
        expect(stored.specification.nodes[0].description).toBe('Original text');
      } finally {
        await jobs.close();
        await sync.close();
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('rejects stale proposal acceptance when human specification revision advanced', async () => {
      if (!(await sandboxAvailable())) return;
      const dir = await mkdtemp(join(tmpdir(), 'stale-accept-'));
      const store = new ProjectStore(dir);
      const p = await store.create({ name: 'StaleAcceptTest' });

      await store.updateSpec(p.id, 0, {
        schemaVersion: 1,
        nodes: [
          {
            id: 'mod-1',
            kind: 'module',
            name: 'Original',
            policy: 'editable',
            provenance: 'human',
            contract: '',
            description: 'Original text',
            instructions: '',
            outputPath: 'src/main.ts',
            fields: [],
            requiredChecks: [],
          },
        ],
        edges: [],
        requirements: [],
      });

      const sync = new SyncService(store, { watch: false });
      const jobs = new JobService(store, sync, {
        executable: process.execPath,
        prefixArgs: [resolve('tests/fake-agent.cjs')],
      });

      try {
        await sync.start(p.id);

        const job = await jobs.create(p.id, {
          task: 'Propose update',
          scope: ['.'],
          kind: 'design',
          settings: {
            model: JSON.stringify({ mode: 'design' }),
          },
        });

        await expect.poll(async () => (await jobs.get(p.id, job.id)).status, { timeout: 15000 }).toBe('review');

        // Human edits intent while proposal is pending in review!
        const current = await store.get(p.id);
        await store.updateSpec(p.id, current.specRevision, {
          schemaVersion: 1,
          nodes: [
            {
              id: 'mod-1',
              kind: 'module',
              name: 'Original',
              policy: 'editable',
              provenance: 'human',
              contract: '',
              description: 'Human edited this concurrently!',
              instructions: '',
              outputPath: 'src/main.ts',
              fields: [],
              requiredChecks: [],
            },
          ],
          edges: [],
          requirements: [],
        });

        // Now human attempts to accept stale proposal -> rejected with 409!
        await expect(jobs.acceptProposal(p.id, job.id)).rejects.toThrow(
          'Specification changed. Request a fresh proposal.'
        );

        // Stored intent remains the concurrently edited human version
        const stored = await store.get(p.id);
        expect(stored.specRevision).toBe(2);
        expect(stored.specification.nodes[0].description).toBe('Human edited this concurrently!');
      } finally {
        await jobs.close();
        await sync.close();
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('fails fake agent design task attempting to modify a frozen item', async () => {
      if (!(await sandboxAvailable())) return;
      const dir = await mkdtemp(join(tmpdir(), 'frozen-agent-'));
      const store = new ProjectStore(dir);
      const p = await store.create({ name: 'FrozenAgentTest' });

      await store.updateSpec(p.id, 0, {
        schemaVersion: 1,
        nodes: [
          {
            id: 'mod-frozen',
            kind: 'module',
            name: 'FrozenMod',
            policy: 'frozen-implementation',
            provenance: 'human',
            contract: '',
            description: 'Frozen baseline',
            instructions: '',
            outputPath: 'src/frozen.ts',
            source: {
              path: 'src/frozen.ts',
              start: 0,
              end: 20,
              line: 1,
              hash: 'h1',
              revision: 'r1',
            },
            baseline: {
              text: 'export const x = 1;',
              source: {
                path: 'src/frozen.ts',
                start: 0,
                end: 20,
                line: 1,
                hash: 'h1',
                revision: 'r1',
              },
            },
            fields: [],
            requiredChecks: [],
          },
        ],
        edges: [],
        requirements: [],
      });

      const sync = new SyncService(store, { watch: false });
      const jobs = new JobService(store, sync, {
        executable: process.execPath,
        prefixArgs: [resolve('tests/fake-agent.cjs')],
      });

      try {
        await sync.start(p.id);

        const job = await jobs.create(p.id, {
          task: 'Violate frozen item',
          scope: ['.'],
          kind: 'design',
          settings: {
            model: JSON.stringify({ mode: 'design', designMode: 'frozen-violation' }),
          },
        });

        await expect.poll(async () => (await jobs.get(p.id, job.id)).status, { timeout: 15000 }).toBe('failed');

        const failedJob = await jobs.get(p.id, job.id);
        expect(failedJob.error).toContain('Proposal modifies a frozen implementation item');

        // Stored intent remains intact
        const stored = await store.get(p.id);
        expect(stored.specRevision).toBe(1);
        expect(stored.specification.nodes[0].description).toBe('Frozen baseline');
      } finally {
        await jobs.close();
        await sync.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
