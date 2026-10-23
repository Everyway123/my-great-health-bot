#!/usr/bin/env python3
"""Publish a SHA-bound review status without disclosing report contents."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import tempfile

CONTEXT = 'agent-orchestrator/review'


def status_payload(report, head, pending=False):
    valid = isinstance(report, dict) and type(report.get('schema_version')) is int and report['schema_version'] == 1
    if valid:
        checks, review = report.get('checks'), report.get('review')
        valid = (report.get('head_sha') == head and report.get('reviewed_sha') == head
                 and isinstance(checks, list) and bool(checks)
                 and all(isinstance(c, dict) and isinstance(c.get('name'), str) and bool(c['name'].strip()) and c.get('passed') is True for c in checks)
                 and isinstance(review, dict) and review.get('verdict') == 'approve'
                 and isinstance(review.get('findings'), list)
                 and all(isinstance(f, dict) and f.get('severity') == 'P3' for f in review['findings'])
                 and type(report.get('requires_human_review')) is bool
                 and (report.get('status') == 'approved' or
                      (report.get('status') == 'blocked' and report['requires_human_review']
                       and report.get('reason') == 'human review required')))
    description = 'review passed' if valid else 'review failed or report unavailable'
    if valid and report['requires_human_review']:
        description = 'review passed; human approval required'
    return {'context': CONTEXT, 'state': 'pending' if pending else ('success' if valid else 'failure'),
            'description': 'review in progress' if pending else description}


def publish_status(repository, head, report_path, run_url, pending=False):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository) or not re.fullmatch(r'[0-9a-f]{40}', head):
        raise ValueError('invalid status target')
    if not re.fullmatch(r'https://github.com/' + re.escape(repository) + r'/actions/runs/[0-9]+', run_url):
        raise ValueError('invalid workflow run URL')
    try:
        report = json.loads(Path(report_path).read_text())
    except (OSError, ValueError):
        report = None
    payload = dict(status_payload(report, head, pending), target_url=run_url)
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json') as body:
        json.dump(payload, body); body.flush()
        result = subprocess.run(['gh', 'api', 'repos/' + repository + '/statuses/' + head,
                                 '--method', 'POST', '--input', body.name],
                                capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError('status publication failed')
    return payload['state']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('repository', 'head', 'report', 'run-url'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--pending', action='store_true')
    args = parser.parse_args()
    try:
        state = publish_status(args.repository, args.head, args.report, args.run_url, args.pending)
    except (ValueError, RuntimeError, OSError, subprocess.TimeoutExpired):
        print(json.dumps({'status': 'blocked', 'reason': 'status publication failed'}))
        return 1
    print(json.dumps({'status': state}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
