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
