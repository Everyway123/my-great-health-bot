import importlib.util,json,subprocess,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('report_status',Path(__file__).parents[1]/'report_status.py'); r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
BASE='a'*40; HEAD='b'*40; REPO='owner/repo'; URL='https://github.com/owner/repo/actions/runs/123'
def report(): return dict(schema_version=1,status='approved',base_sha=BASE,head_sha=HEAD,reviewed_sha=HEAD,checks=[dict(name='tests',passed=True)],review=dict(verdict='approve',findings=[]),requires_human_review=False)
def pr(): return {'state':'open','base':{'sha':BASE,'ref':'main','repo':{'full_name':REPO}},'head':{'sha':HEAD,'repo':{'full_name':REPO}}}
class StatusTests(unittest.TestCase):
 def test_success_requires_exact_base_head_and_checks(self):
  self.assertEqual(r.status_payload(report(),HEAD,BASE)['state'],'success')
  for change in ({'base_sha':'c'*40},{'reviewed_sha':BASE},{'checks':[]},{'status':'blocked'}):
   self.assertEqual(r.status_payload(dict(report(),**change),HEAD,BASE)['state'],'failure')
 def test_sensitive_ai_passes_but_human_release_pending(self):
  sensitive=dict(report(),status='blocked',requires_human_review=True,reason='human review required')
  self.assertEqual(r.status_payload(sensitive,HEAD,BASE)['state'],'success')
  self.assertEqual(r.human_payload(sensitive,HEAD,BASE)['state'],'pending')
  self.assertEqual(r.human_payload(report(),HEAD,BASE)['state'],'success')
  self.assertEqual(r.human_payload({},HEAD,BASE)['state'],'failure')
 def test_live_target_rejects_nondefault_stale_and_crossrepo(self):
  for data in [dict(pr(),state='closed'),dict(pr(),base={'sha':BASE,'ref':'other','repo':{'full_name':REPO}}),dict(pr(),head={'sha':'c'*40,'repo':{'full_name':REPO}}),dict(pr(),base={'sha':'c'*40,'ref':'main','repo':{'full_name':REPO}}),dict(pr(),head={'sha':HEAD,'repo':{'full_name':'attacker/repo'}})]:
   with patch.object(r,'api',side_effect=[{'default_branch':'main'},data]), self.assertRaises(ValueError): r.validate_target(REPO,1,HEAD,BASE)
 def test_post_order_pending_and_final_metadata_verified(self):
  posts=[]
  with tempfile.TemporaryDirectory() as d:
   path=Path(d)/'report';path.write_text(json.dumps(report()))
   with patch.object(r,'validate_target') as target,patch.object(r,'post_status',side_effect=lambda repo,head,payload:posts.append(payload)):
    r.publish_status(REPO,HEAD,path,URL,False,1,BASE)
    target.assert_called_with(REPO,1,HEAD,BASE)
   self.assertEqual([x['context'] for x in posts],[r.HUMAN_CONTEXT,r.CONTEXT]);self.assertTrue(all(x['state']=='success' for x in posts))
   posts.clear()
   with patch.object(r,'validate_target'),patch.object(r,'post_status',side_effect=lambda repo,head,payload:posts.append(payload)):
    r.publish_status(REPO,HEAD,path,URL,True,1,BASE)
   self.assertTrue(all(x['state']=='pending' for x in posts))
 def test_missing_or_corrupt_report_fails_both_gates(self):
  posts=[]
  with patch.object(r,'validate_target'),patch.object(r,'post_status',side_effect=lambda repo,head,payload:posts.append(payload)):
   r.publish_status(REPO,HEAD,'missing',URL,False,1,BASE)
  self.assertEqual([x['state'] for x in posts],['failure','failure'])
 def test_invalid_inputs_never_post(self):
  with patch.object(r,'api') as api:
   for repo,head,base,number in [('bad',HEAD,BASE,1),(REPO,'-bad',BASE,1),(REPO,HEAD,None,1),(REPO,HEAD,BASE,None)]:
    with self.assertRaises(ValueError):r.publish_status(repo,head,'missing',URL,False,number,base)
   api.assert_not_called()
