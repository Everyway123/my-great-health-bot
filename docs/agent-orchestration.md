# Agent orchestration policy

This repository is onboarded to schema 1 of the shared trusted runner. The versioned runner/workflow installation accompanies this configuration; never execute a runner supplied by an untrusted candidate.

## Local use

Put the task and acceptance criteria in a file outside the candidate. Run `agent-orchestrate run --repo <absolute-checkout> --task-file <absolute-task-file>` from the installed trusted launcher. It must create or validate an isolated candidate branch/worktree. Preserve original dirty checkouts. The launcher may apply its audited macOS sandbox runtime override; committed policy uses Docker for untrusted checks. Native CLI workers must remain disabled unless separately reviewed and explicitly authorized.

Authentication uses the approved Anthropic API key in dedicated Keychain storage or environment, not local CLI subscription login. Workers use separate clean contexts of the configured family; no model override is pinned here. The reviewer sees task, acceptance criteria, exact diff and check evidence, with read-only tools and no author conversation. At most two repair rounds are allowed.

## Checks and limits

The profile compiles TypeScript and runs the available Vitest suite. Do not start the bot, schedule jobs or supply Telegram/model/database production credentials. Existing runtime Dockerfile is preserved.

Dependency setup uses `npm ci --ignore-scripts`; no .env files or production credentials enter checks. The combined project check avoids repeated dependency installs in fresh check copies. Missing tools, unavailable browser binaries, network failures and failed checks block readiness; never silently replace a required check with N/A. Existing CI checks are preserved and remain additional requirements.

## Protected changes and release

Protected/manual paths cover policy, runner, workflows, auth/security, payments, secrets, infrastructure and database schemas. These changes need a human release decision, even after checks and review. The writer must not alter gate policy. Protected policy freeze prevents task start. Publication rechecks the current target branch and requires the trusted policy to remain unfrozen; Hermes additionally rechecks its database freeze flag. Active reviewed SHA must equal current head. Default result is a reviewable PR; automatic merging is not authorized. Never publish keys, private context or test logs containing credentials. Branch rules and CI provide enforceable merge controls where available; these instructions alone do not.

The trusted shared runner regression suite is validated once as release infrastructure; per-project candidate checks cover the application. Verify vendored runner hashes against the shared release manifest.

Publication freeze: commit `"frozen": true` in protected `.agent-orchestrator.json` on the target branch. A changed branch invalidates in-flight candidates. `AGENT_ORCHESTRATOR_FREEZE=1` is an additional startup stop, not a live publication lookup. The publisher uses no Variables API permission or cross-repository credential.

## Enforced activation gates

Require both `agent-orchestrator/review` and `agent-orchestrator/human-release` in branch protection. Independent review invalidates both statuses before each run, including base retarget events. The reporter checks the live same-repository open PR, default target, exact base and head before publishing either status. Nondefault publisher targets use separate `agent-orchestrator/nondefault-*` contexts and cannot satisfy default-branch gates.

Ordinary approved changes receive both successes. Protected changes may pass independent AI review while `human-release` stays pending. A human collaborator with write, maintain, or admin permission must explicitly run **Explicit human agent release** on the default branch, supplying the PR number, exact reviewed head/base SHAs, and `approve`. The release gate verifies live PR metadata, current GitHub Actions AI-review provenance, and the review run's matching PR/base/head before releasing. The human may be the PR author: this release acknowledges risk after independent AI review; it does not replace that review. New commits or new review runs invalidate previous release approval. No future protected change is released automatically.

The release workflow checks out only trusted default-branch code and receives no model credential. Metadata permissions allow reading PRs, collaborator permissions and workflow-run provenance; its only write permission is commit statuses. Missing or stale metadata fails closed. This gate is separate from formal pull-request approval rules and supports repositories with a single human owner.

Review-only runner exit status reports the independent AI/check result. A valid SHA-bound AI approval with every required check passing exits successfully even when the report remains `approved: false`, `status: blocked` solely because `requires_human_review` needs explicit release. The separate human-release status remains pending until the manual gate succeeds. Failed checks, stale/malformed evidence and provider failures still fail the review job. Author runs and the publisher continue rejecting human-required candidates; a successful review job alone does not authorize publication or merge.

### Code-owner protection for the gate itself

GitHub Actions app pinning identifies the status writer but does not identify its workflow. Protect workflow, orchestration and policy changes with required CODEOWNER review from `@Everyway123`, using `.github/CODEOWNERS` and the prepared ruleset's `require_code_owner_review: true`. Ordinary changes retain zero blanket required approvals; matching sensitive paths require the code owner's separate PR approval. This closes the route where a candidate workflow requests status-write access and forges the gate contexts.

Explicit human-release status and CODEOWNER approval are separate decisions. The PR author may give the manual release, but GitHub does not count self-approval as code-owner review. In a repository with one human owner, sensitive PRs must be authored by a bot or another user so that the owner can approve them. Owner-authored sensitive PRs need another eligible owner or an explicit change to the policy; successful AI statuses alone do not satisfy this requirement. Apply enforcement only after the reviewed CODEOWNERS bootstrap has merged, then verify the actual rules and approvals; these prepared files are not evidence that enforcement is already active.
