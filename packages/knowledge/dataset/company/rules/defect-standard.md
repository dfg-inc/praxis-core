---
id: defect-standard
title: Defect recording standard
roles: [ba, developer, quality]
stages: [research, implement, verify]
severity: mandatory
overridable: false
sourceDoc: corp-quality-policy
sourceVersion: "1.0.0"
---

# Defect recording standard

Client-reported defects are captured as BUG pages with severity, reporter, and affected surfaces. Internal engineering failures discovered during final-arbiter or Quality review become return events with a task reference — they are not silently fixed without a trail.

Duplicate reports link to the canonical BUG; do not mint a second id for the same failure fingerprint.
