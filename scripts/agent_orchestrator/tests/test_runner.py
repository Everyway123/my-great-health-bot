import json, subprocess, tempfile, unittest
from pathlib import Path
from scripts.agent_orchestrator.runner import Orchestrator, FileTools, validate_verdict, Blocked

class Provider:
    def __init__(self, decisions=None): self.decisions=iter(decisions or ['approve']); self.authors=0; self.reviews=0
    def author(self, task, tools, feedback):
        self.authors+=1; tools.write('candidate.txt', 'fixed '+str(self.authors))
    def review(self, task, tools, evidence):
        self.reviews+=1
        decision=next(self.decisions)
        return {'reviewed_sha': evidence['head_sha'], 'decision':decision, 'findings': [] if decision=='approve' else [{'severity':'P2','path':'candidate.txt','line':1,'reason':'Incorrect result under empty input; handle empty input.'}]}

class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.root=Path(self.temp.name); self.repo=self.root/'repo'; self.repo.mkdir()
        for args in [['init'], ['config','user.name','Test'], ['config','user.email','test@example.org']]: subprocess.run(['git','-C',str(self.repo),*args],capture_output=True,check=True)
        (self.repo/'file.txt').write_text('base'); subprocess.run(['git','-C',str(self.repo),'add','.'],check=True); subprocess.run(['git','-C',str(self.repo),'commit','-m','base'],capture_output=True,check=True)
        self.config={'schema':1,'checks':[{'name':'check','command':['python3','-c','print("ok")']}], 'setup':[], 'test_mode':'local','max_repair_rounds':2}
    def tearDown(self): self.temp.cleanup()
    def run_loop(self,p): return Orchestrator(self.repo,self.config,self.root/'out',p).run('literal $(touch /tmp/unsafe)',isolated_candidate=True)
    def test_repairs_then_independent_review(self):
        p=Provider(['changes_requested','approve']); r=self.run_loop(p)
        self.assertTrue(r['approved']); self.assertEqual((p.authors,p.reviews),(2,2)); self.assertEqual(r['head_sha'],r['verdict']['reviewed_sha'])
    def test_exhausted_repairs_never_approve(self):
        p=Provider(['changes_requested']*3); self.assertFalse(self.run_loop(p)['approved']); self.assertEqual(p.authors,3)
    def test_failed_check_never_approve(self):
        self.config['checks'][0]['command']=['python3','-c','raise SystemExit(1)']; self.assertFalse(self.run_loop(Provider())['approved'])
    def test_malformed_and_stale_verdict(self):
        for v in [{}, {'reviewed_sha':'old','decision':'approve','findings':[]}]:
            with self.assertRaises(Blocked): validate_verdict(v,'current')
    def test_freeze(self):
        freeze=self.root/'freeze'; freeze.touch(); self.config['freeze_file']=str(freeze); p=Provider(); self.assertFalse(self.run_loop(p)['approved']); self.assertEqual(p.authors,0)
    def test_tools_block_escape_symlinks_and_protected(self):
        t=FileTools(self.repo,self.config,True); (self.repo/'escape').symlink_to(self.root)
        for path in ['../outside','escape/outside','.git/config','.github/workflows/a.yml','.env','src/auth/token.py','scripts/agent_orchestrator/runner.py']:
            with self.assertRaises(Blocked): t.write(path,'bad')
        with self.assertRaises(Blocked): FileTools(self.repo,self.config,False).write('file.txt','bad')
    def test_existing_lock_is_never_removed(self):
        lock=self.repo/'.git'/'agent-orchestrator.lock'; lock.mkdir()
        self.assertFalse(self.run_loop(Provider())['approved']); self.assertTrue(lock.exists())
    def test_changed_head_during_review_blocks(self):
        repo=self.repo
        class Mutating(Provider):
            def review(self,task,tools,evidence):
                (repo/'file.txt').write_text('changed during review')
                return super().review(task,tools,evidence)
        self.assertFalse(self.run_loop(Mutating())['approved'])
    def test_same_provider_is_labeled(self):
        from scripts.agent_orchestrator.providers import CLIProvider
        provider=CLIProvider({'author_cli':'codex','reviewer_cli':'codex'})
        self.assertEqual(provider.separation,'UNSAFE local CLI; same-provider clean-context fallback')
    def test_review_only_protected_change_requires_human(self):
        base=subprocess.check_output(['git','-C',str(self.repo),'rev-parse','HEAD'],text=True).strip()
        (self.repo/'.github').mkdir(); (self.repo/'.github'/'workflow.yml').write_text('candidate')
        subprocess.run(['git','-C',str(self.repo),'add','.'],check=True)
        subprocess.run(['git','-C',str(self.repo),'commit','-m','infra'],capture_output=True,check=True)
        p=Provider(); r=Orchestrator(self.repo,self.config,self.root/'out',p).run('review',True,base)
        self.assertEqual(p.reviews,1); self.assertTrue(r['requires_human_review']); self.assertFalse(r['approved'])
    def test_secrets_are_redacted_from_reads_and_diff(self):
        from scripts.agent_orchestrator.runner import redact
        self.assertNotIn('sk-ant-api03-'+'a'*30, redact('key: sk-ant-api03-'+'a'*30))
        (self.repo/'file.txt').write_text('API_KEY="supersecretvalue123"')
        self.assertNotIn('supersecretvalue123',FileTools(self.repo,self.config).read('file.txt'))
    def test_review_rejects_truncated_non_schema_and_false_approval(self):
        for verdict in ['',[],{'reviewed_sha':'head','decision':'approve','findings':[{'severity':'P1','path':'x','line':1,'reason':'bug'}]}]:
            with self.assertRaises(Blocked): validate_verdict(verdict,'head')
    def test_unisolated_default_branch_never_calls_author(self):
        p=Provider(); before=subprocess.check_output(['git','-C',str(self.repo),'rev-parse','HEAD'],text=True)
        r=Orchestrator(self.repo,self.config,self.root/'out',p).run('task')
        self.assertFalse(r['approved']); self.assertEqual(p.authors,0)
        self.assertEqual(before,subprocess.check_output(['git','-C',str(self.repo),'rev-parse','HEAD'],text=True))
    def test_cli_requires_explicit_unsafe_opt_in(self):
        from scripts.agent_orchestrator.providers import CLIProvider
        with self.assertRaisesRegex(Blocked,'native CLI is disabled'): CLIProvider({}).author('task',FileTools(self.repo,self.config,True),None)
    def test_local_check_blocks_sibling_read_and_external_write(self):
        sibling=self.root/'private-secret'; sibling.write_text('private secret')
        outside=self.root/'outside-write'
        self.config['checks']=[{'name':'read denied','command':['python3','-c','from pathlib import Path; Path('+repr(str(sibling))+').read_text()']}, {'name':'write denied','command':['python3','-c','from pathlib import Path; Path('+repr(str(outside))+').write_text("bad")']}]
        results=Orchestrator(self.repo,self.config,self.root/'out',Provider()).checks()
        self.assertEqual([x['passed'] for x in results],[False,False]); self.assertFalse(outside.exists())
    def test_diff_excludes_forbidden_secret_contents_and_requires_human(self):
        base=subprocess.check_output(['git','-C',str(self.repo),'rev-parse','HEAD'],text=True).strip()
        (self.repo/'credentials.json').write_text('{"opaque":"randomOpaqueValueBeyondRegex"}')
        (self.repo/'secrets').mkdir(); (self.repo/'secrets'/'private.txt').write_text('anotherOpaquePrivateValue')
        (self.repo/'file.txt').write_text('normal change')
        subprocess.run(['git','-C',str(self.repo),'add','.'],check=True); subprocess.run(['git','-C',str(self.repo),'commit','-m','secret change'],capture_output=True,check=True)
        head=subprocess.check_output(['git','-C',str(self.repo),'rev-parse','HEAD'],text=True).strip()
        diff=FileTools(self.repo,self.config).diff(base,head)
        self.assertIn('normal change',diff); self.assertNotIn('randomOpaqueValueBeyondRegex',diff); self.assertNotIn('anotherOpaquePrivateValue',diff)
        class Inspect(Provider):
            def review(inner,task,tools,evidence):
                self.assertNotIn('randomOpaqueValueBeyondRegex',evidence['diff'])
                return super(Inspect,inner).review(task,tools,evidence)
        r=Orchestrator(self.repo,self.config,self.root/'out',Inspect()).run('review',True,base,head)
        self.assertFalse(r['approved']); self.assertTrue(r['requires_human_review'])
    def test_freeze_nonfalse_values_fail_closed(self):
        from unittest.mock import patch
        for value in ['true','yes','unexpected',' 1 ']:
            with patch.dict('os.environ',{'AGENT_ORCHESTRATOR_FREEZE':value}):
                p=Provider(); self.assertFalse(self.run_loop(p)['approved']); self.assertEqual(p.authors,0)
    def test_trusted_policy_freeze_blocks_new_tasks_and_malformed_values(self):
        for value in (True,'false',0,None):
            self.config['frozen']=value
            p=Provider(); result=self.run_loop(p)
            self.assertFalse(result['approved']); self.assertEqual(p.authors,0)
    def test_provider_failure_fails_closed(self):
        class Broken(Provider):
            def review(self,*args): raise RuntimeError('provider unavailable')
        self.assertFalse(self.run_loop(Broken())['approved'])

if __name__=='__main__': unittest.main()
