---
id: tracker-workflow
title: Tracker workflow for implementation tasks
roles: [ba, developer]
stages: [research, implement]
severity: advisory
overridable: true
sourceDoc: corp-engineering-handbook
sourceVersion: "1.0.0"
obsoleteToolBinding:
  toolId: legacy-jira-server
  reason: Company retired Jira Server; procedural gates remain, binding needs Linear review
  proceduralContentApplicable: true
  reviewRequired: true
---

# Tracker workflow for implementation tasks

Procedural gates for work entering implementation:

1. Capture type, summary, and acceptance criteria before coding starts.
2. Link the work item to the architecture package or change-spec under review.
3. Move the item to "In progress" only after the BA→Architect handoff is accepted.
4. Close the item only when acceptance checks are recorded.

The steps above remain applicable. The former Jira Server field names and
board automation bindings require human review against the current tracker.
