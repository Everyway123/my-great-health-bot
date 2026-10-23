# Development orchestration

Read [the repository orchestration policy](docs/agent-orchestration.md) and `.agent-orchestrator.json` before implementation. Preserve existing CLAUDE.md instructions where present; COGNICOO also requires MANIFEST.md and ORCHESTRATION.md.

Act as orchestrator. Establish task, acceptance criteria, base SHA and checks; delegate implementation to a writer and independent review to a separate clean context using the installed trusted `agent-orchestrate` launcher. Delegated writers and reviewers perform only their assigned role and must not recursively launch orchestration.

Keep task text in a file. Default workers use independent clean Anthropic API contexts of the configured model family with constrained file tools; this is same-provider separation. Local CLI workers remain blocked by default. Missing credentials, unavailable review, malformed verdicts or failed checks never approve a candidate.

Use an isolated candidate branch/worktree, preserve dirty original checkouts, and allow at most two repair rounds. Ready requires passing mandatory checks, no blocking findings and review bound to current head. A new head invalidates approval. Freeze prevents new work and publication. Auth, payments, secrets, infrastructure, database schemas and orchestration require a human release decision. Never automatically merge or delete work.

Instructions guide behavior; GitHub CI and branch rules enforce merge restrictions where configured. Do not claim universal enforcement.
