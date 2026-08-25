---
id: root-cause
title: Root-cause before workaround
roles: [architect, developer, quality]
stages: [research, plan, implement, verify]
severity: advisory
overridable: true
sourceDoc: corp-engineering-handbook
sourceVersion: "1.0.0"
---

# Root-cause before workaround

Prefer fixing the underlying defect over permanent workarounds. Temporary mitigations must:

- Record the decision (ADR or CR interpretation).
- Name a removal condition.
- Appear in Quality notes when they affect production behavior.

Repeated workarounds with the same fingerprint should lift into a company or product rule via finding-lift.
