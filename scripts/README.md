# Local CLI task loop

`codex-task-loop.py` runs the initial task cards in numeric order. Each task gets a fresh implementation CLI session, required checks, and a separate read-only review session. Review findings go back to implementation for up to three rounds. Only approval with no findings, passing checks, and a successful staged-content secret scan permits a local commit. The script never pushes.

## Start

Requires Linux/Python 3.10+, Git, an authenticated Codex CLI, Node dependencies for project checks, and `uvx` for the default secret scanner. The CLI uses your configured model unless `--model` is supplied. Verified command options match local Codex CLI 0.161.0 and [official non-interactive execution documentation](https://learn.chatgpt.com/docs/non-interactive-mode).

Commit the runner and any existing project edits before starting: the loop refuses unrelated dirty files. Keep `docs/` ignored as configured; do not force-add task files, state, or logs.

```bash
# Inspect the next task without running an agent.
python3 scripts/codex-task-loop.py --dry-run

# Run one task, including review, checks, and local commit.
python3 scripts/codex-task-loop.py --max-tasks 1

# Continue until all initial tasks are complete.
python3 scripts/codex-task-loop.py
```

The five Phase 8 milestones are deferred and always excluded. Explicit task dependencies must be completed before their dependents. Git commits carry `UMLith-Task: T001` trailers; these are the completion ledger. Already implemented tasks can receive a reviewed empty completion commit after their acceptance criteria are verified. The corresponding local card is marked complete and receives an evidence record only after a successful commit.

## Codex and Google Antigravity together

The installed `agy` must be the Antigravity **agent CLI**, with `--input-format stream-json` and `--json-schema` in `agy --help`. An older IDE launcher also named `agy` cannot run these tasks. Authenticate once using `agy` before unattended runs; its credentials remain in the CLI's own storage. The runner uses the documented [headless stdin protocol and structured results](https://www.antigravity.google/docs/cli/headless/).

```bash
# Preview the two earliest tasks whose prerequisites are committed.
python3 scripts/codex-task-loop.py --workers codex,agy --dry-run

# Run Codex and Antigravity concurrently, with separate workspaces.
python3 scripts/codex-task-loop.py --workers codex,agy

# Limit the combined run to two successful local task commits.
python3 scripts/codex-task-loop.py --workers codex,agy --max-tasks 2

# Use Antigravity alone through the same checks/review/commit pipeline.
python3 scripts/codex-task-loop.py --engine agy
```

`--codex` and `--agy` select executable paths. `--model` selects only the Codex model; `--agy-model` selects only the Antigravity model. Without overrides, each CLI keeps its configured model. Each task uses a fresh implementation session and a separate fresh review session from its assigned provider. Codex reviews use its read-only sandbox. Antigravity reviews use plan mode and the runner refuses approval if source, index, history, or task documents change.

Both workers operate in detached Git worktrees inside ignored `.codex-task-loop/worktrees/`, with separate copies of the task plan, logs, state, and Node dependencies. Setup runs `npm install --ignore-scripts --no-audit --no-fund` per worker, cached while its package inputs stay unchanged. This requires network access on first setup; packages that need installation scripts require their documented setup separately. Antigravity uses `--sandbox` for terminal restrictions and `--dangerously-skip-permissions` to avoid unattended permission prompts; this approves tool calls, including writes. The runner does not change your global Antigravity settings. Worktrees isolate Git candidates; CLI sandbox boundaries and mutation checks provide their additional controls.

The coordinator reserves unique task IDs and chooses the lowest-numbered **ready** task for each free worker. Only main's committed `UMLith-Task` trailers satisfy prerequisites. Independent tasks may finish out of numeric order; unmet prerequisites keep their dependents waiting. A dependency chain may leave one worker idle. Implementation and review run concurrently across tasks, while publication to main is serialized. If main advances, the candidate is merged into that new base in its worker and must repeat implementation verification, required checks, independent review, and the secret scan. An unresolved merge conflict stops safely and retains both candidates for inspection.

If the old single-worker loop has a matching pending task, switching to `--workers codex,agy` first copies that candidate into its assigned worker, journals the migration, and removes only the copied pending files from main. No task is marked complete by migration. Already committed tasks remain the shared ledger. A dirty main checkout without a matching pending state is refused.

Quota waits affect the exhausted worker; the other can continue. Ctrl+C stops child process groups and quota waits, preserving candidates and reservations. Restart the same dual-worker command to resume. `parallel.json` and per-worker `state.json` journal interrupted publication and revalidation; changed files outside recorded recovery states stop rather than overwriting edits. Do not edit main or worker files while the loop is active, and do not delete its state or worktrees while tasks are pending. The single-worker command refuses a pending parallel run, so the same task cannot be claimed twice. Neither mode pushes.

## Checks and privacy

Default required checks are `npm test` and `npx tsc --noEmit`. Repeat `--check 'command arguments'` to supply project-specific required commands; supplying this option replaces both defaults. Commands run without shell expansion. A check timeout is a failure. Checks that modify candidate source invalidate review evidence.

A failed check is sent to implementation for repair; the loop stops after the fix limit if it remains unresolved. The staged whitespace check runs before independent review, and violations such as trailing spaces or extra blank lines at EOF go through the same repair loop. Repaired files receive fresh checks and review; Git command errors still stop safely. It does not silently waive a failing baseline. The incomplete initial Vite application is why the default includes the compiler check rather than the full Vite build; task-specific acceptance still requires its documented checks, including a build when appropriate.

Immediately before each commit, the script checks whitespace, scans the exact staged snapshot with `detect-secrets==1.5.0` (27 detectors, network verification disabled), and rejects credential filenames, private keys, credential-bearing URLs, symlinks, and submodules. Potential private local paths require manual review. A scanner error blocks committing. Credential findings require correction; no baseline automatically suppresses them. Secret scanning reduces accidental disclosure; it cannot prove arbitrary source content contains no private information. Your configured Git author name/email remain commit metadata.

When the only findings are potential private local paths, an interactive terminal pauses and lists their workspace, filenames, and line numbers without printing the matched text. Inspect those files, then enter one of:

- `approve`: confirm the listed findings are harmless and continue the existing reviewed commit.
- `fix`: edit the listed workspace files while paused, then press Enter. The loop repeats implementation verification, required checks, independent review, and scanning before committing.
- `stop`: leave everything uncommitted and exit safely.

There is no default approval. A non-interactive run still stops on an unapproved finding. Approval is limited to the exact filename, line, pattern, and complete file contents inspected; any changed file requires new approval. Editing while choosing `approve` also triggers fresh verification. Unchanged approved examples can pass later task scans without repeated prompts. The private, ignored `privacy-approvals.json` stores only approval hashes, never matched text; parallel workers share this record and serialize terminal questions. Ctrl+C cancels a pending question. Credentials, private keys, sensitive files, scanner failures, failing tests, and review findings still block commits.

The scanner may need network access on its first `uvx` invocation to populate the tool cache. It is installed into the tool cache, not the project's dependencies.

## Quota waits and restart

Quota/rate errors wait until a structured reset/retry time or relative delay when supplied; otherwise the loop retries every 15 minutes. Change the fallback with `--quota-wait 1800`. It preserves partial files and retries the same stage in a fresh CLI session. A review quota failure retries review, not implementation. Authentication errors, context-window limits, malformed results, and ordinary CLI failures stop rather than sleeping forever.

An Antigravity result reporting `The stream was interrupted.` retries the same phase once in a fresh session, preserving existing work. Its interrupted result is never accepted as success, even with exit code 0 or a completed structured report. A repeated interruption stops safely; rerun the same command to continue the pending task with fresh checks and review.

Press Ctrl+C to stop. Child process groups are terminated, partial files and private state are retained, and restarting the same command continues the pending task with fresh checks/review. Pending work is refused if Git HEAD or the task plan changed. Do not edit the repository concurrently with the runner: it owns all changes made after starting a task, and cannot identify another person's edits during a paused implementation session.

`.codex-task-loop/` contains the lock, state, structured results, and private logs. It is ignored and restricted to the local user. Do not delete it while work is pending: deleting state would remove the runner's ability to recognize its own unfinished changes. An error does not reset files or discard work. CLI processes exit at the end of each stage; the outer Python process stays alive for the next task or quota wait. Workspace-write sandboxing is used for implementation, read-only for review, with approvals disabled; the runner does not request full-access sandbox bypass.

If a local commit succeeds just before a crash, the completion trailer prevents implementing the task twice and allows the next run to finish updating the local task card. To prevent a racing index or hook from adding unreviewed files, the runner creates the exact approved tree with `git commit-tree` and moves HEAD atomically with `git update-ref`. It refuses executable custom commit hooks instead of silently bypassing them; those repositories require manual commit handling. A removed task-document ignore rule blocks application before documents are staged.

## Runner tests

```bash
python3 -m unittest discover -s tests -p 'test*task_loop.py' -q
```

These tests use disposable real Git repositories and a fake Codex executable. They cover ordering, deferred tasks, quota retry, repair/review cycles, local-only commits, staged-secret rejection, failed checks, malformed approvals, review mutation, dependency validation, and restart. They also verify Antigravity results, actual two-worker overlap, prerequisite scheduling, independent quota waits, revalidation after base changes, interrupted migration/publication, preservation of manual corrections, and cancellation. They do not consume model tokens or run the real project task backlog.
