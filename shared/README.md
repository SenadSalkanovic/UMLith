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
