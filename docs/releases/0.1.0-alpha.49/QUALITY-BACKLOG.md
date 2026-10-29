# Quality improvements backlog (from the independent E2E review, round 8)

Source: independent review of the lab Work Item `WI-FILTR-ZAKAZOV-PO-STATUSU-001` (31/31 PASS, 35 records). The raw mutation run is kept in `evidence/quality-mutation-results.txt` (34 mutations, `quality-mutants.py` generates them).

**Status of the evidence: 31/31 is an honest, independent execution. It is NOT strong proof that every acceptance criterion is correct.** Strength by criterion: 13 STRONG, 15 WEAK, 3 FORMAL, 0 MISSING; 13 of 34 mutations survived (no check of the affected criterion failed). Nothing in this backlog is a Praxis Runtime defect: the checks belong to the lab project (`checks.json`, written by the same agent that built the stand). The source Work Item and orders-app were deliberately left unchanged.

## Q-1 FORMAL checks (3) - replace, do not tune
| Criterion | Problem |
|---|---|
| REQ-ORD-002-AC-06 | passes on the absence of the literal "History" only (survived M17: a "Status log" section) |
| REQ-ORD-005-AC-05 | same pattern |
| REQ-ORD-002-AC-07 | the dash can come from the Items fallback, not from the field under test (survived: blanked dash) |

## Q-2 WEAK checks (15)
Causes: value not bound to its label or position; unit-only check without a UI path; literals copied from the dataset; `expectHidden` passes when the selector matches nothing.
Work: bind each assertion to label + cell position; add the UI path for unit-only criteria; assert on rendered text, not on data literals; make `expectHidden` require the element to exist in another state first.

## Q-3 Surviving mutations (13) - each needs a check that fails
Swapped Customer/Status cells (M08); filter moved below the table (M03); label renamed (M02); drawer on the left instead of the right (M10); highlight CSS removed (M11); Created/Total swapped (M13); Qty/Price swapped (M14); email/phone swapped (M16); extra "Status log" section (M17); blanked dash; reconcile on filter change removed; `order` param left in the URL after closing the drawer; URL cleanup through `replaceState`. Exact ids and results: `evidence/quality-mutation-results.txt`. Three more survived only their own check and were caught elsewhere.

## Q-4 Runner/driver gaps found by the same review (deferred product work, not blocking)
- A console error does not fail a check.
- Screenshots are final-state only (21 files, 7 distinct images).
- `localhost` URLs and dot-files are not reachable from a browser check.
- The legacy layout is not drift-marked (evidence binds to the built bundle only).
- The digest depends on the build location (esbuild embeds relative paths).
- The empty-state criterion (ORD-2005) is unreachable on real mock data in the browser bundle; the entry point lives in `qa-stand`.

## Acceptance rule for closing this backlog
A re-run of the 34 mutations kills at least all 13 survivors and the 3 FORMAL checks no longer pass on a "literal absent" basis. Until then, do not describe the lab's 31/31 as proof of correctness of all AC.
