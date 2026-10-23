import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from scripts.agent_orchestrator.runner import Orchestrator

class DockerTransportTests(unittest.TestCase):
    def test_docker_uses_runner_uid_private_home_and_sanitized_environment(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); repo=root/'repo'; repo.mkdir(); tools=root/'tools'; tools.mkdir(); record=root/'record.json'
            subprocess.run(['git','-C',str(repo),'init'],capture_output=True,check=True)
            (repo/'file').write_text('candidate'); subprocess.run(['git','-C',str(repo),'add','.'],check=True)
            # Exercise actual subprocess transport, without a Docker daemon.
            docker=tools/'docker'; docker.write_text('#!/usr/bin/python3\nimport json,os,sys\nfrom pathlib import Path\nargs=sys.argv[1:]\nmount=args[args.index("-v")+1].split(":")[0]\nPath('+repr(str(record))+').write_text(json.dumps({"args":args,"env":dict(os.environ),"private_home_exists":(Path(mount)/".orchestrator-home").is_dir(),"private_tmp_exists":(Path(mount)/".orchestrator-tmp").is_dir()}))\n'); docker.chmod(0o755)
            config={'schema':1,'test_mode':'docker','checks':[{'name':'check','command':['true']}],'setup':[]}
            from scripts.agent_orchestrator import runner
            env=runner.clean_env(); env['PATH']=str(tools)+':'+env['PATH']
            with patch.dict(os.environ,{'ANTHROPIC_API_KEY':'private-secret','GITHUB_TOKEN':'private-token'}), patch.object(runner,'clean_env',return_value=env):
                result=Orchestrator(repo,config,root/'out',None).checks()
            self.assertTrue(result[0]['passed']); data=json.loads(record.read_text()); args=data['args']
            self.assertIn('--user',args); self.assertEqual(args[args.index('--user')+1],f'{os.getuid()}:{os.getgid()}')
            self.assertIn('--memory=4g',args); self.assertIn('NODE_OPTIONS=--max-old-space-size=3072',args)
            self.assertIn('HOME=/workspace/.orchestrator-home',args); self.assertIn('TMPDIR=/workspace/.orchestrator-tmp',args)
            self.assertTrue(data['private_home_exists']); self.assertTrue(data['private_tmp_exists'])
            self.assertNotIn('ANTHROPIC_API_KEY',data['env']); self.assertNotIn('GITHUB_TOKEN',data['env'])
