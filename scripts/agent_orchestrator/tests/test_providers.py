import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
from scripts.agent_orchestrator import providers
from scripts.agent_orchestrator.runner import Blocked, FileTools

class ProviderTests(unittest.TestCase):
    def test_keychain_lookup_uses_real_home_only_for_trusted_lookup(self):
        result=subprocess.CompletedProcess([],0,'fixture-private-key\n','')
        with patch.dict(os.environ,{},clear=True), patch.object(providers.sys,'platform','darwin'), patch.object(providers.subprocess,'run',return_value=result) as run:
            self.assertEqual(providers.anthropic_key(),'fixture-private-key')
            self.assertEqual(run.call_args.kwargs['env']['HOME'],str(Path.home()))
    def test_http_error_exposes_status_without_body_or_url(self):
        with patch.dict(os.environ,{'ANTHROPIC_API_KEY':'fixture-key'}), patch.object(providers.urllib.request,'urlopen',side_effect=urllib.error.HTTPError('private-url',401,'private-secret',{},None)):
            with self.assertRaisesRegex(Blocked,'Anthropic HTTP 401') as error:
                providers.AnthropicProvider({}).author('task',FileTools(Path.cwd(),{}),None)
            self.assertNotIn('private',str(error.exception))
    def test_script_entrypoint_preserves_actionable_provider_block(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); repo=root/'repo'; repo.mkdir()
            for args in [['init'],['config','user.name','Test'],['config','user.email','test@example.com']]: subprocess.run(['git','-C',str(repo),*args],capture_output=True,check=True)
            (repo/'file').write_text('base'); subprocess.run(['git','-C',str(repo),'add','.'],check=True); subprocess.run(['git','-C',str(repo),'commit','-m','base'],capture_output=True,check=True)
            task=root/'task'; task.write_text('task'); config=root/'config'; config.write_text('{"schema":1,"test_mode":"docker","checks":[{"name":"check","command":["true"]}]}')
            runner=Path(providers.__file__).with_name('runner.py')
            result=subprocess.run(['python3',str(runner),'run','--repo',str(repo),'--config',str(config),'--task-file',str(task),'--output',str(root/'out'),'--backend','cli','--isolated-candidate'],capture_output=True,text=True)
            self.assertIn('native CLI is disabled',result.stdout)

class StructuredReviewTests(unittest.TestCase):
    def exchange(self,responses):
        import io,json
        requests=[]
        def respond(request,**kwargs):
            requests.append(json.loads(request.data)); return io.StringIO(json.dumps(responses.pop(0)))
        return requests,respond
    def verdict(self): return {'reviewed_sha':'head','decision':'approve','findings':[]}
    def test_review_reads_then_submits_structured_verdict(self):
        requests,respond=self.exchange([
            {'stop_reason':'tool_use','content':[{'type':'tool_use','id':'read1','name':'list','input':{}}]},
            {'stop_reason':'tool_use','content':[{'type':'tool_use','id':'submit1','name':'submit_review','input':self.verdict()}]}])
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ,{'ANTHROPIC_API_KEY':'fixture'}), patch.object(providers.urllib.request,'urlopen',side_effect=respond):
            result=providers.AnthropicProvider({}).review('task',FileTools(temporary,{}),{'head_sha':'head'})
        self.assertEqual(result,self.verdict()); self.assertEqual(len(requests),2)
        self.assertEqual({t['name'] for t in requests[0]['tools']},{'list','read','submit_review'})
        self.assertEqual(requests[1]['messages'][-1]['content'][0]['tool_use_id'],'read1')
    def test_author_can_edit_but_reviewer_cannot(self):
        call={'type':'tool_use','id':'edit1','name':'edit','input':{'path':'app.py','old':'wrong','new':'right'}}
        requests,respond=self.exchange([
            {'stop_reason':'tool_use','content':[call]},
            {'stop_reason':'end_turn','content':[{'type':'text','text':'done'}]}])
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ,{'ANTHROPIC_API_KEY':'fixture'}):
            app=Path(temporary)/'app.py'; app.write_text('keep\nwrong\n')
            with patch.object(providers.urllib.request,'urlopen',side_effect=respond):
                providers.AnthropicProvider({}).author('task',FileTools(temporary,{},True),None)
            self.assertEqual(app.read_text(),'keep\nright\n')
            self.assertIn('edit',{t['name'] for t in requests[0]['tools']})
            _,respond=self.exchange([{'stop_reason':'tool_use','content':[call]}])
            with patch.object(providers.urllib.request,'urlopen',side_effect=respond), self.assertRaises(Blocked):
                providers.AnthropicProvider({}).review('task',FileTools(temporary,{}),{'head_sha':'head'})
    def test_mixed_duplicate_or_malformed_finalization_rejected(self):
        for calls in [
            [{'type':'tool_use','id':'a','name':'submit_review','input':self.verdict()},{'type':'tool_use','id':'b','name':'list','input':{}}],
            [{'type':'tool_use','id':'a','name':'submit_review','input':self.verdict()},{'type':'tool_use','id':'b','name':'submit_review','input':self.verdict()}],
            [{'type':'tool_use','id':'a','name':'submit_review','input':{'decision':'approve'}}]]:
            _,respond=self.exchange([{'stop_reason':'tool_use','content':calls}])
            with patch.dict(os.environ,{'ANTHROPIC_API_KEY':'fixture'}), patch.object(providers.urllib.request,'urlopen',side_effect=respond):
                with self.assertRaises(Blocked): providers.AnthropicProvider({}).review('task',FileTools(Path.cwd(),{}),{'head_sha':'head'})
