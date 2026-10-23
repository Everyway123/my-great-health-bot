# Orchestration activation — operator reference

This document describes the activated agent-orchestrator workflow for
repository operators and human reviewers. It covers the two required status
contexts, the human-release gate, the CODEOWNER layer, required checks, and
the trust model that underpins the setup.

---

## How the workflow operates

An orchestration run uses **two separate, clean API contexts** of the same
provider (Anthropic). Both contexts share the same model family but hold no
shared conversation state:

| Role | Context | Permissions |
|------|---------|-------------|
| **Author** | Clean API session — writes implementation | File tools only; no review access |
| **Reviewer** | Separate clean API session — evaluates the diff | **Read-only** file tools; no author conversation visible |

The reviewer sees the task, acceptance criteria, the exact diff, and all
check evidence. Because the reviewer's approval is bound to the exact
`base_sha` and `head_sha` recorded at review time, any new commit
automatically invalidates that approval before a new run starts.

---

## Required status contexts

Branch protection must require **both** of the following commit-status
contexts before a PR can merge:

| Context name | Written by | Purpose |
|---|---|---|
| `agent-orchestrator/review` | `agent-review.yml` on every PR event | Records independent AI review result bound to exact base/head SHAs |
| `agent-orchestrator/human-release` | `agent-release.yml` (manual dispatch) | Records an explicit human release decision for sensitive changes |

Both statuses are invalidated (set to **pending**) at the start of every
review run, including on base-retarget events, before any new evaluation
begins.

### Ordinary changes

When no `manual_review_paths` are matched and all checks pass, both statuses
receive `success` automatically after a successful review run.

### Sensitive / protected changes

Changes that match `manual_review_paths` (policy, runner, workflows,
auth/security, payments, secrets, infrastructure, database schemas — see the
full list in [`.agent-orchestrator.json`](../.agent-orchestrator.json)) pass
independent AI review but leave `agent-orchestrator/human-release` in
**pending** state. A human collaborator with at least repository **write**
permission must run the **Explicit human agent release** workflow manually,
supplying:

- The open PR number
- The exact reviewed head SHA
- The exact reviewed base SHA
- `approve` as the explicit decision

The release workflow checks out only trusted default-branch code, verifies
live PR metadata, confirms AI-review provenance from GitHub Actions, and
matches the supplied SHAs before posting `success` to
`agent-orchestrator/human-release`. A subsequent commit or a new review run
invalidates the previous release approval.

In addition, every sensitive path is covered by CODEOWNER rules (see below).
**CODEOWNER approval** and **human-release** are separate decisions; neither
satisfies the other.

---

## Required project checks

The following check is defined in `.agent-orchestrator.json` and must pass
before the reviewer can approve a candidate. The check is run inside the
configured Docker image (`node:24-bookworm`) after `npm ci --ignore-scripts`:

| Check name | Command |
|---|---|
| `project-validation` | `npm run build && npm test` |

Failed checks, tools that are unavailable, or network errors block readiness.
A required check is never replaced with N/A or skipped.

---

## CODEOWNER protection

`.github/CODEOWNERS` maps every sensitive path to `@Everyway123`. When the
branch ruleset enables `require_code_owner_review: true`, any PR that touches
those paths requires an explicit PR approval from the code owner before
GitHub allows a merge — independent of the agent status contexts.

The CODEOWNERS file itself lives under `.github/`, so modifying it also
requires code-owner review once the ruleset is active.

---

## Trust model

**Repository writers are trusted.** The orchestration setup assumes that
humans and collaborators with repository write access act in good faith. The
system governs constrained API agents, not hostile insiders:

- Writers can execute branch workflows and may be able to post the required
  status contexts; the statuses are pinned to the **GitHub Actions App**, not
  to a specific workflow file.
- The agent workflow does **not** force every action through specific UI
  paths. Instructions guide agent behavior; GitHub CI and branch protection
  rules enforce merge restrictions where configured.
- To protect against a hostile write collaborator a stronger gate with a
  dedicated, separately protected status identity would be required.
- The PR author may perform the human release (acknowledging risk after
  independent AI review), but GitHub does not count self-approval as
  code-owner review. In a single-owner repository, sensitive PRs should be
  authored by a bot or another user so the owner can provide code-owner
  approval.

---

## End-to-end gate summary

```
PR opened / updated
  └─► agent-review.yml triggers on pull_request_target
        ├─ Invalidates agent-orchestrator/review and agent-orchestrator/human-release (→ pending)
        ├─ Runs independent reviewer in a separate clean API context
        ├─ Runs project-validation check  (npm run build && npm test)
        └─ Reports result bound to exact base SHA + head SHA
              ├─ Ordinary change, all checks pass  → both statuses → success
              └─ Sensitive/protected path          → review → success
                                                     human-release → pending
                                                       └─► Human runs "Explicit human agent release"
                                                             └─ Verifies live PR + SHA match
                                                                  └─ human-release → success

Both statuses success + CODEOWNER approval (sensitive paths) → merge eligible
```

---

## Quick reference: manual human release steps

1. Confirm the PR is open, targets the default branch, and has a passing
   `agent-orchestrator/review` status.
2. Note the exact **head SHA** and **base SHA** shown in the review status
   detail or the PR commits list.
3. Navigate to **Actions → Explicit human agent release → Run workflow**.
4. Supply the PR number, head SHA, base SHA, and select `approve`.
5. Verify the `agent-orchestrator/human-release` status on the PR changes to
   `success`.
6. If the PR touches sensitive paths, also ensure `@Everyway123` has approved
   the PR (CODEOWNER review).

Any new commit after step 5 resets both statuses to pending and requires the
full process to repeat.
