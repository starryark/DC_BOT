| Risk ID | Risk | Source | Likelihood | Impact | Mitigation | Owner | Status | Tied to |
|---|---|---|---|---|---|---|---|---|
| RISK-A | Current DC_BOT topology may not justify standalone service in M1 | Baseline A | High | Medium | ADR-001 defers service; M1 in-process | Architecture | Mitigated | ADR-001 |
| RISK-B | Snapshot version vs concurrent append | Baseline B | Medium | Medium | ADR-015: version as evidence, not lock | Architecture | Mitigated | ADR-015 |
| RISK-C | DB+Discord not atomic; crash windows | Baseline C | High | High | ADR-007 separate state machines; reconciliation worker (BL-016) | Architecture + Ops | Mitigated | ADR-007, BL-016 |
| RISK-D | Single user_event_id conflicts with multi-speaker | Baseline D | High | High | ADR-014 many-to-many; ADR-006 per-speaker attribution | Architecture | Mitigated | ADR-006, ADR-014 |
| RISK-E | "Immutable raw events" vs lifecycle mutation | Baseline E | High | Medium | ADR-008: payload immutable, lifecycle in separate append-only table | Architecture | Mitigated | ADR-008, BL-010 |
| RISK-F | `discord:user:<id>` ≠ verified human | Baseline F | High | High | ADR-003: Discord identity only; cross-platform out of scope | Architecture | Mitigated | ADR-003 |
| RISK-G | Alias-on-every-event write amplification | Baseline G | Medium | Medium | Distinct update policies for snapshots vs current identity records; ADR-004 | Architecture | Mitigated | ADR-004 |
| RISK-H | Guild member update intents | Baseline H | Medium | Medium | OQ-BLOCK-004; REQ-OPS-004; review intents before M1 | Ops | **Open (blocking)** | OQ-BLOCK-004 |
| RISK-I | Append history vs privacy deletion | Baseline I | High | High | ADR-012 redaction + tombstone + cascade + forget-log | Architecture + Privacy | Mitigated | ADR-012, BL-029…BL-035 |
| RISK-J | Arbitrary retrieval weights/latency thresholds | Baseline J | Medium | Medium | REQ-EVAL-001 benchmark before tuning | Eval | Open (non-blocking) | BL-038 |
| RISK-K | Airi = proposals/skeletons, not production | Baseline K | Medium | Medium | Do not import Airi design wholesale; verify before citing | Research | Open (non-blocking) | Section 4 |
| RISK-L | AstrBot mutable whole-history JSON unsafe for concurrency | Baseline L | High | High | ADR-013 rejects JSON-whole-history as concurrency model | Architecture | Mitigated | ADR-013 |
| RISK-M | Multilingual/CJK under generic PG full-text | Baseline M | High | High | ADR-011: language-aware tokenizer; CJK bigram; REQ-OPS-003; TEST-MULTI-* | Architecture + Eval | Mitigated | ADR-011, BL-025 |
| RISK-N | Silent ephemeral fallback | Baseline item 22 | Medium | High | ADR-016; TEST-OPS-002; metric must be 0 | Ops | Mitigated | ADR-016 |
| RISK-O | Erasure residue in backups | Inference | Medium | High | Forget-log replayable against restored backups (BL-033) | Privacy + Ops | Mitigated | ADR-012, BL-033 |
| RISK-P | Prompt injection via retrieved memory | Baseline item 16 | High | High | ADR-010; TEST-SEC-001…004 | Security | Mitigated | ADR-010, BL-027, BL-028 |
| RISK-Q | Partial delivery treated as completed turn | Baseline item 15 | High | High | Delivery state machine; TEST-DEL-002 | Ops | Mitigated | ADR-007, BL-014…BL-016 |
| RISK-R | Cross-room recent-context leak | Baseline item 9 | Medium | High | RoomBinding + auth; TEST-SCOPE-002 | Architecture | Mitigated | ADR-005, BL-023 |
| RISK-S | Internal ID/UUID exposure to model | Baseline item 16 | Medium | High | Opaque handles; TEST-SEC-004 | Security | Mitigated | ADR-010, BL-027 |
| RISK-T | Repository facts unverified this session | This session's access limit | High | Medium | Downstream verification agent must re-open URLs in Section 4 | Verification | **Open (blocking)** | OQ-BLOCK-001…004 |

### Critical risks (release-blocking if unresolved)
- RISK-H (guild member intents) — blocking.
- RISK-T (repository verification) — blocking.
- RISK-C, RISK-D, RISK-F, RISK-I, RISK-M, RISK-P, RISK-Q — mitigated, but each must pass its TEST-* before M1 release.

### Required artifact corrections (downstream)
- Re-verify EV-001, EV-004, EV-005 against the actual GitHub repositories with live web access.
- Replace any `(unverified this session)` classification with **Confirmed repository fact** only after direct inspection.
- Confirm OQ-BLOCK-001…004.

### Coding-start recommendation
**CONDITIONAL GO.**

Conditions to lift to **GO**:
1. OQ-BLOCK-001 through OQ-BLOCK-004 resolved by a verification agent with live web access.
2. RISK-H and RISK-T closed.
3. Evaluation harness skeleton (BL-038) exists so REQ-EVAL-001 is not untested at M1.
4. No untested MUST remains in the traceability matrix.

---
