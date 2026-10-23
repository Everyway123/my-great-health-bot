#!/usr/bin/env python3
"""Publish only the SHA-bound approved artifact using a trusted clean checkout."""
import argparse
import fnmatch
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import quote


class Blocked(Exception):
    pass


def validate_gate(g):
    if not isinstance(g, dict) or type(g.get('schema_version')) is not int or g['schema_version'] != 1:
        raise Blocked('invalid gate schema')
    if g.get('status') != 'approved' or g.get('requires_human_review') is not False or g.get('human_required', False) is not False:
        raise Blocked('gate does not authorize publication')
    if any(not isinstance(g.get(k), str) or not re.fullmatch('[0-9a-f]{40}', g[k]) for k in ('base_sha', 'head_sha', 'reviewed_sha')):
        raise Blocked('invalid gate SHA')
    if g['head_sha'] != g['reviewed_sha'] or g['base_sha'] == g['head_sha']:
        raise Blocked('review is stale or candidate is empty')
    checks = g.get('checks')
    if not isinstance(checks, list) or not checks:
        raise Blocked('missing checks')
    for check in checks:
        if not isinstance(check, dict) or not isinstance(check.get('name'), str) or not check['name'].strip() or check.get('passed') is not True:
            raise Blocked('invalid or failed check')
    review = g.get('review')
    if not isinstance(review, dict) or review.get('verdict') != 'approve' or not isinstance(review.get('findings'), list):
        raise Blocked('invalid review')
    for finding in review['findings']:
        if not isinstance(finding, dict) or finding.get('severity') != 'P3':
            raise Blocked('blocking or invalid review finding')
    if type(g.get('repair_rounds')) is not int or g['repair_rounds'] < 0 or not isinstance(g.get('backend'), str) or not g['backend'].strip():
        raise Blocked('invalid gate metadata')
    return g


def validate_policy_checks(gate, policy):
    checks = policy.get('checks')
    if not isinstance(checks, list) or not checks or any(not isinstance(c, dict) or not isinstance(c.get('name'), str) or not c['name'].strip() for c in checks):
        raise Blocked('invalid required check policy')
    expected = [c['name'] for c in checks]
    actual = [c['name'] for c in gate['checks']]
    if len(set(expected)) != len(expected) or len(set(actual)) != len(actual) or set(actual) != set(expected):
        raise Blocked('gate does not match required checks')


def validate_paths(paths, protected, manual=None):
    if not isinstance(protected, list) or any(not isinstance(x, str) for x in protected):
        raise Blocked('invalid protected path policy')
    manual = [] if manual is None else manual
    if not isinstance(manual, list) or any(not isinstance(x, str) for x in manual):
        raise Blocked('invalid manual review policy')
    protected = protected + manual
    for path in paths:
        parts = path.lower().split('/')
        if any(x in ('.git', '.github', 'agent_orchestrator') or x.startswith(('.env', '.agent-orchestrator')) or any(w in x for w in ('credential', 'secret', 'auth', 'security')) for x in parts):
            raise Blocked('candidate changes protected files')
        if any(fnmatch.fnmatchcase(path, pat) for pat in protected):
            raise Blocked('candidate changes protected files')


def branch_name(task_id, sha):
    slug = re.sub('[^a-z0-9]+', '-', task_id.lower()).strip('-')[:48] or 'task'
    return 'agent-orchestrator/' + slug + '-' + sha[:12]


def operation_label(command):
    """Only fixed operation names may reach diagnostics; never arguments or output."""
    if command and command[0]=='psql': return 'psql'
    if command and command[0]=='gh':
        return 'gh '+command[1] if len(command)>1 and command[1] in ('api','pr') else 'gh operation'
    if command and command[0]=='git':
        allowed={'check-ref-format','diff','fetch','ls-remote','merge-base','push','rev-parse','show','status'}
        index=1
        while index<len(command) and command[index]=='-c': index+=2
        return 'git '+command[index] if index<len(command) and command[index] in allowed else 'git operation'
    return 'subprocess operation'


class Publisher:
    def __init__(self, repo, repository):
        self.repo = Path(repo).resolve()
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
            raise Blocked('invalid repository')
        self.repository = repository
        self.require_database_freeze = False
        self.frozen = False

    def run(self, command, required=True):
        env = {k:v for k,v in os.environ.items() if not k.startswith('GIT_')}
        env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_TERMINAL_PROMPT='0')
        try:
            result = subprocess.run(command, cwd=self.repo, env=env, text=True, capture_output=True, timeout=120)
        except (OSError, subprocess.TimeoutExpired):
            raise Blocked('publisher command unavailable or timed out: '+operation_label(command)) from None
        if required and result.returncode:
            raise Blocked('publisher command failed: '+operation_label(command))
        return result

    def git(self, *args):
        return self.run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', *args]).stdout.strip()

    def gh(self, *args):
        return self.run(['gh', *args]).stdout.strip()

    def ensure_current_base(self, base, default):
        current = self.gh('api', 'repos/' + self.repository + '/commits/' + quote(default, safe=''), '--jq', '.sha')
        if current != base:
            raise Blocked('default branch changed; rerun orchestration')

    def ensure_unfrozen(self):
        if self.require_database_freeze and not os.environ.get('DATABASE_URL'):
            raise Blocked('required database freeze state unavailable')
        if type(self.frozen) is not bool or self.frozen:
            raise Blocked('trusted publication policy is frozen or invalid')
        if os.environ.get('DATABASE_URL'):
            # libpq reads the URL through the environment; credentials never enter argv/output.
            old = os.environ.get('PGDATABASE')
            os.environ['PGDATABASE'] = os.environ['DATABASE_URL']
            try:
                result = self.run(['psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', 'BEGIN READ ONLY; SELECT frozen FROM hermes.autopilot_state; ROLLBACK;'])
            finally:
                if old is None: os.environ.pop('PGDATABASE', None)
                else: os.environ['PGDATABASE'] = old
            if result.stdout.strip().splitlines() != ['BEGIN', 'f', 'ROLLBACK']:
                raise Blocked('Hermes freeze state is frozen or unknown')

    def import_bundle(self, bundle, base, head):
        self.git('fetch', '--no-tags', '--no-write-fetch-head', str(Path(bundle).resolve()), 'HEAD:refs/agent-orchestrator/candidate')
        if self.git('rev-parse', 'refs/agent-orchestrator/candidate') != head:
            raise Blocked('bundle does not match reviewed SHA')
        self.git('merge-base', '--is-ancestor', base, head)

    def publish(self, bundle, gate, task_file, task_id, run_url, base_branch=None):
        if os.environ.get('AGENT_ORCHESTRATOR_FREEZE','').strip().lower() not in ('','false','0'):
            raise Blocked('startup freeze requested')
        g = validate_gate(gate)
        if not re.fullmatch(r'https://github.com/' + re.escape(self.repository) + r'/actions/runs/[0-9]+', run_url):
            raise Blocked('invalid workflow run URL')
        base, head = g['base_sha'], g['head_sha']
        if self.git('rev-parse', 'HEAD') != base or self.git('status', '--porcelain'):
            raise Blocked('publisher checkout must be a clean trusted baseline')
        default = base_branch or self.gh('api', 'repos/' + self.repository, '--jq', '.default_branch')
        if default.startswith('-'): raise Blocked('invalid base branch')
        self.git('check-ref-format', '--branch', default)
        self.ensure_current_base(base, default)
        policy = json.loads(self.git('show', base + ':.agent-orchestrator.json'))
        if not isinstance(policy, dict) or type(policy.get('require_database_freeze', False)) is not bool or type(policy.get('frozen', False)) is not bool:
            raise Blocked('invalid trusted publication policy')
        self.require_database_freeze = policy.get('require_database_freeze', False)
        self.frozen = policy.get('frozen', False)
        validate_policy_checks(g, policy)
        self.import_bundle(bundle, base, head)
        paths = self.git('diff', '--name-only', '--no-renames', '-z', base, head).split('\0')
        validate_paths([x for x in paths if x], policy.get('protected_paths', []), policy.get('manual_review_paths', []))
        # Task bytes are data only. No candidate-controlled text enters commands or PR summaries.
        Path(task_file).read_text()
        branch = branch_name(task_id, head)
        remote = 'https://github.com/' + self.repository + '.git'
        existing = self.git('-c', 'credential.helper=!gh auth git-credential', 'ls-remote', '--heads', remote, 'refs/heads/' + branch)
        if existing: raise Blocked('publication branch already exists')
        self.ensure_current_base(base, default)
        self.ensure_unfrozen()
        self.git('-c', 'credential.helper=!gh auth git-credential', 'push', remote, head + ':refs/heads/' + branch)
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json') as status_body:
            json.dump({'state':'success', 'context':'agent-orchestrator/review',
                       'description':'review passed', 'target_url':run_url}, status_body)
            status_body.flush()
            self.gh('api', 'repos/' + self.repository + '/statuses/' + head,
                    '--method', 'POST', '--input', status_body.name)
        self.ensure_current_base(base, default)
        self.ensure_unfrozen()
        body = ('Approved orchestration candidate.\n\nBase: `' + base + '`\nHead: `' + head + '`\n'
                + 'Successful checks: ' + str(len(g['checks'])) + '\nRepair rounds: ' + str(g['repair_rounds']) + '\n')
        with tempfile.NamedTemporaryFile(mode='w', suffix='.md') as f:
            f.write(body); f.flush()
            url = self.gh('pr', 'create', '--repo', self.repository, '--base', default, '--head', branch,
                          '--title', 'Agent orchestration: ' + branch.split('/')[1], '--body-file', f.name)
        if not re.fullmatch(r'https://github.com/' + re.escape(self.repository) + r'/pull/[0-9]+', url):
            raise Blocked('invalid PR URL returned')
        if os.environ.get('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a') as output: output.write('pr_url=' + url + '\n')
        return {'status':'published', 'pr_url':url, 'head_sha':head}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('repo','bundle','gate','task-file','task-id','repository','run-url'):
        parser.add_argument('--'+name, required=True)
    parser.add_argument('--base-branch')
    args = parser.parse_args()
    try:
        result = Publisher(args.repo, args.repository).publish(args.bundle, json.loads(Path(args.gate).read_text()), args.task_file, args.task_id, args.run_url, args.base_branch)
    except Blocked as error:
        print(json.dumps({'status':'blocked', 'reason':str(error)}))
        return 1
    except (ValueError, OSError):
        print(json.dumps({'status':'blocked', 'reason':'trusted publication checks failed'}))
        return 1
    print(json.dumps(result)); return 0


if __name__ == '__main__':
    raise SystemExit(main())
