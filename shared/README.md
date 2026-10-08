# Shared program graph contract

T001 defines one graph in `shared/model.ts` for architecture, ER, and optional function workflows. Views select entities from `nodes` and relationships from `edges`; they retain the same IDs and references. Layout remains outside the graph. Requirements, scenarios, policies, provenance, and source bindings remain on the existing node records.

## Version and input boundary

`GRAPH_SCHEMA_VERSION` is currently `1`. `Graph` is the normalized output type of `GraphSchema`: it requires `schemaVersion: 1` and includes node/edge defaults. `GraphInput` is its input type, allowing omitted defaults and an omitted version for compatibility with existing unversioned JSON. Use `GraphSchema.parse` or `safeParse` at an external graph boundary; a TypeScript annotation alone does not validate JSON.

An omitted version is treated as legacy v1. Explicit versions other than numeric `1`, including null and strings, are rejected. This is compatibility normalization, not a migration of unknown versions. `emptyGraph()` and analyzer results include the version. `ProjectStore.updateSpec` accepts `GraphInput` and persists validated output; `updateAnalysis` validates its graph before writing, so invalid analysis cannot replace the last readable project. Project reads parse both the intended specification and any implemented analysis graph; history reads parse revision graphs. Reading legacy data normalizes the returned graph without rewriting the original file.

## Relationship endpoint kinds

The following are the permitted source/target combinations. All other combinations produce an explicit Zod validation issue. Nested architecture declarations and local declarations inside functions are supported; workflow steps cannot contain architecture or ER entities.

| Relationship | Source | Target |
| --- | --- | --- |
| `contains` | system | system, module, class, interface, function, entity, enum |
| `contains` | module | module, class, interface, function, entity, enum |
| `contains` | class, interface | class, interface, function, enum |
| `contains` | function | class, interface, function, enum, step |
| `contains` | step | step |
| `depends-on` | any kind except step | any kind except step |
| `calls` | system, module, class, function, step | function, class |
| `inherits` | class | class |
| `inherits` | interface | interface, class |
| `implements` | class | interface, class |
| `relates-to` | entity | entity |
| `next`, `true`, `false` | step | step |
| `reads`, `writes` | function, step | entity |

Entities and enums cannot be containers. A node's `parentId` applies exactly the same rule as a `contains` edge from parent to child. TypeScript permits a class to implement another class's instance interface; interface inheritance also permits class targets. Class inheritance targets a class even when its name is merged with an interface declaration.

Node IDs and edge IDs are nonempty and unique within their respective collections. Every parent and edge endpoint must exist in the same graph. Containment cycles are rejected across the union of parent references and explicit containment edges, including self-containment and mixed-representation cycles. The same parent/child relationship may appear in both representations. Call recursion, dependency cycles, and workflow loops are not containment cycles.

Issues identify duplicate IDs, missing references, or invalid relationship kinds at their input paths; containment cycles identify involved IDs. Unsupported versions produce an issue at `schemaVersion`.

## Dependent interfaces

T002–T009 consume the normalized graph and existing node/edge records. T002 owns subsequent identity allocation and reconciliation rules; T001 does not introduce an ID generator or rename algorithm. Persistence/API tasks T010–T014 should accept input at validation boundaries and return normalized `Graph` values. Importer, sync, proposal, and export consumers should carry `schemaVersion` with complete graphs and reuse `GraphSchema` for untrusted input. Refinements enforce rules beyond those expressible in generated JSON Schema.

The task cards and planning contract are controller-owned during this implementation; this document records the shipped interface without editing those files.

## Stable identity and reconciliation contract (T002)

`createNodeId(): string` allocates an opaque UUID using platform `crypto.randomUUID`, available in the supported Node runtime and the local browser's secure context. Call it once when creating a human node, then persist the ID. Never regenerate an existing ID when editing a name, description, parent, contract, workflow, or source binding. Nodes with identical display names receive independent IDs. Existing nonempty IDs remain valid: this is an allocation rule for new nodes, not a UUID-only schema or a migration of saved graphs. AI proposals must likewise preserve IDs for edits to existing nodes.

Layout is a separate `Layout` record indexed by node ID. Moving a node changes only its layout entry; renaming changes only graph content. Selection and edge endpoints continue to reference the persisted ID. `graphDelta` therefore reports a rename as a changed node rather than a deletion/addition, and layout-only changes produce no graph delta. A relationship's label is display text; editing it or an endpoint's display name does not allocate a new edge ID. Allocate an ID once for a new relationship and retain it while that relationship persists.

`sourceIdentityKey(node: Pick<ProgramNode, 'kind' | 'source'>): string | undefined` supplies a **candidate reconciliation key**, separate from `node.id`. Within a single project's captured source, named declarations use the JSON tuple `[source.path, node.kind, source.symbol]`; modules use `[source.path, 'module', null]`. Tuple encoding keeps separator-containing paths and symbols distinct. `source.symbol` must be the qualified declaration identity from the analyzer (for example `Order.save`), rather than a UI label or an unqualified member name. Paths use the captured project's canonical relative spelling; the helper does not guess path aliases, change case, or resolve files. Reconcile within one project and snapshot lineage, not across projects based on matching tuples.

Keys exclude node IDs, display names, layout, parent IDs, source offsets/lines, hashes, and analysis revisions. Editing text before a declaration or changing its body therefore does not change its key. Changing the actual declaration's symbol, path, or kind does change its key. Missing source/path or a missing/empty declaration symbol returns `undefined`; systems and workflow steps also return `undefined`, since their evidence does not supply a reliable declaration key. Do not substitute display names or source offsets for unavailable keys. A human source-bound node can use the same helper to identify candidate implemented declarations without changing its human ID or specification.

Importer and synchronization consumers must group candidates by key in **both** snapshots before reusing an old ID. Reuse requires exactly one compatible logical declaration on each side. Duplicate keys are possible (overloads, merged declarations, or distinct declarations with identical qualified spelling); equal keys alone are not proof. An importer may group overloads/merged declarations only when compiler evidence establishes a single logical symbol. Never use first-match order, nearest offsets, or policy to break ties. Missing or ambiguous identity evidence requires explicit source-binding review, especially for sensitive/frozen nodes. An ambiguous rename or move must not inherit a candidate's ID, layout, selection, source binding, or protected baseline arbitrarily. Clear rename/move matches require scoped declaration evidence beyond the exact key; the matching algorithm and review records belong to T034/T056, with layout/selection integration in T057. Retain prior evidence and baselines pending review; synchronization cannot rewrite human intent or reset protection.

`validRelationship(kind: ProgramEdge['kind'], source: ProgramNode['kind'], target: ProgramNode['kind']): boolean` exposes the existing endpoint-kind rules in the table above for editors and importers. `GraphSchema` uses this same predicate for relationship and parent validation and remains the authoritative graph boundary: the predicate alone does not check IDs, references, or cycles. In particular, `next`, `true`, and `false` connect steps only; branch relationships between ER entities are rejected. This export does not change the v1 endpoint rules.

T018/T020/T022 consume persisted human IDs and `createNodeId` for creation; T034/T056 consume `sourceIdentityKey` and the uniqueness/review rules; T053/T057/T066 consume stable IDs for deltas, view state, and proposal comparison. No graph fields, schema versions, existing IDs, or persistence signatures change in T002. Later task cards remain controller-owned.

## 2026-10-08 — T001 shared program graph

The shared model acceptance criteria and concrete graph scenarios are verified. The graph has a v1 schema marker, normalized legacy input, typed relationships, unique IDs, endpoint/parent checks, and containment-cycle detection. Architecture, ER, and workflows use the same node/edge collections. The shipped interface and dependent-task input/output expectations are documented in [Shared program graph contract](#shared-program-graph-contract).

| T001 requirement/scenario | Evidence |
| --- | --- |
| One graph serves all three views | Mixed module/function/entity/workflow round-trip in `tests/model.test.ts`; the view selections retain the same graph entities and IDs |
| Invalid references and cycles produce explicit errors | Tests assert issue paths/messages for duplicate node/edge IDs, missing endpoints/parents, self-parenting, parent cycles, contains-edge cycles, and mixed containment cycles |
| Unsupported schema versions are rejected | Tests reject numeric/string/null alternatives; persisted specification, analysis, and history tests reject v2 |
| Round-trip module, function, entity, step | JSON round-trip retains nodes, cross-view write relationship, requirements/scenarios, policy, provenance, and source evidence |
| Typed relationship validity | Accepted/rejected relationship cases, plus containment source/target cases tested identically for parent references and edges; recursion and workflow loops remain permitted |
| Existing-code integration | Analyzer fixture graphs pass the shared schema, including class contracts and merged class/interface inheritance; reopened legacy persisted graphs normalize without rewriting their files; rejected analysis writes retain the previous graph and permit recovery after source correction |

Scope: extended existing `shared/model.ts`, `server/store.ts`, `tests/model.test.ts`, and `tests/store.test.ts` and added this shared contract/validation record; preserved the partial implementation's schema-version integration in `server/analyzer.ts`, its analyzer regression tests, and its pre-existing job/compiler and fake-agent adjustments. This continuation did not alter the controller runner, its tests/state/logs, task cards, original plan, or Git index/configuration. The task cards remain controller-owned; completion evidence lives here under the current user instruction.

Validation observed in this continuation:

- Regression tests were run before fixes: 18 failed and 71 passed, reproducing invalid containment acceptance and legacy/unsupported persisted graphs bypassing parsing.
- Final `npm test -- tests/model.test.ts tests/store.test.ts tests/analyzer.test.ts`: 95 tests passed across 3 files.
- Final `npm test`: 102 tests passed across 7 files.
- `npx tsc --noEmit`: passed, exit 0.
- `git diff --check HEAD`: passed, exit 0.
- `npm run build`: failed after TypeScript checking passed; Vite cannot resolve `/src/main.tsx` from `index.html`. The browser entry point is absent in the existing repository and belongs to later browser-workspace tasks; a successful browser bundle is not claimed.
- Bubblewrap availability was confirmed with Node's `--import tsx` loader. The full suite includes both ordinary and fragmented fake-agent output cases. A live external-agent smoke test was not run.

Prior independent review findings addressed: child-kind containment checks now apply to both parent references and contains edges; persisted project specifications/analysis and revision history parse through `GraphSchema`; this record and the shared graph contract supply interface/validation documentation without editing prohibited task documents.

The continuation's independent review also reproduced a P1 regression: the analyzer can emit an invalid calls edge from an interface with a computed property, and unchecked analysis persistence would make subsequent project reads fail. `updateAnalysis` now validates before saving. A real-analyzer regression test first failed because the invalid write succeeded, then passed after the fix, confirming unchanged persisted bytes, readable prior evidence, and successful recovery after source correction.

Independent re-review approved that fix with no remaining findings and separately ran `npm test -- tests/store.test.ts`: 7 tests passed. The full suite and TypeScript check above were rerun after the fix. Browser/live-agent checks remain limited as noted above.

## 2026-10-08 — T002 stable identity and relationship semantics

Scope: `shared/model.ts`, `tests/model.test.ts`, and this shared contract. Added explicit ID allocation and source candidate-key exports and exposed the existing relationship validator; retained the graph shape, persisted IDs, and endpoint rules. Task cards, original plan, runner and its tests/state/logs, and Git index/configuration remain unchanged.

| T002 requirement/scenario | Evidence |
| --- | --- |
| Human node rename and layout movement retain identity | Model test creates a human function, renames and repositions it, round-trips the graph, and verifies unchanged ID, selection reference, edge endpoint, and changed-node delta with no deletions |
| Human ID allocation is independent of display names | Two identically named human functions receive distinct IDs and validate together |
| Invalid relationship combinations are rejected | Existing accepted/rejected endpoint tests remain; new `true` and `false` branch tests reject unrelated entities via the public predicate and the graph boundary |
| Importer/synchronization can consume identity rules | Typed `sourceIdentityKey` tests cover stable keys across label/offset/content/revision edits; different paths, kinds, and qualified symbols; delimiter safety; modules; and unavailable evidence. The contract above defines uniqueness and binding-review requirements for consumers |

Validation observed:

- Before implementation, `npm test -- tests/model.test.ts`: 7 new tests failed because the required exports were absent; 83 existing tests passed.
- After implementation, `npm test -- tests/model.test.ts`: all 90 model tests passed.
- `npm test`: all 109 tests passed across 7 files, including analyzer, persistence, sync, review, export, and fake-agent tests.
- `npx tsc --noEmit`: passed, exit 0.
- `git diff --check HEAD`: passed, exit 0.
- `npm run build`: TypeScript passed; Vite failed because `/src/main.tsx` is absent, the pre-existing browser-entry blocker recorded for T001. No browser bundle or browser interaction is claimed.

Independent read-only review approved T002 with no findings and verified every acceptance criterion and concrete scenario against the implementation, tests, and contract. The reviewer independently ran `npm test -- tests/model.test.ts` (90 passed) and `git diff --check HEAD` (passed). Full-suite and TypeScript evidence above came from the implementer's runs; the reviewer did not repeat them.

Limits: full source rename/move reconciliation and its review UI are later T034/T056/T057 work. This task defines their reusable keys and mandatory review semantics, without claiming that the current analyzer already implements those later tasks. Live-agent and browser smoke tests were not run.
