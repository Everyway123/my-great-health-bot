import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('report_status', Path(__file__).parents[1] / 'report_status.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


def report():
    return dict(schema_version=1, status='approved', head_sha='b'*40, reviewed_sha='b'*40,
                checks=[dict(name='tests',passed=True)], review=dict(verdict='approve', findings=[]),
                requires_human_review=False)


class StatusTests(unittest.TestCase):
    def test_success_only_for_exact_reviewed_head_and_passed_checks(self):
        self.assertEqual(r.status_payload(report(), 'b'*40)['state'],'success')
        for change in ({'status':'blocked'}, {'reviewed_sha':'a'*40}, {'head_sha':'a'*40}, {'checks':[]},
                       {'checks':[dict(name='test',passed=1)]}, {'schema_version':True},
                       {'review':dict(verdict='approve',findings=[dict(severity='P2')])}):
            with self.subTest(change=change):
                self.assertEqual(r.status_payload(dict(report(),**change),'b'*40)['state'],'failure')

    def test_human_review_remains_success_with_explicit_description(self):
        payload=r.status_payload(dict(report(),requires_human_review=True,status='blocked',reason='human review required'),'b'*40)
        self.assertEqual(payload['state'],'success')
        self.assertEqual(payload['description'],'review passed; human approval required')

    def test_missing_or_corrupt_report_posts_failure_without_details(self):
        calls=[]
        def run(command, **kwargs):
            calls.append((command,json.loads(Path(command[-1]).read_text())))
            return subprocess.CompletedProcess(command,0,'{}','')
        with tempfile.TemporaryDirectory() as d, patch.object(r.subprocess,'run',run):
            file=Path(d)/'report'
            for content in (None,'bad secret', '{"checks": "secret"}'):
                if content is not None: file.write_text(content)
                r.publish_status('owner/repo','b'*40,file,'https://github.com/owner/repo/actions/runs/123')
        self.assertEqual(len(calls),3)
        for command,payload in calls:
            self.assertEqual(command[2], 'repos/owner/repo/statuses/'+'b'*40)
            self.assertEqual(payload['state'],'failure')
            self.assertEqual(payload['context'],'agent-orchestrator/review')
            self.assertNotIn('secret',json.dumps(payload))

    def test_invalid_target_never_posts(self):
        with patch.object(r.subprocess,'run') as run:
            for repo,sha,url in [('owner/repo','-bad','https://github.com/owner/repo/actions/runs/123'),
                                 ('owner/repo','b'*40,'https://evil.com/actions/runs/123'),
                                 ('owner/repo','b'*40,'https://github.com/other/repo/actions/runs/123')]:
                with self.assertRaises(ValueError): r.publish_status(repo,sha,'missing',url)
            run.assert_not_called()

if __name__ == '__main__': unittest.main()
