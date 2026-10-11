"""Exercise the runner with real temporary Git repositories and a fake CLI."""
import importlib.util
import json
import os
import signal
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'codex-task-loop.py'


def load_runner():
    spec = importlib.util.spec_from_file_location('task_loop', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


FAKE_CODEX = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
prompt = sys.stdin.read()
root = pathlib.Path.cwd()
mode = os.environ.get('FAKE_MODE', 'approve')
assert args[:3] == ['--ask-for-approval', 'never', 'exec']
assert '--json' in args and '--output-schema' in args and args[-1] == '-'
assert args[args.index('--cd') + 1] == str(root)
calls = root / '.codex-task-loop' / 'fake-calls.json'
history = json.loads(calls.read_text()) if calls.exists() else []
role = 'review' if args[args.index('--sandbox') + 1] == 'read-only' else 'implement'
history.append(role)
calls.write_text(json.dumps(history))
print(json.dumps({'type': 'thread.started', 'thread_id': 'test-session'}))
if mode == 'quota' and len(history) == 1:
    (root / 'partial.txt').write_text('partial work\n')
    print(json.dumps({'type': 'turn.failed', 'error': {'message': 'Usage limit reached. Try again in 0 seconds.', 'retry_after_seconds': 0}}))
    sys.exit(1)
if mode == 'auth':
    print(json.dumps({'type': 'turn.failed', 'error': {'message': 'Authentication failed: sign in required'}}))
    sys.exit(1)
if mode == 'quota-review' and role == 'review' and history.count('review') == 1:
    print(json.dumps({'type': 'turn.failed', 'error': {'message': 'rate_limit_exceeded', 'retry_after_seconds': 0}}))
    sys.exit(1)
if role == 'implement':
    task = prompt.split('CURRENT TASK: ')[1].split()[0]
    (root / (task + '.txt')).write_text('implemented\n')
    if mode=='whitespace-always' or (mode=='whitespace-fix' and history.count('implement')==1):
        (root / (task + '.txt')).write_text('implemented\n\n')
    if mode=='whitespace-fix' and history.count('implement')==2:
        assert 'Staged whitespace check failed' in prompt
    if mode == 'secret':
        (root / 'auth.json').write_text('{}')
    if mode == 'private':
        (root / 'example.txt').write_text('Example: ' + '/' + 'home/user/project\nTask: '+task+'\n')
    if mode == 'empty':
        (root / (task + '.txt')).unlink()
    if mode == 'expose-docs':
        (root / '.gitignore').write_text('/.codex-task-loop/\n')
    result = {'status': 'completed', 'summary': 'Task implemented', 'checks': ['fixture check passed']}
    if mode in ('sandbox-checks', 'task-blocked'):
        assert 'outside your CLI sandbox after you return completed' in prompt
        result['checks'].append('Full suite unavailable in sandbox: listen EPERM; deferred to controller')
        if mode == 'task-blocked':
            result['status'] = 'blocked'
            result['summary'] = 'Task-specific acceptance remains unverified'
else:
    if mode == 'sandbox-checks':
        assert 'Controller checks passed:' in prompt
        assert 'do not repeat them in the sandbox' in prompt
    result = {'decision': 'approve', 'summary': 'Reviewed actual diff', 'findings': []}
    if mode == 'reject' or (mode == 'fix' and history.count('review') == 1):
        result = {'decision': 'request_changes', 'summary': 'Fix required', 'findings': ['Missing edge case']}
    if mode == 'mutating-review':
        (root / 'review-tamper.txt').write_text('unreviewed change')
    if mode == 'malformed':
        result = {'decision': 'approve'}
out = pathlib.Path(args[args.index('--output-last-message') + 1])
out.write_text(json.dumps(result))
print(json.dumps({'type': 'turn.completed', 'usage': {'input_tokens': 1, 'output_tokens': 1}}))
if mode == 'lingering':
    import subprocess
    subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
'''

FAKE_AGY = r'''#!/usr/bin/env python3
import json, os, pathlib, sys
args=sys.argv[1:]
assert '--sandbox' in args and '--dangerously-skip-permissions' in args
assert args[args.index('--input-format')+1]=='stream-json'
assert args[args.index('--output-format')+1]=='stream-json'
prompt=json.loads(sys.stdin.readline())['message']['content']
assert not sys.stdin.read()
root=pathlib.Path.cwd()
calls=root/'.codex-task-loop/fake-calls.json'
history=json.loads(calls.read_text()) if calls.exists() else []
schema=json.loads(pathlib.Path(args[args.index('--json-schema')+1]).read_text())
role='review' if 'decision' in schema['required'] else 'implement'
history.append(role); calls.write_text(json.dumps(history))
mode=os.environ.get('FAKE_MODE','approve')
if mode=='quota' and len(history)==1:
    print(json.dumps({'event':'result','result':{'status':'ERROR','error':'RESOURCE_EXHAUSTED: quota exhausted','retry_after_seconds':0}}));sys.exit(1)
if mode in ('auth','nonterminal'):
    print(json.dumps({'event':'result','result':{'status':'ERROR' if mode=='auth' else 'WAITING','error':'authentication required'}}));sys.exit(0)
if mode=='stream-always' or (mode=='stream-once' and history.count(role)==1):
    (root/'partial.txt').write_text('partial work\n')
    print(json.dumps({'event':'result','result':{'status':'ERROR','error':'The stream was interrupted. Please continue the task you were working on.','structured_output':{'status':'completed','summary':'Implemented rate limit middleware','checks':[]}}}));sys.exit(0)
if role=='implement':
    task=prompt.split('CURRENT TASK: ')[1].split()[0]
    (root/(task+'.txt')).write_text('implemented\n')
    if mode=='whitespace-always' or (mode=='whitespace-fix' and history.count('implement')==1):
        (root/(task+'.txt')).write_text('implemented\n\n')
    if mode=='whitespace-fix' and history.count('implement')==2:
        assert 'Staged whitespace check failed' in prompt
    output={'status':'completed','summary':'Implemented fixture','checks':['fixture passes']}
else:
    output={'decision':'approve','summary':'Independent review passed','findings':[]}
    if mode=='mutating-review': (root/'tampered.txt').write_text('unreviewed')
if mode=='malformed': output={'status':'completed'}
print(json.dumps({'event':'result','result':{'status':'SUCCESS','structured_output':output}}))
if mode=='contradictory':
    print(json.dumps({'event':'result','result':{'status':'ERROR','error':'Terminal failure after success'}}))
'''


class TaskLoopTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.runner = load_runner()
        self.git('init', '-q')
        self.git('config', 'user.name', 'Fixture User')
        self.git('config', 'user.email', 'fixture@example.invalid')
        (self.repo / '.gitignore').write_text('/docs/\n/.codex-task-loop/\n')
        (self.repo / 'base.txt').write_text('baseline\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'baseline')
        self.base = self.git('rev-parse', 'HEAD').strip()
        self.tasks = self.repo / 'docs/tasks/architecture-workspace'
        for name in ['ORIGINAL-PLAN.md', 'CONTRACT.md', 'DECISIONS.md', 'REQUIREMENTS.md', 'README.md']:
            self.tasks.mkdir(parents=True, exist_ok=True)
            (self.tasks / name).write_text('# Local plan\n')
        self.card('T001', 1)
        self.card('T002', 1, 'T001')
        self.card('T003', 8)
        self.cli = self.repo / '.git' / 'fake-codex'
        self.cli.write_text(FAKE_CODEX)
        self.cli.chmod(0o700)
        # This scanner reads actual staged snapshot files. The real scanner is
        # separately exercised against this project's index before any commit.
        self.scanner = self.repo / '.git' / 'fake-scanner'
        self.scanner.write_text('#!/usr/bin/env python3\nimport json, pathlib, sys\np=pathlib.Path(sys.argv[-1])\nresults={} if not (p/"auth.json").exists() else {"auth.json":[{"type":"Secret Keyword", "line_number":1}]}\nprint(json.dumps({"results":results}))\n')
        self.scanner.chmod(0o700)

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args):
        return subprocess.check_output(['git', *args], cwd=self.repo, text=True)

    def card(self, task, phase, dependency=None):
        directory = self.tasks / f'{phase:02}-phase'
        directory.mkdir(exist_ok=True)
        dependency_text = f'- [{dependency} — prerequisite](../01-phase/{dependency}-fixture.md)' if dependency else '- None'
        (directory / f'{task}-fixture.md').write_text(f'# {task}: Fixture\n\n**Status:** Not assessed\n**Phase:** {phase} — Fixture\n\n## Dependencies\n\n{dependency_text}\n\n## Acceptance criteria\n\n- [ ] Implement the fixture.\n')

    def run_loop(self, mode='approve', max_tasks=0, check=None, rounds=3, engine='codex'):
        if engine == 'agy':
            self.cli.write_text(FAKE_AGY)
        args = self.runner.parse_args(['--repo', str(self.repo), '--codex', str(self.cli),
                                      '--engine', engine, '--agy', str(self.cli),
                                      '--secret-command', str(self.scanner), '--check', check or 'true',
                                      '--max-tasks', str(max_tasks), '--max-fix-rounds', str(rounds),
                                      '--quota-wait', '0.001'])
        old = os.environ.get('FAKE_MODE')
        os.environ['FAKE_MODE'] = mode
        try:
            return self.runner.run(args)
        finally:
            if old is None:
                os.environ.pop('FAKE_MODE', None)
            else:
                os.environ['FAKE_MODE'] = old

    def test_ordered_local_commits_skip_deferred_and_restart_without_duplicates(self):
        self.assertEqual(self.run_loop(), 0)
        self.assertEqual(self.git('rev-list', '--count', 'HEAD').strip(), '3')
        self.assertIn('UMLith-Task: T001', self.git('log', '--format=%B'))
        self.assertIn('UMLith-Task: T002', self.git('log', '--format=%B'))
        self.assertFalse((self.repo / 'T003.txt').exists())
        self.assertEqual(self.git('status', '--porcelain').strip(), '')
        self.assertEqual(self.run_loop(), 0)
        self.assertEqual(self.git('rev-list', '--count', 'HEAD').strip(), '3')
        self.assertNotIn('docs/', self.git('ls-files'))

    def test_sandbox_check_limitations_still_require_controller_checks(self):
        with patch.object(self.runner, 'checks', wraps=self.runner.checks) as required:
            self.assertEqual(self.run_loop('sandbox-checks', max_tasks=1), 0)
        self.assertEqual(required.call_count, 1)
        self.assertIn('UMLith-Task: T001', self.git('log', '-1', '--format=%B'))
        with self.assertRaises(self.runner.LoopError):
            self.run_loop('sandbox-checks', max_tasks=1, check='false', rounds=1)
        self.assertNotIn('UMLith-Task: T002', self.git('log', '-1', '--format=%B'))
        self.assertEqual(json.loads((self.repo / '.codex-task-loop/fake-calls.json').read_text()),
                         ['implement', 'review', 'implement'])

    def test_missing_task_evidence_remains_blocked(self):
        with patch.object(self.runner, 'checks', wraps=self.runner.checks) as required:
            with self.assertRaisesRegex(self.runner.LoopError, 'T001 is blocked'):
                self.run_loop('task-blocked', max_tasks=1)
        self.assertEqual(required.call_count, 0)
        self.assertEqual(self.git('rev-list', '--count', 'HEAD').strip(), '1')

    def test_quota_wait_preserves_partial_files_and_retries_same_task(self):
        self.assertEqual(self.run_loop('quota', max_tasks=1), 0)
        self.assertEqual((self.repo / 'partial.txt').read_text(), 'partial work\n')
        self.assertEqual(json.loads((self.repo / '.codex-task-loop/fake-calls.json').read_text()), ['implement', 'implement', 'review'])

    def test_quota_during_review_retries_review_without_reimplementing(self):
        self.assertEqual(self.run_loop('quota-review', max_tasks=1), 0)
        self.assertEqual(json.loads((self.repo / '.codex-task-loop/fake-calls.json').read_text()), ['implement', 'review', 'review'])

    def test_agy_implements_independently_reviews_and_commits_locally(self):
        self.assertEqual(self.run_loop(engine='agy', max_tasks=1), 0)
        self.assertIn('UMLith-Task: T001', self.git('log', '-1', '--format=%B'))
        self.assertEqual(json.loads((self.repo/'.codex-task-loop/fake-calls.json').read_text()), ['implement','review'])

    def test_agy_quota_retries_but_other_errors_block(self):
        self.assertEqual(self.run_loop('quota', engine='agy', max_tasks=1), 0)
        self.assertEqual(json.loads((self.repo/'.codex-task-loop/fake-calls.json').read_text()), ['implement','implement','review'])
        self.assertEqual(self.runner.CHILDREN,set())

    def test_agy_retries_interrupted_implementation_and_review_without_trusting_error_result(self):
        with patch.object(self.runner, 'wait_for_quota', side_effect=AssertionError('Stream interruption is not quota exhaustion')), patch.object(self.runner, 'checks', wraps=self.runner.checks) as required:
            self.assertEqual(self.run_loop('stream-once', engine='agy', max_tasks=1), 0)
        self.assertEqual(required.call_count, 1)
        self.assertEqual(json.loads((self.repo/'.codex-task-loop/fake-calls.json').read_text()),
                         ['implement', 'implement', 'review', 'review'])
        self.assertEqual((self.repo/'partial.txt').read_text(), 'partial work\n')
        self.assertIn('T001', self.runner.completed_tasks(self.repo))

    def test_agy_repeated_stream_interruption_stops_without_commit(self):
        with patch.object(self.runner, 'wait_for_quota', side_effect=AssertionError('Stream interruption is not quota exhaustion')), self.assertRaisesRegex(self.runner.LoopError, 'stream interrupted'):
            self.run_loop('stream-always', engine='agy', max_tasks=1)
        self.assertEqual(self.git('rev-parse', 'HEAD').strip(), self.base)
        self.assertEqual(json.loads((self.repo/'.codex-task-loop/fake-calls.json').read_text()),
                         ['implement', 'implement'])
        self.assertFalse((self.repo/'.codex-task-loop/implement-result.json').exists())

    def test_agy_auth_nonterminal_malformed_or_mutating_review_never_commit(self):
        for mode in ('auth','nonterminal','malformed','mutating-review','contradictory'):
            with self.subTest(mode=mode), self.assertRaises(self.runner.LoopError):
                self.run_loop(mode, engine='agy', max_tasks=1)
            self.assertEqual(self.git('rev-parse','HEAD').strip(),self.base)

    def test_local_completion_does_not_push_to_configured_origin(self):
        remote = self.repo / '.git' / 'remote.git'
        subprocess.check_call(['git', 'init', '--bare', '-q', str(remote)])
        self.git('remote', 'add', 'origin', str(remote))
        self.git('push', '-q', 'origin', 'HEAD:refs/heads/main')
        self.assertEqual(self.run_loop(max_tasks=1), 0)
        remote_head = subprocess.check_output(['git', '--git-dir', str(remote), 'rev-parse', 'main'], text=True).strip()
        self.assertEqual(remote_head, self.base)

    def test_scanner_reads_staged_content_even_when_worktree_hides_it(self):
        (self.repo / 'auth.json').write_text('{}')
        self.git('add', 'auth.json')
        (self.repo / 'auth.json').unlink()
        with self.assertRaises(self.runner.LoopError):
            self.runner.scan_staged(self.repo, str(self.scanner))
        self.assertEqual(self.git('rev-parse', 'HEAD').strip(), self.base)

    def private_example(self):
        file = self.repo / 'example.txt'
        file.write_text('Example: ' + '/' + 'home/user/project\n')
        self.git('add', 'example.txt')
        return file

    def test_private_path_can_be_approved_once_for_exact_file_contents(self):
        self.private_example()
        with patch.object(self.runner, 'privacy_answer', return_value='approve') as answer:
            self.runner.scan_staged(self.repo, str(self.scanner), interactive=True)
            self.runner.scan_staged(self.repo, str(self.scanner), interactive=True)
        self.assertEqual(answer.call_count, 1)
        report=self.repo/'.codex-task-loop/privacy-approvals.json'
        self.assertTrue(report.exists())
        self.assertNotIn('/'+'home/user/project',report.read_text())
        self.assertEqual(self.git('rev-parse','HEAD').strip(),self.base)

    def test_changed_private_example_requires_new_approval(self):
        file=self.private_example()
        with patch.object(self.runner,'privacy_answer',return_value='approve'):
            self.runner.scan_staged(self.repo,str(self.scanner),interactive=True)
        file.write_text(file.read_text()+'Changed contents\n');self.git('add','example.txt')
        with patch.object(self.runner,'privacy_answer',return_value='stop') as answer,self.assertRaises(self.runner.LoopError):
            self.runner.scan_staged(self.repo,str(self.scanner),interactive=True)
        answer.assert_called_once()

    def test_fix_requests_fresh_verification_and_never_approves_old_tree(self):
        self.private_example()
        with patch.object(self.runner,'privacy_answer',side_effect=['fix','']),self.assertRaises(self.runner.PrivacyFixRequested):
            self.runner.scan_staged(self.repo,str(self.scanner),interactive=True)
        self.assertFalse((self.repo/'.codex-task-loop/privacy-approvals.json').exists())

    def test_privacy_approval_does_not_override_credentials(self):
        self.private_example();(self.repo/'auth.json').write_text('{}');self.git('add','auth.json')
        with patch.object(self.runner,'privacy_answer',return_value='approve') as answer,self.assertRaises(self.runner.LoopError):
            self.runner.scan_staged(self.repo,str(self.scanner),interactive=True)
        answer.assert_not_called()

    def test_editing_during_approval_requires_fresh_verification(self):
        file=self.private_example()
        def approve(prompt):
            file.write_text('Changed while inspecting\n');return 'approve'
        with patch.object(self.runner,'privacy_answer',side_effect=approve),self.assertRaises(self.runner.PrivacyFixRequested):
            self.runner.scan_staged(self.repo,str(self.scanner),interactive=True)
        self.assertFalse((self.repo/'.codex-task-loop/privacy-approvals.json').exists())

    def test_scanner_findings_cannot_be_overridden_by_privacy_approval(self):
        self.private_example()
        self.scanner.write_text('#!/usr/bin/env python3\nimport json\nprint(json.dumps({"results":{"example.txt":[{"type":"Secret Keyword","line_number":1}]}}))\n')
        with patch.object(self.runner,'privacy_answer',return_value='approve') as answer,self.assertRaises(self.runner.LoopError):
            self.runner.scan_staged(self.repo,str(self.scanner),interactive=True)
        answer.assert_not_called()

    def test_noninteractive_private_finding_still_blocks(self):
        self.private_example()
        with patch.object(self.runner.sys.stdin,'isatty',return_value=False),self.assertRaises(self.runner.LoopError):
            self.runner.scan_staged(self.repo,str(self.scanner),interactive=True)

    def test_approve_commits_and_fix_reruns_checks_and_review(self):
        with patch.object(self.runner,'privacy_answer',return_value='approve'):
            self.assertEqual(self.run_loop('private',max_tasks=1),0)
        self.assertIn('T001',self.runner.completed_tasks(self.repo))
        self.card('T002',1,'T001')
        calls=self.repo/'.codex-task-loop/fake-calls.json'
        calls.unlink()
        original=self.runner.checks
        checked=[]
        def required(*args):
            checked.append('checked');return original(*args)
        def human(prompt):
            if 'Edit the workspace' in prompt:
                (self.repo/'example.txt').write_text('Harmless sample\n')
                os.environ['FAKE_MODE']='approve'
                return ''
            return 'fix'
        # New candidate contents invalidate the first task's approval.
        with patch.object(self.runner,'privacy_answer',side_effect=human),patch.object(self.runner,'checks',side_effect=required):
            self.assertEqual(self.run_loop('private',max_tasks=1),0)
        self.assertEqual(checked,['checked','checked'])
        self.assertEqual(json.loads(calls.read_text()),['implement','review','implement','review'])
        self.assertEqual((self.repo/'example.txt').read_text(),'Harmless sample\n')

    def test_terminal_privacy_reader_can_be_cancelled(self):
        import pty
        import threading
        import io
        import tty
        master,slave=pty.openpty()
        tty.setcbreak(slave)
        stream=io.TextIOWrapper(os.fdopen(slave,'rb',buffering=0))
        errors=[]
        def reader():
            try:self.runner.privacy_answer('Test privacy prompt: ')
            except self.runner.LoopError as error:errors.append(str(error))
        try:
            with patch.object(self.runner.sys,'stdin',stream):
                os.write(master,b'a')
                thread=threading.Thread(target=reader);thread.start()
                time.sleep(.05);self.runner.STOP.set();thread.join(timeout=2)
                self.assertFalse(thread.is_alive())
                self.assertTrue(errors)
        finally:
            self.runner.STOP.clear();stream.close();os.close(master)

    def test_terminal_reader_preserves_two_pasted_answers(self):
        import pty
        import threading
        import io
        master,slave=pty.openpty()
        stream=io.TextIOWrapper(os.fdopen(slave,'rb',buffering=0));answers=[]
        def reader():
            answers.append(self.runner.privacy_answer('First: '))
            answers.append(self.runner.privacy_answer('Second: '))
        try:
            with patch.object(self.runner.sys,'stdin',stream):
                os.write(master,b'approve\nstop\n')
                thread=threading.Thread(target=reader);thread.start();thread.join(timeout=2)
                self.runner.STOP.set();thread.join(timeout=2)
                self.assertEqual(answers,['approve','stop'])
        finally:
            self.runner.STOP.clear();stream.close();os.close(master)

    def test_pending_failure_can_resume_without_skipping_task(self):
        with self.assertRaises(self.runner.LoopError):
            self.run_loop('reject', max_tasks=1, rounds=1)
        self.assertEqual(self.git('rev-parse', 'HEAD').strip(), self.base)
        self.assertEqual(self.run_loop('approve', max_tasks=1), 0)
        self.assertIn('UMLith-Task: T001', self.git('log', '-1', '--format=%B'))

    def whitespace_repair(self, engine):
        with patch.object(self.runner,'checks',wraps=self.runner.checks) as required:
            self.assertEqual(self.run_loop('whitespace-fix',engine=engine,max_tasks=1),0)
        self.assertEqual(required.call_count,2)
        self.assertEqual(json.loads((self.repo/'.codex-task-loop/fake-calls.json').read_text()),['implement','implement','review'])
        self.assertEqual((self.repo/'T001.txt').read_text(),'implemented\n')
        self.assertIn('UMLith-Task: T001',self.git('log','-1','--format=%B'))

    def test_codex_repairs_whitespace_then_rechecks_and_reviews(self):
        self.whitespace_repair('codex')

    def test_agy_repairs_whitespace_then_rechecks_and_reviews(self):
        self.whitespace_repair('agy')

    def test_unrepaired_whitespace_stops_at_fix_limit_without_review_or_commit(self):
        with self.assertRaisesRegex(self.runner.LoopError,'Fix/review limit'):
            self.run_loop('whitespace-always',max_tasks=1,rounds=2)
        self.assertEqual(self.git('rev-parse','HEAD').strip(),self.base)
        self.assertEqual(json.loads((self.repo/'.codex-task-loop/fake-calls.json').read_text()),['implement','implement'])
        self.assertIn('Staged whitespace check failed',self.runner.load_json(self.repo/'.codex-task-loop/state.json',{})['feedback'])
        self.assertEqual((self.repo/'T001.txt').read_text(),'implemented\n\n')

    def test_git_whitespace_command_error_still_stops_safely(self):
        original=self.runner.command
        def failed_git(argv,*args,**kwargs):
            if argv==['git','diff','--cached','--check']:
                return 128,'fatal: invalid Git configuration'
            return original(argv,*args,**kwargs)
        with patch.object(self.runner,'command',side_effect=failed_git),self.assertRaisesRegex(self.runner.LoopError,'exit 128'):
            self.run_loop(max_tasks=1)
        self.assertEqual(self.git('rev-parse','HEAD').strip(),self.base)
        self.assertEqual(json.loads((self.repo/'.codex-task-loop/fake-calls.json').read_text()),['implement'])

    def test_resume_rejects_changed_specification_and_changed_head(self):
        with self.assertRaises(self.runner.LoopError):
            self.run_loop('reject', max_tasks=1, rounds=1)
        original = (self.tasks / 'ORIGINAL-PLAN.md').read_text()
        (self.tasks / 'ORIGINAL-PLAN.md').write_text('changed requirements')
        with self.assertRaises(self.runner.LoopError):
            self.run_loop(max_tasks=1)

        (self.tasks / 'ORIGINAL-PLAN.md').write_text(original)
        self.git('commit', '--allow-empty', '-qm', 'external commit')
        with self.assertRaises(self.runner.LoopError):
            self.run_loop(max_tasks=1)

    def test_post_review_file_cannot_enter_commit(self):
        original = self.runner.atomic_json
        def interrupted_state_write(path, value):
            original(path, value)
            if path.name == 'state.json' and value.get('review', {}).get('decision') == 'approve':
                (self.repo / 'unreviewed.txt').write_text('external edit after approval')
        with patch.object(self.runner, 'atomic_json', interrupted_state_write):
            with self.assertRaises(self.runner.LoopError):
                self.run_loop(max_tasks=1)
        self.assertEqual(self.git('rev-parse', 'HEAD').strip(), self.base)

    def test_index_race_after_staging_cannot_replace_reviewed_tree(self):
        original = self.runner.git
        injected = False
        def racing_index(repo, *args, **kwargs):
            nonlocal injected
            result = original(repo, *args, **kwargs)
            if args == ('diff', '--exit-code') and not injected:
                injected = True
                (self.repo / 'unreviewed.txt').write_text('unreviewed staged addition')
                self.git('add', 'unreviewed.txt')
            return result
        with patch.object(self.runner, 'git', racing_index):
            with self.assertRaises(self.runner.LoopError):
                self.run_loop(max_tasks=1)
        self.assertEqual(self.git('rev-parse', 'HEAD').strip(), self.base)

    def test_normal_cli_exit_cleans_descendants_holding_stdout(self):
        args = [sys.executable, str(SCRIPT), '--repo', str(self.repo), '--codex', str(self.cli),
                '--secret-command', str(self.scanner), '--check', 'true', '--max-tasks', '1']
        child = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 text=True, env={**os.environ, 'FAKE_MODE':'lingering'}, start_new_session=True)
        try:
            stdout, stderr = child.communicate(timeout=5)
            self.assertEqual(child.returncode, 0, stderr)
            self.assertIn('committed locally', stdout)
        finally:
            if child.poll() is None:
                os.kill(child.pid, signal.SIGTERM)
                child.communicate(timeout=5)

    def test_removing_local_plan_ignore_rule_blocks_commit(self):
        with self.assertRaises(self.runner.LoopError):
            self.run_loop('expose-docs', max_tasks=1)
        self.assertEqual(self.git('rev-parse', 'HEAD').strip(), self.base)
        self.assertNotIn('docs/', self.git('ls-files'))

    def test_custom_commit_hook_requires_manual_handling_without_commit(self):
        hook = self.repo / '.git/hooks/pre-commit'
        hook.write_text('#!/bin/sh\nprintf extra > hook-change.txt\ngit add hook-change.txt\n')
        hook.chmod(0o700)
        with self.assertRaises(self.runner.LoopError):
            self.run_loop(max_tasks=1)
        self.assertEqual(self.git('rev-parse', 'HEAD').strip(), self.base)
        self.assertFalse((self.repo / 'hook-change.txt').exists())

    def test_quota_delay_uses_metadata_from_multiple_error_events(self):
        events = '\n'.join([json.dumps({'type':'error', 'message':'usage_limit_reached', 'retry_after_seconds':3}),
                            json.dumps({'type':'turn.failed', 'error':{'message':'usage_limit_reached'}})])
        self.assertEqual(self.runner.quota_delay(events, 900), 3)

    def test_cleanup_kills_descendant_even_after_leader_exits(self):
        leader_code = "import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-c',\"import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); print('ready',flush=True); time.sleep(60)\"],stdout=subprocess.PIPE,text=True); p.stdout.readline(); print(p.pid,flush=True); time.sleep(60)"
        leader = subprocess.Popen([sys.executable, '-c', leader_code], stdout=subprocess.PIPE, text=True, start_new_session=True)
        try:
            descendant = int(leader.stdout.readline())
            self.runner.stop_child(leader)
            for _ in range(100):
                state = Path(f'/proc/{descendant}/stat')
                if not state.exists() or state.read_text().split()[2] == 'Z':
                    break
                time.sleep(0.01)
            else:
                self.fail('Descendant survived process-group cleanup')
        finally:
            self.runner.stop_child(leader)
            leader.stdout.close()

    def test_malformed_review_value_is_controlled_failure(self):
        with self.assertRaises(self.runner.LoopError):
            self.runner.validate_result({'decision':[], 'summary':'Invalid', 'findings':[]}, review=True)

    def test_auth_error_stops_instead_of_waiting_or_committing(self):
        with self.assertRaises(self.runner.LoopError):
            self.run_loop('auth')
        self.assertEqual(self.git('rev-parse', 'HEAD').strip(), self.base)

    def test_review_findings_are_fixed_and_reviewed_before_commit(self):
        self.assertEqual(self.run_loop('fix', max_tasks=1), 0)
        self.assertEqual(json.loads((self.repo / '.codex-task-loop/fake-calls.json').read_text()), ['implement', 'review', 'implement', 'review'])

    def test_failed_check_rejected_review_and_malformed_review_cannot_commit(self):
        for mode, check in [('approve', 'false'), ('reject', 'true'), ('malformed', 'true')]:
            with self.subTest(mode=mode):
                with self.assertRaises(self.runner.LoopError):
                    self.run_loop(mode, max_tasks=1, check=check, rounds=1)
                self.assertEqual(self.git('rev-parse', 'HEAD').strip(), self.base)
                self.git('reset', '--mixed', 'HEAD')
                for p in self.repo.glob('T*.txt'):
                    p.unlink()
                state = self.repo / '.codex-task-loop/state.json'
                state.unlink(missing_ok=True)

    def test_already_implemented_task_can_be_verified_with_an_empty_completion_commit(self):
        self.assertEqual(self.run_loop('empty', max_tasks=1), 0)
        self.assertEqual(self.git('rev-parse', 'HEAD^{tree}'), self.git('rev-parse', f'{self.base}^{{tree}}'))
        self.assertIn('UMLith-Task: T001', self.git('log', '-1', '--format=%B'))
        self.assertIn('- [x] Implement the fixture.', (self.tasks / '01-phase/T001-fixture.md').read_text())

    def test_secret_file_blocks_commit_without_discarding_candidate(self):
        with self.assertRaises(self.runner.LoopError):
            self.run_loop('secret', max_tasks=1)
        self.assertEqual(self.git('rev-parse', 'HEAD').strip(), self.base)
        self.assertTrue((self.repo / 'auth.json').exists())

    def test_read_only_reviewer_mutation_invalidates_approval(self):
        with self.assertRaises(self.runner.LoopError):
            self.run_loop('mutating-review', max_tasks=1)
        self.assertEqual(self.git('rev-parse', 'HEAD').strip(), self.base)

    def test_unrelated_dirty_worktree_cannot_be_adopted(self):
        (self.repo / 'base.txt').write_text('someone else edited this')
        with self.assertRaises(self.runner.LoopError):
            self.run_loop(max_tasks=1)
        self.assertFalse((self.repo / '.codex-task-loop/fake-calls.json').exists())

    def test_missing_dependency_and_duplicate_task_ids_are_rejected(self):
        self.card('T000', 1, 'T099')
        with self.assertRaises(self.runner.LoopError):
            self.run_loop(max_tasks=1)
        (self.tasks / '01-phase/T000-fixture.md').unlink()
        duplicate = self.tasks / '02-phase'
        duplicate.mkdir()
        (duplicate / 'T001-duplicate.md').write_text('# T001: Duplicate\n**Phase:** 2 — Fixture\n')
        with self.assertRaises(self.runner.LoopError):
            self.run_loop(max_tasks=1)

    def test_quota_classifier_ignores_context_window_and_successful_token_usage(self):
        self.assertIsNone(self.runner.quota_delay('context window exceeded', 900))
        self.assertIsNone(self.runner.quota_delay('tokens used: 5000', 900))
        self.assertEqual(self.runner.quota_delay('Usage limit reached. Try again in 2 hours 5 minutes.', 900), 7500)
        self.assertEqual(self.runner.quota_delay('rate_limit_exceeded', 900), 900)
        self.assertEqual(self.runner.quota_delay(json.dumps({'message':'usage_limit_reached', 'retry_after_seconds':123}), 900), 123)


if __name__ == '__main__':
    unittest.main()
