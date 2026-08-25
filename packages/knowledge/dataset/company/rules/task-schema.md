---
id: task-schema
title: Task schema standard
roles: [ba, architect, developer, quality]
stages: [research, plan, implement, verify]
severity: mandatory
overridable: true
sourceDoc: corp-engineering-handbook
sourceVersion: "1.0.0"
---

# Task schema standard

Every tracker task that enters implementation must include:

1. **Type** — Feature, Bug, TechDebt, or Spike.
2. **Summary** — one sentence naming the user-visible or system outcome.
3. **Acceptance criteria** — Given/When/Then or equivalent observable checks.
4. **Fix version** — set when the change is releasable; leave unset for spikes that produce only knowledge.

Tasks missing acceptance criteria must not leave the BA→Architect handoff gate.
