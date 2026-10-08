# Shared program graph contract

T001 defines one graph in `shared/model.ts` for architecture, ER, and optional function workflows. Views select entities from `nodes` and relationships from `edges`; they retain the same IDs and references. Layout remains outside the graph. T003 adds graph-level requirements; function scenarios, policies, provenance, and source bindings remain on the existing node records.

## Version and input boundary

`GRAPH_SCHEMA_VERSION` is currently `1`. `Graph` is the normalized output type of `GraphSchema`: it requires `schemaVersion: 1` and includes node/edge defaults and a `requirements` array. `GraphInput` is its input type, allowing omitted defaults and an omitted version for compatibility with existing unversioned JSON. Use `GraphSchema.parse` or `safeParse` at an external graph boundary; a TypeScript annotation alone does not validate JSON.

An omitted version is treated as legacy v1. Explicit versions other than numeric `1`, including null and strings, are rejected. This is compatibility normalization, not a migration of unknown versions. `emptyGraph()` and analyzer results include the version. `ProjectStore.updateSpec` accepts `GraphInput` and persists validated output; imported snapshots and `updateAnalysis` validate their graphs before writing, so invalid analysis cannot replace the last readable project. Project reads parse both the intended specification and any implemented analysis graph; history reads parse revision graphs. Reading legacy data normalizes the returned graph without rewriting the original file.

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
| `next`, `true`, `false`, `exception` | step | step |
| `reads`, `writes` | function, step | entity |

Entities and enums cannot be containers. A node's `parentId` applies exactly the same rule as a `contains` edge from parent to child. TypeScript permits a class to implement another class's instance interface; interface inheritance also permits class targets. Class inheritance targets a class even when its name is merged with an interface declaration.

Node IDs and edge IDs are nonempty and unique within their respective collections. Every parent and edge endpoint must exist in the same graph. Containment cycles are rejected across the union of parent references and explicit containment edges, including self-containment and mixed-representation cycles. The same parent/child relationship may appear in both representations. Call recursion, dependency cycles, and workflow loops are not containment cycles.

Issues identify duplicate IDs, missing references, or invalid relationship kinds at their input paths; containment cycles identify involved IDs. Unsupported versions produce an issue at `schemaVersion`.

## Dependent interfaces

T002–T009 consume the normalized graph and existing node/edge records. T002 owns subsequent identity allocation and reconciliation rules; T001 does not introduce an ID generator or rename algorithm. Persistence/API tasks T010–T014 should accept input at validation boundaries and return normalized `Graph` values. Importer, sync, proposal, and export consumers should carry `schemaVersion` with complete graphs and reuse `GraphSchema` for untrusted input. Refinements enforce rules beyond those expressible in generated JSON Schema.

The task cards and planning contract are controller-owned during this implementation; this document records the shipped interface without editing those files.

## Intended specification and implemented snapshots (T006)

The existing `Project` fields remain the shared interface: `specification` is human-owned intent, `specRevision` counts explicit accepted edits, and optional `analysis` contains the implemented graph with its independent source `revision` and update `sequence`. Graph schema version is separate from both revision streams. No snapshot, extraction, or agent preview is evidence of human acceptance.

`ProjectStore.create` without a source `root` creates a managed project with an empty specification at revision `0` and no analysis. With an existing directory `root`, it runs the existing TypeScript/Prisma analyzer through `AnalysisWorker` and validates/persists an initial implemented snapshot before returning. The worker closes on success or failure and uses its own loader without inheriting parent CLI hooks/flags. Its intended specification stays empty at revision `0`, representing unadopted intent. Analysis failures are surfaced; creation never copies extracted declarations into intent or writes to imported source files. Both modes preserve the supplied target description without selecting a generation template.

`updateSpec(id, expectedRevision, graph)` is the explicit human edit/acceptance boundary. A caller establishing intent from imported code must deliberately submit the reviewed graph through that method; even accepting an empty specification advances its revision. The method validates the graph, rejects stale edits, increments only `specRevision`, and records the accepted graph in revision history. Existing proposal acceptance uses this same method; agent progress and live synchronization use separate analysis/preview paths. The store cannot determine who invoked a method: HTTP/UI authorization and review belong to their owning tasks.

Intended project data remains in `project.json`, with accepted graph history in `revisions/<revision>.json`. Implemented snapshots live in `analysis.json`. `updateAnalysis(id, analysis)` validates the graph and atomically replaces only the snapshot file under the existing per-project transaction lock. It does not write intended JSON, revision history, layout, checks, source bindings, or protection baselines, including when the snapshot is partial/stale. No analysis revision advances or resets the specification revision. The generic project save helper is private so consumers use the explicit mutation boundaries.

Legacy inline `project.json.analysis` remains readable when `analysis.json` is absent. Reads normalize graph output without rewriting storage. A new snapshot takes precedence over inline evidence and leaves legacy intended JSON byte-for-byte unchanged. The next explicit specification/layout/check save persists the current inline evidence separately before removing it from project metadata. Malformed or unsupported separate snapshots raise an error rather than silently falling back to old inline evidence. This is local storage compatibility; portable export continues to use approved `specification`, with implemented revision information kept separate.

T008 consumes the existing `Analysis` snapshot contract; T010/T011 retain ownership of multi-file specification persistence/revision recovery; import and sync consumers use `updateAnalysis`; human editors and proposal acceptance use `updateSpec`. `tests/store.test.ts` exercises new/imported creation in Vitest and a real Node/tsx subprocess, explicit adoption, repeated snapshots with unchanged intended JSON/history/baselines, and legacy storage compatibility. No controller-owned task documents or runner files are changed.

## Requirements and acceptance scenarios contract (T003)

`RequirementSchema` validates `{ id, text, nodeIds, edgeIds, constraints, scenarios }`; `Requirement` is its normalized TypeScript output type. `id` is a nonempty opaque identifier, unique within `graph.requirements`. Assign it once and retain it when editing text or links. IDs need not match display text or use a particular format, and requirement IDs have their own namespace separate from node/edge IDs. `text` is a required string. The remaining fields are arrays defaulting to `[]`: `nodeIds` and `edgeIds` contain nonempty IDs; `constraints` and `scenarios` contain prose strings. Empty prose is permitted for drafts. No text is trimmed, split, sorted, or newline-normalized, and array order and repeated scenario text are retained.

Requirements with no item links apply to the project. Link a function requirement using its node ID; the same record can link multiple nodes or relationships. References resolve only within the enclosing graph. `GraphSchema` reports duplicate requirement IDs at `requirements[index].id` and missing items at `requirements[index].nodeIds[index]` or `edgeIds[index]`, identifying the missing ID. Deleting a linked function or edge requires an explicit requirement edit/removal in the same validated graph; references are never silently pruned. Standalone `RequirementSchema` validates record shape, while `GraphSchema` validates referential integrity.

Existing `node.scenarios` remain ordered prose descriptions and need no workflow. Requirement constraints/scenarios likewise make no claim of execution or proof; configured executable checks remain separate in `requiredChecks` and project check definitions. The existing agent instructions explicitly state that tests do not prove every prose requirement.

This is an additive v1 field: legacy graph JSON omitting `requirements` normalizes to `[]` without rewriting files on read. `emptyGraph()` and analyzer graphs supply `requirements: []`; extraction does not invent human requirements. `graphDelta` additionally supplies `changedRequirements` and `deletedRequirements`, keyed by stable requirement ID, for consumers comparing graph content. Complete snapshots retain requirement array order; like existing node/edge deltas, content deltas do not encode collection reordering.

`ProjectStore.updateSpec` accepts requirements via `GraphInput`, validates the complete graph before writing, and preserves them in project JSON and revision history. Reopening a project and reading history use the same schema. `bundleFiles`/`exportBundle` carry the complete graph in `specification.json`, and `ARCHITECTURE.md` includes ordered requirement IDs, prose, graph links, constraints, and scenarios. JSON is the lossless handoff representation; readable Markdown adds presentation around the unchanged prose. Export does not add local storage paths.

T004 consumes the existing function scenarios and linked requirements; T010 consumes the normalized graph through the existing persistence boundary; T065/T068 consume `RequirementSchema`/`GraphSchema` for proposals and portable handoffs; T066 can compare stable requirement IDs. No parallel requirement store, runner, execution status, or editor UI is introduced by T003.

## Description-only and detailed functions contract (T004)

Functions use the existing `NodeSchema` and stable `node.id`. `description` is prose (default `''` for drafts). `inputs`, `outputs`, `rules`, and `errors` are optional prose strings; `scenarios` is an optional ordered array of prose strings. Missing details remain `undefined` in parsed records and absent in JSON, rather than being normalized to empty strings/arrays. Explicit `''` and `[]` remain explicit, including in existing v1 files. Nulls, wrong field types, and non-string scenarios are rejected with field paths. Supplied text, whitespace, newline conventions, Unicode, ordering, and repeated scenarios are preserved.

This replaces the previous empty defaults for these five node fields without changing the v1 input format or rewriting saved files. Existing explicit empty values cannot reveal whether a human supplied them or an older parser inserted them; consumers must not treat them as proof of a known empty contract. Readers must handle omitted fields, using `?? ''` or `?? []` only for display rather than writing those fallbacks back as evidence. Requirement-level constraints/scenarios keep their existing array defaults; they are separate from optional node scenarios.

Both description-only and detailed functions validate without workflow nodes/edges. Existing steps and typed relationships can coexist with either level of detail; workflow semantics belong to T005. Enrich a function by changing its fields while retaining its ID, parent, and references. `graphDelta` then reports a changed node rather than deletion/recreation. Supplying details never generates source bindings, steps, analysis snapshots, or a completion status.

The existing `provenance` and `source` identify human intent, extracted declarations, and AI proposals. An extracted function's source-backed `contract` is separate from unspecified semantic fields: parsing/extraction never fills unknown rules, errors, or scenarios from the presence of a signature or workflow. Source evidence and detail presence do not prove behavior or implementation completeness. Further provenance/evidence validation belongs to T007; this task introduces no competing evidence or execution model.

`ProjectStore.updateSpec`, project reads, and revision history preserve both levels of detail through `GraphSchema`. Portable `specification.json` retains absent fields and all supplied details; `ARCHITECTURE.md` renders supplied prose and safely handles absent node scenarios. Agent instructions explicitly state that missing details/workflows are unspecified and supplied details/scenarios do not prove implementation completeness.

T005 consumes optional function details alongside the existing workflow records; T023–T026 editors must handle omitted prose/scenarios without converting unknown values into facts; T010 persistence and T068 export consume the same validated graph. Task cards and the planning contract remain controller-owned.

## Optional function control flow (T005)

Workflows remain optional. A function with no steps or flow edges is valid, regardless of its contract detail. Workflow records use the existing stable node/edge IDs; no workflow object, completeness flag, or execution result is generated. `NodeSchema` and `EdgeSchema` validate record shapes; `GraphSchema` additionally enforces the following workflow semantics.

Every `step` has an explicit `stepType`: `operation`, `call`, `condition`, `loop`, `try`, `throw`, `return`, or `opaque`. Other node kinds cannot have a `stepType`. Each step has exactly one distinct containment parent, a function or another step, using `parentId`, a `contains` edge, or both for the same relationship. Follow this nesting to the nearest owning function. Orphans, multiple parents (including conflicting nesting within one function), and containment cycles are rejected. Nested function declarations own their own workflows; ownership does not pass through a nested function to its outer function.

| Step or relationship | Meaning |
| --- | --- |
| `operation` | A described action |
| `call` / `calls` | A call-site step; the existing `calls` relationship identifies a function or constructor target when known |
| `condition` / `true`, `false` | A decision with optional true/false destinations |
| `loop` / `true`, `false` | A loop decision; true enters the body, false exits; body flow can return to the loop |
| `try` | A protected block whose steps can be nested inside it |
| `throw` | An exceptional exit; an `exception` edge can route it to a handler |
| `return` | A function exit; no ordinary continuation |
| `opaque` | Unsupported logic retained with source evidence rather than reconstructed execution claims |
| `next` | Ordinary flow between steps |
| `exception` | Exceptional flow to a handler step, with an optional descriptive label; it may originate from a potentially throwing step or a try block |

`next`, `true`, `false`, and the additive v1 `exception` relationship connect steps in the same owning function, including across nested blocks. A boolean branch must originate at a `condition` or `loop`, with at most one edge for each boolean outcome. Missing branches are permitted for partial workflows; validation does not claim completeness. `return` and `throw` cannot have a `next` edge. Exceptional flow is separate from ordinary continuation. Calls may target another function without transferring ownership. Flow cycles, including loop back-edges and self-loops, are legitimate; only containment participates in containment-cycle rejection.

Opaque steps require `source` with a nonblank path, content hash, and analysis revision, safe integer offsets satisfying `0 <= start <= end`, and a positive safe integer line. The evidence survives JSON round-trips with its original provenance; it is not proof that unsupported execution paths were understood. Validation of other source/provenance records and verification against captured files belong to T007 and importer tasks.

Errors identify `nodes[index].stepType`, `nodes[index].parentId`, `nodes[index].source`, or the relevant `edges[index].kind`/`target`. Existing valid analyzer workflows already supply kinds, ownership, and opaque evidence. Legacy malformed workflows lacking these semantics are rejected explicitly, without assigning owners or inventing evidence. `validRelationship` continues to check endpoint kinds only; editors, persistence, proposals, and importers must use `GraphSchema` for complete graph validation.

T010 persistence and T068 export retain the same graph records. T023 workflow editors and T037/T038 importer consumers use the step kinds, nesting, branch, and exception semantics above; partial analysis must retain opaque evidence. The implementation and required concrete scenarios are covered in `tests/model.test.ts`; task cards and the original plan remain controller-owned.

## 2026-10-08 — T004 description-only and detailed functions

Scope: removed empty defaults for optional function detail fields in `shared/model.ts`, updated the existing readable export consumer/instructions in `server/export.ts`, added focused model/persistence/export checks and an analyzer regression assertion, and documented the shipped interface here. No new dependencies, alternate function API, completeness flag, runner changes, task-document edits, or Git mutations.

| T004 requirement/scenario | Evidence |
| --- | --- |
| Description-only functions validate | Model JSON round-trip retains the description without fabricating detail fields, source evidence, or workflow |
| Detailed contracts retain every requested field | Model, disk persistence/history, and portable ZIP tests preserve all six fields, including multiline/Unicode prose and ordered scenarios |
| Optional detail does not imply implementation completeness | Model tests preserve human provenance and absent source/workflow; persistence leaves analysis absent; real analyzer keeps unknown semantics absent despite extracted signatures/workflows; exported instructions state the limit explicitly |
| Save description-only beside detailed | Persistence test saves both in one new project, reopens it, and checks supplied details and omitted fields; export test verifies the same mixed graph through ZIP handoff |
| Add detail while retaining identity | Model test preserves ID, parent, relationships, and linked requirements with a changed-node delta; persistence test reopens the enriched function and verifies the prior revision still has unspecified details |
| Validate supplied details | Model cases reject null/wrong-type prose and malformed scenario arrays with explicit field paths; explicit empty legacy values still round-trip |

Validation observed: the focused run before implementation failed four checks because unknown fields were filled with empty values (133 existing/new checks passed). After implementation, `npm test -- tests/model.test.ts tests/store.test.ts tests/export.test.ts tests/analyzer.test.ts` passed all 137 checks. Full `npm test` passed all 143 checks across seven files; `npx tsc --noEmit` and `git diff --check` passed. `npm run build` passed TypeScript checking but Vite failed on the pre-existing absent `/src/main.tsx`; browser bundling/interaction is not claimed.

Independent read-only review approved all T004 criteria/scenarios with no correctness, regression, scope, or privacy findings. It separately passed 121 model/analyzer checks, actual-store assertions in memory for mixed-detail persistence/reopening/enrichment/history, portable ZIP assertions, TypeScript, and whitespace checks. It confirmed the browser entry point is absent in both HEAD and the working tree, and the staged diff is empty. The reviewer did not repeat the full disk suite; the implementer's full suite above exercised real disk persistence. Browser and live-agent smoke tests were skipped. Task documents, original plan, runner/tests/state/logs, and Git index/configuration remain unchanged.

## 2026-10-08 — T003 requirements and acceptance scenarios

Scope: extended `shared/model.ts`, supplied an empty requirement list in `server/analyzer.ts`, included requirements in the existing readable `server/export.ts` handoff, and added model/persistence/export regression tests and this shared interface record. Reused existing graph persistence/history and ZIP packaging. Task documents, original plan, runner and its tests/state/logs, and Git index/configuration remain controller-owned and unchanged.

| T003 requirement/scenario | Evidence |
| --- | --- |
| Project and function requirements are representable | Model fixture round-trips an unlinked project requirement and a function requirement linked to a function, entity, and write relationship; edits retain requirement IDs and references |
| Scenario descriptions are lossless | Model, persistence/history, and ZIP export tests retain multiline strings, CRLF/LF, Unicode, indentation, trailing whitespace/newlines, and array order; existing function scenarios coexist with requirement scenarios |
| Deleted items cannot leave unnoticed requirement references | Model tests reject missing node/edge links with the exact issue path and missing ID; persistence test deletes a linked function, confirms rejection before project/history writes, then explicitly removes its requirement and successfully saves |
| Requirements survive editing, persistence, and handoff | Reopened project and separate historical revisions retain old/new requirement text; portable JSON retains complete records and readable instructions include ordered IDs, item links, constraints, and scenarios |
| Prose is not executable proof | Requirement constraints/scenarios are string arrays with no execution status or inferred pass; the export retains the existing explicit instruction that tests do not prove every prose requirement |
| Existing callers and legacy data remain usable | Missing requirement arrays/details receive empty defaults; empty and analyzer graphs include the normalized array; content deltas report requirement changes/deletions; full analyzer/sync/review/job regression suite and TypeScript checking pass |

Validation observed:

- Before implementation, `npm test -- tests/model.test.ts tests/store.test.ts tests/export.test.ts`: 16 failures exposed discarded requirements, absent defaults/deltas, and unvalidated links/record shapes; 97 existing tests passed.
- After implementation, the same focused command: 113 tests passed across 3 files.
- `npm test`: 124 tests passed across 7 files.
- `npx tsc --noEmit`: passed, exit 0.
- `git diff --check`: passed, exit 0.
- `npm run build`: TypeScript passed; Vite failed because the pre-existing `/src/main.tsx` browser entry point is absent. T003 model/persistence/export acceptance is verified by the tests above; browser-workspace implementation and live-agent smoke tests are outside this task.

Independent review approved with no correctness, scope, or regression findings. The reviewer independently passed all 113 focused tests, TypeScript and whitespace checks, and additional assertions covering blank/repeated scenarios, separate ID namespaces, deleted-edge errors, requirement preservation through layout/check/analysis updates, history/export fidelity, and unchanged files after rejected edits. Review was read-only; no repository files were edited by the reviewer.

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
