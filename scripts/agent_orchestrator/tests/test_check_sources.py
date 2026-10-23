import json,subprocess,tempfile,unittest
from pathlib import Path
from scripts.agent_orchestrator.runner import Orchestrator,FileTools,Blocked

class CheckSourceTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.repo=self.root/'repo';self.repo.mkdir()
  subprocess.run(['git','init','-q',str(self.repo)],check=True)
  self.paths=['lib/auth/cron-secret.ts','lib/auth/cron-secret.test.ts']
  for name in self.paths:
   file=self.repo/name;file.parent.mkdir(parents=True,exist_ok=True);file.write_text('export const fixture = process.env.CRON_SECRET;\n')
  (self.repo/'lib/auth/other-secret.ts').write_text('export const unused = 1;\n')
  (self.repo/'.env').write_text('fixture-env-private');(self.repo/'credentials.key').write_text('fixture-key-private')
  subprocess.run(['git','-C',str(self.repo),'add','--all'],check=True)
  self.config={'schema':1,'test_mode':'local','setup':[],'checks':[{'name':'source-copy','command':['python3','-c','from pathlib import Path; assert not Path(".env").exists(); assert not Path("credentials.key").exists(); assert not Path("lib/auth/other-secret.ts").exists(); assert Path("lib/auth/cron-secret.ts").exists(); assert Path("lib/auth/cron-secret.test.ts").exists()']}]}
 def tearDown(self):self.temp.cleanup()
 def checks(self):return Orchestrator(self.repo,self.config,self.root/'out',None).checks()
 def test_excludes_by_default_but_exact_tracked_sources_allow_checks(self):
  self.assertFalse(self.checks()[0]['passed'])
  self.config['check_source_paths']=self.paths
  self.assertTrue(self.checks()[0]['passed'])
  tools=FileTools(self.repo,self.config,True)
  for path in self.paths:
   with self.assertRaises(Blocked):tools.read(path)
   with self.assertRaises(Blocked):tools.write(path,'bad')
  self.assertFalse(any('secret' in path for path in tools.list()['files']))
 def test_invalid_policy_and_credential_blobs_fail_closed(self):
  for value in (None,{},'lib/auth/cron-secret.ts',[True],self.paths+self.paths,['/outside.ts'],['../outside.ts'],['lib/../outside.ts'],['.git/config.ts'],['lib/.env/helper.ts'],['.env'],['credentials.key'],['credentials.json'],['lib/*.ts'],['lib//source.ts']):
   self.config['check_source_paths']=value
   with self.subTest(value=value),self.assertRaises(Blocked):self.checks()
 def test_missing_untracked_symlink_and_outside_sources_fail_closed(self):
  outside=self.root/'outside.ts';outside.write_text('outside fixture')
  (self.repo/'untracked-secret.ts').write_text('untracked fixture')
  (self.repo/'linked-secret.ts').symlink_to(outside)
  subprocess.run(['git','-C',str(self.repo),'add','linked-secret.ts'],check=True)
  for path in ('missing-secret.ts','untracked-secret.ts','linked-secret.ts'):
   self.config['check_source_paths']=[path]
   with self.subTest(path=path),self.assertRaises(Blocked):self.checks()
