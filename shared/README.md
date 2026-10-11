# Shared program graph contract

T001 defines one graph in `shared/model.ts` for architecture, ER, and optional function workflows. Views select entities from `nodes` and relationships from `edges`; they retain the same IDs and references. Layout remains outside the graph. T003 adds graph-level requirements; function scenarios, policies, provenance, and source bindings remain on the existing node records.

## Loopback binding and browser origin enforcement (T015)

`server/main.ts` binds the Fastify service exclusively to loopback interfaces (`127.0.0.1`, `localhost`, `::1`, or IPv4 `127.0.0.0/8`) and rejects wildcard (`0.0.0.0`, `::`) and non-loopback interface bindings at both configuration and `app.listen` time.

A precise allowed-origin policy is enforced across reads, mutations, event streams, and preflight requests:
- Allowed origins comprise local development browser origins (`http://127.0.0.1:5173`, `http://localhost:5173`, `http://[::1]:5173`), same-origin loopback ports matching the service's own port (`http://127.0.0.1:<port>`, `http://localhost:<port>`, `http://[::1]:<port>`, defaulting to port 4317 or the active bound listener port), and any custom origins configured via `options.allowedOrigins` or `ALLOWED_ORIGINS`.
- Preflight `OPTIONS` requests from allowed origins return 204 No Content with `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers`, `Access-Control-Max-Age: 86400`, and `Vary: Origin`. Preflights from foreign origins are rejected with status 403 Forbidden without CORS allow headers.
- Protected API routes and SSE event streams (`/api/events` and `/api/projects/:id/events`) validate the `Origin` header: foreign browser origins are rejected with 403 Forbidden before any route handler executes, preventing unauthorized reads, mutations, or stream access.
- Same-origin production packaged serving via `@fastify/static` serves static frontend assets and provides SPA client routing fallback when `staticDir` or `dist/` is present, while continuing to enforce origin protection on all API routes.
- DNS rebinding is prevented by validating the `Host` header against loopback interfaces, and cross-site browser requests attempting to omit `Origin` with `Sec-Fetch-Site: cross-site` are rejected with status 403 Forbidden.

## Validated local project and revision interfaces (T014)

`shared/api.ts` exports validated Zod request and response schemas and types: `CreateProjectRequestSchema`, `UpdateSpecificationRequestSchema`, `UpdateLayoutRequestSchema`, `ProjectIdParamSchema`, `ProjectSchema`, `ProjectListResponseSchema`, `RevisionRecordSchema`, `RevisionHistoryResponseSchema`, `LayoutResponseSchema`, `ChecksSchema`, and `ApiErrorResponseSchema`.

`server/main.ts` exports `createServer` building a Fastify service bound to local API routes:
- `GET /api/projects`: lists stored projects, sorted by creation date descending.
- `POST /api/projects`: creates a new managed project or registers and imports an existing project root with structural analysis. Invalid parameters, nonexistent roots, files as roots, and syntax/graph errors during import fail closed with status 400 without storing malformed projects.
- `GET /api/projects/:id`: retrieves the stored project with its intended specification, layout, and analysis snapshot.
- `PUT /api/projects/:id/specification` and `/spec`: updates the human specification with a mandatory concurrency guard (`expectedRevision` or `expected`). Malformed graph JSON fails schema validation with status 400 Bad Request, leaving stored project data and revision history unchanged. Stale revisions reject with status 409 Conflict containing `projectId`, `expectedRevision`, `currentRevision`, and reload instructions.
- `GET /api/projects/:id/specification` and `/spec`: returns the current specification graph.
- `GET /api/projects/:id/revisions` and `/history`: returns the complete committed specification revision history.
- `GET /api/projects/:id/layout`: retrieves default positions, `layoutRevision`, and scoped layout views.
- `PUT /api/projects/:id/layout` and `PATCH /api/projects/:id/layout`: updates default or scoped layout positions independently of specification validity without modifying `specRevision` or intended graph JSON.
- `GET /api/projects/:id/checks` and `PUT /api/projects/:id/checks`: retrieves and updates configured project verification checks.

The service routes map validation errors to 400 Bad Request with structured issue paths, missing projects to 404 Not Found, invalid project IDs to 400 Bad Request, and specification revision conflicts to 409 Conflict. Tests in `tests/api.test.ts` verify all concrete scenarios and edge cases using both in-process Fastify injection and real HTTP loopback network calls.

## Project file and snapshot boundary (T013)

The existing `server/files.ts` APIs retain their signatures. Project keys use slash-separated canonical relative paths: no empty/dot/parent segments, backslashes, drive prefixes, absolute paths or NULs. Approved roots resolve to canonical directories; symlinks below a root are excluded from enumeration and rejected by explicit access. `safePath(root, path, allowMissing)` validates a pathname at that instant, permitting absent paths only when requested. Its returned string does not pin directories for subsequent I/O.

`listFiles`, `captureFiles`, `copySnapshot` and `removeFile` use the same path policy with pinned directory handles and no-follow child access, preventing concurrent symlink substitution from redirecting their operations. Each operation resolves its approved root once and retains that handle throughout capture or deletion; replacement before opening fails closed, and replacement after opening cannot redirect access. Directory-descriptor access uses Linux procfs (`/proc/self/fd`); other Unix systems require compatible `/dev/fd` directory access. Unsupported systems fail closed. Verification covers Linux; other platforms need verification or native descriptor-relative support before being enabled. `atomicJson` remains the separate, service-owned metadata writer, rather than an API for project-relative paths.

Captures contain original `Buffer` bytes, including binary, empty, BOM, CRLF and Unicode content. SHA-256 hashes and snapshots operate on those bytes without text conversion. Source files, declaration files, configuration, dependency manifests and lockfiles are captured alongside other included files; the analyzer chooses eligible source files from this inventory. Generated/dependency trees in `ignoredDirs`, private names in `excluded`, symlinks and nonregular entries are omitted. Exclusions apply at every directory level. The existing 20,000-file and 20 MiB per-file limits fail explicitly. Captures reflect additions/deletions and do not mutate previous captures; cross-file write stabilization and immutable analysis revisions remain T032's responsibility.

`copySnapshot` requires a separate, empty destination: canonical source/destination roots cannot overlap, including through aliases. Destination traversal also compares pinned directory identities and ancestry before creating entries and rejects overlap observed after a source rename. Destination entries are verified for continued separation, and any write into a destination moved beneath the source during execution is unlinked before failing closed to preserve source integrity. It rejects reused destinations instead of overwriting files or retaining stale ones, and creates copied files exclusively. Current job/import callers already create a fresh destination per job. Snapshot contents are independent of originals when the destination remains separate; the returned hashes describe the copied bytes. Failed copies may leave an incomplete destination; callers must discard it and choose a fresh destination before retrying. `removeFile` permits absent files and rejects explicit symlinks while keeping deletion within its pinned parent.

`tests/files.test.ts` exercises static and concurrent unsafe paths, root replacement before/after pinning, source renames into destination ancestry before capture, during traversal, and before write, sibling-prefix roots, raw bytes/hashes, prototype-named files, source/config/dependency inputs, exclusions, oversized files, additions/deletions, independent snapshots, reused destinations and overlapping roots. Task documents and Git remain controller-owned.

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

## Independent layout persistence (T012)

`LayoutSchema` validates the existing `Layout` shape: stable node IDs mapped to strict `{x, y}` records with finite numeric coordinates. `ScopedLayoutsSchema` maps nonblank caller-owned view keys to those same position records. Keys can distinguish architecture, ER, or function scopes (for example `architecture:root` and `function:<stable-node-id>`); they are not file paths and do not allocate graph identities.

`ProjectStore.updateLayout(id, positions, view?)` retains the two-argument default-view API. A supplied view key replaces only that scoped view; an empty position record clears that view. Other views remain intact. Store-created/loaded projects expose `layoutRevision` and `scopedLayouts`, initialized to `0` and `{}`. These additions are optional in the shared `Project` type so existing in-memory project callers remain compatible.

Geometry lives in an independently validated, atomically replaced `layout.json` record: `{schemaVersion: 1, revision, layout, scopedLayouts}`. Only successful layout edits advance this revision. Layout updates never rewrite `project.json`, specification history, implemented evidence, or pending jobs. The specification revision, specification JSON/content hashes, graph deltas, exported package, protected baselines, and candidate/application validity remain independent of node movement. No graph schema version changes.

On graph replacement and project reads, default/scoped positions are filtered against the union of stable IDs in the intended graph and the latest implemented snapshot only when analysis is current (or no analysis exists). Removing an item from one graph keeps its position if it still exists in the other; removing it from both omits its positions everywhere. While analysis is partial, stale, or updating, cleanup is deferred: omitted IDs are uncertain, and reads and unrelated layout edits retain their positions until complete analysis confirms deletion. Renames and replacements retaining IDs keep their positions. Filtering does not create a layout revision or add a second filesystem commit to a graph update. The next layout edit compacts confirmed deleted entries in all views on disk. Selection and ambiguous identity reconciliation remain later synchronization/editor work.

Legacy projects without `layout.json` load validated inline layout at revision zero. The legacy reader retains its prior normalization of extra coordinate metadata; new layout inputs and separate records use strict coordinates. Reads leave files untouched. The first layout edit commits separate geometry while leaving legacy intended JSON byte-for-byte unchanged. A specification/check save writes separate geometry before removing inline layout metadata from `project.json`. Once present, the separate record takes precedence; invalid JSON, unsupported versions, invalid revisions, and malformed coordinates are reported rather than falling back to stale inline data. Failed atomic replacement retains committed geometry and permits retry.

Later canvas and synchronization consumers use the existing flat `project.layout`, optional `project.scopedLayouts[view]`, and `updateLayout` API. Candidate verification/application continue comparing `specRevision` and source hashes. Task cards and the original plan remain controller-owned; this is the shipped shared-interface record.

T012 evidence is in `tests/store.test.ts`: an actual pending implementation is validated, moved, validated again, and applied; intended JSON/history hashes and portable exports are unchanged. Tests also cover concurrent scoped edits, scoped clearing, restart, replacement of either graph first, union-based deletion cleanup, legacy migration through each write path, invalid positions/view keys/records, and failed atomic layout replacement with recovery. Current, partial, and stale analysis updates preserve default/scoped positions, the layout revision, and committed layout bytes alongside human intent and protected baselines. A real Prisma parse failure omits an imported entity; its default/scoped positions survive unrelated movement, restart, and repair with the same stable ID, then are cleaned up after complete analysis confirms its deletion.

## Protection policies and prerequisites (T009)

Policies remain on the existing node records and apply to every node kind. `editable` is the default. `sensitive` identifies items for highlighted review and carries additional prose in `instructions` and named configured-check references in `requiredChecks`. These fields remain specification data, including through JSON persistence and agent handoff. Empty instructions and an empty check list are valid drafts; check references must be nonblank strings. Text and check ordering are preserved. Resolving those references against `Project.checks` remains the existing candidate verifier's responsibility; a missing configuration does not silently pass.

`NodeSchema` and its graph consumers reject a `frozen-implementation` without a structurally valid `source`, a separate `baseline.source`, and `baseline.text`. Text is preserved exactly, including whitespace and an empty string for an empty bound range. A `frozen-contract` requires a source binding or a nonblank explicit `contract`, plus a nonblank `baseline.contract` recording the protected declared interface. An explicit interface can be frozen before code or source evidence exists. A source binding alone cannot stand in for captured interface evidence. Baselines retain their own historical source revision; rebinding a node does not automatically replace that evidence.

`freezeNode` is the existing explicit policy-edit operation. Implementation freezing uses `resolveSourceEvidence` to require valid, current captured content before recording exact text. Contract freezing preserves a supplied nonblank interface; when none is supplied, it requires current source evidence and exactly one analyzed declaration matching the binding's kind, path, range, symbol, hash, and revision, with a nonblank extracted interface. Stale, unavailable, invalid, ambiguous, and interface-free evidence is rejected. Returned nodes are validated and independently copy source/baseline records, preventing mutation through shared references. Choosing `editable` or `sensitive` explicitly clears the baseline while preserving instructions and checks.

Schema validation checks stored record prerequisites, not filesystem existence or current source currency. Baseline creation validates captured content through the evidence resolver; protected candidate verification retains the existing fail-closed source/interface checks. Frozen text permits no changes within the bound range; frozen interfaces permit internal changes while preserving the declared interface. No parsing, analysis update, or graph delta creates or refreshes an intended baseline. `ProjectStore.updateAnalysis` writes only implemented evidence; changing an intended baseline requires an explicit `freezeNode`/`updateSpec` action with the existing specification revision guard. Existing AI-proposal checks reject policy, source-binding, or baseline changes. Future editor/review tasks consume the policy discriminator for visual highlighting; this model task adds no UI.

Focused model, review, persistence, and export tests exercise all four policies, rejection of missing freezing prerequisites, an explicit interface before code exists, binding-derived interfaces, invalid/stale/ambiguous evidence, sensitive field preservation, baseline independence, and historical baseline retention after an explicit specification edit.

## Source evidence and provenance (T007)

`SourceSchema` retains the existing v1 binding fields: `path`, optional qualified `symbol`, `start`, `end`, `line`, `hash`, and `revision`. Paths, content hashes, and analysis revisions must be nonblank. Offsets are nonnegative safe integers describing a half-open `[start, end)` range in the captured JavaScript string's UTF-16 code units, with `end >= start`; `line` is a positive integer, counted from 1 using LF separators (including CRLF). Empty ranges at EOF are valid. The same validation applies to ordinary source-backed nodes and protection baselines, as well as opaque steps. Invalid bindings produce explicit Zod issues rather than being repaired or dropped.

`ProvenanceSchema` shares the existing `human`, `extracted`, and `ai` discriminators across nodes and relationships. Attaching a valid binding to AI interpretation does not change its provenance into compiler extraction. Extracted structure describes saved code, not proven runtime behavior or business intent. AI relationships default to `uncertain: true`; explicitly claiming `uncertain: false` is rejected. Human and extracted relationships retain their existing false default, and extracted unresolved relationships may remain uncertain.

`resolveSourceEvidence(source, capture, currentRevision?)` consumes the existing captured `Analysis` fields (`revision`, `status`, and `files`), without reading live files. It returns one of:

- `current` or `stale`, with the unchanged source binding and exact captured `text`;
- `invalid`, with an explicit message for malformed ranges, mismatched hashes, out-of-content bounds, or inconsistent line metadata;
- `unavailable`, with an explicit message for absent bindings, captures, revisions, or files.

Consumers must branch on the returned status before using text. The capture's revision and file hash must match the binding, and the range and line are checked against that file's captured text. Captured file hashes are trusted input supplied by the existing capture/analyzer pipeline; this helper compares identities and does not recompute hashes or validate filesystem access. T013 owns safe file access, and T032 owns immutable capture boundaries. Missing or different revisions never fall back to slicing current text. An older matching capture can still display the exact finding with `status: stale`, retaining its original hash and revision. A caller must supply the known current revision to claim currency; omitting it, or supplying a stale/updating capture, yields stale evidence. A matching partial analysis can contain current structural evidence, without implying complete file or behavioral coverage.

Both existing source-text consumers in `server/review.ts` use this resolver. Freezing or checking protection requires current valid evidence; invalid/unavailable/stale bindings fail explicitly before recording or comparing source text. Identity reconciliation remains separate: `sourceIdentityKey` is a candidate key, not evidence that a binding is valid or current. T008/T025/T026 can consume these records and statuses for snapshots and the later source viewer without rewriting provenance or revisions.

T007 validation (2026-10-08): tests cover negative, reversed, fractional, unsafe, and out-of-bounds ranges; ordinary and baseline bindings; CRLF and UTF-16 excerpts; empty EOF ranges; missing files/revisions; mismatched hashes and lines; historical display without revision mutation; and AI provenance/uncertainty round-trips. A protection integration test rejects unavailable revisions, missing files, stale/updating snapshots, incorrect hashes, and ranges that JavaScript would otherwise silently truncate. Before implementation, 22 model scenarios and the new protection scenario failed; after implementation, all 177 focused model/review tests passed. `npm test` passed all 209 tests across 7 files, `npx tsc --noEmit` passed, and `git diff --check` passed. `npm run build` passed TypeScript but Vite remains blocked by the pre-existing absent `src/main.tsx`. Browser-source-viewer work belongs to T025; no browser rendering or live-agent execution is claimed by this model task.

Independent read-only review approved T007 with no actionable findings after checking acceptance scenarios, the diff, and connected analyzer/store/review consumers. The reviewer independently passed all 177 focused tests, TypeScript checking, and whitespace checking. An additional standalone analyzer smoke test could not run because of sandbox IPC and existing dependency-export restrictions; the passing Vitest integration tests exercised the analyzer. Task documents, runner files, and the Git index/configuration remain unchanged.

## Analysis snapshots, quality and graph updates (T008)

`AnalysisSchema`, `AnalysisStatusSchema`, `DiagnosticSchema`, and `QualitySchema` validate the existing analyzer contract; `Analysis`, `Diagnostic`, and `Quality` are inferred from those schemas. Snapshots contain the implemented `graph`, captured `files` (hash and text), source `revision`, publication `sequence`, ISO `analyzedAt`, finite nonnegative `durationMs`, analysis status, and quality report. Graph validation still rejects unsupported versions, invalid relationships, dangling references and containment cycles. Revision hashes identify captured inputs; positive publication sequences distinguish repeated analyses of identical inputs. Zero is reserved for the empty lineage. Neither stream is a specification revision.

Statuses mean: `updating` is analysis in progress; `current` is current structural evidence; `partial` has incomplete analysis and can retain explicitly outdated portions; `stale` is retained evidence after a failed analysis. `StaleEvidenceSchema` records a nonblank `reason` and either `scope: 'all'` with a `paths` array, or `scope: 'paths'` with at least one affected path. These are captured path spellings, including deleted paths. Stale snapshots require this metadata; current snapshots reject it. Source-backed findings in marked paths are outdated, including in partial snapshots; `resolveSourceEvidence` returns their original excerpt and binding as stale. Unaffected matching evidence in a partial snapshot can remain current. A whole-graph failure marks relationships and findings without source bindings outdated as well.

Retained findings keep their original source revisions, ranges and hashes. Snapshot `revision` describes its captured evidence, rather than silently relabeling old evidence with a failed attempt's source revision. The existing `revision: ''`, `sequence: 0` sentinel is valid only for a stale snapshot with an empty graph and no captured files, representing failure before any evidence exists. Old persisted records are not rewritten by this task; persistence continues its existing graph validation. Consumers using the full snapshot schema must explicitly identify outdated evidence in legacy stale records before accepting them.

Quality counts are safe nonnegative integers: eligible/analyzed files, unresolved references, unsupported constructs and AI-inferred items. Analyzed files cannot exceed eligible files. Diagnostics retain severity (`error`, `warning`, `info`), nonblank message, optional path/code, and optional positive integer line. Parser and type diagnostics use these same records; codes/messages identify their findings. Prisma validation remains `passed`, `failed`, `unavailable`, or `not-applicable`. Quality objects reject unknown fields, including behavioral-completeness claims. Even 100% file coverage, no diagnostics, or passed Prisma validation describe structural analysis only; runtime behavior and business intent remain uncertain.

`graphDelta(before, after): GraphDelta` retains its graph-only API and six changed/deleted arrays for nodes, edges and requirements. `GraphDeltaSchema` rejects duplicate changes/deletions, empty IDs and IDs simultaneously changed and deleted. Deletion IDs use the same nonempty-string rules as the existing graph contract; opaque ID spelling is retained without trimming. Deletions cannot silently drop requirement links or incident edges: producers must include those changes, and the resulting graph must validate.

`GraphUpdateSchema` wraps that delta in the existing `type: 'analysis'` notification with graph `schemaVersion`, `baseRevision`, next `revision`, `baseSequence`, next `sequence`, status, quality, `analyzedAt`, `durationMs`, and optional stale evidence. The next sequence must advance; source revisions may be equal. A null base revision paired with base sequence zero means no valid prior capture. `SyncService` validates successful snapshots and notifications before storing/publishing them, and failed runs retain the last valid capture with whole-graph stale metadata and an error diagnostic. Status notifications carry failure quality and stale metadata without pretending a new capture succeeded.

`applyGraphUpdate(before: Pick<Analysis, 'revision' | 'sequence' | 'graph'> | undefined, input: unknown): Graph` validates an envelope, compares both base tokens, merges changed/deleted records by stable ID, sorts graph records by ID like the analyzer, and validates the complete resulting graph. It leaves the previous snapshot untouched and never automatically deletes orphaned edges, descendants or requirement links. Mismatched bases throw an explicit fresh-snapshot instruction. Clients publish the returned graph together with the envelope's next tokens and metadata only after application succeeds; deltas do not supply captured file contents, so clients fetch the corresponding capture for source viewing rather than relabeling old text. SSE transport/reconnection UI and capture scheduling remain later synchronization tasks.

T008 validation covers deletion of nodes, relationships and requirements; first publication, different-revision mismatch, same-source replay, and unmodified prior snapshots; partial/stale/updating snapshots with diagnostics and unchanged source evidence; path-scoped stale resolution; full file coverage without behavioral proof; malformed counts, diagnostic fields, capture metadata, versions and ambiguous operations; and rejection of dangling references after applying deltas. Real sync tests compare applied updates with stored analyzer graphs and exercise failures both with and without prior evidence. Task cards, original plan, runner and Git operations remain controller-owned.

T008 validation observed (2026-10-08): the initial model run failed all 48 new cases while 173 existing cases passed; both new sync scenarios then failed on missing envelope/stale metadata. Integration exposed record-order differences, corrected by using the analyzer's ID ordering. Independent review reproduced two compatibility failures (zero-sequence captured snapshots and deletion of opaque whitespace IDs); new tests failed before the fixes. Final `npm test` passed 263 tests across 7 files, `npx tsc --noEmit` passed, and `git diff --check` passed. Independent read-only re-review approved all acceptance criteria and scenarios, passing the latest 228 model/sync tests, consumer checks, TypeScript, whitespace and 33 additional assertions on deletion, replay, retained evidence, invalid-result publication and recovery. `npm run build` passed TypeScript but Vite failed on the pre-existing missing `src/main.tsx`. Browser/SSE UI and live-agent checks were not performed; no successful browser build is claimed.

## Intended specification and implemented snapshots (T006)

The existing `Project` fields remain the shared interface: `specification` is human-owned intent, `specRevision` counts explicit accepted edits, and optional `analysis` contains the implemented graph with its independent source `revision` and update `sequence`. Graph schema version is separate from both revision streams. No snapshot, extraction, or agent preview is evidence of human acceptance.

`ProjectStore.create` without a source `root` creates a managed project with an empty specification at revision `0` and no analysis. With an existing directory `root`, it runs the existing TypeScript/Prisma analyzer through `AnalysisWorker` and validates/persists an initial implemented snapshot before returning. The worker closes on success or failure and uses its own loader without inheriting parent CLI hooks/flags. Its intended specification stays empty at revision `0`, representing unadopted intent. Analysis failures are surfaced; creation never copies extracted declarations into intent or writes to imported source files. Both modes preserve the supplied target description without selecting a generation template.

`updateSpec(id, expectedRevision, graph)` is the explicit human edit/acceptance boundary. A caller establishing intent from imported code must deliberately submit the reviewed graph through that method; even accepting an empty specification advances its revision. The method validates the graph, rejects stale edits, increments only `specRevision`, and records the accepted graph in revision history. Existing proposal acceptance uses this same method; agent progress and live synchronization use separate analysis/preview paths. The store cannot determine who invoked a method: HTTP/UI authorization and review belong to their owning tasks.

The expected revision is required at runtime and must be a nonnegative safe integer; omitted or malformed values raise `AppError` with status `400` without writing. Specification, layout, analysis, and check mutations share the store instance's per-project transaction queue and read the latest state inside it. Two specification edits based on one revision cannot both commit. A mismatch raises `SpecificationConflictError` (an `AppError` with status `409`) containing `projectId`, `expectedRevision`, and `currentRevision`, plus reload instructions. Callers reload with `get(projectId)`, review their edit against the returned specification, and retry using that snapshot's `specRevision`. Conflicts leave committed JSON and history unchanged; rejected operations do not block later mutations. This queue coordinates a single service store instance; separate processes or store instances are not coordinated.

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

## 2026-10-10 — T045 Expose imports and analysis snapshots through local APIs

Scope: `shared/api.ts`, `server/analysis-worker.mjs`, `server/worker.ts`, `server/main.ts`, `src/api.ts`, `tests/api.test.ts`, and this shared contract. Added validated analysis start/status, snapshot, and report endpoints and Zod schemas; wired `AnalysisWorker` into project import; guaranteed that import runs off the browser request path in background worker threads; persisted completed analysis without mutating human-authored specifications; verified explicit error mapping and responsive browser interactions during parse failures. Task cards and the original plan remain controller-owned.

| T045 requirement/scenario | Evidence |
| --- | --- |
| Import runs off browser request path | `AnalysisWorker` runs analysis in a background worker thread (`worker_threads`), preventing event-loop blockage so concurrent browser requests remain responsive |
| Snapshot and report revisions match | Validated snapshots (`GET /api/projects/:id/analysis/snapshot`) and quality reports (`GET /api/projects/:id/analysis/report`) share identical source revisions matching `project.analysis.revision` |
| Import does not establish intended architecture automatically | Project import and re-analysis update only `project.analysis` and `analysis.json`; `project.specification` remains untouched at `emptyGraph()` (revision 0) until explicit human adoption |
| Explicit analysis errors | Parse/syntax failures return HTTP 400 with explicit error messages and failure diagnostics; the project state updates to `status: 'stale'` with diagnostic evidence |
| Browser remains responsive during parse failures | Concurrent project metadata requests (`GET /api/projects/:id`), project listing, and health checks return HTTP 200 immediately while analysis fails |
| Import known fixture and compare graph | Imported `tests/fixtures/typescript-structure` via API; snapshot graph strictly matches `tests/fixtures/typescript-structure.expected.json` |
| Client helpers | `src/api.ts` provides typed helpers (`startAnalysis`, `getAnalysisStatus`, `getAnalysisSnapshot`, `getAnalysisReport`, `importProject`) tested over real loopback network socket |

## Semantic specification diff contract (T066)

`computeSpecificationDiff(before, after, options?)` in `server/proposals.ts` consumes validated graphs (including graphs from `validateProposal`) and returns `SpecificationDiff`, validated by `SpecificationDiffSchema` in `shared/model.ts`. It compares stable node, relationship, and requirement IDs without mutating either graph. New IDs are additions; missing IDs are deletions; renames retain identity. Node, relationship, and requirement collection order does not create changes.

Each entry contains an action, human-readable explanation, and property changes with before/after values. Strings remain readable; structured values are JSON; `null` means absent, distinct from an explicitly empty string. Added/deleted entries retain all semantic properties, including requirements, scenarios, constraints, contracts, policy configuration, source bindings, and provenance. Nested object key order is irrelevant; array order is retained. Layout inputs (`beforeLayout`, `afterLayout`) and legacy inline node geometry (`x`, `y`, `width`, `height`, `position`) never produce implementation instructions. The optional proposal `explanation` remains separate from source evidence.

`policyChanged` highlights modifications to policy, instructions, required checks, or baselines. `contractChanged` identifies contract additions, changes, or deletions; `provenanceChanged` includes source-binding and evidence changes. Protected/sensitive flags consider both old and new policies, including removal of protection. Relationship entries also flag affected endpoints; requirements flag bound nodes and bound relationship endpoints. Summaries count every addition, modification, and deletion; policy changes count modified nodes, and protected/sensitive counts include all flagged entries. This computation does not accept, store, or apply a proposal; the human acceptance boundary remains separate.
