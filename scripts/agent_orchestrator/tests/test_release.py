import importlib.util,unittest
from pathlib import Path
from unittest.mock import patch
import sys
sys.path.insert(0,str(Path(__file__).parents[1]))
spec=importlib.util.spec_from_file_location('release',Path(__file__).parents[1]/'release.py');r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
REPO='owner/repo';HEAD='b'*40;BASE='a'*40;URL='https://github.com/owner/repo/actions/runs/123'
class ReleaseTests(unittest.TestCase):
 def responses(self):return [{'type':'User'},{'permission':'write'},[{'context':'agent-orchestrator/review','state':'success','target_url':URL,'creator':{'login':'github-actions[bot]','type':'Bot'}}],{'event':'pull_request_target','path':'.github/workflows/agent-review.yml','pull_requests':[{'number':1,'head':{'sha':HEAD},'base':{'sha':BASE}}]}]
 def test_human_author_can_explicitly_release_after_independent_ai(self):
  with patch.object(r,'api',side_effect=self.responses()),patch.object(r,'validate_target') as target,patch.object(r,'post_status') as post:
   r.release(REPO,1,HEAD,BASE,'owner','approve',URL)
   self.assertEqual(target.call_count,2);self.assertEqual(post.call_args.args[2]['state'],'success')
 def test_actor_decision_ai_provenance_and_staleness_fail_closed(self):
  for response in [ [{'type':'Bot'},{'permission':'admin'},[]], [{'type':'User'},{'permission':'read'},[]], [{'type':'User'},{'permission':'write'},[]], [{'type':'User'},{'permission':'admin'},[{'context':'agent-orchestrator/review','state':'success','creator':{'login':'owner','type':'User'}}]], [{'type':'User'},{'permission':'admin'},[{'context':'agent-orchestrator/review','state':'pending','creator':{'login':'github-actions[bot]','type':'Bot'}}]] ]:
   with patch.object(r,'api',side_effect=response),patch.object(r,'validate_target'),patch.object(r,'post_status') as post,self.assertRaises(ValueError):r.release(REPO,1,HEAD,BASE,'owner','approve',URL)
   post.assert_not_called()
  with patch.object(r,'api') as api,self.assertRaises(ValueError):r.release(REPO,1,HEAD,BASE,'owner','reject',URL)
  api.assert_not_called()
  with patch.object(r,'api',side_effect=self.responses()),patch.object(r,'validate_target',side_effect=[None,ValueError('stale')]),patch.object(r,'post_status') as post,self.assertRaises(ValueError):r.release(REPO,1,HEAD,BASE,'owner','approve',URL)
  post.assert_not_called()

 def test_old_base_wrong_run_or_superseded_ai_never_releases(self):
  cases=[]
  changed=self.responses();changed[3]['pull_requests'][0]['base']['sha']='c'*40;cases.append(changed)
  changed=self.responses();changed[3]['event']='workflow_dispatch';cases.append(changed)
  changed=self.responses();changed[3]['path']='.github/workflows/untrusted.yml';cases.append(changed)
  changed=self.responses();changed[2].insert(0,dict(changed[2][0],state='pending'));cases.append(changed)
  for responses in cases:
   with self.subTest(responses=responses),patch.object(r,'api',side_effect=responses),patch.object(r,'validate_target'),patch.object(r,'post_status') as post,self.assertRaises(ValueError):r.release(REPO,1,HEAD,BASE,'owner','approve',URL)
   post.assert_not_called()
