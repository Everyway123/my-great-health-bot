import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('publish', Path(__file__).parents[1] / 'publish.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def gate():
    return dict(schema_version=1, status='approved', base_sha='a'*40, head_sha='b'*40,
                reviewed_sha='b'*40, checks=[dict(name='unit', passed=True)],
                review=dict(verdict='approve', findings=[]), repair_rounds=0,
                backend='codex', requires_human_review=False)


class PublisherTests(unittest.TestCase):
    def test_gate_is_sha_bound_and_fail_closed(self):
        self.assertEqual(p.validate_gate(gate())['head_sha'], 'b'*40)
        for update in ({'reviewed_sha':'c'*40}, {'base_sha':'-bad'}, {'checks':[]},
                       {'checks':[{'name':'test','passed':1}]}, {'requires_human_review':True},
                       {'review':{'verdict':'approve','findings':[{'severity':'P2'}]}},
                       {'status':'blocked'}, {'schema_version':True}):
            with self.subTest(update=update), self.assertRaises(p.Blocked):
                p.validate_gate(dict(gate(), **update))

    def test_protected_paths(self):
        for name in ('.github/x', '.env.production', 'src/auth.py', 'credentials.json',
                     'scripts/agent_orchestrator/runner.py', '.agent-orchestrator.json'):
            with self.subTest(name=name), self.assertRaises(p.Blocked):
                p.validate_paths([name], [])
        p.validate_paths(['src/app.py'], [])
        with self.assertRaises(p.Blocked): p.validate_paths(['infra/file'], ['infra/*'])

    def test_required_check_names_are_exact_and_unique(self):
        policy={'checks':[{'name':'unit'},{'name':'build'}]}
        valid=dict(gate(),checks=[{'name':'unit','passed':True},{'name':'build','passed':True}])
        p.validate_policy_checks(valid,policy)
        for checks in ([{'name':'unit','passed':True}],
                       [{'name':'unit','passed':True},{'name':'unit','passed':True}],
                       [{'name':'unit','passed':True},{'name':'extra','passed':True}]):
            with self.subTest(checks=checks), self.assertRaises(p.Blocked):
                p.validate_policy_checks(dict(gate(),checks=checks),policy)

    def test_manual_review_paths_are_not_publishable(self):
        with self.assertRaises(p.Blocked):
            p.validate_paths(['infra/deploy.yml'], [], ['infra/*'])

    def test_required_database_freeze_without_url_fails_closed(self):
        obj=p.Publisher(Path('.'),'owner/repo')
        obj.require_database_freeze=True
        with patch.dict(os.environ, {}, clear=True), self.assertRaises(p.Blocked):
            obj.ensure_unfrozen()

    def test_task_metacharacters_never_enter_branch(self):
        branch = p.branch_name('$(touch /tmp/pwn); `echo x`', 'b'*40)
        self.assertRegex(branch, r'^agent-orchestrator/[a-z0-9-]+-b{12}$')

    def test_policy_freeze_and_stale_base_block(self):
        class Fake(p.Publisher):
            def gh(self,*args): return 'c'*40
            def run(self,*args,**kwargs): raise AssertionError('no Variables API permitted')
        obj=Fake(Path('.'),'owner/repo'); obj.frozen=True
        with self.assertRaises(p.Blocked): obj.ensure_unfrozen()
        with self.assertRaises(p.Blocked): obj.ensure_current_base('a'*40,'main')

    def test_default_policy_is_unfrozen_but_malformed_fails_closed(self):
        class Fake(p.Publisher):
            def run(self,*args,**kwargs): raise AssertionError('no Variables API permitted')
        obj=Fake(Path('.'),'owner/repo')
        with patch.dict(os.environ,{},clear=True): obj.ensure_unfrozen()
        for value in ('false',0,None,[],{}):
            obj.frozen=value
            with self.subTest(value=value), self.assertRaises(p.Blocked): obj.ensure_unfrozen()

    def test_explicit_base_branch_is_checked_and_used_as_data(self):
        class Fake(p.Publisher):
            def gh(self, *args):
                self.last=args
                return 'a'*40
        obj=Fake(Path('.'), 'owner/repo')
        obj.ensure_current_base('a'*40, 'feature/approved')
        self.assertIn('feature%2Fapproved', obj.last[1])

    def test_publication_rechecks_freeze_and_keeps_task_text_out_of_pr(self):
        with tempfile.TemporaryDirectory() as d:
            source=Path(d)/'source'; source.mkdir()
            def git(*args):
                return subprocess.check_output(['git', '-C', str(source), *args], text=True).strip()
            git('init','-q'); git('config','user.name','Test'); git('config','user.email','test@example.com')
            (source/'.agent-orchestrator.json').write_text('{"protected_paths":[],"checks":[{"name":"unit"}]}')
            (source/'app').write_text('base'); git('add','.'); git('commit','-qm','base'); base=git('rev-parse','HEAD')
            target=Path(d)/'target'; subprocess.check_call(['git','clone','-q',str(source),str(target)])
            (source/'app').write_text('head'); git('commit','-qam','head'); head=git('rev-parse','HEAD')
            bundle=Path(d)/'candidate.bundle'; git('bundle','create',str(bundle),base+'..HEAD')
            task=Path(d)/'task'; task.write_text('$(touch /tmp/malicious); secret task detail')
            class Fake(p.Publisher):
                calls=[]
                base_count=0
                stale_before_pr=False
                policy=None
                database_count=0
                database_freeze_second=False
                def run(self, command, required=True):
                    self.calls.append(command)
                    if command[0]=='git' and 'show' in command and self.policy is not None:
                        return subprocess.CompletedProcess(command,0,json.dumps(self.policy),'')
                    if command[0]=='psql':
                        self.database_count+=1
                        value='BEGIN\nt\nROLLBACK' if self.database_freeze_second and self.database_count==2 else 'BEGIN\nf\nROLLBACK'
                        return subprocess.CompletedProcess(command,0,value,'')
                    if command[0]=='gh':
                        if '/statuses/' in command[2]:
                            self.status_body=json.loads(Path(command[-1]).read_text())
                            self.status_bodies=getattr(self,'status_bodies',[])+[self.status_body]
                            value='{}'
                        elif command[1]=='pr':
                            self.body=Path(command[-1]).read_text()
                            value='https://github.com/owner/repo/pull/123'
                        elif '/variables/' in command[2]: raise AssertionError('Variables permission must not be required')
                        elif '/commits/' in command[2]:
                            self.base_count+=1
                            value='c'*40 if self.stale_before_pr and self.base_count==3 else base
                        else: value='main'
                        return subprocess.CompletedProcess(command,0,value,'')
                    if 'ls-remote' in command or 'push' in command:
                        return subprocess.CompletedProcess(command,0,'','')
                    return super().run(command,required)
            g=dict(gate(),base_sha=base,head_sha=head,reviewed_sha=head)
            obj=Fake(target,'owner/repo')
            self.assertEqual(obj.publish(bundle,g,task,'$(echo task)', 'https://github.com/owner/repo/actions/runs/123')['pr_url'], 'https://github.com/owner/repo/pull/123')
            self.assertEqual(obj.base_count,3)
            remote_preflight=next(c for c in obj.calls if c[0]=='git' and 'ls-remote' in c)
            self.assertIn('credential.helper=!gh auth git-credential',remote_preflight)
            self.assertEqual(obj.status_body['state'],'success')
            self.assertEqual([body['context'] for body in obj.status_bodies],['agent-orchestrator/human-release','agent-orchestrator/review'])
            self.assertNotIn('secret',json.dumps(obj.status_body))
            status_index=next(i for i,c in enumerate(obj.calls) if c[0]=='gh' and '/statuses/' in c[2])
            pr_index=next(i for i,c in enumerate(obj.calls) if c[:2]==['gh','pr'])
            self.assertLess(status_index,pr_index)
            self.assertNotIn('secret task detail',obj.body)
            self.assertNotIn('$(touch',str(obj.calls))
            nondefault=Fake(target,'owner/repo'); nondefault.calls=[]
            nondefault.publish(bundle,g,task,'other', 'https://github.com/owner/repo/actions/runs/123','feature')
            self.assertEqual([body['context'] for body in nondefault.status_bodies],['agent-orchestrator/nondefault-human-release','agent-orchestrator/nondefault-review'])
            obj=Fake(target,'owner/repo'); obj.calls=[]; obj.stale_before_pr=True
            with self.assertRaises(p.Blocked): obj.publish(bundle,g,task,'id','https://github.com/owner/repo/actions/runs/123')
            self.assertFalse(any(c[:2]==['gh','pr'] for c in obj.calls))
            for frozen in (True,'false',0,None):
                obj=Fake(target,'owner/repo'); obj.calls=[]; obj.policy={'checks':[{'name':'unit'}],'frozen':frozen}
                with self.subTest(frozen=frozen), self.assertRaises(p.Blocked): obj.publish(bundle,g,task,'policy','https://github.com/owner/repo/actions/runs/123')
                self.assertFalse(any(c[0]=='git' and 'push' in c for c in obj.calls))
            obj=Fake(target,'owner/repo'); obj.calls=[]; obj.policy={'checks':[{'name':'unit'}],'require_database_freeze':True}; obj.database_freeze_second=True
            with patch.dict(os.environ,{'DATABASE_URL':'postgresql://dummy:dummy@127.0.0.1:1/dummy'}), self.assertRaises(p.Blocked):
                obj.publish(bundle,g,task,'db-twice','https://github.com/owner/repo/actions/runs/123')
            self.assertEqual(obj.database_count,2)
            self.assertFalse(any(c[:2]==['gh','pr'] for c in obj.calls))
            class RequiredDatabase(Fake):
                def run(self, command, required=True):
                    if command[0]=='git' and 'show' in command:
                        return subprocess.CompletedProcess(command,0,json.dumps({'checks':[{'name':'unit'}], 'require_database_freeze':True}),'')
                    return super().run(command,required)
            obj=RequiredDatabase(target,'owner/repo'); obj.calls=[]
            with patch.dict(os.environ, {}, clear=True), self.assertRaises(p.Blocked):
                obj.publish(bundle,g,task,'db','https://github.com/owner/repo/actions/runs/123')
            self.assertFalse(any(c[0]=='git' and 'push' in c for c in obj.calls))


    def test_subprocess_failure_diagnostics_include_only_allowlisted_operation(self):
        obj=p.Publisher(Path('.'),'owner/repo')
        for command,label in [(['git','-c','credential.helper=private-key','ls-remote','https://user:secret@example.com/repo'],'git ls-remote'),(['gh','api','private-repository','--input','private-file'],'gh api'),(['psql','private-database-url'],'psql')]:
            result=subprocess.CompletedProcess(command,1,'private-output','private-error')
            with patch.object(p.subprocess,'run',return_value=result), self.assertRaises(p.Blocked) as error: obj.run(command)
            self.assertIn(label,str(error.exception)); self.assertNotIn('private',str(error.exception)); self.assertNotIn('secret',str(error.exception))

    def test_database_uri_decoded_to_scoped_pg_environment(self):
        obj=p.Publisher(Path('.'),'owner/repo')
        uri='postgresql://u%40ser:p%3Aa%2Fss@127.0.0.1:1/db%20name?sslmode=require&channel_binding=require&connect_timeout=2'
        original={'DATABASE_URL':uri,'PGHOST':'old-host','PGPASSWORD':'old-password','PGSERVICE':'old-service'}
        result=subprocess.CompletedProcess([],0,'BEGIN\nf\nROLLBACK','')
        with patch.dict(os.environ,original,clear=True), patch.object(p.subprocess,'run',return_value=result) as run:
            obj.ensure_unfrozen(); args=run.call_args.args[0]; env=run.call_args.kwargs['env']
            self.assertEqual((env['PGHOST'],env['PGPORT'],env['PGUSER'],env['PGPASSWORD'],env['PGDATABASE']),('127.0.0.1','1','u@ser','p:a/ss','db name'))
            self.assertEqual((env['PGSSLMODE'],env['PGCHANNELBINDING'],env['PGCONNECT_TIMEOUT']),('require','require','2'))
            self.assertNotIn('PGSERVICE',env); self.assertNotIn(uri,str(args)); self.assertNotIn('p:a/ss',str(args))
            self.assertEqual(dict(os.environ),original)
    def test_database_uri_malformed_fails_closed_without_details(self):
        obj=p.Publisher(Path('.'),'owner/repo')
        for uri in ('not-a-uri','https://dummy:private@host/db','postgresql://u:p@host:0/db','postgresql://u:p@host:notaport/db','postgresql://u:p@host/db?unknown=private','postgresql://u:p@host/db?connect_timeout=9999'):
            with patch.dict(os.environ,{'DATABASE_URL':uri}), self.subTest(uri=uri), self.assertRaises(p.Blocked) as error:
                obj.ensure_unfrozen()
            self.assertEqual(str(error.exception),'invalid database connection configuration')
    def test_real_psql_uses_remote_endpoint_not_local_socket(self):
        import shutil
        if not shutil.which('psql'): self.skipTest('optional psql transport probe: psql unavailable')
        actual=subprocess.run; records=[]
        def transport(*args,**kwargs):
            result=actual(*args,**kwargs); records.append(result); return result
        obj=p.Publisher(Path('.'),'owner/repo')
        with patch.dict(os.environ,{'DATABASE_URL':'postgresql://dummy:dummy@127.0.0.1:1/dummy?connect_timeout=1'}), patch.object(p.subprocess,'run',side_effect=transport), self.assertRaises(p.Blocked): obj.ensure_unfrozen()
        self.assertIn('127.0.0.1',records[0].stderr); self.assertNotIn('/tmp/.s.PGSQL',records[0].stderr)
        self.assertNotIn('postgresql://',str(records[0].args))

    def test_real_bundle_import_matches_head(self):
        with tempfile.TemporaryDirectory() as d:
            source=Path(d)/'source'; source.mkdir()
            def git(*args):
                return subprocess.check_output(['git', '-C', str(source), *args], text=True).strip()
            git('init','-q'); git('config','user.name','Test'); git('config','user.email','test@example.com')
            (source/'a').write_text('base'); git('add','.'); git('commit','-qm','base'); base=git('rev-parse','HEAD')
            (source/'a').write_text('head'); git('commit','-qam','head'); head=git('rev-parse','HEAD')
            bundle=Path(d)/'candidate.bundle'; git('bundle','create',str(bundle),base+'..HEAD')
            target=Path(d)/'target'; subprocess.check_call(['git','clone','-q',str(source),str(target)])
            obj=p.Publisher(target,'owner/repo')
            obj.import_bundle(bundle, base, head)
            with self.assertRaises(p.Blocked): obj.import_bundle(bundle,base,'f'*40)

if __name__ == '__main__': unittest.main()
