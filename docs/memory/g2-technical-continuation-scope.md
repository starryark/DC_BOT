# G2 technical continuation and operational rollout scope

Date: 2026-08-02  
Status: coding-scope decision; not a production approval

The ownership guard, public package-boundary closure, and cross-process
validation satisfy G2 only for continued implementation of runtime-inert memory
code. This scope permits IMP-301A actor-evidence capture with every memory
feature flag disabled and no database opened.

It does not approve shadow writes, prompt reads, backfill, production writes,
or rollout. Deployment process inventory, local storage, backup destination,
deployment-shaped soak, approved operating envelope, and owner sign-off remain
mandatory before the operational G2/R2 scope can pass.

This is a scope interpretation of the existing “G2 coding continuation only”
option in `evidence/g2-operational-acceptance-template.md`, not a new canonical
ADR and not a substitute for a signed operational acceptance record.

| Scope | Status |
|---|---|
| G2 technical implementation | Complete after the guarded public API boundary and its tests pass |
| G2 coding continuation | Approved only for IMP-301A |
| G2 operational deployment | Pending |
| IMP-301B persistence or shadow-write activation | Blocked |
| Prompt reads, backfill, production writes, and rollout | Blocked |
| IMP-305 and final G3 | Blocked on their actual dependencies, including FIND-010 where additional gateway data is required |

Canonical ADR-001 already selects in-process, file-backed SQLite for M1.
`OQ-BLOCK-003` is therefore split: the architecture question is resolved, while
`OQ-EVIDENCE-003` tracks deployment topology, storage, backup, soak, and owner
approval evidence.
