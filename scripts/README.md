# Local Codex task loop

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

## Checks and privacy

Default required checks are `npm test` and `npx tsc --noEmit`. Repeat `--check 'command arguments'` to supply project-specific required commands; supplying this option replaces both defaults. Commands run without shell expansion. A check timeout is a failure. Checks that modify candidate source invalidate review evidence.

This repository currently has a pre-existing TS2367 error at `server/jobs.ts:99`; the default type check will block commits until that issue is resolved. A failed check is sent to implementation for repair; the loop stops after the fix limit if it remains unresolved. It does not silently waive a failing baseline. The incomplete initial Vite application is why the default includes the compiler check rather than the full Vite build; task-specific acceptance still requires its documented checks, including a build when appropriate.

Immediately before each commit, the script checks whitespace, scans the exact staged snapshot with `detect-secrets==1.5.0` (27 detectors, network verification disabled), and rejects credential filenames, private keys, credential-bearing URLs, private local home paths, symlinks, and submodules. A scanner error blocks committing. Findings require local inspection; no baseline automatically suppresses them. Secret scanning reduces accidental disclosure; it cannot prove arbitrary source content contains no private information. Your configured Git author name/email remain commit metadata.

The scanner may need network access on its first `uvx` invocation to populate the tool cache. It is installed into the tool cache, not the project's dependencies.

## Quota waits and restart

Quota/rate errors wait until a structured reset/retry time or relative delay when supplied; otherwise the loop retries every 15 minutes. Change the fallback with `--quota-wait 1800`. It preserves partial files and retries the same stage in a fresh CLI session. A review quota failure retries review, not implementation. Authentication errors, context-window limits, malformed results, and ordinary CLI failures stop rather than sleeping forever.

Press Ctrl+C to stop. Child process groups are terminated, partial files and private state are retained, and restarting the same command continues the pending task with fresh checks/review. Pending work is refused if Git HEAD or the task plan changed. Do not edit the repository concurrently with the runner: it owns all changes made after starting a task, and cannot identify another person's edits during a paused implementation session.

`.codex-task-loop/` contains the lock, state, structured results, and private logs. It is ignored and restricted to the local user. Do not delete it while work is pending: deleting state would remove the runner's ability to recognize its own unfinished changes. An error does not reset files or discard work. CLI processes exit at the end of each stage; the outer Python process stays alive for the next task or quota wait. Workspace-write sandboxing is used for implementation, read-only for review, with approvals disabled; the runner does not request full-access sandbox bypass.

If a local commit succeeds just before a crash, the completion trailer prevents implementing the task twice and allows the next run to finish updating the local task card. To prevent a racing index or hook from adding unreviewed files, the runner creates the exact approved tree with `git commit-tree` and moves HEAD atomically with `git update-ref`. It refuses executable custom commit hooks instead of silently bypassing them; those repositories require manual commit handling. A removed task-document ignore rule blocks application before documents are staged.

## Runner tests

```bash
python3 -m unittest discover -s tests -p 'test_task_loop.py' -q
```

These tests use disposable real Git repositories and a fake Codex executable. They cover ordering, deferred tasks, quota retry, repair/review cycles, local-only commits, staged-secret rejection, failed checks, malformed approvals, review mutation, dependency validation, and restart. They do not consume model tokens or run the real project task backlog.
