"""Two isolated CLI workers sharing one prerequisite-aware local commit queue."""
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
import copy
import hashlib
import json
from pathlib import Path
import shutil
import threading


class Coordinator:
    def __init__(self, args, runner):
        self.args, self.r = args, runner
        self.repo = args.repo.resolve()
        self.directory = (self.repo / args.tasks).resolve()
        if not self.directory.is_relative_to(self.repo):
            raise runner.LoopError('Task directory must stay inside the repository')
        self.cards = runner.task_cards(self.directory)
        self.private = self.repo / '.codex-task-loop'
        self.path = self.private / 'parallel.json'
        self.mutex = threading.RLock()
        self.data = runner.load_json(self.path, {})

    def save(self):
        self.r.atomic_json(self.path, self.data)

    def head(self):
        return self.r.git(self.repo, 'rev-parse', 'HEAD').strip()

    def assert_main(self):
        if (self.head() != self.data['head']
                or self.r.git(self.repo, 'status', '--porcelain').strip()
                or self.r.plan_hash(self.directory) != self.data['plan_hash']):
            raise self.r.LoopError('Main files/history/task plan changed outside the coordinator; pending work retained')
        if self.r.STOP.is_set():
            raise self.r.LoopError('Parallel task loop stopped')

    def workspace(self, engine):
        return self.private / 'worktrees' / engine

    def worker_state(self, engine):
        return self.workspace(engine) / '.codex-task-loop/state.json'

    def create_workspace(self, engine):
        workspace = self.workspace(engine)
        if not workspace.exists():
            workspace.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            self.r.git(self.repo, 'worktree', 'add', '--detach', str(workspace), self.head())
        listed = self.r.git(self.repo, 'worktree', 'list', '--porcelain')
        if f'worktree {workspace}\n' not in listed:
            raise self.r.LoopError('Worker path is not a registered worktree; refusing to reuse it')
        return workspace

    def initialize(self):
        self.r.check_hooks(self.repo)
        self.r.check_local_boundaries(self.repo, self.directory)
        if not self.data:
            self.data = {'version': 1, 'head': self.head(), 'plan_hash': self.r.plan_hash(self.directory), 'jobs': {}}
            self.save()
        if self.data.get('version') != 1 or set(self.data.get('jobs', {})) - {'codex', 'agy'}:
            raise self.r.LoopError('Unrecognized parallel state; inspect private state before resuming')
        if not self.data['jobs'] and not self.data.get('publishing') and not self.data.get('migration'):
            self.data['head'] = self.head()
            self.data['plan_hash'] = self.r.plan_hash(self.directory)
            self.save()
        if self.data.get('publishing'):
            self.recover_publication()
        if self.data.get('migration'):
            self.finish_migration()
        serial = self.r.load_json(self.private / 'state.json', {})
        if serial:
            self.migrate_serial(serial)
        self.assert_main()
        done = self.r.completed_tasks(self.repo)
        for engine, task in list(self.data['jobs'].items()):
            if task in done:
                self.data['jobs'].pop(engine)
                self.r.atomic_json(self.worker_state(engine), {})
        self.save()

    def migrate_serial(self, state):
        """Copy the pending candidate before removing only those copied main files."""
        if (state.get('base') != self.head() or state.get('plan_hash') != self.r.plan_hash(self.directory)
                or state.get('task') not in {c['id'] for c in self.cards}
                or state['task'] in self.r.completed_tasks(self.repo)):
            raise self.r.LoopError('Pending serial task/HEAD/plan mismatch; cannot migrate safely')
        if self.data['jobs']:
            raise self.r.LoopError('Interrupted serial migration; copied worker and original files retained for inspection')
        engine = self.args.engine
        workspace = self.create_workspace(engine)
        if self.r.git(workspace, 'status', '--porcelain').strip():
            raise self.r.LoopError('Migration worker already has changes; no files discarded')
        self.r.git(workspace, 'read-tree', '-u', '-m', 'HEAD', self.head())
        self.r.git(workspace, 'update-ref', 'HEAD', self.head())
        before = self.r.fingerprint(self.repo)
        paths = self.r.changed_paths(self.repo)
        for name in paths:
            source, target = self.repo / name, workspace / name
            if source.is_symlink() or (source.exists() and not source.is_file()):
                raise self.r.LoopError('Cannot safely migrate non-regular pending files')
            if source.is_file():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
            else:
                target.unlink(missing_ok=True)
        shutil.copytree(self.directory, workspace / self.args.tasks, dirs_exist_ok=True)
        copied = copy.deepcopy(state)
        copied['plan_hash'] = self.r.plan_hash(workspace / self.args.tasks)
        copied['feedback'] = ('The coordinator preserved this interrupted serial candidate in a private worker. '
                              'Continue it and retain all required checks.\n' + copied.get('feedback', ''))
        private = workspace / '.codex-task-loop'
        private.mkdir(mode=0o700, exist_ok=True)
        self.r.atomic_json(private / 'state.json', copied)
        if self.r.fingerprint(self.repo) != before:
            raise self.r.LoopError('Main changed during migration; original and copied candidate retained')
        self.data['jobs'][engine] = state['task']
        self.data['migration'] = {'engine': engine, 'paths': paths}
        self.save()  # Journal ownership before touching the original candidate.
        self.finish_migration()
        print(f"{state['task']}: pending changes preserved in the {engine} worker", flush=True)

    def finish_migration(self):
        journal = self.data['migration']
        workspace = self.workspace(journal['engine'])
        paths = journal['paths']
        if self.head() != self.data['head'] or self.r.plan_hash(self.directory) != self.data['plan_hash']:
            raise self.r.LoopError('Main changed during migration; original and copied work retained')
        if set(self.r.changed_paths(self.repo)) - set(paths):
            raise self.r.LoopError('Unowned files appeared during migration; no files discarded')
        for name in self.r.changed_paths(self.repo):
            source, backup = self.repo / name, workspace / name
            if source.is_symlink() or backup.is_symlink():
                raise self.r.LoopError('Pending file changed during migration; no files discarded')
            if ((not source.exists() and backup.exists())
                    or (source.exists() and (not source.is_file() or not backup.is_file()
                        or source.read_bytes() != backup.read_bytes()
                        or source.stat().st_mode != backup.stat().st_mode))):
                raise self.r.LoopError('Pending file changed during migration; no files discarded')
        indexed = set(self.r.git(self.repo, 'ls-files', '-z').split('\0'))
        indexed.update(self.r.git(self.repo, 'ls-tree', '-r', '--name-only', '-z', 'HEAD').split('\0'))
        owned = [name for name in paths if name in indexed]
        if owned:
            self.r.git(self.repo, 'restore', '--source', 'HEAD', '--staged', '--worktree', '--', *owned)
        for name in paths:
            if name not in indexed:
                (self.repo / name).unlink(missing_ok=True)
        self.r.atomic_json(self.private / 'state.json', {})
        self.data.pop('migration')
        self.save()

    def setup_dependencies(self, workspace):
        package = workspace / 'package.json'
        if not package.exists():
            return
        lockfile = self.repo / 'package-lock.json'
        digest = hashlib.sha256(package.read_bytes() + (lockfile.read_bytes() if lockfile.exists() else b'')).hexdigest()
        marker = workspace / '.codex-task-loop/dependencies.json'
        if (workspace / 'node_modules').is_dir() and self.r.load_json(marker, {}).get('hash') == digest:
            return
        if lockfile.exists():
            shutil.copy2(lockfile, workspace / 'package-lock.json')
        code, output = self.r.command(['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund'], workspace, self.args.check_timeout)
        (workspace / '.codex-task-loop/setup.log').write_text(output)
        if code:
            raise self.r.LoopError('Worker dependency setup failed; inspect its private setup.log')
        self.r.atomic_json(marker, {'hash': digest})

    def assign(self, engine, card):
        with self.mutex:
            self.assert_main()
            workspace = self.create_workspace(engine)
            if self.r.git(workspace, 'status', '--porcelain').strip():
                raise self.r.LoopError('Idle worker has unowned changes; refusing to overwrite them')
            self.r.git(workspace, 'read-tree', '-u', '-m', 'HEAD', self.head())
            self.r.git(workspace, 'update-ref', 'HEAD', self.head())
            destination = workspace / self.args.tasks
            if destination.exists():
                shutil.rmtree(destination)
            shutil.copytree(self.directory, destination)
            private = workspace / '.codex-task-loop'
            private.mkdir(mode=0o700, exist_ok=True)
            self.r.atomic_json(private / 'state.json', {'task': card['id'], 'base': self.head(),
                'plan_hash': self.r.plan_hash(destination), 'feedback': '', 'checks': self.args.check})
            self.data['jobs'][engine] = card['id']
            self.save()
            print(f"{card['id']}: assigned to {engine} in an isolated worktree", flush=True)

    def recover_rebase(self, engine, state):
        journal = state.get('rebase')
        if not journal:
            return
        workspace = self.workspace(engine)
        if self.r.git(workspace, 'rev-parse', 'HEAD').strip() not in (journal['old'], journal['base']):
            raise self.r.LoopError('Worker HEAD changed during rebase recovery')
        code, _ = self.r.command(['git', 'diff', '--quiet'], workspace)
        index = self.r.git(workspace, 'write-tree').strip()
        if (code or index not in (journal['candidate'], journal['tree'])
                or self.r.git(workspace, 'ls-files', '--others', '--exclude-standard').strip()
                or self.r.plan_hash(workspace / self.args.tasks) != state['plan_hash']):
            raise self.r.LoopError('Worker changed during rebase recovery; current files retained for inspection')
        self.r.git(workspace, 'read-tree', '--reset', '-u', journal['tree'])
        self.r.git(workspace, 'update-ref', 'HEAD', journal['base'])
        state['base'] = journal['base']
        state.pop('rebase')
        state.pop('review', None)
        state['feedback'] = 'Another task committed while this task ran. Reverify the merged candidate against the new base, rerun checks and obtain fresh review.'
        self.r.atomic_json(self.worker_state(engine), state)

    def work(self, engine):
        workspace = self.workspace(engine)
        args = copy.copy(self.args)
        args.repo, args.engine, args.workers = workspace, engine, None
        args.task, args.max_tasks, args.prepare_only = self.data['jobs'][engine], 1, True
        self.recover_rebase(engine, self.r.load_json(self.worker_state(engine), {}))
        self.setup_dependencies(workspace)
        for _ in range(args.max_fix_rounds):
            prepared = self.r.run(args)
            if not isinstance(prepared, dict):
                raise self.r.LoopError('Worker returned no reviewed candidate')
            with self.mutex:
                self.assert_main()
                state, tree = prepared['state'], prepared['tree']
                if (self.r.fingerprint(workspace) != prepared['fingerprint']
                        or self.r.git(workspace, 'write-tree').strip() != tree
                        or self.r.plan_hash(workspace / args.tasks) != state['plan_hash']):
                    raise self.r.LoopError('Worker candidate changed after review; no publication allowed')
                if self.head() != state['base']:
                    candidate = self.r.git(workspace, 'commit-tree', tree, '-p', state['base'], '-m', 'Private reviewed candidate').strip()
                    code, output = self.r.command(['git', 'merge-tree', '--write-tree', self.head(), candidate], workspace)
                    (workspace / '.codex-task-loop/merge.log').write_text(output)
                    if code:
                        raise self.r.LoopError(f"{state['task']}: merge conflict; both candidates retained. Inspect the worker's private merge.log")
                    merged = output.splitlines()[0]
                    state['rebase'] = {'old': state['base'], 'base': self.head(), 'tree': merged, 'candidate': tree}
                    self.r.atomic_json(self.worker_state(engine), state)
                    self.recover_rebase(engine, state)
                    print(f"{state['task']}: base advanced; repeating implementation checks and independent review", flush=True)
                    continue
                self.r.check_hooks(self.repo)
                self.r.check_local_boundaries(self.repo, self.directory)
                message = f"Complete {prepared['card']['title']}\n\nUMLith-Task: {state['task']}\n"
                commit = self.r.git(workspace, 'commit-tree', tree, '-p', state['base'], '-m', message).strip()
                card = next(c for c in self.cards if c['id'] == state['task'])
                completed_text = self.r.completion_text(card, state, commit)
                completed_hash = self.r.plan_hash(self.directory, {str(card['path'].relative_to(self.directory)): completed_text.encode()})
                self.data['publishing'] = {'engine': engine, 'task': state['task'], 'base': state['base'],
                    'tree': tree, 'commit': commit, 'completed_text': completed_text, 'completed_hash': completed_hash}
                self.save()
                self.recover_publication()
                print(f"{state['task']}: committed locally as {commit[:8]}; {engine} sessions exited", flush=True)
                return
        raise self.r.LoopError('Base advanced too often; reviewed candidate retained. Rerun to continue.')

    def recover_publication(self):
        journal = self.data['publishing']
        base, commit = journal['base'], journal['commit']
        current = self.head()
        if current not in (base, commit) or self.r.plan_hash(self.directory) not in (self.data['plan_hash'], journal['completed_hash']):
            raise self.r.LoopError('Publication journal does not match main; no automatic recovery')
        if self.r.git(self.repo, 'diff', '--name-only').strip() or self.r.git(self.repo, 'ls-files', '--others', '--exclude-standard').strip():
            raise self.r.LoopError('Unowned files appeared during publication; no overwrite allowed')
        index = self.r.git(self.repo, 'write-tree').strip()
        base_tree = self.r.git(self.repo, 'rev-parse', f'{base}^{{tree}}').strip()
        if index not in (base_tree, journal['tree']):
            raise self.r.LoopError('Main index differs from publication journal; no overwrite allowed')
        if current == base:
            self.r.git(self.repo, 'read-tree', '-u', '-m', base, commit)
            self.r.git(self.repo, 'update-ref', '-m', f"Complete {journal['task']}", 'HEAD', commit, base)
        elif index != journal['tree']:
            raise self.r.LoopError('Published main index is inconsistent; inspect before resuming')
        engine = journal['engine']
        workspace = self.workspace(engine)
        card = next(c for c in self.cards if c['id'] == journal['task'])
        temporary = card['path'].with_suffix('.tmp')
        temporary.write_text(journal['completed_text'])
        temporary.replace(card['path'])
        worker_head = self.r.git(workspace, 'rev-parse', 'HEAD').strip()
        if worker_head not in (base, commit):
            raise self.r.LoopError('Worker HEAD changed during publication recovery')
        if worker_head == base:
            self.r.git(workspace, 'update-ref', 'HEAD', commit, base)
        self.r.atomic_json(self.worker_state(engine), {})
        self.data['jobs'].pop(engine, None)
        self.data['head'] = commit
        self.data['plan_hash'] = self.r.plan_hash(self.directory)
        self.data.pop('publishing')
        self.save()


def run_parallel(args, runner):
    coordinator = Coordinator(args, runner)
    if Path(runner.git(coordinator.repo, 'rev-parse', '--show-toplevel').strip()).resolve() != coordinator.repo:
        raise runner.LoopError('--repo must name the Git repository root')
    if args.task:
        raise runner.LoopError('--task is for a single worker; omit it with --workers')
    if args.dry_run:
        done = runner.completed_tasks(coordinator.repo)
        ready = [c for c in coordinator.cards if c['id'] not in done and all(d in done for d in c['dependencies'])]
        for engine, card in zip(('codex', 'agy'), ready):
            print(f"Next {engine}: {card['title']}")
        if not ready:
            print('No prerequisite-ready tasks.')
        return 0
    ignored, _ = runner.command(['git','check-ignore','-q',str(coordinator.private/'parallel.json')],coordinator.repo)
    if ignored:
        raise runner.LoopError('Parallel state/worktrees must remain ignored')
    with runner.lock(coordinator.private):
        coordinator.initialize()
        initial = runner.completed_tasks(coordinator.repo)
        futures = {}
        executor = ThreadPoolExecutor(max_workers=2)
        try:
            while True:
                with coordinator.mutex:
                    coordinator.assert_main()
                    done = runner.completed_tasks(coordinator.repo)
                    busy = set(futures.values())
                    reserved = set(coordinator.data['jobs'].values())
                    capacity = args.max_tasks - len(done - initial) - len(reserved) if args.max_tasks else 2
                    for engine in ('codex','agy'):
                        if engine in busy:
                            continue
                        task = coordinator.data['jobs'].get(engine)
                        if not task and capacity > 0:
                            card = next((c for c in coordinator.cards if c['id'] not in done | reserved
                                and all(d in done for d in c['dependencies'])), None)
                            if card:
                                coordinator.assign(engine,card)
                                reserved.add(card['id']);capacity -= 1;task = card['id']
                        if task:
                            futures[executor.submit(coordinator.work,engine)] = engine
                    if not futures:
                        pending = [c for c in coordinator.cards if c['id'] not in done]
                        if pending and not (args.max_tasks and len(done-initial) >= args.max_tasks):
                            raise runner.LoopError('Remaining tasks have incomplete or missing prerequisites')
                        print('Task limit reached.' if pending else 'All initial tasks complete.',flush=True)
                        return 0
                finished,_=wait(futures,timeout=0.5,return_when=FIRST_COMPLETED)
                for future in finished:
                    futures.pop(future)
                    future.result()
        finally:
            runner.cancel_children()
            executor.shutdown(wait=True,cancel_futures=True)
            runner.STOP.clear()
