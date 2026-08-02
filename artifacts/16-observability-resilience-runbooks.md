# Observability, Resilience, and Operational Runbooks

**Artifact filename:** `16-observability-resilience-runbooks.md`  
**Status:** Proposed specification for review  
**Role:** Production reliability architecture  
**Primary system:** DC_BOT shared-memory implementation  
**Repository baseline:** `starryark/DC_BOT` at commit `0ea3cbf5ec92f719e2b48066c3ada45aa50122ad`  
**Comparison baselines:** `moeru-ai/airi` at commit `4d6e61f77dc99ec76c7cf352df62abb4282386c5`; `AstrBotDevs/AstrBot` at commit `49095d3ba3fca9272a67aa5eeab2f6c0719c5091`

---

## 1. Executive conclusion

**Recommendation.** DC_BOT should adopt one topology-neutral operational contract for the memory authority, whether the first implementation is an in-process `MemoryPort` backed by SQLite/PostgreSQL or a later remote Memory Runtime. Metrics, structured events, trace boundaries, delivery states, deletion evidence, and failure semantics must remain stable across those deployment choices.

**Recommendation.** Production correctness must be observable independently of availability. A request is not “successful” merely because generation completed or Discord accepted a send call. Memory append, generation, delivery attempt, delivery outcome, history eligibility, worker processing, deletion propagation, and export completion require separate states and measurements.

**Recommendation.** The first release should prioritize four release-blocking guarantees:

1. no silent fallback to unrelated process-local history;
2. no authorization or cross-scope leakage;
3. no false claim that delivery or deletion completed;
4. deterministic recovery from duplicate requests, crashes, schema mismatch, and backend unavailability.

**Confirmed repository fact.** DC_BOT already has useful voice operational foundations: service-readiness checks, phase/utterance/playback telemetry, response epochs that cancel stale work, playback-drain checks before committing the existing session history, and atomic-style TTS cache file replacement. These are valuable precedents, but they do not constitute a durable shared-memory or delivery-reconciliation system.

**External research finding.** OpenTelemetry supplies vendor-neutral trace, metric, and log instrumentation and context propagation; it is not itself the monitoring backend. Google SRE guidance recommends defining service-level indicators around user-visible behavior, setting objectives from user needs rather than current performance alone, and managing releases with error budgets. The latency values in this document are therefore test hypotheses, not approved SLOs.

**Approval decision required.** Coding must not begin until owners approve: the topology ADR; the write/degraded-mode policy; the delivery ledger state machine; privacy-safe telemetry fields and retention; deletion semantics including backups; and the SLO measurement protocol.

---

## 2. Scope

**Source-plan requirement.** This artifact specifies observability, resilience behavior, SLO approval, incident response, and operator runbooks for the proposed shared-memory implementation used by DC_BOT text and voice paths.

Included:

- application, persistence, cache, worker, delivery, export, and deletion telemetry;
- structured logs and distributed traces using identifiers rather than content;
- availability, latency, correctness, privacy, and recovery indicators;
- local/in-process and remote-memory deployment modes;
- Discord text-send and voice-playback crash windows;
- queue, spool, migration, cache, and credential incidents;
- SLO measurement, review, approval, and error-budget policy;
- testable operational acceptance criteria.

Excluded:

- production implementation code;
- final database schema and migration SQL;
- final identity, alias, authorization, and retention policy;
- model-quality scoring except where it affects operational correctness;
- Discord-wide service status operations unrelated to memory behavior;
- general host hardening beyond credentials and telemetry exposure.

---

## 3. Sources inspected

### 3.1 Assignment and source-plan baseline

- Uploaded source specification: `16_observability_operations_spec.txt`.
- It requires a complete operational artifact, explicit metric coverage, privacy-safe structured logs/traces, sixteen named runbooks, and a measured approval process for latency and voice deadlines.

### 3.2 DC_BOT

Inspected branch: `main`  
Inspected commit: `0ea3cbf5ec92f719e2b48066c3ada45aa50122ad`

- Repository and README: https://github.com/starryark/DC_BOT
- Commit: https://github.com/starryark/DC_BOT/commit/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad
- Launcher: https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/start-bot.ps1
- Telemetry: https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/telemetry.ts
- Conversation controller: https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/conversation-controller.ts
- TTS cache: https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/providers/tts/tts-cache.ts
- Existing runbook: https://github.com/starryark/DC_BOT/blob/main/RUNBOOK.md

### 3.3 AIRI

Inspected branch: `main`  
Inspected commit: `4d6e61f77dc99ec76c7cf352df62abb4282386c5`

- Repository: https://github.com/moeru-ai/airi
- Commit: https://github.com/moeru-ai/airi/commit/4d6e61f77dc99ec76c7cf352df62abb4282386c5
- Memory architecture alternatives issue: https://github.com/moeru-ai/airi/issues/387
- Alaya memory-driver proposal: https://github.com/moeru-ai/airi/issues/879
- Open Alaya memory-layer PR: https://github.com/moeru-ai/airi/pull/1957
- Browser inference observability roadmap: https://github.com/moeru-ai/airi/issues/1661

### 3.4 AstrBot

Inspected branch: `master`  
Inspected commit: `49095d3ba3fca9272a67aa5eeab2f6c0719c5091`

- Repository: https://github.com/AstrBotDevs/AstrBot
- Commit: https://github.com/AstrBotDevs/AstrBot/commit/49095d3ba3fca9272a67aa5eeab2f6c0719c5091
- Conversation manager: https://github.com/AstrBotDevs/AstrBot/blob/49095d3ba3fca9272a67aa5eeab2f6c0719c5091/astrbot/core/conversation_mgr.py
- Conversation-manager documentation: https://github.com/AstrBotDevs/AstrBot/wiki/en-dev-star-guides-ai

### 3.5 External primary sources

- OpenTelemetry overview: https://opentelemetry.io/docs/what-is-opentelemetry/
- OpenTelemetry context propagation: https://opentelemetry.io/docs/concepts/context-propagation/
- OpenTelemetry traces: https://opentelemetry.io/docs/concepts/signals/traces/
- OpenTelemetry metrics data model: https://opentelemetry.io/docs/specs/otel/metrics/data-model/
- OpenTelemetry logs: https://opentelemetry.io/docs/concepts/signals/logs/
- Prometheus histograms: https://prometheus.io/docs/practices/histograms/
- Prometheus metric types: https://prometheus.io/docs/concepts/metric_types/
- Prometheus instrumentation guidance: https://prometheus.io/docs/practices/instrumentation/
- Google SRE, Service Level Objectives: https://sre.google/sre-book/service-level-objectives/
- Google SRE, Implementing SLOs: https://sre.google/workbook/implementing-slos/
- Google SRE, Error Budget Policy: https://sre.google/workbook/error-budget-policy/
- Google SRE, Canarying Releases: https://sre.google/workbook/canarying-releases/
- PostgreSQL monitoring: https://www.postgresql.org/docs/current/monitoring.html
- PostgreSQL cumulative statistics: https://www.postgresql.org/docs/current/monitoring-stats.html
- PostgreSQL runtime statistics: https://www.postgresql.org/docs/current/runtime-config-statistics.html
- Discord rate limits: https://docs.discord.com/developers/topics/rate-limits

---

## 4. Evidence table

| ID | Claim | Classification | Source URL | Confidence |
|---|---|---|---|---|
| EVID-001 | DC_BOT documents a voice path from Discord through ASR, Gemini, TTS, and Discord playback. | Confirmed repository fact | https://github.com/starryark/DC_BOT | High |
| EVID-002 | `start-bot.ps1` waits for ASR health and a TTS TCP endpoint and refuses bot launch after readiness timeout. | Confirmed repository fact | https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/start-bot.ps1 | High |
| EVID-003 | Current telemetry includes utterance, response epoch, Gemini, TTS cache, synthesis, first-byte, playback, and invariant events. | Confirmed repository fact | https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/telemetry.ts | High |
| EVID-004 | Current telemetry rejects non-scalar fields and drops field names matching secrets, authorization, audio, PCM, prompts, cache contents, and environment patterns. | Confirmed repository fact | Same as EVID-003 | High |
| EVID-005 | The current derived voice metrics use averages/rates and do not provide the latency distributions required for SLO evaluation. | Confirmed repository fact | Same as EVID-003 | High |
| EVID-006 | The conversation controller uses response epochs to stop stale generation/synthesis/playback work. | Confirmed repository fact | https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/conversation-controller.ts | High |
| EVID-007 | Existing session history is committed only after playback drains successfully, but it is not a durable delivery ledger. | Confirmed repository fact plus inference | Same as EVID-006 | High for code behavior; medium for architectural implication |
| EVID-008 | TTS cache disk writes use temporary files, synchronization, rename, validation, and invalid-entry removal. | Confirmed repository fact | https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/providers/tts/tts-cache.ts | High |
| EVID-009 | AIRI memory work visible in the inspected sources includes issues/proposals and an open PR, so it must not be represented as a completed production memory runtime. | Confirmed repository fact | https://github.com/moeru-ai/airi/issues/387; https://github.com/moeru-ai/airi/issues/879; https://github.com/moeru-ai/airi/pull/1957 | High |
| EVID-010 | AstrBot persists conversation content and `add_message_pair` performs a read/append/update flow on a conversation history. | Confirmed repository fact | https://github.com/AstrBotDevs/AstrBot/blob/49095d3ba3fca9272a67aa5eeab2f6c0719c5091/astrbot/core/conversation_mgr.py | High |
| EVID-011 | A mutable whole-history read-modify-write pattern requires explicit concurrency control to rule out lost updates. | Inference | Same as EVID-010 | Medium |
| EVID-012 | OpenTelemetry supports correlated traces, metrics, and logs but does not provide a storage/visualization backend by itself. | External research finding | https://opentelemetry.io/docs/what-is-opentelemetry/ | High |
| EVID-013 | Histograms are appropriate for latency distributions and percentile-oriented SLO analysis. | External research finding | https://prometheus.io/docs/practices/histograms/; https://opentelemetry.io/docs/specs/otel/metrics/data-model/ | High |
| EVID-014 | SLOs should be based on user needs and reviewed with an error-budget policy instead of being copied from current performance. | External research finding | https://sre.google/sre-book/service-level-objectives/; https://sre.google/workbook/error-budget-policy/ | High |
| EVID-015 | Discord clients should honor returned rate-limit information rather than hard-code limits. | External research finding | https://docs.discord.com/developers/topics/rate-limits | High |
| EVID-016 | Shared-memory production must not silently fall back to unrelated ephemeral memory while claiming successful writes. | Source-plan requirement | Uploaded assignment | High |
| EVID-017 | Delivery and persistence cannot be made exactly atomic with Discord send/playback; crash windows require explicit states and reconciliation. | Source-plan requirement | Uploaded assignment | High |
| EVID-018 | Privacy, identity, attribution, delivery correctness, and deletion are release-blocking. | Source-plan requirement | Uploaded assignment | High |

---

## 5. Current-state findings

### 5.1 Useful operational foundations in DC_BOT

**Confirmed repository fact.** The launcher has startup readiness gates for local ASR and TTS dependencies. This is a good pattern for dependency checks, but startup readiness alone does not establish ongoing availability.

**Confirmed repository fact.** Existing voice telemetry covers several important lifecycle points and already rejects suspicious telemetry field names. This should be extended rather than replaced abruptly.

**Confirmed repository fact.** Response epochs prevent stale work from being spoken or committed after cancellation. This is a strong local concurrency invariant.

**Confirmed repository fact.** Current history commit occurs after playback drains. This avoids treating interrupted synthesis/playback as an ordinary completed exchange within the current process.

**Confirmed repository fact.** TTS disk-cache replacement uses temporary files and validation. The same principles—write-ahead intent, atomic visibility, checksum/version validation, and safe cleanup—should inform spool and migration design.

### 5.2 Gaps relative to shared-memory production

**Inference.** Current voice telemetry is optimized for developer diagnostics, not SLOs. Averages obscure tail latency and cannot support percentile objectives or reliable burn-rate alerts.

**Inference.** The existing session-history commit is coupled to a local controller lifecycle and does not record durable Discord delivery attempts, ambiguous outcomes, restart reconciliation, or many-to-many causal relations.

**Open question.** No verified repository evidence establishes a production shared-memory authority, durable append ledger, deletion workflow, export workflow, cross-scope detector, or remote-runtime failover path in DC_BOT.

**Open question.** The initial deployment topology remains undecided. Operational semantics therefore must not depend on HTTP or on a standalone service.

### 5.3 Comparison-repository lessons

**Confirmed repository fact.** AIRI provides useful architectural discussion, but inspected memory work includes proposals and an open pull request. It is directional evidence, not proof of production readiness.

**Confirmed repository fact.** AstrBot provides a persisted conversation baseline and history-management API.

**Inference.** A whole-history read/modify/write design is not an acceptable concurrency assumption for a multi-speaker, multi-medium event ledger unless version checks, transactions, or append semantics are demonstrated.

---

## 6. Proposed decisions

### ADR-016-001 — Topology-neutral telemetry contract

**Decision: Recommendation.** Define one semantic telemetry contract at the `MemoryPort` boundary. In-process SQLite, in-process PostgreSQL, and a remote Memory Runtime emit the same operation names, result classes, identifiers, and SLI events. Deployment-specific measurements may add `backend` and `deployment_mode`, but must not change success semantics.

### ADR-016-002 — Explicit success and degraded states

**Decision: Recommendation.** Every operation returns one of:

- `succeeded`;
- `rejected`;
- `failed_definite`;
- `accepted_pending_authority` only when an approved durable spool has synchronously accepted the record;
- `outcome_unknown`;
- `degraded_read`;
- `cancelled`.

No caller may translate a failed memory write into `succeeded`, and no process-local history may impersonate the memory authority.

### ADR-016-003 — Separate persistence, generation, and delivery

**Decision: Recommendation.** Persist inbound events and assistant artifacts separately from delivery attempts. History eligibility is derived from durable delivery state; it is not set merely because content was generated.

### ADR-016-004 — Distribution metrics, not averages alone

**Decision: Recommendation.** All latency SLIs use histograms with documented units and bucket strategy. Dashboards may show averages, but alerts and SLOs use ratios, percentiles, or threshold-compliance counts.

### ADR-016-005 — Bounded-cardinality metrics

**Decision: Recommendation.** Metrics may label by operation, stage, result, medium, backend, deployment mode, scope type, queue, store, and bounded reason class. They must never label by event ID, turn ID, user ID, guild ID, conversation ID, room ID, alias, job ID, free-form exception, or raw URL.

### ADR-016-006 — Content-free default telemetry

**Decision: Recommendation.** Default logs, metrics, and traces contain identifiers and metadata only. User content, prompts, transcripts, model output, memory text, audio, embeddings, and presentation attributes are prohibited.

### ADR-016-007 — Durable deletion and export workflow

**Decision: Recommendation.** Deletion and export are job workflows with manifests, per-store states, retry/dead-letter behavior, completion evidence, and operator-visible deadlines. “Completed” means every required active store and derived index has reported the policy-defined terminal state.

### ADR-016-008 — Correctness and privacy outrank availability

**Decision: Recommendation.** Authorization ambiguity, corrupt room binding, schema incompatibility, suspected cross-scope leakage, and deletion-integrity failure are fail-closed conditions. Availability error budgets cannot excuse privacy or correctness violations.

### ADR-016-009 — Reconciliation instead of automatic replay

**Decision: Recommendation.** On restart, text deliveries with unknown outcomes are reconciled using durable Discord identifiers when possible. Voice playback with unknown outcome is not replayed automatically because replay can duplicate speech and there is no reliable proof that a human heard the prior output.

### ADR-016-010 — SLOs require measured approval

**Decision: Recommendation.** Numeric targets below remain hypotheses until the procedure in Section 10 is completed and signed off by product, operations, privacy/security, and the text/voice owners.

---

## 7. Alternatives considered

### 7.1 Standalone Memory Runtime immediately

**Alternative.** Require HTTP/gRPC and operate memory as a separate service in milestone one.

**Benefit.** Independent scaling, fault domain, deployment, and language neutrality.

**Cost.** Adds network latency, service discovery, credentials, distributed tracing, retries, partial failure, schema compatibility, and a second deployment before repository evidence establishes the need.

**Decision.** Deferred. Preserve protocol and telemetry compatibility so this remains a migration path.

### 7.2 In-process memory only, with process-local fallback

**Alternative.** Use local in-memory history whenever persistent storage fails.

**Benefit.** High apparent availability and simple user experience.

**Cost.** Split-brain history, untracked writes, inconsistent text/voice behavior, deletion gaps, and false success.

**Decision.** Rejected.

### 7.3 Exactly-once Discord delivery

**Alternative.** Treat database commit and Discord delivery as one atomic transaction.

**Decision.** Rejected as an unavailable guarantee. Use idempotency, durable attempts, explicit `outcome_unknown`, reconciliation, and duplicate detection.

### 7.4 Log message text for debugging

**Alternative.** Store prompts, transcripts, and retrieved memory in standard application logs.

**Benefit.** Fast diagnosis.

**Cost.** Privacy leakage, prompt-injection propagation, retention conflicts, high breach impact, and difficult deletion.

**Decision.** Rejected by default. A controlled incident-capture mode is specified instead.

### 7.5 SLOs based on fixed design numbers

**Alternative.** Adopt arbitrary append/retrieval/voice deadlines before benchmarks.

**Decision.** Rejected. Candidate values may guide test design but do not become objectives without evidence and approval.

---

## 8. Rejected alternatives and reasons

| ID | Rejected alternative | Reason |
|---|---|---|
| REJ-016-001 | Silent ephemeral-memory fallback | Violates source-plan requirement and creates split-brain truth. |
| REJ-016-002 | Raw Discord IDs as metric labels | High cardinality and unnecessary personal-data exposure. |
| REJ-016-003 | Prompt/transcript logging | Violates least-data telemetry and complicates deletion. |
| REJ-016-004 | Commit assistant history at generation completion | Confuses generation with delivery and mishandles interruption. |
| REJ-016-005 | Automatic replay of unknown voice delivery | Can duplicate audible output without proving prior outcome. |
| REJ-016-006 | Ignore sequence conflicts and accept last write | Can lose or reorder attributable events. |
| REJ-016-007 | Retry all failed worker jobs forever | Produces poison-message loops and hides permanent failure. |
| REJ-016-008 | Flush every cache globally on any stale read | Creates avoidable load spikes; use versioned, scoped invalidation. |
| REJ-016-009 | Treat backups as immediately mutable append history | Conflicts with immutable backup properties; use policy-approved expiry, tombstone, or crypto-erasure semantics. |
| REJ-016-010 | Use availability error budget for privacy leaks | Privacy/cross-scope correctness requires incident handling, not budget consumption. |

---

## 9. Normative specification and detailed plan

Normative terms **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are used as requirements.

### 9.1 Operational invariants

- **REQ-OPS-001.** A successful event append MUST mean the authoritative store committed the event, or an approved durable spool synchronously committed an `accepted_pending_authority` record.
- **REQ-OPS-002.** A failed append MUST NOT be represented as successful.
- **REQ-OPS-003.** Retrieval MUST authorize scope before returning or ranking memory.
- **REQ-OPS-004.** A corrupt or ambiguous logical-room binding MUST fail closed.
- **REQ-OPS-005.** Every retryable write MUST use an idempotency key.
- **REQ-OPS-006.** Sequence conflicts MUST be observable and MUST NOT silently overwrite accepted events.
- **REQ-OPS-007.** Assistant generation, persistence, Discord dispatch, and delivery outcome MUST be distinct.
- **REQ-OPS-008.** Unknown delivery MUST remain unknown until reconciled; it MUST NOT be converted to delivered by timeout alone.
- **REQ-OPS-009.** Interrupted, failed, cancelled, or outcome-unknown assistant output MUST NOT become an ordinary completed conversational turn.
- **REQ-OPS-010.** Worker jobs MUST have bounded retries and a dead-letter terminal path.
- **REQ-OPS-011.** Deletion completion MUST be supported by a per-store manifest.
- **REQ-OPS-012.** Cross-scope leak detections MUST page an operator and stop the affected retrieval path.
- **REQ-OPS-013.** Telemetry MUST default to content-free operation.
- **REQ-OPS-014.** Schema incompatibility MUST fail startup or isolate incompatible traffic; it MUST NOT be ignored.
- **REQ-OPS-015.** Production MUST expose memory-authority health independently from bot-process health.
- **REQ-OPS-016.** Degraded behavior MUST be user- and operator-visible through stable result codes and telemetry.

### 9.2 Metric conventions

- Prefix: `memory_` for shared-memory operations; existing voice metrics may retain names during transition but SHOULD map to the same semantic spans.
- Duration unit: seconds in metric backends; milliseconds may be used in structured logs.
- Counters: suffix `_total`.
- Histograms: suffix `_duration_seconds`, `_size_bytes`, or domain-specific unit.
- Gauges: current queue depth, oldest age, active connections, disk free space.
- IDs appear in logs/traces only, never in metric labels.
- Error labels use bounded `error_class`, not exception messages.
- Each metric definition MUST specify owner, unit, labels, cardinality estimate, retention, and dashboard/alert use before production enablement.

### 9.3 Required metric catalog

| Metric | Type | Required labels | Meaning and required use |
|---|---|---|---|
| `memory_event_append_duration_seconds` | Histogram | `backend`, `deployment_mode`, `result`, `medium` | Authoritative append latency from call entry to durable result. |
| `memory_event_append_total` | Counter | `result`, `medium`, `error_class` | Append success, rejection, definite failure, pending-authority, or unknown result. |
| `memory_context_assembly_duration_seconds` | Histogram | `medium`, `result`, `degraded` | Time to authorize, select, and serialize context, excluding model generation. |
| `memory_delivery_record_duration_seconds` | Histogram | `medium`, `delivery_state`, `result` | Time to durably record a delivery transition. |
| `memory_retrieval_stage_duration_seconds` | Histogram | `stage`, `backend`, `result`, `medium` | Latency for `authorize`, `structured`, `temporal`, `lexical`, optional `vector`, optional `rerank`, and `serialize`. |
| `memory_retrieval_total` | Counter | `result`, `degraded_reason`, `medium` | Completed, degraded, rejected, or failed retrievals. |
| `memory_cache_requests_total` | Counter | `cache`, `result` | Hit, miss, stale-hit-prevented, bypass, or error. |
| `memory_cache_entry_age_seconds` | Histogram | `cache`, `result` | Age of served or rejected cache entries. |
| `memory_degraded_retrieval_total` | Counter | `reason`, `medium` | Retrieval completed without one or more approved stages. |
| `memory_idempotency_duplicates_total` | Counter | `operation`, `resolution` | Duplicate requests and whether prior result was replayed, pending, or conflicting. |
| `memory_sequence_conflicts_total` | Counter | `entity_type`, `resolution` | Version/sequence conflicts for rooms, streams, identities, or jobs. |
| `memory_worker_jobs` | Gauge | `queue`, `state` | Ready, leased, retry-wait, dead-letter, or blocked jobs. |
| `memory_worker_oldest_job_age_seconds` | Gauge | `queue`, `state` | User-impacting backlog age; primary backlog alert input. |
| `memory_worker_attempts_total` | Counter | `queue`, `result`, `error_class` | Worker success, retry, permanent failure, cancellation. |
| `memory_worker_dead_letters_total` | Counter | `queue`, `error_class` | Jobs entering dead letter. |
| `memory_summary_duration_seconds` | Histogram | `result`, `model_class` | Summary-job processing time outside the critical voice path. |
| `memory_summary_lag_seconds` | Histogram | `result` | Delay from eligibility to completed summary. |
| `memory_summary_total` | Counter | `result`, `error_class` | Summary success/failure/retry. |
| `memory_extraction_duration_seconds` | Histogram | `result`, `model_class` | Memory extraction processing time. |
| `memory_extraction_lag_seconds` | Histogram | `result` | Delay from eligibility to durable extraction. |
| `memory_extraction_total` | Counter | `result`, `error_class` | Extraction success/failure/retry. |
| `memory_supersession_duration_seconds` | Histogram | `result` | Time to apply correction/supersession and invalidate dependent views. |
| `memory_supersession_total` | Counter | `result`, `reason_class` | Applied, no-op, conflict, rejected, or failed supersession. |
| `memory_deletion_propagation_seconds` | Histogram | `store`, `result` | Time from accepted deletion request to terminal state in each store. |
| `memory_deletion_items_total` | Counter | `store`, `state`, `item_class` | Pending, deleted, redacted, tombstoned, expired-in-backup, or failed items. |
| `memory_deletion_requests` | Gauge | `state` | Active deletion workflows by state. |
| `memory_authorization_decisions_total` | Counter | `decision`, `reason`, `scope_type`, `operation` | Allow/reject decisions; rejection-rate SLI. |
| `memory_cross_scope_leak_detections_total` | Counter | `detector`, `severity`, `environment` | Synthetic or production leak detections. Any production confirmed event is incident-worthy. |
| `memory_delivery_history_divergence_total` | Counter | `medium`, `kind` | Delivered-without-history, history-without-delivery, duplicate, illegal transition, or unresolved unknown. |
| `memory_voice_added_latency_seconds` | Histogram | `stage`, `result`, `deployment_mode` | Memory-related added time on voice critical path. |
| `memory_db_query_duration_seconds` | Histogram | `operation`, `result`, `backend` | Database call latency by bounded operation. |
| `memory_db_pool_connections` | Gauge | `state`, `backend` | Active, idle, waiting, max. |
| `memory_db_lock_wait_seconds` | Histogram | `operation`, `backend` | Lock-wait distribution. |
| `memory_db_transactions_total` | Counter | `result`, `backend`, `error_class` | Commit, rollback, serialization retry, timeout. |
| `memory_db_disk_free_bytes` | Gauge | `backend`, `volume_class` | Capacity guard; no host/path label. |
| `memory_db_replication_lag_seconds` | Gauge | `backend`, `replica_class` | When PostgreSQL replication exists. |
| `memory_authority_requests_total` | Counter | `operation`, `result`, `deployment_mode` | Availability denominator/numerator. |
| `memory_authority_inflight_requests` | Gauge | `operation`, `deployment_mode` | Saturation and overload signal. |
| `memory_spool_items` | Gauge | `state` | Pending, replaying, blocked, corrupt. Emitted only when spool exists. |
| `memory_spool_bytes` | Gauge | `state` | Spool capacity. |
| `memory_spool_oldest_age_seconds` | Gauge | `state` | Oldest pending record age. |
| `memory_spool_replay_total` | Counter | `result`, `error_class` | Replay success, duplicate, retry, permanent failure. |
| `memory_export_completion_seconds` | Histogram | `result`, `format_class` | Accepted request to completed/failed export. |
| `memory_export_requests` | Gauge | `state` | Active export workflows. |
| `memory_schema_compatibility` | Gauge | `component`, `status` | Exactly one for compatible, zero for incompatible/unknown. |
| `memory_migration_total` | Counter | `migration_class`, `result` | Applied, rolled back, blocked, failed. |

### 9.4 Derived SLIs

**Availability SLI**

```text
successful authoritative operations
-----------------------------------
eligible authoritative operations
```

Eligible operations exclude malformed and unauthorized requests but include dependency failures. `accepted_pending_authority` is not counted as authoritative success until replay commits; a separate degraded-acceptance SLI tracks it.

**Append durability SLI**

```text
event appends reaching authoritative durable commit within threshold
-------------------------------------------------------------------
eligible event append attempts
```

**Retrieval latency SLI**

```text
authorized retrievals completed within threshold
------------------------------------------------
authorized retrieval attempts
```

Report separately for text/voice, local/remote, cold/warm cache, and workload class.

**Delivery-history consistency SLI**

```text
terminal delivery records with correct derived history eligibility
------------------------------------------------------------------
all terminal delivery records
```

`outcome_unknown` is tracked separately, not treated as success.

**Deletion completion SLI**

```text
deletion workflows reaching policy-defined complete within deadline
-------------------------------------------------------------------
accepted deletion workflows
```

A workflow cannot complete while a required store is `unknown`, `retrying`, or `failed`.

**Privacy/cross-scope SLI**

This is a correctness invariant, not an error-budgeted availability objective:

```text
confirmed cross-scope disclosures = 0
false deletion-complete declarations = 0
```

### 9.5 Structured log schema

Every operational event SHOULD use this envelope:

```json
{
  "timestamp": "RFC3339 UTC",
  "severity": "INFO|WARN|ERROR|CRITICAL",
  "schema_version": "ops-event/v1",
  "event_name": "memory.event.append.completed",
  "service_name": "discord-bot|memory-runtime|memory-worker",
  "service_version": "commit-or-release",
  "deployment_mode": "in_process|remote",
  "environment": "dev|staging|production",
  "trace_id": "opaque",
  "span_id": "opaque",
  "turn_id": "opaque",
  "event_id": "opaque",
  "conversation_id": "opaque",
  "logical_room_id": "opaque",
  "snapshot_version": 42,
  "medium": "text|voice",
  "operation": "append_event",
  "latency_ms": 18,
  "count": 1,
  "token_estimate": 730,
  "degraded": false,
  "error_class": null,
  "delivery_state": null,
  "worker_job_id": null,
  "result": "succeeded"
}
```

Rules:

- IDs MUST be internal opaque identifiers. Raw Discord snowflakes MUST NOT be used as default telemetry IDs.
- Missing non-applicable fields SHOULD be omitted rather than populated with user data.
- `error_class` MUST come from a bounded taxonomy.
- Exception messages and stack traces MUST be scrubbed before export.
- `token_estimate` is an integer estimate, not prompt text.
- `count` is an aggregate count, not a list.
- `snapshot_version` records what generation/retrieval observed; it does not imply optimistic rejection of ordinary concurrent appends.
- Log event names and field semantics MUST be versioned.
- Security audit events MAY use a separate protected sink with stricter access and retention.

Required event families:

- `memory.event.append.started|completed`
- `memory.context.assembly.completed`
- `memory.retrieval.stage.completed`
- `memory.authorization.decided`
- `memory.cache.lookup.completed`
- `memory.delivery.transition`
- `memory.delivery.reconciliation`
- `memory.worker.transition`
- `memory.deletion.store_transition`
- `memory.export.transition`
- `memory.schema.compatibility`
- `memory.migration.transition`
- `memory.scope_leak.detected`
- `memory.credential.use_rejected`
- `memory.incident.capture_enabled|disabled`

### 9.6 Data that must never be logged by default

- message bodies, transcripts, prompts, system prompts, model responses, summaries, extracted memories, retrieved documents, or procedural-memory text;
- audio, PCM, encoded audio, spectrograms, voiceprints, or reference-voice material;
- usernames, global display names, guild nicknames, aliases, avatar URLs, email addresses, phone numbers, or IP addresses;
- raw Discord user, guild, channel, message, webhook, or interaction identifiers;
- API keys, OAuth tokens, bot tokens, cookies, authorization headers, refresh tokens, private keys, database passwords, or connection strings;
- complete environment-variable dumps;
- embedding vectors, reranker features, graph payloads, or cache contents;
- unredacted SQL parameters, full query text containing values, filesystem paths containing identity data, or export bundle contents;
- deletion-subject selectors or identity-resolution evidence;
- free-form exception objects when they can contain request payloads;
- internal opaque person references if they can be surfaced to user-visible logs or responses;
- Discord mentions or user-controlled strings as log keys, metric labels, span names, or alert titles.

**Recommendation.** An incident-only content capture mode MAY exist only with: named incident ID, two-person authorization, explicit scope, encryption, access audit, maximum duration, short retention, automated disablement, redaction, and deletion workflow integration. It MUST remain off by default.

### 9.7 Trace model

Root trace options:

- `discord.text.turn`
- `discord.voice.turn`
- `memory.worker.job`
- `memory.deletion.request`
- `memory.export.request`

Recommended synchronous child spans:

```text
discord.*.turn
├── actor.snapshot.validate
├── memory.authorize
├── memory.event.append
├── memory.context.assemble
│   ├── memory.retrieve.structured
│   ├── memory.retrieve.temporal
│   ├── memory.retrieve.lexical
│   ├── memory.retrieve.vector       (only if enabled)
│   ├── memory.retrieve.rerank       (only if enabled)
│   └── memory.context.serialize
├── model.generate
├── delivery.dispatch
└── memory.delivery.record
```

Async summary, extraction, supersession, export, and deletion jobs SHOULD start new traces linked by `event_id` and `worker_job_id`; they SHOULD NOT preserve an indefinitely long parent span.

Trace requirements:

- W3C trace context SHOULD propagate across a remote Memory Runtime.
- Sensitive values MUST NOT be placed in trace baggage.
- Error, privacy, deletion, schema, migration, and delivery-unknown traces SHOULD be sampled at 100%.
- Successful high-volume traffic MAY be sampled deterministically using a non-sensitive opaque ID.
- Metrics remain complete even when traces are sampled.
- Clock measurements use monotonic timers inside a process; cross-process timelines use synchronized UTC and record clock-skew health.

### 9.8 Error taxonomy

Minimum bounded classes:

`authorization_rejected`, `scope_binding_corrupt`, `dependency_unavailable`, `timeout`, `overloaded`, `rate_limited`, `idempotency_conflict`, `sequence_conflict`, `schema_mismatch`, `migration_failed`, `data_corrupt`, `cache_stale`, `spool_full`, `spool_corrupt`, `worker_poison`, `delivery_rejected`, `delivery_outcome_unknown`, `privacy_suspected`, `credential_rejected`, `validation_failed`, `cancelled`, `internal_error`.

### 9.9 Delivery and history state machine

#### Text delivery

```text
generated
  └── dispatch_planned
        └── dispatching
              ├── acknowledged(message_id)
              ├── failed_definite
              └── outcome_unknown
                       ├── reconciled_acknowledged
                       ├── reconciled_not_sent
                       └── unresolved
```

#### Voice delivery

```text
generated
  └── playback_queued
        └── playback_started
              ├── playback_completed
              ├── playback_interrupted
              ├── failed_definite
              └── outcome_unknown
```

History eligibility:

| Delivery state | Eligible as completed assistant turn? |
|---|---|
| Text `acknowledged` or `reconciled_acknowledged` | Yes |
| Voice `playback_completed` | Yes, as transport-completed; not proof a human heard it |
| `failed_definite` | No |
| `playback_interrupted` | No |
| `outcome_unknown` or `unresolved` | No normal completion; preserve artifact and reconciliation evidence |
| `cancelled` before dispatch/playback | No |

**REQ-DELIVERY-016.** Every state transition MUST be append-recorded with previous state, next state, attempt number, timestamp, and idempotency key.

**REQ-DELIVERY-017.** Illegal transitions MUST be rejected and counted.

**REQ-DELIVERY-018.** An assistant artifact MAY be causally linked to several user events, and one user event MAY influence several artifacts; operational correlation MUST support many-to-many causal edges.

### 9.10 Resilience behavior matrix

| Condition | Required behavior | User-visible behavior | Operator signal |
|---|---|---|---|
| Authoritative DB unavailable, no spool | Reject memory writes; do not pretend persistence | Clear temporary memory-unavailable response or configured suppression | Page on availability burn and append failures |
| DB unavailable, approved spool healthy | Return `accepted_pending_authority`; retrieval limited to authorized committed state | Explicit degraded indicator where product policy requires | Spool backlog/age alarms |
| Remote runtime unavailable | Circuit break; bounded retries; optional durable spool; no local split-brain authority | Degraded/unavailable notice | Runtime availability and circuit state |
| Retrieval stage slow | Enforce per-stage budgets; skip only approved optional stages; mark degraded | Continue only under approved degraded policy | Stage latency and degraded-rate alarms |
| Authorization dependency fails | Fail closed | No memory returned | Immediate page if sustained |
| Room binding corrupt | Quarantine binding; no cross-room retrieval | Ask user to retry later, without exposing binding details | Privacy/correctness page |
| Cache stale or version mismatch | Bypass/evict; read authoritative store | Minor latency increase | Stale-prevented counter |
| Worker poison job | Bounded retries, then dead letter | No critical-path block unless deletion/export deadline affected | DLQ alert |
| Spool disk near full | Stop accepting pending-authority writes before corruption | Memory unavailable, not false success | Capacity page |
| Schema mismatch | Refuse incompatible startup/traffic | Service unavailable or routed to compatible version | Deployment block |
| Delivery outcome unknown | Reconcile text; preserve unknown voice; no blind replay | Avoid duplicate output | Divergence alert |
| Suspected privacy leak | Disable affected retrieval path and preserve evidence without content expansion | Minimal incident-safe notice | SEV-0 response |
| Credential compromise | Revoke/rotate, isolate service, invalidate sessions | Temporary outage possible | SEV-0/SEV-1 response |

### 9.11 Alerting principles

- Page on user-visible unavailability, correctness, privacy, data-loss risk, deletion deadline risk, and sustained queue age.
- Ticket on capacity trends, low-rate dead letters, cache inefficiency, and non-urgent SLO drift.
- Prefer multi-window burn-rate alerts for approved SLOs.
- Alert on oldest-job age rather than count alone.
- Resource alerts such as CPU or connection saturation should include a correlated user-impact signal or imminent exhaustion threshold.
- Every page MUST link to one runbook and one dashboard.
- Every alert MUST state owner, urgency, expected action, and safe rollback.
- Alerts MUST be tested through synthetic fault injection before production approval.

---

## 10. SLO and voice-deadline measurement and approval

### 10.1 Candidate hypotheses, not approved objectives

The following are **Recommendation: test hypotheses only**:

| Workload | Candidate threshold for evaluation | Notes |
|---|---:|---|
| In-process authoritative append | p95 ≤ 25 ms; p99 ≤ 75 ms | Benchmark SQLite and PostgreSQL separately, including fsync policy. |
| Remote authoritative append | p95 ≤ 75 ms; p99 ≤ 200 ms | Same-region target; include serialization and network. |
| Context assembly, text | p95 ≤ 250 ms | Excludes model generation; includes authorization and serialization. |
| Context assembly, voice | p95 ≤ 150 ms | Must preserve voice responsiveness. |
| Total retrieval, text | p95 ≤ 400 ms | Optional stages may be disabled only by approved policy. |
| Total retrieval, voice | p95 ≤ 200 ms | Measure cold/warm and multilingual workloads. |
| Delivery-state recording, local | p95 ≤ 50 ms | Must not block indefinitely after Discord acknowledgement. |
| Delivery-state recording, remote | p95 ≤ 150 ms | Failure creates explicit reconciliation work. |
| Added memory latency to first audible voice output | p95 ≤ 200 ms; p99 ≤ 400 ms | Establish through A/B comparison against memory-disabled baseline. |
| Memory authority availability | 99.9% monthly candidate | Separate reads/writes and local/remote modes. |
| Online deletion propagation | p95 ≤ 15 min; 100% ≤ 24 h candidate | Backup handling depends on approved privacy policy. |
| Export completion | p95 ≤ 15 min; 99% ≤ 24 h candidate | Segment by export size class. |
| Spool oldest record | warning at 5 min; page at 30 min candidate | Re-evaluate from recovery objectives and volume. |

These numbers MUST NOT be published as promises or encoded as hard release gates until approved.

### 10.2 Measurement protocol

1. **Define user journeys.** At minimum: text turn, one-speaker voice turn, multi-speaker voice turn, DM, guild room, bound cross-channel logical room, correction/supersession, deletion, export, and restart reconciliation.
2. **Define exact boundaries.** Document start/end timestamps for every SLI. For example, event append begins at `MemoryPort.appendEvent` entry and ends only at durable authority result.
3. **Instrument distributions.** Use histograms and threshold-compliance counters; preserve text/voice, deployment mode, backend, cache state, and workload class.
4. **Calibrate telemetry.** Compare spans against controlled timers and synthetic delays. Verify no negative durations, unit errors, double counts, or missing terminal states.
5. **Collect a representative baseline.** Run at least two continuous weeks and preferably four, covering expected concurrency, cold starts, cache churn, multilingual/CJK content, group voice, large histories, worker load, and network impairment.
6. **Benchmark fault modes.** Inject DB loss, remote-runtime loss, lock contention, cache invalidation, slow optional retrieval, Discord timeout, process crash, spool fill, poison jobs, and schema skew.
7. **Separate workload classes.** Report local/remote, text/voice, cold/warm, payload-size class, language/tokenization class, and concurrency level. Do not hide slow classes in a global percentile.
8. **Perform voice A/B tests.** Replay a fixed corpus through memory-disabled and memory-enabled paths on the target hardware. Measure added time from finalized utterance to first audible byte and to playback completion. Repeat warm/cold and with background worker load.
9. **Validate quality guardrails.** A latency improvement is unacceptable if it raises authorization errors, cross-scope leakage, stale retrieval, attribution errors, or delivery divergence.
10. **Propose objectives.** Reliability owner drafts thresholds and error-budget windows from measured distributions and user research.
11. **Approve jointly.** Required signatories: text owner, voice owner, memory/data owner, operations owner, product owner, and privacy/security owner.
12. **Canary.** Enable for a small traffic slice with rollback on correctness/privacy invariants or excessive error-budget burn.
13. **Review.** Reapprove after topology, model, database, index, Discord library, scope model, or hardware changes; otherwise review at least quarterly.

### 10.3 Approval record

Each approved SLO MUST record:

- SLI query and exact numerator/denominator;
- target and window;
- included/excluded traffic;
- workload segmentation;
- measurement version and dashboard;
- owner and paging policy;
- error-budget action;
- baseline dates and sample size;
- known blind spots;
- approval names/date;
- next review date.

### 10.4 Error-budget policy

**Recommendation.**

- At 25% budget consumed before 50% of window: reliability review.
- At 50% consumed before 50% of window: freeze risky memory features.
- At 100% consumed: stop non-remediation releases until recovered.
- A confirmed cross-scope leak, false deletion completion, credential exfiltration, or silent write-loss bypasses error-budget arithmetic and triggers incident policy immediately.

---

## 11. Interfaces, schemas, diagrams, and test vectors

### 11.1 Topology-neutral operation result

```ts
type MemoryOperationResult<T> =
  | { status: "succeeded"; value: T; authorityCommitId: string }
  | { status: "rejected"; errorClass: string }
  | { status: "failed_definite"; errorClass: string; retryable: boolean }
  | {
      status: "accepted_pending_authority";
      spoolRecordId: string;
      durability: "fsynced";
    }
  | { status: "outcome_unknown"; reconciliationId: string }
  | {
      status: "degraded_read";
      value: T;
      omittedStages: string[];
      reason: string;
    }
  | { status: "cancelled" };
```

This is specification pseudocode, not production code.

### 11.2 Delivery transition record

```json
{
  "transition_id": "opaque",
  "assistant_artifact_id": "opaque",
  "attempt_id": "opaque",
  "medium": "text",
  "previous_state": "dispatching",
  "next_state": "outcome_unknown",
  "occurred_at": "RFC3339 UTC",
  "discord_message_id_encrypted": null,
  "idempotency_key_hash": "opaque",
  "error_class": "delivery_outcome_unknown",
  "trace_id": "opaque"
}
```

Raw Discord delivery identifiers, when required for reconciliation, SHOULD be encrypted in the operational datastore and omitted from ordinary logs.

### 11.3 Deletion manifest

```json
{
  "deletion_request_id": "opaque",
  "policy_version": "privacy-delete/v1",
  "accepted_at": "RFC3339 UTC",
  "deadline_at": "RFC3339 UTC",
  "stores": [
    {"store": "raw_events", "state": "deleted", "completed_at": "..."},
    {"store": "summaries", "state": "deleted", "completed_at": "..."},
    {"store": "semantic_index", "state": "deleted", "completed_at": "..."},
    {"store": "cache", "state": "invalidated", "completed_at": "..."},
    {"store": "backup", "state": "expiry_scheduled", "completed_at": null}
  ],
  "overall_state": "pending_backup_policy"
}
```

### 11.4 Representative test vectors

| Vector | Input/fault | Expected result |
|---|---|---|
| TV-016-001 | Same event and idempotency key submitted twice | One event; second call returns prior result; duplicate counter increments. |
| TV-016-002 | Same idempotency key with different payload hash | Reject as `idempotency_conflict`; page only if sustained/attack-like. |
| TV-016-003 | Another event appends during generation | Existing generation snapshot remains evidence; ordinary append is not rejected merely due to snapshot change. |
| TV-016-004 | DB commit succeeds, process crashes before response | Retry resolves via idempotency record; no duplicate event. |
| TV-016-005 | Discord text send times out after remote acceptance | Delivery becomes `outcome_unknown`; reconcile before resend. |
| TV-016-006 | Process dies after voice playback starts | Delivery remains unknown/interrupted; do not auto-replay or mark complete. |
| TV-016-007 | Private alias appears in public-room retrieval candidate | Authorization/serialization removes it; canary detector remains zero. |
| TV-016-008 | Cache version older than room-binding version | Cache entry rejected and invalidated; authoritative read used. |
| TV-016-009 | Deletion succeeds in DB but embedding deletion fails | Workflow remains failed/pending; no completion declaration. |
| TV-016-010 | Remote runtime unavailable with no approved spool | Write fails explicitly; no local-history success. |
| TV-016-011 | Remote runtime unavailable with healthy spool | Return `accepted_pending_authority`, then replay idempotently after recovery. |
| TV-016-012 | Worker job repeatedly fails validation | Bounded retries, then dead letter with content-free diagnostics. |

---

## 12. Failure modes

| RISK ID | Failure mode | Detection | Required containment |
|---|---|---|---|
| RISK-016-001 | False successful write | Append result mismatch, restart verification, audit reconciliation | Stop writes; mark affected range; repair from idempotency/spool evidence |
| RISK-016-002 | Split-brain local and remote memory | Divergent authority IDs or local fallback metric | Disable fallback; choose authority; reconcile explicitly |
| RISK-016-003 | Cross-scope retrieval | Synthetic canary, authorization audit, user report | Disable affected retrieval path; SEV-0 privacy response |
| RISK-016-004 | Delivery/history divergence | Divergence counter and reconciliation scan | Stop history promotion; reconcile affected artifacts |
| RISK-016-005 | Duplicate Discord text | Duplicate detector, repeated message ID/content fingerprint in protected ledger | Halt automatic retry for affected key; reconcile |
| RISK-016-006 | Duplicate voice playback | Playback attempt ledger and user report | Stop auto replay; preserve unknown state |
| RISK-016-007 | Stale authorization/cache | Version mismatch and stale-prevented metric | Bypass cache; invalidate scoped keys |
| RISK-016-008 | Queue poison/backlog | Oldest age, retries, dead letters | Pause producer or isolate poison job |
| RISK-016-009 | Spool fills/corrupts | Capacity, checksum, replay failures | Stop accepting pending-authority writes |
| RISK-016-010 | Schema skew | Compatibility gauge/startup handshake | Block incompatible instance |
| RISK-016-011 | Migration partial failure | Migration ledger/checksum/version mismatch | Stop traffic; rollback or restore using tested procedure |
| RISK-016-012 | Deletion falsely completes | Manifest audit and residual canary lookup | Reopen request; privacy incident review |
| RISK-016-013 | Telemetry leaks content | Schema validator/DLP scan | Disable sink; restrict access; incident response |
| RISK-016-014 | Metric cardinality explosion | Time-series count and label audit | Drop offending labels; protect backend |
| RISK-016-015 | Clock skew distorts traces | NTP/clock health and impossible durations | Use monotonic local durations; flag cross-host timeline |
| RISK-016-016 | Authorization fail-open during dependency loss | Fault injection and decision counters | Enforce fail-closed policy |
| RISK-016-017 | Optional retrieval degrades silently | Degraded flag/rate | Expose degradation and enforce approved budget |
| RISK-016-018 | Backup retains erased data beyond policy | Backup manifest and restore audit | Apply approved expiry/crypto-erasure/tombstone process |

---

## 13. Security and privacy implications

**Source-plan requirement.** Retrieved memory is untrusted data. Operational tooling must not convert memory content into commands, log structure, alert titles, or trace attributes.

**Recommendation.**

- Use role-based access to dashboards, logs, traces, deletion manifests, exports, and reconciliation ledgers.
- Encrypt telemetry in transit and at rest.
- Give application logs shorter retention than authoritative audit records.
- Maintain an audited break-glass path.
- Treat stable opaque IDs as pseudonymous data; they still require access and retention controls.
- Keep security audit logs separate from user-content storage and ordinary application logs.
- Validate all log fields against a schema and length limit before emission.
- Escape control characters and prevent user-controlled strings from defining JSON keys, span names, labels, or dashboard links.
- Maintain synthetic identities/scopes as privacy canaries. Their appearance outside authorized test contexts is an immediate incident.
- Ensure deletion policy explicitly addresses operational ledgers, telemetry correlation IDs, exports, caches, derived indexes, dead letters, spools, and backups.
- Credential rotation must cover Discord bot credentials, database credentials, remote-memory service credentials, observability exporters, model providers, and encryption keys.
- Avoid placing credentials in command lines, process listings, crash dumps, or environment snapshots.
- Prompt-injection response must distinguish model-behavior incidents from authorization failures. The model cannot grant itself broader memory scope.

**Open question.** Whether operational ledgers retain pseudonymous correlation records after a user deletion requires a legal/privacy decision balancing audit integrity and erasure obligations.

---

## 14. Operational runbooks

### Common incident entry procedure

1. Declare severity and incident ID.
2. Freeze destructive automation affecting the incident domain.
3. Preserve content-free telemetry, deployment version, schema version, and time range.
4. Do not paste user content or credentials into the incident channel.
5. Identify affected environment, deployment mode, backend, medium, scopes, and first known bad time.
6. Prefer safe containment over speculative repair.
7. Record every manual state change.
8. Close only after verification tests and backlog/reconciliation completion.

Severity guidance:

- **SEV-0:** confirmed/suspected cross-scope disclosure, credential compromise with access, deliberate data corruption, or broad false deletion completion.
- **SEV-1:** memory authority unavailable with significant impact, migration failure with data risk, large delivery divergence, deletion deadline breach.
- **SEV-2:** sustained slow retrieval, worker backlog, stale cache, limited dead letters.
- **SEV-3:** low-impact anomaly without user-visible correctness risk.

### RUNBOOK-016-001 — Database unavailable

**Trigger:** append/read failures, connection exhaustion, health-check failure, transaction timeout spike, disk exhaustion, or database process loss.

**Immediate safety**

1. Determine whether this is the authoritative database.
2. Disable any code path that would claim successful writes without authority.
3. If no approved spool exists, fail writes explicitly.
4. If an approved spool exists, verify fsync, encryption, capacity, and checksum health before allowing `accepted_pending_authority`.
5. Fail authorization-dependent reads closed if required data is unavailable.

**Diagnosis**

- Check database reachability, pool waiters, active/idle/max connections, lock waits, disk free space, transaction failures, and host health.
- Distinguish application pool exhaustion from database outage.
- Check recent deploys, migrations, credential rotations, and network policy changes.
- For PostgreSQL, inspect official activity/statistics views using a read-only operator account.

**Mitigation**

- Shed non-critical worker load before critical text/voice operations.
- Open circuit breakers to prevent retry storms.
- Restore capacity, credentials, routing, or database service.
- Do not increase connection limits blindly; confirm server capacity.
- Do not promote an unverified replica without data-loss assessment.

**Recovery verification**

- Run read/write synthetic transactions.
- Verify idempotency behavior.
- Replay spool in bounded batches, preserving order where required.
- Confirm queue age falls, no sequence conflicts increase, and authority availability recovers.
- Reconcile the outage window for false successes and unknown outcomes.

**Escalate when:** data corruption, replica divergence, disk loss, failed restore, or privacy/deletion workflows were affected.

### RUNBOOK-016-002 — Remote Memory Runtime unavailable

**Trigger:** connection failures, timeouts, unhealthy circuit, compatibility handshake failure, or widespread `dependency_unavailable`.

**Immediate safety**

- Keep the bot from switching to an unrelated local authority.
- Open the circuit after bounded failures.
- Permit only approved degraded reads from version-valid authorized cache.
- Permit pending writes only through the approved durable spool.

**Diagnosis**

- Check runtime health, DNS/service discovery, TLS, credentials, network policy, version compatibility, and backend dependencies.
- Compare bot-side and runtime-side traces by trace ID.
- Determine whether the failure is total, operation-specific, or tenant/scope-specific.

**Mitigation**

- Roll back the runtime or client when the outage follows deployment.
- Route only to a verified compatible healthy instance.
- Shed optional retrieval and background jobs.
- Do not create a second authority.

**Recovery**

- Close the circuit gradually.
- Replay spool idempotently.
- Verify no stale cache was served past authorization/version boundaries.
- Reconcile all pending and unknown operations.

### RUNBOOK-016-003 — Slow retrieval

**Trigger:** stage p95/p99 breach, voice added-latency burn, timeout rise, or degraded-retrieval rate above approved limit.

**Immediate safety**

- Identify the slow stage before disabling anything.
- Preserve authorization and structured exact lookup.
- Only skip stages explicitly designated optional.
- Mark every shortened result as degraded.

**Diagnosis**

- Break down `authorize`, `structured`, `temporal`, `lexical`, `vector`, `rerank`, and `serialize`.
- Segment cold/warm cache, text/voice, language class, payload size, backend, and concurrency.
- Check DB lock waits, slow queries, index health, worker contention, connection pools, and remote network.
- Compare memory-enabled voice latency with baseline.

**Mitigation**

- Enforce per-stage deadlines.
- Bypass an unhealthy optional vector/rerank stage.
- Reduce retrieval breadth only within approved quality/privacy limits.
- Throttle background summarization/extraction before critical voice traffic.
- Roll back recent query/index/config changes.

**Recovery**

- Confirm stage distributions and degraded rate recover.
- Run multilingual, multi-speaker, and privacy-canary queries.
- Do not close based on average latency alone.

### RUNBOOK-016-004 — Corrupt room binding

**Trigger:** binding checksum/version failure, impossible channel-to-room mapping, duplicate active binding, authorization disagreement, or canary cross-scope result.

**Immediate safety**

- Fail closed for affected physical channels/logical rooms.
- Invalidate all caches keyed by the affected binding/version.
- Stop cross-channel recent-context retrieval.
- Escalate as privacy/correctness incident if any disclosure may have occurred.

**Diagnosis**

- Inspect append-only binding history and latest valid version.
- Compare configuration source, database state, cache state, and authorization decisions.
- Identify first bad version and affected time range.
- Do not inspect message content unless incident-capture approval exists.

**Mitigation**

- Restore the last verified binding version through an audited administrative action.
- Quarantine ambiguous bindings rather than guessing.
- Rebuild derived caches/indexes from authoritative bindings.

**Recovery**

- Run positive and negative authorization tests.
- Verify private aliases and DM context cannot appear in guild retrieval.
- Re-enable one affected room at a time.

### RUNBOOK-016-005 — Worker backlog

**Trigger:** oldest job age or deadline risk exceeds threshold; retry rate rises; dead letters accumulate.

**Immediate safety**

- Identify queue and whether work is critical, deletion/export deadline-bound, or optional.
- Prioritize deletion and correctness repair over summaries/embeddings.
- Prevent producer amplification if consumers are failing.

**Diagnosis**

- Inspect ready/leased/retry/dead-letter counts and oldest age.
- Find dominant error class and job version.
- Check worker capacity, dependency latency, poison jobs, lease timeout, and deployment skew.

**Mitigation**

- Pause poison job types.
- Scale only after proving dependencies can absorb load.
- Reduce optional producer rate.
- Retry dead letters only after fixing cause and with a new audited attempt.

**Recovery**

- Backlog age returns below objective.
- No lease duplication or out-of-order supersession.
- Deadline-bound jobs complete and manifests verify.

### RUNBOOK-016-006 — Stale cache

**Trigger:** version mismatch, stale-hit-prevented spike, user report, authorization discrepancy, or outdated supersession/deletion result.

**Immediate safety**

- Bypass affected cache.
- Invalidate by scope/entity/version, not user-provided free text.
- Fail closed if stale data could cross an authorization boundary.

**Diagnosis**

- Compare cache key/version with authoritative identity, room-binding, supersession, and deletion versions.
- Check invalidation events, subscriber lag, clock skew, and TTL policy.
- Determine whether stale values were served.

**Mitigation**

- Purge scoped entries.
- Repair invalidation stream and replay missed invalidations.
- Temporarily shorten TTL only if it will not overload the authority.

**Recovery**

- Verify authoritative values and negative-cache behavior.
- Run deletion/supersession and scope-canary tests.
- Monitor database load after rewarming.

### RUNBOOK-016-007 — Failed deletion

**Trigger:** deletion job failed/dead-lettered, per-store deadline at risk, residual lookup succeeds, or overall state falsely appears complete.

**Immediate safety**

- Reopen workflow; set overall state to `failed` or `incomplete`.
- Block any success notification.
- Disable retrieval of known targeted records where safe and authorized.
- Escalate to privacy owner.

**Diagnosis**

- Inspect manifest by store without exposing subject content.
- Check raw events, summaries, semantic index, caches, exports, dead letters, spool, analytics/telemetry policy, and backups.
- Identify transient failure, unsupported erasure, schema drift, or identity-resolution gap.

**Mitigation**

- Retry idempotently per store.
- Apply approved tombstone/crypto-erasure/expiry process for immutable backups.
- Regenerate summaries/indexes that depended on removed data.
- Invalidate all relevant caches.

**Recovery**

- Run residual search using the approved deletion test harness.
- Verify every required store is terminal.
- Obtain privacy-owner approval before completion.
- Document any legally required retained audit evidence.

### RUNBOOK-016-008 — Duplicate Discord delivery

**Trigger:** duplicate message/playback report, duplicate detector, repeated delivery attempt for one idempotency key, or reconciliation mismatch.

**Immediate safety**

- Stop retries for the affected artifact/idempotency key.
- Do not delete Discord messages automatically without product/operator policy.
- For voice, stop further automatic replay.

**Diagnosis**

- Review delivery attempt ledger, process restarts, timeout boundaries, Discord acknowledgements, message IDs, and idempotency decisions.
- Determine whether duplication is text, voice, or history-only.
- Check concurrent workers and lease expiry.

**Mitigation**

- Mark all attempts and identify the canonical delivered artifact.
- Repair history eligibility to one logical assistant turn.
- Fix retry/reconciliation logic before reenabling.

**Recovery**

- Reproduce with crash injection.
- Verify duplicate rate returns to baseline and no legitimate retries are suppressed.

### RUNBOOK-016-009 — Crash during text send

**Trigger:** process termination after `dispatching` and before durable acknowledgement recording.

**Immediate safety**

- On restart, classify the attempt as `outcome_unknown`.
- Do not immediately resend.

**Diagnosis and reconciliation**

- Use stored idempotency key, Discord nonce/message ID where supported, destination, and bounded time window.
- Query/reconcile through approved Discord API behavior without logging raw content.
- If a matching acknowledged message exists, transition to `reconciled_acknowledged`.
- If definitively absent and retry is still valid, transition to `reconciled_not_sent` and create a new attempt.
- If unresolved, retain `unresolved` and require policy-based operator/user handling.

**Recovery verification**

- History eligibility matches the reconciled state.
- No duplicate delivery was produced.
- Crash-window test passes in staging.

### RUNBOOK-016-010 — Crash during voice playback

**Trigger:** process termination after playback starts but before completion is durably recorded.

**Immediate safety**

- Record or infer `outcome_unknown` after restart.
- Do not mark playback complete.
- Do not replay automatically.

**Diagnosis**

- Review playback-start telemetry, audio queue state, Discord voice connection lifecycle, and last durable transition.
- Distinguish crash before playback start from crash after start.

**Mitigation**

- Clear orphaned local playback resources.
- Let the next user turn proceed under normal policy.
- A product-specific apology may be generated only as a new turn, not as replay of the unknown artifact.

**Recovery**

- Ensure unknown artifact is excluded from normal completed history.
- Verify future turns do not inherit partial assistant text as delivered truth.

### RUNBOOK-016-011 — Unknown delivery state after restart

**Trigger:** reconciliation scan finds `dispatching`, `playback_started`, or missing terminal transition.

**Procedure**

1. Freeze automatic retry for each affected attempt.
2. Classify by medium.
3. For text, run deterministic reconciliation and persist evidence.
4. For voice, retain unknown unless a durable completion signal exists.
5. Compare generated artifact, delivery attempts, and derived history.
6. Count unresolved divergence.
7. Escalate when volume or age exceeds objective.

**Do not:** infer success from elapsed time, model completion, TTS completion, or absence of an exception.

### RUNBOOK-016-012 — Schema mismatch

**Trigger:** compatibility handshake fails, unknown event version, missing migration, or worker cannot parse a job.

**Immediate safety**

- Block incompatible instance or message.
- Do not coerce unknown fields into an older schema.
- Preserve raw opaque envelope only if policy permits and it cannot be executed.

**Diagnosis**

- Compare producer/consumer versions, migration ledger, feature flags, and deployment order.
- Identify backward/forward compatibility promise.

**Mitigation**

- Roll back incompatible deployment or route to a compatible consumer.
- Deploy an explicitly tested compatibility adapter if approved.
- Quarantine incompatible jobs.

**Recovery**

- Run contract tests for N-1/N/N+1 supported versions.
- Confirm compatibility gauge is healthy across all instances.

### RUNBOOK-016-013 — Failed migration

**Trigger:** migration command fails, checksum differs, partial schema visible, or application errors begin after migration.

**Immediate safety**

- Stop new application writes.
- Keep readers only if the migration plan explicitly proves safety.
- Preserve migration logs and database state.

**Diagnosis**

- Identify transactional vs non-transactional steps.
- Check backup/restore point, lock state, disk, permissions, and data validation.
- Never rerun blindly.

**Mitigation**

- Execute tested rollback when reversible.
- Otherwise restore to a verified point or complete forward with approved repair steps.
- Keep incompatible application versions out.

**Recovery**

- Validate row counts/checksums/invariants without exposing content.
- Run append, retrieval, delivery, deletion, and export smoke tests.
- Reopen traffic gradually.

### RUNBOOK-016-014 — Suspected privacy leak

**Trigger:** cross-scope canary, user report, private alias in public output, unauthorized retrieval, or telemetry content exposure.

**Severity:** SEV-0 until bounded.

**Immediate containment**

- Disable the affected retrieval/cache/serialization path.
- Revoke access to exposed logs/exports if relevant.
- Preserve content-free evidence and access audit.
- Notify privacy/security incident leadership.
- Do not broaden exposure by copying content into incident tools.

**Investigation**

- Establish first/last possible exposure, scopes, users, medium, deployment version, binding/authorization versions, caches, and recipients.
- Determine whether the failure was retrieval, serialization, model prompt injection, delivery routing, logging, or operator access.
- Use approved incident capture only when essential.

**Recovery**

- Patch and test with positive/negative scope cases.
- Purge leaked caches/derived artifacts where required.
- Complete notification/legal process.
- Reenable via canary with zero-tolerance detector.

### RUNBOOK-016-015 — Prompt-injection incident

**Trigger:** retrieved memory attempts to alter system instructions, expose internal IDs, create mentions, forge roles, or bypass scope.

**Immediate safety**

- Disable the affected memory source or serialization path.
- Keep authorization enforcement outside the model.
- Do not grant broader tools or scopes in response to memory content.

**Diagnosis**

- Identify source layer: raw event, summary, semantic memory, procedural memory, or external retrieval.
- Verify delimiter escaping, role separation, Unicode normalization, mention neutralization, and internal-ID suppression.
- Determine whether output or action escaped the intended boundary.

**Mitigation**

- Quarantine malicious records.
- Regenerate affected summaries/embeddings after correction.
- Patch serializer and add regression vectors.
- Treat any actual cross-scope disclosure under the privacy-leak runbook.

**Recovery**

- Run adversarial corpus across text and voice serialization.
- Verify content cannot create trusted roles or operational log structure.

### RUNBOOK-016-016 — Compromised service credential

**Trigger:** secret appears in logs/repository, unauthorized access, unusual authentication, provider alert, or suspected host compromise.

**Severity:** SEV-0 or SEV-1 depending on access and scope.

**Immediate containment**

- Revoke/disable the credential at the provider.
- Isolate affected workload.
- Rotate dependent credentials and invalidate sessions/tokens.
- Block known malicious source where appropriate.
- Preserve audit evidence without copying the secret.

**Diagnosis**

- Determine credential type, privileges, exposure window, access logs, actions taken, data reachable, and persistence.
- Search protected secret-scanning results, not general chat history.
- Check observability exporters and CI/CD secrets as well as application credentials.

**Recovery**

- Deploy new credential through approved secret manager.
- Verify old credential rejection.
- Review least privilege and rotation coverage.
- Run data-integrity, privacy, delivery, and deletion checks for the exposure window.
- Complete required notification and post-incident actions.

---

## 15. Testable acceptance criteria

| Test ID | Acceptance criterion |
|---|---|
| TEST-OPS-001 | Every required critical-path operation emits a terminal metric and structured event with stable semantics. |
| TEST-OPS-002 | One text and one voice turn can be correlated across append, retrieval, generation, delivery, and record spans using opaque IDs. |
| TEST-OPS-003 | Automated telemetry tests reject prompts, transcripts, model output, audio, aliases, raw Discord IDs, credentials, and connection strings. |
| TEST-OPS-004 | Metric label cardinality remains within an approved bound under one million synthetic users/events. |
| TEST-OPS-005 | DB loss without spool produces explicit failed writes and zero false successes. |
| TEST-OPS-006 | DB/runtime loss with approved spool returns only `accepted_pending_authority`, survives restart, and replays idempotently. |
| TEST-OPS-007 | Duplicate append requests create one authoritative event and increment duplicate metrics. |
| TEST-OPS-008 | Conflicting idempotency payloads and sequence versions are rejected, not overwritten. |
| TEST-OPS-009 | Crash at each text-send boundary yields acknowledged, definitely failed, or unknown plus deterministic reconciliation. |
| TEST-OPS-010 | Crash/interruption at each voice boundary never creates an ordinary completed turn unless playback completion is durable. |
| TEST-OPS-011 | Restart scan finds and classifies all nonterminal delivery attempts. |
| TEST-OPS-012 | Poison worker jobs stop after bounded retries and enter dead letter with content-free diagnostics. |
| TEST-OPS-013 | A deletion cannot report complete while any required store is pending, failed, or unknown. |
| TEST-OPS-014 | Supersession and deletion invalidate stale cache entries before they can be served. |
| TEST-OPS-015 | Corrupt/ambiguous room binding fails closed and triggers an operational signal. |
| TEST-OPS-016 | Authorization dependency failure returns no memory and increments rejection/failure metrics. |
| TEST-OPS-017 | Synthetic private-scope canaries never appear in public/guild retrieval or prompt serialization. |
| TEST-OPS-018 | Supported schema-version matrix passes; unsupported versions are blocked safely. |
| TEST-OPS-019 | Each migration has a tested rollback or explicitly approved forward-repair and restore procedure. |
| TEST-OPS-020 | Incident capture cannot activate without incident ID, approval, TTL, access logging, and auto-disable. |
| TEST-OPS-021 | Credential rotation test proves old credential rejection and uninterrupted auditability. |
| TEST-OPS-022 | SLO proposal includes at least two weeks of representative distribution data and all required workload segments. |
| TEST-OPS-023 | Voice A/B benchmark reports added time to first audible byte and playback completion under cold/warm and worker-load conditions. |
| TEST-OPS-024 | Every page alert is exercised in staging and links to the correct runbook/dashboard. |
| TEST-OPS-025 | Dashboard shows authority availability, append/retrieval distributions, degraded rate, divergence, queue age, deletion/export state, and privacy detectors. |
| TEST-OPS-026 | Backup restore drill verifies data integrity and deletion-policy behavior. |
| TEST-OPS-027 | Spool-full test stops pending-authority acceptance before corruption or disk exhaustion. |
| TEST-OPS-028 | Export workflow is resumable/idempotent and never exposes another scope. |
| TEST-OPS-029 | Trace sampling retains 100% of required error/privacy/deletion/delivery-unknown traces while successful traffic is sampled. |
| TEST-OPS-030 | No production configuration can silently substitute unrelated process-local history for the memory authority. |
| TEST-OPS-031 | Multilingual/CJK retrieval is benchmarked as a separate workload class rather than inferred from generic full-text claims. |
| TEST-OPS-032 | Database saturation test demonstrates controlled shedding and no authorization fail-open. |
| TEST-OPS-033 | Delivery/history reconciliation scan detects intentionally injected illegal transitions. |
| TEST-OPS-034 | Snapshot-version tests allow ordinary concurrent appends while preserving what generation observed. |
| TEST-OPS-035 | Telemetry backend loss does not block memory correctness, and bounded local buffering does not leak content or exhaust disk. |

Release requires all correctness/privacy tests and all topology-relevant resilience tests to pass. A latency hypothesis may be revised through approval; a correctness invariant may not be waived by an availability target.

---

## 16. Non-goals

- Guaranteeing exactly-once Discord delivery.
- Proving that a human heard voice output.
- Choosing SQLite versus PostgreSQL versus remote runtime in this artifact.
- Mandating vectors, learned reranking, or graph storage.
- Logging content to improve model quality.
- Making background summarization/extraction part of the voice-critical path.
- Defining final legal retention periods.
- Treating Discord identity as verified cross-platform human identity.
- Using room snapshot version to reject every append that occurs during generation.
- Replacing application-level correctness checks with dashboards.

---

## 17. Dependencies on other artifacts

This document depends on the following artifacts or decisions:

1. **MemoryPort and topology ADR:** in-process versus remote behavior, durability boundary, retry contract, and spool decision.
2. **Event and causal data model:** append semantics, event IDs, sequence/version rules, many-to-many causal edges, and payload/state separation.
3. **Identity and scope authorization specification:** Discord identity key, actor snapshots, alias scoping, logical-room bindings, DM/guild isolation.
4. **Delivery ledger specification:** exact text/voice transitions, Discord reconciliation identifiers, and history-eligibility derivation.
5. **Privacy, retention, deletion, and export specification:** stores in the deletion manifest, backup semantics, audit retention, and completion deadlines.
6. **Retrieval specification:** mandatory and optional stages, degraded-mode rules, multilingual evaluation, and prompt serialization.
7. **Worker specification:** queue technology, leases, ordering, retries, dead letters, and job-version compatibility.
8. **Database schema/migration plan:** transactional guarantees, migration tooling, backup/restore, and concurrency control.
9. **Security threat model:** credential inventory, trust boundaries, incident severity, and logging access.
10. **Evaluation plan:** representative workloads, identity/attribution/privacy benchmarks, and voice latency corpus.

---

## 18. Open questions

### 18.1 Blocking

- **OPEN-016-001.** Is milestone one in-process or remote, and what verified deployment need would justify the remote runtime?
- **OPEN-016-002.** Is a durable local spool permitted? If so, what encryption, ordering, capacity, fsync, and operator semantics apply?
- **OPEN-016-003.** What exact user behavior is allowed when memory writes are unavailable: refuse turn, answer without personal memory, or another explicitly disclosed mode?
- **OPEN-016-004.** What is the authoritative delivery reconciliation method for Discord text in the chosen library/API path?
- **OPEN-016-005.** Which delivery states qualify assistant artifacts for context, summaries, extraction, and person memory?
- **OPEN-016-006.** What are the approved logical-room binding authority and version semantics?
- **OPEN-016-007.** What stores, backups, telemetry, audit ledgers, spools, and exports are in scope for deletion?
- **OPEN-016-008.** What retention is permitted for pseudonymous operational IDs after deletion?
- **OPEN-016-009.** Which retrieval stages are optional in degraded mode, separately for text and voice?
- **OPEN-016-010.** What database concurrency mechanism prevents lost updates and preserves attributable ordering?
- **OPEN-016-011.** Who owns 24/7 incident response and credential revocation for each dependency?
- **OPEN-016-012.** What production hardware, regions, concurrency, language mix, and traffic shape define representative SLO tests?

### 18.2 Non-blocking

- **OPEN-016-013.** Which observability backend will store OpenTelemetry data?
- **OPEN-016-014.** Should successful trace sampling be head-based, tail-based, or deterministic by opaque turn ID?
- **OPEN-016-015.** Are native histograms supported by the selected metrics backend?
- **OPEN-016-016.** Which dashboards are embedded in the existing DC_BOT runbook?
- **OPEN-016-017.** Should synthetic privacy canaries run continuously in production or only in a shadow environment?
- **OPEN-016-018.** When should vector/reranker stages receive their own SLOs if introduced?
- **OPEN-016-019.** What operator UI is required for unknown delivery and deletion reconciliation?
- **OPEN-016-020.** What maximum acceptable unresolved-delivery age should page an operator?

---

## 19. Handoff instructions for downstream agents

### For the data-model agent

- Define append-only event and state-transition records that support idempotency, sequence conflict, delivery attempts, many-to-many causality, and deletion manifests.
- Keep payload immutability distinct from lifecycle transitions.
- Provide indexes needed by reconciliation without requiring content logs.

### For the MemoryPort/runtime agent

- Implement the result taxonomy in Section 11.1.
- Preserve identical semantics for local and remote modes.
- Expose health, readiness, compatibility, and metrics without reporting false success.
- Do not implement a spool until its blocking questions are resolved.

### For the Discord delivery agent

- Specify durable text reconciliation fields and Discord API behavior.
- Implement the delivery state machines and illegal-transition checks.
- Never auto-replay unknown voice output.

### For the privacy/security agent

- Approve prohibited telemetry fields, retention, incident capture, deletion-store inventory, backup semantics, and credential rotation.
- Define cross-scope canaries and incident notification thresholds.

### For the evaluation/SLO agent

- Build the measurement corpus and fault-injection plan from Section 10.
- Treat every numeric threshold as a hypothesis.
- Produce an approval record with segmented distributions and voice A/B results.

### For the operations agent

- Convert each runbook into alert-linked operational pages with owners, commands appropriate to the selected infrastructure, and tested rollback steps.
- Conduct game days for DB loss, remote-runtime loss, delivery crash windows, deletion failure, schema skew, and privacy leak.

---

## 20. What must be true before coding starts

1. The topology and authoritative durability boundary are approved.
2. The no-silent-fallback behavior is explicit for text and voice.
3. The operation result taxonomy is accepted.
4. The delivery ledger and history-eligibility state machine are accepted.
5. Room-binding and authorization failures are defined as fail closed.
6. The telemetry schema and never-log list are privacy/security approved.
7. Metric names, units, labels, and cardinality budgets are registered.
8. Deletion/export store manifests and completion semantics are approved.
9. Database concurrency and migration/restore mechanisms are selected.
10. Worker retry, ordering, lease, and dead-letter semantics are selected.
11. A credential inventory and rotation owner exist.
12. The representative SLO benchmark environment and approvers are named.
13. Crash-window, outage, privacy-canary, deletion, and migration tests are part of the release gate.
14. Production on-call ownership and incident severity policy are documented.
15. No unresolved blocking open question is being hidden behind an implementation default.

---

## Concise handoff summary

The next required decisions are the **MemoryPort/topology ADR**, **delivery-ledger state machine**, **identity/scope authorization contract**, **privacy-retention-deletion/export policy**, **database concurrency and migration plan**, and **SLO benchmark/approval plan**. Coding should begin only after those artifacts establish the authority boundary, degraded behavior, delivery reconciliation, deletion completion, and privacy-safe telemetry contract.
