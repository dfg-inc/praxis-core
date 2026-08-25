---
id: E1-FR1
type: fr
epic: E1
status: batched
version: 1
traces_to:
  - CR-001
enforces: []
references_nfr: []
related: []
---

As a caller I get a Hello greeting.

## Acceptance Criteria

```gherkin
Given a name "World"
When formatGreeting is called
Then the result is "Hello, World!"
```
