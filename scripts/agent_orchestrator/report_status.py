#!/usr/bin/env python3
"""Publish base/head-bound AI and human-release gates for live default-target PRs."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import tempfile
CONTEXT='agent-orchestrator/review'
HUMAN_CONTEXT='agent-orchestrator/human-release'

def validate_inputs(repository,head,base,number,run_url=None):
    if not isinstance(repository,str) or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',repository) or any(not isinstance(x,str) or not re.fullmatch('[0-9a-f]{40}',x) for x in (head,base)) or type(number) is not int or number<1: raise ValueError('invalid status target')
    if run_url is not None and not re.fullmatch(r'https://github.com/'+re.escape(repository)+r'/actions/runs/[0-9]+',run_url): raise ValueError('invalid workflow run URL')

def api(endpoint):
    result=subprocess.run(['gh','api',endpoint],capture_output=True,text=True,timeout=60)
    if result.returncode: raise ValueError('GitHub metadata unavailable')
    try: return json.loads(result.stdout)
    except ValueError: raise ValueError('invalid GitHub metadata') from None

def validate_target(repository,number,head,base):
    validate_inputs(repository,head,base,number)
    metadata=api('repos/'+repository)
    pr=api('repos/'+repository+'/pulls/'+str(number))
    try:
        valid=(isinstance(metadata['default_branch'],str) and pr['state']=='open' and pr['base']['ref']==metadata['default_branch'] and pr['base']['sha']==base and pr['head']['sha']==head and pr['base']['repo']['full_name']==repository and pr['head']['repo']['full_name']==repository)
    except (TypeError,KeyError): valid=False
    if not valid: raise ValueError('PR target is stale, nondefault, closed, or cross-repository')
    return pr

def status_payload(report,head,base,pending=False):
    valid=isinstance(report,dict) and type(report.get('schema_version')) is int and report['schema_version']==1
    if valid:
        checks,review=report.get('checks'),report.get('review')
        valid=(report.get('base_sha')==base and report.get('head_sha')==head and report.get('reviewed_sha')==head and isinstance(checks,list) and bool(checks) and all(isinstance(c,dict) and isinstance(c.get('name'),str) and bool(c['name'].strip()) and c.get('passed') is True for c in checks) and isinstance(review,dict) and review.get('verdict')=='approve' and isinstance(review.get('findings'),list) and all(isinstance(f,dict) and f.get('severity')=='P3' for f in review['findings']) and type(report.get('requires_human_review')) is bool and (report.get('status')=='approved' or (report.get('status')=='blocked' and report['requires_human_review'] and report.get('reason')=='human review required')))
    return {'context':CONTEXT,'state':'pending' if pending else ('success' if valid else 'failure'),'description':'review in progress' if pending else ('review passed; human approval required' if valid and report['requires_human_review'] else 'review passed' if valid else 'review failed or report unavailable')}

def human_payload(report,head,base,pending=False):
    ai=status_payload(report,head,base,pending)
    state='pending' if pending or (ai['state']=='success' and report['requires_human_review']) else ai['state']
    return {'context':HUMAN_CONTEXT,'state':state,'description':'explicit human release required' if state=='pending' else 'human release not required' if state=='success' else 'release blocked by invalid review'}

def post_status(repository,head,payload):
    with tempfile.NamedTemporaryFile(mode='w',suffix='.json') as body:
        json.dump(payload,body);body.flush()
        result=subprocess.run(['gh','api','repos/'+repository+'/statuses/'+head,'--method','POST','--input',body.name],capture_output=True,text=True,timeout=60)
    if result.returncode: raise ValueError('status publication failed')

def publish_status(repository,head,report_path,run_url,pending=False,pr_number=None,base=None):
    validate_inputs(repository,head,base,pr_number,run_url)
    try: report=json.loads(Path(report_path).read_text())
    except (OSError,ValueError): report=None
    # A live target check immediately precedes each status mutation. Human gate is
    # always written first so AI success can never briefly open sensitive releases.
    for payload in (human_payload(report,head,base,pending),status_payload(report,head,base,pending)):
        validate_target(repository,pr_number,head,base)
        post_status(repository,head,dict(payload,target_url=run_url))
    return status_payload(report,head,base,pending)['state']

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('repository','head','base','report','run-url'):parser.add_argument('--'+name,required=True)
    parser.add_argument('--pr-number',type=int,required=True);parser.add_argument('--pending',action='store_true');args=parser.parse_args()
    try: state=publish_status(args.repository,args.head,args.report,args.run_url,args.pending,args.pr_number,args.base)
    except (ValueError,OSError,subprocess.TimeoutExpired):print(json.dumps({'status':'blocked','reason':'status publication failed'}));return 1
    print(json.dumps({'status':state}));return 0
if __name__=='__main__':raise SystemExit(main())
