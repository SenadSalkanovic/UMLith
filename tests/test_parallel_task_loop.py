"""Parallel CLI behavior against disposable Git repositories; no model calls."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import threading
import time
import unittest
from unittest.mock import patch

import test_task_loop as fixtures
from test_task_loop import FAKE_CODEX, FAKE_AGY

MODULE = Path(__file__).resolve().parents[1] / 'scripts/parallel_task_loop.py'


class ParallelTests(unittest.TestCase):
    setUp = fixtures.TaskLoopTests.setUp
    tearDown = fixtures.TaskLoopTests.tearDown
    git = fixtures.TaskLoopTests.git
    card = fixtures.TaskLoopTests.card

    def parallel(self, mode='approve', limit=2, rounds=3, check='true'):
        spec=importlib.util.spec_from_file_location('parallel_loop',MODULE)
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        codex=self.repo/'.git/fake-codex';codex.write_text(FAKE_CODEX);codex.chmod(0o700)
        agy=self.repo/'.git/fake-agy';agy.write_text(FAKE_AGY);agy.chmod(0o700)
        args=self.runner.parse_args(['--repo',str(self.repo),'--workers','codex,agy',
            '--codex',str(codex),'--agy',str(agy),'--secret-command',str(self.scanner),
            '--check',check,'--max-tasks',str(limit),'--max-fix-rounds',str(rounds),'--quota-wait','0.001'])
        with patch.dict(os.environ,{'FAKE_MODE':mode}):
            return module.run_parallel(args,self.runner)

    def independent(self):
        self.card('T004',1)

    def test_two_isolated_workers_commit_without_duplicates_and_restart(self):
        self.independent()
        self.assertEqual(self.parallel(),0)
        done=self.runner.completed_tasks(self.repo)
        self.assertEqual(done,{'T001','T004'})
        self.assertEqual(self.git('status','--porcelain').strip(),'')
        self.assertEqual(self.parallel(limit=1),0)
        self.assertEqual(self.runner.completed_tasks(self.repo),{'T001','T002','T004'})
        self.assertEqual(self.git('rev-list','--count','HEAD').strip(),'4')
        self.assertNotIn('docs/',self.git('ls-files'))
        workers=self.repo/'.codex-task-loop/worktrees'
        self.assertTrue((workers/'codex').exists())
        self.assertTrue((workers/'agy').exists())

    def test_both_implementations_start_before_either_finishes(self):
        self.independent()
        barrier = self.repo / '.git' / 'barrier'
        barrier.mkdir()
        gate = '''
    import time
    barrier=pathlib.Path(os.environ['FAKE_BARRIER'])
    (barrier/task).write_text(str(time.monotonic()))
    deadline=time.monotonic()+3
    while len(list(barrier.iterdir())) < 2 and time.monotonic() < deadline: time.sleep(.01)
    assert len(list(barrier.iterdir())) >= 2, 'workers did not overlap'
'''
        with patch.dict(os.environ,{'FAKE_BARRIER':str(barrier)}), patch('test_parallel_task_loop.FAKE_CODEX',FAKE_CODEX.replace("    (root / (task + '.txt')).write_text",gate+"    (root / (task + '.txt')).write_text",1)), patch('test_parallel_task_loop.FAKE_AGY',FAKE_AGY.replace("    (root/(task+'.txt')).write_text",gate+"    (root/(task+'.txt')).write_text",1)):
            self.assertEqual(self.parallel(),0)
        self.assertEqual({p.name for p in barrier.iterdir()},{'T001','T004'})

    def test_publication_recovery_after_head_and_completion_card_updated(self):
        original = self.runner.atomic_json
        injected = False
        def interrupted(path,value):
            nonlocal injected
            if path.name=='parallel.json' and value.get('head')!=self.base and not value.get('publishing') and not injected:
                injected=True
                raise OSError('Simulated crash after commit and task-card update')
            original(path,value)
        with patch.object(self.runner,'atomic_json',interrupted),self.assertRaises(OSError):
            self.parallel(limit=1)
        commit=self.git('rev-parse','HEAD').strip()
        self.assertEqual(self.parallel(limit=1),0)
        self.assertIn(commit,self.git('log','--format=%H'))
        self.assertEqual(self.git('rev-list','--count','HEAD').strip(),'3')

    def test_interrupted_migration_resumes_from_its_copied_candidate(self):
        (self.repo/'pending.txt').write_text('keep this');self.git('add','pending.txt')
        private=self.repo/'.codex-task-loop';private.mkdir(mode=0o700)
        self.runner.atomic_json(private/'state.json',{'task':'T001','base':self.base,'plan_hash':self.runner.plan_hash(self.tasks),'checks':['true']})
        original=self.runner.git
        def interrupted(repo,*args,**kwargs):
            if repo==self.repo and args[0]=='restore': raise OSError('Simulated crash during migration')
            return original(repo,*args,**kwargs)
        with patch.object(self.runner,'git',interrupted),self.assertRaises(OSError): self.parallel(limit=1)
        self.assertEqual((self.repo/'pending.txt').read_text(),'keep this')
        self.assertEqual(self.parallel(limit=1),0)
        self.assertEqual((self.repo/'pending.txt').read_text(),'keep this')

    def test_dependent_task_is_not_dispatched_until_prerequisite_commits(self):
        self.assertEqual(self.parallel(),0)
        commits=self.git('log','--reverse','--format=%B')
        self.assertLess(commits.index('UMLith-Task: T001'),commits.index('UMLith-Task: T002'))

    def test_review_rejection_or_failed_check_cannot_publish(self):
        with self.assertRaises(self.runner.LoopError): self.parallel('reject',limit=1,rounds=1)
        self.assertEqual(self.git('rev-parse','HEAD').strip(),self.base)
        self.assertEqual(self.parallel(limit=1),0)
        self.assertIn('T001',self.runner.completed_tasks(self.repo))

    def test_failed_check_or_secret_scan_cannot_publish(self):
        with self.assertRaises(self.runner.LoopError): self.parallel(limit=1,rounds=1,check='false')
        self.assertEqual(self.git('rev-parse','HEAD').strip(),self.base)
        with self.assertRaises(self.runner.LoopError): self.parallel('secret',limit=1)
        self.assertEqual(self.git('rev-parse','HEAD').strip(),self.base)

    def test_single_worker_mode_refuses_pending_parallel_work(self):
        with self.assertRaises(self.runner.LoopError): self.parallel('reject',limit=1,rounds=1)
        args=self.runner.parse_args(['--repo',str(self.repo),'--check','true'])
        with self.assertRaisesRegex(self.runner.LoopError,'Pending parallel work'):
            self.runner.run(args)

    def test_pending_serial_candidate_moves_without_loss_or_false_completion(self):
        path=self.repo/'pending.txt';path.write_text('unfinished candidate\n');self.git('add','pending.txt')
        private=self.repo/'.codex-task-loop';private.mkdir(mode=0o700)
        state={'task':'T001','base':self.base,'plan_hash':self.runner.plan_hash(self.tasks),'feedback':'Preserve partial work','checks':['true']}
        self.runner.atomic_json(private/'state.json',state)
        with self.assertRaises(self.runner.LoopError): self.parallel('auth',limit=1)
        self.assertEqual(self.git('rev-parse','HEAD').strip(),self.base)
        self.assertEqual(self.git('status','--porcelain').strip(),'')
        self.assertEqual((private/'worktrees/codex/pending.txt').read_text(),'unfinished candidate\n')
        self.assertEqual(self.runner.load_json(private/'state.json',None),{})
        self.assertEqual(self.parallel(limit=1),0)
        self.assertEqual(path.read_text(),'unfinished candidate\n')

    def test_unowned_dirty_files_stop_without_discarding_them(self):
        (self.repo/'personal.txt').write_text('keep me')
        with self.assertRaises(self.runner.LoopError): self.parallel()
        self.assertEqual((self.repo/'personal.txt').read_text(),'keep me')
        self.assertEqual(self.git('rev-parse','HEAD').strip(),self.base)

    def test_staged_deletion_migrates_and_keeps_main_clean(self):
        self.git('rm','-q','base.txt')
        private=self.repo/'.codex-task-loop';private.mkdir(mode=0o700)
        self.runner.atomic_json(private/'state.json',{'task':'T001','base':self.base,'plan_hash':self.runner.plan_hash(self.tasks),'checks':['true']})
        self.assertEqual(self.parallel(limit=1),0)
        self.assertFalse((self.repo/'base.txt').exists())
        self.assertEqual(self.git('status','--porcelain').strip(),'')

    def test_main_change_after_review_requires_fresh_checks_and_review(self):
        self.independent();self.parallel()
        reviews=0
        for engine in ('codex','agy'):
            path=self.repo/f'.codex-task-loop/worktrees/{engine}/.codex-task-loop/fake-calls.json'
            reviews+=json.loads(path.read_text()).count('review')
        self.assertGreaterEqual(reviews,3)

    def test_workers_repair_whitespace_before_publishing(self):
        self.independent()
        self.assertEqual(self.parallel('whitespace-fix'),0)
        self.assertEqual(self.runner.completed_tasks(self.repo),{'T001','T004'})
        self.assertEqual(self.git('diff','--cached','--check'),'')

    def test_quota_worker_and_second_worker_both_finish(self):
        self.independent()
        original=self.runner.wait_for_quota
        observed=[]
        def wait_for_other_worker(seconds,state,path):
            if state['task']=='T001':
                deadline=time.monotonic()+3
                while 'T004' not in self.runner.completed_tasks(self.repo) and time.monotonic()<deadline:
                    time.sleep(.01)
                self.assertIn('T004',self.runner.completed_tasks(self.repo))
                observed.append('independent commit during quota wait')
            original(seconds,state,path)
        with patch.object(self.runner,'wait_for_quota',wait_for_other_worker):
            self.assertEqual(self.parallel('quota'),0)
        self.assertTrue(observed)
        self.assertEqual(self.runner.completed_tasks(self.repo),{'T001','T004'})

    def test_cancellation_wakes_quota_waits_and_retains_pending_jobs(self):
        self.independent()
        timer=threading.Timer(.4,self.runner.cancel_children)
        timer.start()
        try:
            with patch('test_parallel_task_loop.FAKE_CODEX',FAKE_CODEX.replace("'retry_after_seconds': 0","'retry_after_seconds': 60")),patch('test_parallel_task_loop.FAKE_AGY',FAKE_AGY.replace("'retry_after_seconds':0","'retry_after_seconds':60")),self.assertRaises(self.runner.LoopError):
                self.parallel('quota')
        finally:
            timer.cancel();timer.join()
        self.assertEqual(self.git('rev-parse','HEAD').strip(),self.base)
        self.assertEqual(self.runner.CHILDREN,set())
        self.assertTrue(json.loads((self.repo/'.codex-task-loop/parallel.json').read_text())['jobs'])

    def test_worker_manual_correction_after_interrupted_rebase_is_preserved(self):
        self.independent()
        original=self.runner.git
        def interrupted(repo,*args,**kwargs):
            if args[:2]==('read-tree','--reset'): raise OSError('Simulated rebase interruption')
            return original(repo,*args,**kwargs)
        with patch.object(self.runner,'git',interrupted),self.assertRaises(OSError): self.parallel()
        journal=json.loads((self.repo/'.codex-task-loop/parallel.json').read_text())
        engine,task=next(iter(journal['jobs'].items()))
        correction=self.repo/f'.codex-task-loop/worktrees/{engine}/{task}.txt'
        correction.write_text('manual correction')
        with self.assertRaises(self.runner.LoopError): self.parallel(limit=1)
        self.assertEqual(correction.read_text(),'manual correction')

    def test_merge_conflict_retains_second_candidate_and_never_overwrites_first(self):
        self.independent()
        conflict="    (root / 'base.txt').write_text(task+'\\n')\n"
        # Both providers change the same original line in independent workspaces.
        with patch('test_parallel_task_loop.FAKE_CODEX',FAKE_CODEX.replace("    (root / (task + '.txt')).write_text('implemented\\n')\n", "    (root / (task + '.txt')).write_text('implemented\\n')\n"+conflict)), patch('test_parallel_task_loop.FAKE_AGY',FAKE_AGY.replace("    (root/(task+'.txt')).write_text('implemented\\n')\n", "    (root/(task+'.txt')).write_text('implemented\\n')\n"+conflict)):
            with self.assertRaises(self.runner.LoopError): self.parallel()
        done=self.runner.completed_tasks(self.repo)
        self.assertEqual(len(done),1)
        self.assertEqual((self.repo/'base.txt').read_text(),next(iter(done))+'\n')


if __name__=='__main__': unittest.main()
