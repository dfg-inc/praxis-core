# Local mode and Jira

Praxis works fully without Jira. Jira is an optional integration; nothing in the flow requires it.

## Local mode (default)

The work item lives in `.praxis/workflow/` of the repository. Requirements, stories, reviews, prototype, plan, decisions, repositories and verdicts are all there. No account, no network, no external service. A missing Jira configuration is reported only when you ask for a Jira write.

## What maps to what

Local work and Jira are separate records. The Jira flows (`praxis_ba_*`, `praxis_architect_*`) work from a Jira Epic and a proposal file; **nothing synchronises the local requirements, stories, reviews or prototype to Jira automatically.** The intended correspondence is: work item <-> Epic (linked with `link-work-item`; the Praxis id stays the identity), requirement and story <-> Story issues written by a BA apply you approve, work package <-> Work Package issue written by an Architect apply. Today that mapping is made by the agent and the apply tools, not by a sync.

## Writing to Jira

Every write goes through the protected preview / apply pair (`praxis_ba_preview` / `praxis_ba_apply`, `praxis_architect_*`, `praxis_quality_apply`, and so on). The preview shows the exact issues, fields and operations; you approve exactly that in the client's dialog; a client without a dialog does not execute it. Reviews, stage changes and prototypes never write to Jira. Reading Jira (status, discovery) needs no approval.

## Re-sync, conflicts, errors

An apply runs only against a current preview: a stale preview is refused and you get a new one. A Jira error is reported with its code and message; the Runtime does not retry a write silently. Which exact Jira fields conflict after an outside edit is decided by the Jira plugin, not by this workflow.
