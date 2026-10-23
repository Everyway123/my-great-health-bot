import contextlib,copy,io,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from scripts.agent_orchestrator import runner
BASE='a'*40;HEAD='b'*40

def manual_report():
 return {'approved':False,'schema_version':1,'status':'blocked','base_sha':BASE,'head_sha':HEAD,'reviewed_sha':HEAD,'checks':[{'name':'unit','passed':True}],'review':{'verdict':'approve','findings':[]},'requires_human_review':True,'reason':'human review required'}

class RunnerExitTests(unittest.TestCase):
 def invoke(self,action,report):
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary);(root/'repo').mkdir();config=root/'config';config.write_text('{}');task=root/'task';task.write_text('review')
   args=['runner.py',action,'--repo',str(root/'repo'),'--config',str(config),'--task-file',str(task),'--output',str(root/'out'),'--base',BASE,'--head',HEAD]
   with patch.object(runner.sys,'argv',args),patch.object(runner.Orchestrator,'run',return_value=report),contextlib.redirect_stdout(io.StringIO()):return runner.main()
 def test_manual_review_passes_job_without_authorizing_publication(self):
  report=manual_report();self.assertEqual(self.invoke('review',report),0)
  self.assertFalse(report['approved']);self.assertEqual(report['status'],'blocked')
  self.assertEqual(self.invoke('run',report),1)
 def test_failed_malformed_or_stale_manual_reviews_fail_job(self):
  for change in ({'checks':[]},{'checks':[{'name':'unit','passed':False}]},{'checks':[{'name':'unit','passed':1}]},{'reviewed_sha':'c'*40},{'base_sha':'c'*40},{'reason':'provider failed'},{'review':{'verdict':'changes_requested','findings':[]}}, {'schema_version':True}):
   with self.subTest(change=change):self.assertEqual(self.invoke('review',dict(manual_report(),**change)),1)
