#!/usr/bin/env python3
"""Implement, independently review, check, and locally commit ordered task cards."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import selectors
import shlex
import signal
import subprocess
import sys
import tempfile
import threading
import time


class LoopError(RuntimeError):
    pass


class PrivacyFixRequested(LoopError):
    pass


STOP = threading.Event()
CHILDREN = set()
CHILDREN_LOCK = threading.Lock()
PRIVACY_LOCK = threading.Lock()


def register_child(child):
    with CHILDREN_LOCK:
        CHILDREN.add(child)
        if STOP.is_set():
            stop_child(child)
            raise LoopError('Task loop stopped')


def unregister_child(child):
    with CHILDREN_LOCK:
        CHILDREN.discard(child)


def cancel_children():
    STOP.set()
    with CHILDREN_LOCK:
        children = list(CHILDREN)
    for child in children:
        stop_child(child)


IMPLEMENT_SCHEMA = {
    'type': 'object', 'additionalProperties': False,
    'required': ['status', 'summary', 'checks'],
    'properties': {'status': {'type': 'string', 'enum': ['completed', 'blocked']},
                   'summary': {'type': 'string'},
                   'checks': {'type': 'array', 'items': {'type': 'string'}}},
}
REVIEW_SCHEMA = {
    'type': 'object', 'additionalProperties': False,
    'required': ['decision', 'summary', 'findings'],
    'properties': {'decision': {'type': 'string', 'enum': ['approve', 'request_changes', 'blocked']},
                   'summary': {'type': 'string'},
                   'findings': {'type': 'array', 'items': {'type': 'string'}}},
}
RATE_ERROR = re.compile(r'usage[_ ]limit|rate[_ -]limit|resource[_ -]exhausted|quota (?:exceeded|exhausted)|insufficient_quota|too many requests|http\s*429|out of (?:tokens|credits)|token limit reached', re.I)
SENSITIVE_NAMES = {'auth.json', 'credentials.json', 'id_rsa', 'id_ed25519', '.npmrc', '.pypirc'}
LOCAL_PATTERNS = {
    'private key': r'-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----',
    'credential URL': r'(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis)://[^\s/:]+:[^\s/@]+@',
    'private local path': r'/(?:home|Users)/[A-Za-z0-9_.-]+/',
}


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[1])
    p.add_argument('--tasks', default='docs/tasks/architecture-workspace')
    p.add_argument('--codex', default='codex', help='Codex executable (defaults to configured model)')
    p.add_argument('--agy', default='agy', help='Google Antigravity CLI executable')
    p.add_argument('--engine', choices=['codex', 'agy'], default='codex', help='CLI for implementation and fresh review sessions')
    p.add_argument('--workers', choices=['codex,agy'], help='Run two isolated workers, one per CLI')
    p.add_argument('--agy-model', help='Optional Antigravity model; --model applies only to Codex')
    p.add_argument('--task', help='Run a single initial task ID whose prerequisites are committed')
    p.add_argument('--model', help='Optional explicit Codex model for implementation and review')
    p.add_argument('--check', action='append', help='Required command, repeatable; no shell expansion. Default: npm test and npx tsc --noEmit')
    p.add_argument('--secret-command', default='uvx --from detect-secrets==1.5.0 detect-secrets scan --all-files --no-verify', help='Scanner command producing detect-secrets JSON; snapshot path is appended')
    p.add_argument('--quota-wait', type=float, default=900, help='Fallback quota retry interval in seconds (default 900)')
    p.add_argument('--max-fix-rounds', type=int, default=3, help='Maximum implementation/review rounds per invocation/task')
    p.add_argument('--max-tasks', type=int, default=0, help='Stop after N tasks; 0 runs all initial tasks')
    p.add_argument('--check-timeout', type=float, default=900)
    p.add_argument('--dry-run', action='store_true', help='Show next task without launching Codex or changing files')
    args = p.parse_args(argv)
    if args.quota_wait <= 0 or args.max_fix_rounds < 1 or args.max_tasks < 0 or args.check_timeout <= 0:
        p.error('Wait/timeout/fix rounds must be positive; max tasks must be nonnegative')
    args.check = args.check or ['npm test', 'npx tsc --noEmit']
    return args


def command(argv, repo, timeout=None, env=None):
    """A command's entire process group belongs to this runner, including checks."""
    if STOP.is_set():
        raise LoopError('Task loop stopped')
    try:
        child = subprocess.Popen(argv, cwd=repo, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, text=True, start_new_session=True,
                                 env={**os.environ, 'GIT_TERMINAL_PROMPT': '0', **(env or {})})
    except OSError as error:
        raise LoopError(f'Cannot start {argv[0]}: {error}') from error
    try:
        register_child(child)
        output, _ = child.communicate(timeout=timeout)
        return child.returncode, output
    except (KeyboardInterrupt, subprocess.TimeoutExpired):
        stop_child(child)
        raise
    finally:
        stop_child(child)
        unregister_child(child)


def stop_child(child):
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
    finally:
        # The leader may exit before a descendant that ignores SIGTERM.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def git(repo, *args, env=None):
    code, output = command(['git', *args], repo, env=env)
    if code:
        raise LoopError(f'Git {args[0]} failed: {output.strip()}')
    return output


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def load_json(path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError) as error:
        raise LoopError(f'Invalid local state/report: {path.name}') from error


def task_cards(directory):
    cards = []
    seen = set()
    for path in sorted(directory.glob('*/T[0-9][0-9][0-9]-*.md')):
        text = path.read_text()
        task_id = path.name[:4]
        phase = re.search(r'^\*\*Phase:\*\* (\d+)', text, re.M)
        if task_id in seen or not phase:
            raise LoopError(f'Duplicate task ID or missing phase: {path.name}')
        seen.add(task_id)
        if int(phase[1]) >= 8:
            continue
        title = text.splitlines()[0].removeprefix('# ')
        dependencies = re.findall(r'\[(T\d{3}) —', text)
        cards.append({'id': task_id, 'path': path, 'title': title, 'dependencies': dependencies})
    if not cards:
        raise LoopError('No initial task cards found')
    return sorted(cards, key=lambda card: card['id'])


def completed_tasks(repo):
    # Commit trailers survive a crash between commit and local state writes.
    return set(re.findall(r'^UMLith-Task: (T\d{3})$', git(repo, 'log', '--first-parent', '--format=%B'), re.M))


def next_task(cards, done):
    card = next((card for card in cards if card['id'] not in done), None)
    if card and any(dep not in done for dep in card['dependencies']):
        raise LoopError(f"{card['id']} has an incomplete or missing prerequisite")
    return card


def changed_paths(repo):
    tracked = git(repo, 'diff', '--name-only', '-z', 'HEAD').split('\0')
    untracked = git(repo, 'ls-files', '--others', '--exclude-standard', '-z').split('\0')
    return sorted(set(path for path in tracked + untracked if path))


def fingerprint(repo, include_index=True):
    digest = hashlib.sha256()
    digest.update(git(repo, 'rev-parse', 'HEAD').encode())
    for path in changed_paths(repo):
        file = repo / path
        digest.update(path.encode() + b'\0')
        if file.is_symlink():
            digest.update(b'link:' + os.readlink(file).encode())
        elif file.is_file():
            digest.update(file.read_bytes())
            digest.update(str(file.stat().st_mode).encode())
        else:
            digest.update(b'deleted')
    if include_index:
        digest.update(git(repo, 'diff', '--cached', '--raw').encode())
    return digest.hexdigest()


def plan_hash(directory, overrides=None):
    digest = hashlib.sha256()
    for file in sorted(directory.rglob('*.md')):
        relative = str(file.relative_to(directory))
        digest.update(relative.encode() + b'\0' + (overrides or {}).get(relative, file.read_bytes()))
    return digest.hexdigest()


def quota_delay(message, fallback):
    """Only actual quota/rate failures wait; context limits and auth errors stop."""
    if not RATE_ERROR.search(message):
        return None
    try:
        value = json.loads(message)
    except ValueError:
        value = []
        for line in message.splitlines():
            try:
                value.append(json.loads(line))
            except ValueError:
                pass
    def explicit_delay(obj):
        if isinstance(obj, dict):
            for key in ('retry_after_seconds', 'retry_after'):
                if isinstance(obj.get(key), (int, float)) and obj[key] >= 0:
                    return float(obj[key])
            for key in ('resets_at', 'reset_at'):
                reset = obj.get(key)
                if isinstance(reset, (int, float)):
                    return max(0, reset - time.time())
                if isinstance(reset, str):
                    try:
                        date = datetime.fromisoformat(reset.replace('Z', '+00:00'))
                        if date.tzinfo:
                            return max(0, date.timestamp() - time.time())
                    except ValueError:
                        pass
            for child in obj.values():
                delay = explicit_delay(child)
                if delay is not None:
                    return delay
        elif isinstance(obj, list):
            for child in obj:
                delay = explicit_delay(child)
                if delay is not None:
                    return delay
        return None
    delay = explicit_delay(value)
    if delay is not None:
        return delay
    match = re.search(r'(?:try again|retry|reset(?:s)?) in ([\d\s.,a-z]+)', message, re.I)
    if match:
        units = {'second': 1, 'minute': 60, 'hour': 3600, 'day': 86400}
        parts = re.findall(r'(\d+(?:\.\d+)?)\s*(second|minute|hour|day)s?', match[1], re.I)
        if parts:
            return sum(float(number) * units[unit.lower()] for number, unit in parts)
    return fallback


def wait_for_quota(seconds, state, state_path):
    deadline = time.time() + max(seconds, 0.001)
    state['retry_at'] = deadline
    atomic_json(state_path, state)
    print(f'Quota exhausted; waiting {math.ceil(seconds)} seconds. Ctrl+C stops safely.', flush=True)
    while time.time() < deadline:
        if STOP.wait(min(30, max(0, deadline - time.time()))):
            raise LoopError('Task loop stopped during quota wait')
    state.pop('retry_at', None)
    atomic_json(state_path, state)


def run_agent(args, repo, state_dir, state, prompt, review=False):
    role = 'review' if review else 'implement'
    schema = state_dir / f'{role}-schema.json'
    atomic_json(schema, REVIEW_SCHEMA if review else IMPLEMENT_SCHEMA)
    result_path = state_dir / f'{role}-result.json'
    stream_retries = 0
    while True:
        if state.get('retry_at', 0) > time.time():
            wait_for_quota(state['retry_at'] - time.time(), state, state_dir / 'state.json')
        result_path.unlink(missing_ok=True)
        if STOP.is_set():
            raise LoopError('Task loop stopped')
        if args.engine == 'agy':
            argv = [args.agy, '--input-format', 'stream-json', '--output-format', 'stream-json',
                    '--json-schema', str(schema), '--sandbox', '--dangerously-skip-permissions',
                    '--mode', 'plan' if review else 'accept-edits', '--disable-slash-commands',
                    '--print-timeout', '0', '--log-file', str(state_dir / f'agy-{role}.log')]
            if args.agy_model:
                argv += ['--model', args.agy_model]
            stdin = json.dumps({'event': 'user', 'message': {'content': prompt}}) + '\n'
        else:
            argv = [args.codex, '--ask-for-approval', 'never', 'exec', '--cd', str(repo),
                    '--sandbox', 'read-only' if review else 'workspace-write', '--json',
                    '--output-schema', str(schema), '--output-last-message', str(result_path)]
            if args.model:
                argv += ['--model', args.model]
            argv += ['-']
            stdin = prompt
        try:
            child = subprocess.Popen(argv, cwd=repo, stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     start_new_session=True,
                                     env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'})
        except OSError as error:
            raise LoopError(f'Cannot start {args.engine}: {error}') from error
        errors = []
        completed = False
        stream_interrupted = False
        terminal_count = 0
        log_path = state_dir / f"{state['task']}-{role}.jsonl"
        print(f"{state['task']}: starting fresh {args.engine} {role} CLI session", flush=True)
        def read_event(raw, log):
            nonlocal completed, terminal_count, stream_interrupted
            line = raw.decode('utf8', errors='replace')
            log.write(line + '\n')
            log.flush()
            try:
                event = json.loads(line)
            except ValueError:
                errors.append(line)
                return
            if not isinstance(event, dict):
                errors.append('Invalid CLI event')
                return
            if args.engine == 'agy' and event.get('event') == 'result':
                terminal_count += 1
                envelope = event.get('result')
                if terminal_count == 1 and isinstance(envelope, dict) and envelope.get('status') == 'SUCCESS':
                    completed = True
                    atomic_json(result_path, envelope.get('structured_output'))
                else:
                    completed = False
                    result_path.unlink(missing_ok=True)
                    errors.append(json.dumps(event))
                    if isinstance(envelope, dict) and envelope.get('status') == 'ERROR':
                        stream_interrupted = str(envelope.get('error', '')).startswith('The stream was interrupted.')
                return
            kind = event.get('type')
            if kind == 'turn.completed':
                completed = True
            if kind in ('error', 'turn.failed'):
                errors.append(json.dumps(event))
        try:
            register_child(child)
            with log_path.open('a') as log, selectors.DefaultSelector() as selector:
                child.stdin.write(stdin.encode())
                child.stdin.close()
                selector.register(child.stdout, selectors.EVENT_READ)
                buffer = b''
                while True:
                    if STOP.is_set():
                        raise LoopError('Task loop stopped')
                    if child.poll() is not None:
                        # A background tool may inherit stdout after the CLI
                        # exits. Kill remaining descendants before waiting EOF.
                        stop_child(child)
                    if not selector.select(timeout=0.2):
                        continue
                    chunk = os.read(child.stdout.fileno(), 65536)
                    if not chunk:
                        if buffer:
                            read_event(buffer, log)
                        break
                    buffer += chunk
                    while b'\n' in buffer:
                        line, buffer = buffer.split(b'\n', 1)
                        read_event(line, log)
                child.wait()
        except BaseException:
            stop_child(child)
            raise
        finally:
            stop_child(child)
            unregister_child(child)
            child.stdout.close()
            child.stdin.close()
        if child.returncode == 0 and completed and result_path.exists():
            return load_json(result_path, None)
        if stream_interrupted and terminal_count == 1:
            if stream_retries >= 1:
                raise LoopError(f'{args.engine} {role} stream interrupted after one retry; pending work retained. Rerun to continue.')
            if (git(repo, 'rev-parse', 'HEAD').strip() != state['base']
                    or plan_hash(repo / args.tasks) != state['plan_hash']):
                raise LoopError('HEAD/task plan changed during interrupted session; refusing to continue')
            stream_retries += 1
            print(f"{state['task']}: {args.engine} {role} stream interrupted; retrying once with existing work", flush=True)
            prompt += '\nThe previous CLI stream was interrupted. Inspect existing work and continue the same task and role.\n'
            continue
        failure = '\n'.join(errors)
        delay = quota_delay(failure, args.quota_wait)
        if delay is None:
            raise LoopError(f'{args.engine} {role} failed (exit {child.returncode}); inspect private log {log_path.name}')
        # Keep existing partial files; a fresh session reads the same task again.
        wait_for_quota(delay, state, state_dir / 'state.json')
        if git(repo, 'rev-parse', 'HEAD').strip() != state['base']:
            raise LoopError('HEAD changed during quota wait; refusing to continue')


def validate_result(result, review=False):
    field, values, items = ('decision', {'approve', 'request_changes', 'blocked'}, 'findings') if review else ('status', {'completed', 'blocked'}, 'checks')
    if (not isinstance(result, dict) or set(result) != {field, 'summary', items}
            or not isinstance(result[field], str) or result[field] not in values or not isinstance(result['summary'], str)
            or not result['summary'].strip() or not isinstance(result[items], list)
            or not all(isinstance(item, str) for item in result[items])):
        raise LoopError('CLI returned malformed structured output; no commit allowed')
    if review and result['decision'] == 'approve' and result['findings']:
        raise LoopError('Reviewer approved with unresolved findings; no commit allowed')


def checks(args, repo, state_dir):
    before = fingerprint(repo)
    failures = []
    for i, text in enumerate(args.check, 1):
        print(f'Check: {text}', flush=True)
        try:
            code, output = command(shlex.split(text), repo, args.check_timeout)
        except subprocess.TimeoutExpired:
            code, output = 124, 'Required check timed out'
        (state_dir / f'check-{i}.log').write_text(output)
        if code:
            failures.append(f'{text} failed (exit {code}); check-{i}.log:\n{output[-12000:]}')
    if fingerprint(repo) != before:
        raise LoopError('Required checks modified candidate source; review evidence is invalid')
    return failures


def privacy_answer(prompt):
    if not sys.stdin.isatty():
        raise LoopError('Privacy finding needs manual review in a terminal; no commit created')
    print(prompt, end='', flush=True)
    with selectors.DefaultSelector() as selector:
        selector.register(sys.stdin, selectors.EVENT_READ)
        answer = bytearray()
        while not STOP.is_set():
            if selector.select(timeout=0.2):
                chunk = os.read(sys.stdin.fileno(), 1)
                if not chunk:
                    raise LoopError('Privacy review input closed; no commit created')
                if chunk == b'\n':
                    return answer.decode(errors='replace').strip().lower()
                answer.extend(chunk)
    raise LoopError('Task loop stopped during privacy review')


def review_private_paths(repo, findings, approval_dir, interactive, before):
    with PRIVACY_LOCK:
        path = approval_dir / 'privacy-approvals.json'
        approvals = load_json(path, {'approved': []})
        if (not isinstance(approvals, dict) or set(approvals) != {'approved'}
                or not isinstance(approvals['approved'], list)
                or not all(isinstance(item, str) and re.fullmatch(r'[0-9a-f]{64}', item) for item in approvals['approved'])):
            raise LoopError('Invalid private privacy-approval record; no commit allowed')
        pending = [item for item in findings if item['id'] not in approvals['approved']]
        if not pending:
            return
        if not interactive:
            item = pending[0]
            raise LoopError(f"Potential private local path: {item['file']}:{item['line']}; inspect locally")
        print(f'\nPrivacy review needed. Workspace: {repo}', flush=True)
        for item in pending:
            print(f"Potential private local path: {item['file']}:{item['line']}", flush=True)
        while True:
            answer = privacy_answer('Inspect the files. [approve] harmless findings / [fix] edit and reverify / [stop] keep uncommitted: ')
            if answer == 'stop':
                raise LoopError('Privacy review stopped; changes retained and uncommitted')
            if answer == 'fix':
                privacy_answer('Edit the workspace files now, then press Enter to rerun checks and independent review: ')
                raise PrivacyFixRequested('Human requested privacy corrections')
            if answer == 'approve':
                if fingerprint(repo) != before:
                    raise PrivacyFixRequested('Files changed during privacy inspection')
                approval_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
                approvals['approved'] = sorted(set(approvals['approved']) | {item['id'] for item in pending})
                atomic_json(path, approvals)
                return
            print('Enter approve, fix, or stop; no default approval.', flush=True)


def scan_staged(repo, scanner, tree=None, interactive=False, approval_dir=None):
    """Scan index content, not the potentially different working tree."""
    tree = tree or git(repo, 'write-tree').strip()
    before = fingerprint(repo)
    findings = []
    with tempfile.TemporaryDirectory(prefix='umlith-staged-scan-') as tmp:
        env = {'GIT_INDEX_FILE': str(Path(tmp) / 'index')}
        snapshot = Path(tmp) / 'files'
        snapshot.mkdir()
        git(repo, 'read-tree', tree, env=env)
        tracked = [p for p in git(repo, 'ls-files', '-z', env=env).split('\0') if p]
        for name in tracked:
            path = Path(name)
            if (path.name.startswith('.env') or path.name in SENSITIVE_NAMES
                    or path.suffix.lower() in {'.pem', '.key', '.p12', '.pfx'}
                    or any(part in {'.codex-task-loop', '.ssh', '.aws', '.codex'} for part in path.parts)):
                raise LoopError(f'Sensitive file cannot be committed: {name}')
            mode = git(repo, 'ls-files', '--stage', '--', name, env=env).split()[0]
            if mode in {'120000', '160000'}:
                raise LoopError(f'Symlink/submodule needs manual review before committing: {name}')
        git(repo, 'checkout-index', '--all', f'--prefix={snapshot}/', env=env)
        for name in tracked:
            file = snapshot / name
            digest = hashlib.sha256(file.read_bytes()).hexdigest()
            for line_number, line in enumerate(file.read_text(errors='replace').splitlines(), 1):
                for label, pattern in LOCAL_PATTERNS.items():
                    if re.search(pattern, line):
                        if label != 'private local path':
                            raise LoopError(f'Potential {label}: {name}:{line_number}; inspect locally')
                        identifier = hashlib.sha256(f'{name}\0{line_number}\0{pattern}\0{digest}'.encode()).hexdigest()
                        findings.append({'id': identifier, 'file': name, 'line': line_number})
        code, output = command(shlex.split(scanner) + [str(snapshot)], repo, timeout=300)
        if code:
            raise LoopError('Secret scanner failed; refusing to commit')
        try:
            result = json.loads(output)
        except ValueError as error:
            raise LoopError('Secret scanner did not return valid JSON; refusing to commit') from error
        if not isinstance(result, dict) or not isinstance(result.get('results'), dict):
            raise LoopError('Secret scanner report is malformed; refusing to commit')
        if any(result['results'].values()):
            raise LoopError('Secret scanner found possible credentials; inspect staged files locally. No commit created.')
    if findings:
        review_private_paths(repo, findings, approval_dir or repo / '.codex-task-loop', interactive, before)


def completion_text(card, state, commit):
    text = card['path'].read_text()
    text = re.sub(r'^\*\*Status:\*\*.*$', '**Status:** Complete — checked, reviewed, and committed locally', text, count=1, flags=re.M)
    text = text.replace('- [ ]', '- [x]')
    text += (f"\n\n## Automated completion\n\n- Commit: `{commit}`\n"
             f"- Date: {datetime.now(timezone.utc).isoformat()}\n"
             f"- Checks: {', '.join(state.get('checks', []))}\n"
            '- Independent review: approved with no findings.\n'
             '- Pre-commit check: staged snapshot secret scan passed.\n'
             f"- Implementation evidence: {state.get('implementation', {}).get('summary', '')}\n"
             f"- Task checks: {json.dumps(state.get('implementation', {}).get('checks', []))}\n"
             f"- Review evidence: {state.get('review', {}).get('summary', '')}\n")
    return text


def record_completion(card, state, commit):
    text = completion_text(card, state, commit)
    temporary = card['path'].with_suffix('.tmp')
    temporary.write_text(text)
    temporary.replace(card['path'])


def check_local_boundaries(repo, directory):
    """An agent changing ignore rules must not publish private planning inputs."""
    local_files = [file for file in directory.rglob('*') if file.is_file()]
    local_files.append(repo / '.codex-task-loop/state.json')
    for file in local_files:
        code, _ = command(['git', 'check-ignore', '--no-index', '-q', str(file)], repo)
        if code:
            raise LoopError('Local task documents/state must remain ignored; no commit allowed')
    prefix = directory.relative_to(repo).as_posix() + '/'
    tracked = git(repo, 'ls-files', '-z').split('\0')
    if any(name.startswith((prefix, '.codex-task-loop/')) for name in tracked):
        raise LoopError('Local task documents/state entered the index; no commit allowed')


def check_hooks(repo):
    # Do not silently bypass checks a user has configured in custom hooks.
    hooks = Path(git(repo, 'rev-parse', '--git-path', 'hooks').strip())
    if not hooks.is_absolute():
        hooks = repo / hooks
    for name in ('pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit'):
        hook = hooks / name
        if hook.exists() and os.access(hook, os.X_OK):
            raise LoopError(f'Custom {name} hook requires manual commit handling; automated snapshot commit would bypass it')


@contextmanager
def lock(directory):
    directory.mkdir(mode=0o700, exist_ok=True)
    directory.chmod(0o700)
    with (directory / 'lock').open('w') as file:
        try:
            fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise LoopError('Another task loop is already running in this repository') from error
        yield


def run(args):
    repo = args.repo.resolve()
    if Path(git(repo, 'rev-parse', '--show-toplevel').strip()).resolve() != repo:
        raise LoopError('--repo must name the Git repository root')
    directory = (repo / args.tasks).resolve()
    if not directory.is_relative_to(repo):
        raise LoopError('Task directory must stay inside the repository')
    cards = task_cards(directory)
    if args.task:
        cards = [card for card in cards if card['id'] == args.task]
        if not cards:
            raise LoopError('Requested task is missing or deferred')
    done = completed_tasks(repo)
    if args.dry_run:
        card = next_task(cards, done)
        print(f"Next: {card['title']} ({card['path'].relative_to(repo)})" if card else 'All initial tasks are complete.')
        return 0
    state_dir = repo / '.codex-task-loop'
    ignored, _ = command(['git', 'check-ignore', '-q', str(state_dir / 'state.json')], repo)
    if ignored != 0:
        raise LoopError('Add /.codex-task-loop/ to .gitignore before running; logs/state must stay private')
    with lock(state_dir):
        parallel = load_json(state_dir / 'parallel.json', {})
        if parallel.get('jobs') or parallel.get('publishing') or parallel.get('migration'):
            raise LoopError('Pending parallel work exists; restart with --workers codex,agy to preserve task ownership')
        check_hooks(repo)
        check_local_boundaries(repo, directory)
        state_path = state_dir / 'state.json'
        state = load_json(state_path, {})
        if state and state.get('task') in done:
            # Recover after commit success followed by an interrupted state update.
            old = next((card for card in cards if card['id'] == state['task']), None)
            if old and '## Automated completion' not in old['path'].read_text():
                commit = git(repo, 'log', '--first-parent', '-1', '--format=%H', '--grep', f"^UMLith-Task: {state['task']}$").strip()
                record_completion(old, state, commit)
            atomic_json(state_path, {})
            state = {}
        count = 0
        while True:
            card = next_task(cards, completed_tasks(repo))
            if card is None or (args.max_tasks and count >= args.max_tasks):
                print('All initial tasks complete.' if card is None else 'Task limit reached.', flush=True)
                return 0
            if state:
                if state.get('task') != card['id'] or state.get('base') != git(repo, 'rev-parse', 'HEAD').strip():
                    raise LoopError('Pending state does not match task/HEAD; inspect it before resuming')
                if state.get('plan_hash') != plan_hash(directory):
                    raise LoopError('Task plan changed during pending work; inspect it before resuming')
                # Any interrupted/restarted job receives fresh checks and a fresh review.
            else:
                if git(repo, 'status', '--porcelain').strip():
                    raise LoopError('Start requires a clean worktree/index; commit your existing work first')
                state = {'task': card['id'], 'base': git(repo, 'rev-parse', 'HEAD').strip(),
                         'plan_hash': plan_hash(directory), 'feedback': '', 'checks': args.check}
                atomic_json(state_path, state)
            approved = False
            for attempt in range(args.max_fix_rounds):
                prompt = (f"CURRENT TASK: {card['id']}\nImplement only {card['path'].relative_to(repo)}.\n"
                          f'Read {directory.relative_to(repo)}/ORIGINAL-PLAN.md, CONTRACT.md, DECISIONS.md, '
                          'the task card and its dependencies. Inspect and reuse existing code. '
                          'Complete every acceptance criterion and concrete scenario; never weaken checks. '
                          'The user authorized automatic task implementation, independent review and local commits. '
                          'Do not ask again for routine design approval within the specified task. '
                          'Do not stage, commit, reset, push, or modify Git configuration: the controller owns Git. '
                          'Do not change scripts/codex-task-loop.py, scripts/parallel_task_loop.py, tests/test_task_loop.py, '
                          'tests/test_parallel_task_loop.py, runner state/logs, task documents or original plan. '
                          'Do not add private paths, credentials, auth files, or logs to source. '
                          'Partial work may already exist after quota interruption; inspect it and continue. '
                          'Use meaningful task tests and return blocked for unresolved task defects or missing task-specific evidence. '
                          'The controller runs the required checks below outside your CLI sandbox after you return completed, '
                          'and refuses review or commit if any fail. Do not duplicate those full checks in the sandbox. '
                          'If you already attempted them, report sandbox permission failures honestly; they alone do not '
                          'require blocked when task-specific acceptance is verified. Completed hands the candidate to '
                          'controller validation; it does not certify those pending checks. '
                          'Require browser or live-agent evidence only when the task actually calls for it.\n'
                          f"Required controller checks: {json.dumps(args.check)}\n"
                          f"Previous check/review feedback: {state.get('feedback') or 'None'}\n")
                result = run_agent(args, repo, state_dir, state, prompt)
                validate_result(result)
                state['implementation'] = result
                atomic_json(state_path, state)
                if git(repo, 'rev-parse', 'HEAD').strip() != state['base'] or plan_hash(directory) != state['plan_hash']:
                    raise LoopError('Agent changed Git history or task documents; no commit allowed')
                if result['status'] != 'completed':
                    raise LoopError(f"{card['id']} is blocked; inspect the private implementation result")
                checked_content = fingerprint(repo, include_index=False)
                failures = checks(args, repo, state_dir)
                if failures:
                    state['feedback'] = '\n'.join(failures)
                    atomic_json(state_path, state)
                    continue
                check_local_boundaries(repo, directory)
                paths = changed_paths(repo)
                if paths:
                    git(repo, 'add', '-A', '--', *paths)
                git(repo, 'diff', '--exit-code')
                code, output = command(['git', 'diff', '--cached', '--check'], repo)
                if code == 2:
                    state['feedback'] = ('Staged whitespace check failed:\n' + output
                                         + '\nFix the source whitespace. Do not disable the check through Git configuration or attributes.')
                    state.pop('review', None)
                    atomic_json(state_path, state)
                    print(f"{card['id']}: whitespace check failed; requesting repair before review", flush=True)
                    continue
                if code:
                    raise LoopError(f'Git whitespace check failed (exit {code}): {output.strip()}')
                # Freeze the commit tree before independent review; never
                # adopt a different index or file snapshot after approval.
                tree = git(repo, 'write-tree').strip()
                if fingerprint(repo, include_index=False) != checked_content:
                    raise LoopError('Candidate changed after required checks; no commit allowed')
                before = fingerprint(repo)
                if git(repo, 'write-tree').strip() != tree:
                    raise LoopError('Index changed while freezing review snapshot')
                review_prompt = (f"CURRENT TASK: {card['id']}\nIndependently review {card['path'].relative_to(repo)} against actual current files, "
                                 f"git diff {state['base']} {tree}, and the original plan/contract. "
                                 'Verify every acceptance criterion and concrete scenario, correctness, regression risk, '
                                 'scope, and potential credential/privacy leaks. Verify configured checks and task-specific evidence. '
                                 'The controller has already run the configured checks outside your read-only CLI sandbox '
                                 'against this unchanged candidate. Use that controller evidence for those checks; '
                                 'do not repeat them in the sandbox or block solely because its permissions prevent rerunning them. '
                                 'Independently inspect source and task-specific evidence; missing required evidence still blocks approval. '
                                 'A claimed implementation summary is not proof. Return approve only with zero unresolved findings. '
                                 'The findings array contains only unresolved actionable defects, never positive observations or passed checks. '
                                 'Put verification evidence in summary. When approving, return exactly "findings": []. '
                                 'Review only: do not edit files, stage, commit, reset, or push. The controller commits locally. '
                                 'A task may already be implemented; an empty diff still requires full task verification.\n'
                                 f"Controller checks passed: {json.dumps(args.check)}\n"
                                 f"Implementation report: {json.dumps(result)}\n")
                review = run_agent(args, repo, state_dir, state, review_prompt, review=True)
                validate_result(review, review=True)
                if fingerprint(repo) != before or plan_hash(directory) != state['plan_hash']:
                    raise LoopError('Files/index/history changed during review; approval is invalid')
                if review['decision'] == 'blocked':
                    raise LoopError('Reviewer could not verify acceptance; no commit allowed')
                if review['decision'] == 'request_changes':
                    state['feedback'] = json.dumps(review)
                    atomic_json(state_path, state)
                    continue
                approved = True
                state['review'] = review
                atomic_json(state_path, state)
                break
            if not approved:
                raise LoopError('Fix/review limit reached; changes remain local and uncommitted. Rerun to continue.')
            if fingerprint(repo) != before:
                raise LoopError('Candidate changed after approval; no commit allowed')
            check_local_boundaries(repo, directory)
            check_hooks(repo)
            if git(repo, 'write-tree').strip() != tree:
                raise LoopError('Index no longer matches the approved tree; no commit allowed')
            git(repo, 'diff', '--cached', '--check')
            try:
                scan_staged(repo, args.secret_command, tree=tree, interactive=True,
                            approval_dir=getattr(args, 'privacy_directory', state_dir))
            except PrivacyFixRequested as error:
                if git(repo, 'rev-parse', 'HEAD').strip() != state['base'] or plan_hash(directory) != state['plan_hash']:
                    raise LoopError('History/task plan changed during privacy inspection; no commit allowed') from error
                state['feedback'] = ('The human requested privacy corrections or edited files during inspection. '
                                     'Inspect the existing edits, reverify task acceptance, rerun required checks and obtain fresh independent review.\n'
                                     + state.get('feedback', ''))
                state.pop('review', None)
                atomic_json(state_path, state)
                continue
            if (git(repo, 'rev-parse', 'HEAD').strip() != state['base']
                    or git(repo, 'write-tree').strip() != tree
                    or fingerprint(repo) != before or plan_hash(directory) != state['plan_hash']):
                raise LoopError('Candidate changed during pre-commit scan; no commit allowed')
            if getattr(args, 'prepare_only', False):
                return {'card': card, 'state': state, 'tree': tree, 'fingerprint': before}
            message = f"Complete {card['title']}\n\nUMLith-Task: {card['id']}\n"
            # Build precisely the immutable reviewed tree, then atomically move
            # HEAD only if its parent still matches; never reread a racing index.
            commit = git(repo, 'commit-tree', tree, '-p', state['base'], '-m', message).strip()
            git(repo, 'update-ref', '-m', f"Complete {card['id']}", 'HEAD', commit, state['base'])
            record_completion(card, state, commit)
            atomic_json(state_path, {})
            state = {}
            count += 1
            print(f"{card['id']}: committed locally as {commit[:8]}; CLI sessions exited", flush=True)


def main():
    os.umask(0o077)
    # SIGTERM follows the same process-group cleanup path as Ctrl+C.
    def interrupted(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    try:
        args = parse_args()
        if args.workers:
            from parallel_task_loop import run_parallel
            return run_parallel(args, sys.modules[__name__])
        return run(args)
    except KeyboardInterrupt:
        cancel_children()
        print('Stopped; pending work and local state retained. Nothing pushed.', file=sys.stderr)
        return 130
    except (LoopError, OSError) as error:
        print(f'Stopped: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
