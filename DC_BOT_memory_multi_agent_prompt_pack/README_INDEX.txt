DC_BOT MEMORY MULTI-AGENT PROMPT PACK
====================================

Each numbered TXT file is self-contained and can be sent to an agent by itself.
Agents are instructed to inspect repositories through GitHub web/raw URLs and not to clone.

Recommended order:
- 00_program_coordinator.txt: Program Coordinator and Document Controller
- 01_repository_evidence_audit.txt: Current DC_BOT Repository Evidence Audit
- 02_comparative_research.txt: Comparative Upstream Implementation Research
- 03_topology_storage_adr.txt: Deployment Topology and Storage ADR
- 04_requirements_baseline.txt: Requirements Baseline and Traceability
- 05_identity_alias_spec.txt: Person Identity and Alias Specification
- 06_room_scope_authorization_spec.txt: Room, Scope, and Authorization Specification
- 07_event_causality_delivery_spec.txt: Event, Causality, and Delivery Lifecycle Specification
- 08_persistence_concurrency_spec.txt: Persistence, Sequencing, Concurrency, and Idempotency
- 09_memory_port_api_spec.txt: MemoryPort and API Contract Specification
- 10_context_prompt_security_spec.txt: Context Assembly and Prompt Security Specification
- 11_memory_lifecycle_spec.txt: Summarization and Semantic-Memory Lifecycle
- 12_retrieval_spec.txt: Retrieval, Multilingual Search, and Ranking
- 13_security_threat_model.txt: Security, Privacy, and Abuse Threat Model
- 14_data_governance_spec.txt: Data Governance, Retention, Deletion, and Export
- 15_migration_plan.txt: Migration and Backward-Compatibility Plan
- 16_observability_operations_spec.txt: Observability, Resilience, and Operations
- 17_evaluation_benchmark_spec.txt: Benchmark and Evaluation Specification
- 18_failure_injection_plan.txt: Failure-Injection and Concurrency Test Plan
- 19_rollout_rollback_plan.txt: Rollout, Feature Flags, and Rollback
- 20_coding_agent_skills.txt: Coding-Agent Skill Pack
- 21_implementation_backlog.txt: Implementation Backlog and Ownership Graph
- 22_documentation_integrator.txt: Documentation Integrator and Specification Compiler
- 23_red_team_readiness_review.txt: Independent Adversarial Readiness Review
- 99_MASTER_START_ACTUAL_CODING.txt: Run only after all documentation artifacts and red-team review are complete.

Suggested execution waves:
Wave 0: 00–03
Wave 1: 04–08
Wave 2: 09–14
Wave 3: 15–19
Wave 4: 20–23
Implementation: 99

Expected artifact names are stated inside each prompt.
