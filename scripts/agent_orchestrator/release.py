#!/usr/bin/env python3
"""Explicit human release after independent AI review, with live PR binding."""
import argparse
import json
import re
import subprocess
from urllib.parse import quote
try: from .report_status import api,validate_inputs,validate_target,post_status,CONTEXT,HUMAN_CONTEXT
except ImportError: from report_status import api,validate_inputs,validate_target,post_status,CONTEXT,HUMAN_CONTEXT

def release(repository,number,head,base,actor,decision,run_url):
    validate_inputs(repository,head,base,number,run_url)
    if decision!='approve' or not isinstance(actor,str) or not re.fullmatch('[A-Za-z0-9-]{1,39}',actor):raise ValueError('explicit human approval required')
    user=api('users/'+quote(actor,safe=''))
    permission=api('repos/'+repository+'/collaborators/'+quote(actor,safe='')+'/permission')
    if not isinstance(user,dict) or user.get('type')!='User' or not isinstance(permission,dict) or permission.get('permission') not in ('write','maintain','admin'):raise ValueError('human actor lacks release permission')
    validate_target(repository,number,head,base)
    # List API exposes creator; combined-status endpoint omits provenance. Results
    # are newest first: the first matching context supersedes all older approvals.
    found=None
    for page in range(1,11):
        statuses=api('repos/'+repository+'/commits/'+head+'/statuses?per_page=100&page='+str(page))
        if not isinstance(statuses,list):raise ValueError('invalid review status metadata')
        found=next((s for s in statuses if isinstance(s,dict) and s.get('context')==CONTEXT),None)
        if found is not None or len(statuses)<100:break
    creator=found.get('creator',{}) if isinstance(found,dict) else {}
    if not found or found.get('state')!='success' or creator.get('login')!='github-actions[bot]' or creator.get('type')!='Bot':raise ValueError('current trusted AI approval required')
    # Reporter links its run, whose PR event must have reviewed this exact base.
    target=found.get('target_url','')
    match=re.fullmatch('https://github.com/'+re.escape(repository)+r'/actions/runs/([0-9]+)',target)
    if not match:raise ValueError('trusted review run required')
    run=api('repos/'+repository+'/actions/runs/'+match.group(1))
    if not isinstance(run,dict) or run.get('event')!='pull_request_target' or run.get('path')!='.github/workflows/agent-review.yml' or not any(isinstance(p,dict) and p.get('number')==number and p.get('head',{}).get('sha')==head and p.get('base',{}).get('sha')==base for p in run.get('pull_requests',[])):raise ValueError('AI review was not bound to current PR base')
    validate_target(repository,number,head,base)
    post_status(repository,head,{'context':HUMAN_CONTEXT,'state':'success','description':'explicit human release by '+actor,'target_url':run_url})

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('repository','head','base','actor','decision','run-url'):parser.add_argument('--'+name,required=True)
    parser.add_argument('--pr-number',required=True,type=int);args=parser.parse_args()
    try:release(args.repository,args.pr_number,args.head,args.base,args.actor,args.decision,args.run_url)
    except (ValueError,OSError,KeyError,TypeError,subprocess.TimeoutExpired):print(json.dumps({'status':'blocked','reason':'human release validation failed'}));return 1
    print(json.dumps({'status':'released'}));return 0
if __name__=='__main__':raise SystemExit(main())
