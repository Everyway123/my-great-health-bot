import io,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from scripts.agent_orchestrator.runner import FileTools,Blocked
from scripts.agent_orchestrator.providers import AnthropicProvider

class PagingTests(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory();self.repo=Path(self.temp.name);self.tools=FileTools(self.repo,{},True)
 def tearDown(self):self.temp.cleanup()
 def test_large_list_pages_all_names_without_silent_3000_file_cutoff(self):
  source=self.repo/'src';source.mkdir()
  for number in range(3105):(source/(f'{number:04d}-'+('long-name-'*6)+'.ts')).touch()
  first=self.tools.list();self.assertEqual(first['total'],3105);self.assertEqual(first['returned'],200);self.assertEqual(first['next_offset'],200)
  names=[];offset=0
  while True:
   page=self.tools.list(prefix='src/',offset=offset,limit=2000);names+=page['files']
   self.assertLessEqual(len(json.dumps(page,ensure_ascii=False).encode()),160000)
   if page['next_offset'] is None:break
   offset=page['next_offset']
  self.assertEqual(len(set(names)),3105);self.assertEqual(names,sorted(names))
 def test_unicode_and_large_ascii_reads_continue_with_bounded_json(self):
  for name,content in [('CLAUDE.md','Привіт світ! '*12000),('large.txt','A'*500000),('escaped.txt','\\"'*120000)]:
   (self.repo/name).write_text(content)
   first=self.tools.read(name);self.assertEqual(first['total'],len(content));self.assertEqual(first['returned'],20000)
   chunks=[];offset=0
   while True:
    page=self.tools.read(name,offset=offset,limit=200000);chunks.append(page['content'])
    self.assertLessEqual(len(json.dumps(page,ensure_ascii=False).encode()),160000)
    if page['next_offset'] is None:break
    self.assertGreater(page['next_offset'],offset);offset=page['next_offset']
   self.assertEqual(''.join(chunks),content)
 def test_pagination_path_guards_and_types(self):
  (self.repo/'file').write_text('text');(self.repo/'outside').symlink_to(self.repo.parent)
  for value in (True,-1,1.5,'1',None):
   for function,kwargs in [(self.tools.list,{'offset':value}),(self.tools.read,{'path':'file','offset':value})]:
    with self.assertRaises(Blocked):function(**kwargs)
  for value in (True,-1,0,1.5,'1',None,200001):
   with self.assertRaises(Blocked):self.tools.read('file',limit=value)
  for value in (True,-1,0,1.5,'1',None,2001):
   with self.assertRaises(Blocked):self.tools.list(limit=value)
  for prefix in ('../','/private/tmp','outside/','.git/','.env'):
   with self.assertRaises(Blocked):self.tools.list(prefix=prefix)
  with self.assertRaises(Blocked):self.tools.read('outside/private')
 def test_redaction_happens_before_paging_and_internal_alias_is_protected(self):
  fixture_value='opaque-boundary-token-123456'
  label='API'+'_KEY'
  text='A'*19995+' '+label+'='+chr(34)+fixture_value+chr(34)+' '+'tail'*100
  (self.repo/'file').write_text(text)
  pages=[];offset=0
  while True:
   page=self.tools.read('file',offset=offset,limit=20000);pages.append(page['content'])
   if page['next_offset'] is None:break
   offset=page['next_offset']
  self.assertNotIn(fixture_value,''.join(pages));self.assertIn('[REDACTED]',''.join(pages))
  (self.repo/'.env').write_text('opaque-secret');(self.repo/'alias').symlink_to('.env')
  with self.assertRaises(Blocked):self.tools.read('alias')
  runner=self.repo/'scripts/agent_orchestrator/runner.py';runner.parent.mkdir(parents=True);runner.write_text('protected')
  (self.repo/'runner-alias').symlink_to('scripts/agent_orchestrator/runner.py')
  with self.assertRaises(Blocked):self.tools.write('runner-alias','bad')
  self.assertEqual(runner.read_text(),'protected')
 def test_provider_handles_unicode_paged_tool_results_and_continues(self):
  content='Привіт '*16000;(self.repo/'CLAUDE.md').write_text(content);requests=[]
  responses=[{'stop_reason':'tool_use','content':[{'type':'tool_use','id':'read1','name':'read','input':{'path':'CLAUDE.md','limit':200000}}]},{'stop_reason':'end_turn','content':[{'type':'text','text':'completed'}]}]
  def respond(request,**kwargs):requests.append(json.loads(request.data));return io.StringIO(json.dumps(responses.pop(0)))
  with patch.dict(os.environ,{'ANTHROPIC_API_KEY':'fixture'}),patch('scripts.agent_orchestrator.providers.urllib.request.urlopen',side_effect=respond):
   self.assertEqual(AnthropicProvider({}).author('task',self.tools,None),'completed')
  tool=requests[1]['messages'][-1]['content'][0];self.assertNotIn('is_error',tool)
  self.assertIn('Привіт',tool['content']);self.assertLessEqual(len(tool['content'].encode()),160000)
  page=json.loads(tool['content']);self.assertIsNotNone(page['next_offset'])
