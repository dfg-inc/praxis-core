---
id: review-checklist
title: Merge review checklist
roles: [quality, developer, architect]
stages: [verify, implement]
severity: mandatory
overridable: true
sourceDoc: corp-quality-policy
sourceVersion: "1.0.0"
---

# Merge review checklist

Before a merge request is approved:

1. Developer→Quality handoff present with verification.build/tests/lint true.
2. Intention names the requirements and decisions covered.
3. No `FIXME-CRITICAL` markers in production sources.
4. Tests cover the stated acceptance criteria.
5. Architecture deviations have an accepted ADR or deviation record.

Quality `review-path` is the local executable baseline; combat CI remains the deployment gate.
