# Local operation

Requires Node.js 22.12 or newer. Run `npm install`, `npm run build`, then `npm start`; open the loopback URL printed by the service (default port 4317). `npm run dev` runs the service plus Vite on port 5173. `PORT` changes the service port for a built app. `DATA_DIR` selects a separate data directory; the default is ignored `.workspace-data`. Keep this directory: it stores intended specifications, history, layouts, jobs, candidates, and recovery backups.

Create a blank managed project or register an existing TypeScript/Prisma folder. Code analysis supplies the implemented model; adopt it explicitly into intended architecture if desired. Architecture, ER, and optional function workflows can be edited independently of execution. Saved source updates the implemented model; prose requirements do not become proof of behavior.

## Portable agent workflow

Open **Agent workspace**, describe the task, and enter one scope per line. An exact file permits only that file; a trailing slash permits a directory; `.` permits included project files. Scope excludes credentials, private configuration, Git data, dependencies, and generated directories.

Download the handoff ZIP and result template. The ZIP contains a versioned manifest and specification, readable architecture, agent instructions, and import-quality report. It contains specification evidence and protected baselines, so inspect it before sharing with a provider. It does not include arbitrary local source folders or credentials.

Give an external agent the approved handoff and the relevant source files. Return its changed UTF-8 files in the downloaded JSON template. Preserve the template's handoff ID, project ID, specification revision, source hashes, task, and scope. The saved handoff fixes the approved task and scope; an edited or unknown handoff is rejected. `files` maps canonical relative paths to complete new text, or `null` to delete a file. Untouched files remain copied from the captured baseline. For example, fill `files` with `{"src/example.ts":"export const example = 1;\n"}`. External JSON import supports text; integrated candidate review also identifies binary changes. The HTTP body limit is 32 MiB and imported text is limited to 20 MiB per file.

Upload the result JSON. Import creates a separate candidate and never applies it directly. Stale revisions, unsafe paths, excluded files, and out-of-scope edits are rejected. Review the actual file and architecture differences, diagnostics, warnings, and named check results. Select the human-review confirmation and apply only a passing candidate. Rejecting a candidate preserves originals and intended architecture.

## Optional integrated execution

Install and authenticate Codex separately and make `codex` available on the service's PATH. Linux must allow Bubblewrap's isolation namespaces; having a `bwrap` binary is insufficient. The app probes actual isolation and supported installed CLI options. If either prerequisite fails, it explains the reason and disables launch; portable export/import remains usable. There is no unsandboxed execution fallback.

Choose hosted inference, Ollama, or LM Studio. For a local provider, enter an installed model name and run its service separately. Hosted inference requires provider authentication and can consume paid quota. The app does not install models or manage provider billing. No live provider inference is part of default checks.

An implementation task writes only its candidate. The original source, stored specifications, other jobs, and dependency directories remain inaccessible or read-only. A design task cannot modify candidate source; its proposal still requires human acceptance in the architecture review panel. Cancelling terminates the task process group; timeout escalates to forced termination when necessary. Interrupted running jobs are identified on restart rather than silently resumed as success.

## Checks, application, and recovery

Configure named checks as an executable and argument array in Agent workspace. All configured project checks run; names referenced by sensitive/protected items must also exist and pass inside isolation. Failed or unavailable required checks prevent application. Changed Prisma definitions require isolated project-version semantic validation; AST import alone does not verify a live database. Changing check definitions invalidates old passing results and requires revalidation.

Before application the app rechecks the intended revision, original hashes, complete candidate hashes and file permissions, required checks, and policies. It serializes application per project and writes durable recovery backups before any original mutation. Each affected file is replaced through a pinned directory with symlink checks and a final content check. Intended architecture and protection baselines are preserved; saved-source reconciliation supplies the new implemented graph.

Restart automatically checks pending journals. Interrupted writes are rolled back only when current bytes and permissions match recorded before/after evidence. External conflicting edits are preserved and block another application. Inspect the affected files and restore the appropriate recorded content, then use **Retry recovery**; the app never blindly overwrites conflicting edits. Keep the recovery directory until resolved. File checks cannot lock unrelated editors or programs; avoid editing the same source while applying a candidate.

## Validation record

The 2026-10-11 completion pass deferred new automated tests at the user's request. Build/type checks and disposable-project API checks plus browser loading checks are recorded in the task cards and completion ledger. Those checks do not establish exhaustive regression coverage, successful hosted/local inference, all-platform isolation, or measured synchronization latency. Run `npm test` when resuming automated validation; test-focused initial cards and later milestones remain explicitly deferred.

## Prepared design handoff and local MCP

In Agent workspace, enter a bounded task and allowed paths, inspect missing checks and source evidence, then choose **Prepare handoff**. Save semantic drafts first. Copy architecture text and Download handoff read the captured revision even after the live design changes; prepare again to share a newer revision. The full graph, requirements, configured checks, protections and deliberately included source baselines are shared. Selecting an item focuses navigation and never hides global constraints. Required missing checks still block later application.

Open **Connect through MCP** and copy the displayed `mcpServers` configuration into your own client's settings. It contains an absolute Node executable, the installed `tsx` loader and entrypoint, private project artifact directory and selected handoff UUID. No client configuration is modified automatically. For a terminal launch from this checkout:

```bash
npm run mcp -- /absolute/private/project-artifact-directory HANDOFF_UUID
```

The official TypeScript SDK `@modelcontextprotocol/sdk` is pinned to 1.32.1, the maintained v1 compatibility release verified against [official releases](https://github.com/modelcontextprotocol/typescript-sdk/releases) and [stdio documentation](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio). This slice supports stdio only. Its three tools (`get_design_manifest`, `get_design_context`, `get_method_specification`) are read-only; resources expose only the selected manifest, specification, architecture and node context. A method is identified by its stable node ID, including when names are overloaded. It cannot execute checks, update design or apply code.

Context pages use `offset` and `limit` (1–100), with `nextOffset` and `total`. A response above 1 MiB fails explicitly instead of silently dropping rules; use pages, focused nodes or the captured download. Stored handoffs are limited to 32 MiB. Keep private handoff artifacts with their matching result baseline records under the project `handoffs/` directory; deleting them makes their MCP configuration/result import unavailable. Stdout is reserved for protocol traffic and startup errors go to stderr. The manifest digest hashes sorted package file entries before the digest fields are added, avoiding a self-referential hash. Live source edits never refresh captured evidence.

Verification: **Test MCP connection** starts the official SDK Client over stdio, discovers tools/resources, reads the captured manifest, verifies its digest and reads a method when present. This verifies the SDK client; individual third-party clients still require their own connection check. External result JSON remains version 1 and retains its original review/application safeguards; graph/handoff format 2 is distinct from that result envelope and the negotiated MCP protocol revision.

## Local PlantUML diagrams

Run `npm run setup:plantuml` once with Java 11+ installed. This downloads checksum-pinned PlantUML 1.2026.8 from Maven Central into ignored `.tools/`; diagram contents are never sent to a public renderer. The local service runs Java with PlantUML SANDBOX and Smetana layout, so Graphviz is not required. Requests accept a validated graph and view rather than arbitrary PlantUML programs. Rendering has time, concurrency, input and output limits.

Overview, Classes, Database, and selected-method flowcharts use generated PlantUML SVG by default. Click class members or relationships to open the same stable object in Details. Zoom/Fit and scroll preserve each view's viewport. PlantUML source and SVG download represent the visible graph, including clearly indicated unsaved drafts; only saved revisions can become AI handoffs. Handoffs include `diagrams/*.puml`, manifest mappings, and read-only MCP diagram resources from the same immutable bytes. Optional text-only methods remain valid.

Project notes save through the specification revision guard; graph Undo/Redo does not include project description history. After a conflicting notes save, copy/reconcile the retained text, cancel the dialog and reload the project before retrying.
