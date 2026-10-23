import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from scripts.agent_orchestrator.runner import local_check

@unittest.skipUnless(sys.platform=='darwin','macOS seatbelt integration')
class SandboxTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='agent-probe-',dir='/private/tmp'); self.copy=Path(self.temp.name)
    def tearDown(self): self.temp.cleanup()
    def test_child_worker_lifecycle_and_external_signal_denial(self):
        child=local_check(['python3','-c','import subprocess; p=subprocess.Popen(["/bin/sleep","2"]); p.terminate(); p.wait(timeout=3)'],self.copy)
        self.assertEqual(child.returncode,0,child.stderr)
        outside=subprocess.Popen(['/bin/sleep','20'])
        try:
            result=local_check(['python3','-c',f'import os,signal; os.kill({outside.pid},signal.SIGTERM)'],self.copy)
            self.assertNotEqual(result.returncode,0); self.assertIsNone(outside.poll())
        finally: outside.terminate(); outside.wait()
    def test_keychain_credential_lookup_denied(self):
        result=local_check(['/usr/bin/security','find-generic-password','-s','agent-orchestrator-anthropic','-w'],self.copy)
        # Never include output, which could contain a credential if the policy regressed.
        self.assertNotEqual(result.returncode,0)
    def test_cannot_read_outside_fixture_process_environment(self):
        import json
        sentinel='ORCHESTRATOR_DUMMY_SENTINEL=fixture-only-no-real-secret'
        fixture=subprocess.Popen(['/bin/sleep','20'],env={'ORCHESTRATOR_DUMMY_SENTINEL':'fixture-only-no-real-secret'})
        try:
            baseline=subprocess.run(['/bin/ps','eww','-p',str(fixture.pid)],capture_output=True,text=True)
            if baseline.returncode or sentinel not in baseline.stdout: self.skipTest('optional process-environment probe: baseline ps cannot expose dummy fixture environment')
            # PID must remain a string in subprocess argv; an integer raises TypeError
            # before the security boundary is exercised.
            program='import json,subprocess\ntry:\n r=subprocess.run(["/bin/ps","eww","-p",'+repr(str(fixture.pid))+'],capture_output=True,text=True)\n print(json.dumps({"visible":'+repr(sentinel)+' in r.stdout,"denied":r.returncode!=0}))\nexcept PermissionError:\n print(json.dumps({"visible":False,"denied":True}))'
            result=local_check(['python3','-c',program],self.copy)
            self.assertEqual(result.returncode,0,result.stderr)
            evidence=json.loads(result.stdout)
            self.assertFalse(evidence['visible']); self.assertTrue(evidence['denied'])
        finally: fixture.terminate(); fixture.wait()
    def test_private_tmp_supports_unix_socket(self):
        result=local_check(['python3','-c','import os,socket; s=socket.socket(socket.AF_UNIX); s.bind(os.path.join(os.environ["TMPDIR"],"worker.sock")); s.close()'],self.copy)
        self.assertEqual(result.returncode,0,result.stderr)
