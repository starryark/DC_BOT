/** SQLite schema version 1 for IMP-201. */
export const schemaV1 = String.raw`
CREATE TABLE people (
  person_id TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE migration_runs (
  migration_run_id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_locator_redacted TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('inventory','dry_run','running','completed','failed','quarantined')),
  schema_version INTEGER NOT NULL,
  writer_version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  source_count INTEGER NOT NULL DEFAULT 0 CHECK (source_count >= 0),
  migrated_count INTEGER NOT NULL DEFAULT 0 CHECK (migrated_count >= 0),
  quarantined_count INTEGER NOT NULL DEFAULT 0 CHECK (quarantined_count >= 0),
  checksum TEXT NOT NULL
) STRICT;

CREATE TABLE migration_source_records (
  migration_source_record_id TEXT PRIMARY KEY,
  migration_run_id TEXT NOT NULL REFERENCES migration_runs(migration_run_id),
  source_partition TEXT NOT NULL,
  source_record_key TEXT NOT NULL,
  source_checksum TEXT NOT NULL,
  historical_display_snapshot TEXT,
  source_metadata_json TEXT CHECK (source_metadata_json IS NULL OR json_valid(source_metadata_json)),
  status TEXT NOT NULL CHECK (status IN ('pending','migrated','quarantined','skipped')),
  UNIQUE (migration_run_id, source_partition, source_record_key)
) STRICT;

CREATE TABLE legacy_unresolved_actors (
  legacy_actor_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_partition TEXT NOT NULL,
  source_native_speaker_key TEXT,
  historical_display_snapshot TEXT NOT NULL,
  resolution_status TEXT NOT NULL CHECK (resolution_status IN ('unresolved','candidate','resolved_automatic','resolved_manual','quarantined','invalidated')),
  candidate_person_ids_json TEXT CHECK (candidate_person_ids_json IS NULL OR json_valid(candidate_person_ids_json)),
  created_by_migration_run_id TEXT NOT NULL REFERENCES migration_runs(migration_run_id),
  UNIQUE (source_id, source_partition, source_native_speaker_key, legacy_actor_id)
) STRICT;

CREATE TABLE identity_resolutions (
  identity_resolution_id TEXT PRIMARY KEY,
  legacy_actor_id TEXT NOT NULL REFERENCES legacy_unresolved_actors(legacy_actor_id),
  person_id TEXT REFERENCES people(person_id),
  previous_status TEXT NOT NULL,
  resolution_status TEXT NOT NULL CHECK (resolution_status IN ('unresolved','candidate','resolved_automatic','resolved_manual','quarantined','invalidated')),
  evidence_type TEXT NOT NULL,
  evidence_reference_redacted TEXT NOT NULL,
  reason TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  reviewed_by TEXT,
  decided_at TEXT NOT NULL,
  supersedes_resolution_id TEXT REFERENCES identity_resolutions(identity_resolution_id),
  CHECK (resolution_status NOT IN ('resolved_automatic','resolved_manual') OR person_id IS NOT NULL)
) STRICT;

CREATE TABLE actor_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(person_id),
  username TEXT,
  global_name TEXT,
  guild_nick TEXT,
  avatar_url TEXT,
  voice_characteristics_json TEXT CHECK (voice_characteristics_json IS NULL OR json_valid(voice_characteristics_json)),
  captured_at TEXT NOT NULL
) STRICT;

CREATE TABLE aliases (
  alias_id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(person_id),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('platform','character_global','guild','logical_room','private')),
  scope_id TEXT NOT NULL,
  value TEXT NOT NULL,
  precedence INTEGER NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public','private')),
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  source TEXT,
  CHECK ((scope_type = 'private') = (visibility = 'private')),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
) STRICT;
CREATE INDEX ix_aliases_resolution ON aliases(scope_type, scope_id, value, valid_to);

CREATE TABLE alias_preferences (
  alias_preference_id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(person_id),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('platform','character_global','guild','logical_room','private')),
  scope_id TEXT NOT NULL,
  alias_id TEXT NOT NULL REFERENCES aliases(alias_id),
  version INTEGER NOT NULL CHECK (version > 0),
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  superseded_by_id TEXT REFERENCES alias_preferences(alias_preference_id),
  UNIQUE (person_id, scope_type, scope_id, version),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
) STRICT;
CREATE UNIQUE INDEX uq_alias_preference_current ON alias_preferences(person_id, scope_type, scope_id) WHERE valid_to IS NULL;

CREATE TABLE physical_rooms (
  physical_room_id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform = 'discord'),
  channel_id TEXT NOT NULL,
  channel_kind TEXT NOT NULL CHECK (channel_kind IN ('dm','guild_text','guild_voice')),
  guild_id TEXT,
  participant_person_id TEXT REFERENCES people(person_id),
  created_at TEXT NOT NULL,
  UNIQUE (platform, channel_id),
  CHECK ((channel_kind = 'dm' AND guild_id IS NULL AND participant_person_id IS NOT NULL)
      OR (channel_kind <> 'dm' AND guild_id IS NOT NULL AND participant_person_id IS NULL))
) STRICT;

CREATE TABLE logical_rooms (
  logical_room_id TEXT PRIMARY KEY,
  isolation_scope_type TEXT NOT NULL CHECK (isolation_scope_type IN ('dm','guild','person','character','logical_room','unbound_channel')),
  isolation_scope_id TEXT NOT NULL,
  room_kind TEXT NOT NULL CHECK (room_kind IN ('dm','guild','person','character','unbound_channel','logical')),
  next_sequence INTEGER NOT NULL DEFAULT 1,
  current_version INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  UNIQUE (isolation_scope_type, isolation_scope_id, logical_room_id),
  CHECK (next_sequence = current_version + 1)
) STRICT;

CREATE TABLE legacy_room_resolutions (
  legacy_room_resolution_id TEXT PRIMARY KEY,
  migration_source_record_id TEXT NOT NULL REFERENCES migration_source_records(migration_source_record_id),
  logical_room_id TEXT REFERENCES logical_rooms(logical_room_id),
  status TEXT NOT NULL CHECK (status IN ('unresolved','resolved','quarantined','invalidated')),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  supersedes_resolution_id TEXT REFERENCES legacy_room_resolutions(legacy_room_resolution_id),
  CHECK (status <> 'resolved' OR logical_room_id IS NOT NULL)
) STRICT;

CREATE TABLE room_bindings (
  binding_id TEXT PRIMARY KEY,
  physical_room_id TEXT NOT NULL REFERENCES physical_rooms(physical_room_id),
  logical_room_id TEXT NOT NULL REFERENCES logical_rooms(logical_room_id),
  binding_type TEXT NOT NULL,
  authorized_by TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  superseded_by_id TEXT REFERENCES room_bindings(binding_id),
  UNIQUE (physical_room_id, version),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
) STRICT;
CREATE UNIQUE INDEX uq_room_binding_current ON room_bindings(physical_room_id) WHERE valid_to IS NULL;
CREATE INDEX ix_room_bindings_logical ON room_bindings(logical_room_id, valid_to);

CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  logical_room_id TEXT NOT NULL REFERENCES logical_rooms(logical_room_id),
  room_sequence INTEGER NOT NULL CHECK (room_sequence > 0),
  event_kind TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  modality TEXT NOT NULL CHECK (modality IN ('text','voice')),
  author_person_id TEXT REFERENCES people(person_id),
  actor_snapshot_id TEXT REFERENCES actor_snapshots(snapshot_id),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  source_system TEXT NOT NULL,
  source_event_key TEXT,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  immutability_hash TEXT NOT NULL,
  redaction_state TEXT NOT NULL DEFAULT 'active' CHECK (redaction_state IN ('active','redacted','tombstoned')),
  context_eligibility TEXT NOT NULL DEFAULT 'eligible' CHECK (context_eligibility IN ('eligible','stale_but_valid','superseded','ineligible','unknown_pending_review')),
  schema_version INTEGER NOT NULL DEFAULT 1,
  writer_version TEXT NOT NULL,
  UNIQUE (logical_room_id, room_sequence),
  UNIQUE (source_system, source_event_key),
  CHECK (modality <> 'voice' OR direction <> 'inbound' OR (author_person_id IS NOT NULL AND actor_snapshot_id IS NOT NULL))
) STRICT;
CREATE INDEX ix_events_room_sequence ON events(logical_room_id, room_sequence);
CREATE INDEX ix_events_person_time ON events(author_person_id, occurred_at);
CREATE INDEX ix_events_room_kind_sequence ON events(logical_room_id, event_kind, room_sequence);

CREATE TABLE event_lifecycle (
  transition_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(event_id),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  transitioned_at TEXT NOT NULL,
  reason TEXT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  UNIQUE (event_id, ordinal)
) STRICT;

CREATE TABLE assistant_generations (
  generation_id TEXT PRIMARY KEY,
  assistant_event_id TEXT NOT NULL UNIQUE REFERENCES events(event_id),
  generation_idempotency_key TEXT NOT NULL UNIQUE,
  context_snapshot_version INTEGER NOT NULL CHECK (context_snapshot_version >= 0),
  generation_started_at TEXT NOT NULL,
  generation_completed_at TEXT,
  generation_status TEXT NOT NULL CHECK (generation_status IN ('drafting','generated','failed','cancelled','superseded')),
  model_provider TEXT,
  model_name TEXT,
  context_eligibility TEXT NOT NULL CHECK (context_eligibility IN ('eligible','stale_but_valid','superseded','ineligible','unknown_pending_review')),
  eligibility_reason TEXT,
  failure_code TEXT
) STRICT;

CREATE TABLE context_snapshot_evidence (
  generation_id TEXT NOT NULL REFERENCES assistant_generations(generation_id),
  visible_event_id TEXT NOT NULL REFERENCES events(event_id),
  visibility_role TEXT NOT NULL CHECK (visibility_role IN ('trigger','context','excluded')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (generation_id, visible_event_id),
  UNIQUE (generation_id, ordinal)
) STRICT;

CREATE TABLE generation_causes (
  generation_id TEXT NOT NULL REFERENCES assistant_generations(generation_id),
  triggering_event_id TEXT NOT NULL REFERENCES events(event_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  contribution_kind TEXT NOT NULL DEFAULT 'direct',
  PRIMARY KEY (generation_id, triggering_event_id),
  UNIQUE (generation_id, ordinal)
) STRICT;
CREATE INDEX ix_generation_causes_trigger ON generation_causes(triggering_event_id, generation_id);

CREATE TABLE output_segments (
  output_segment_id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES assistant_generations(generation_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  modality TEXT NOT NULL CHECK (modality IN ('text','voice')),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  content_hash TEXT NOT NULL,
  UNIQUE (generation_id, ordinal)
) STRICT;

CREATE TABLE delivery_attempts (
  delivery_attempt_id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES assistant_generations(generation_id),
  output_segment_id TEXT REFERENCES output_segments(output_segment_id),
  medium TEXT NOT NULL CHECK (medium IN ('discord_text','discord_voice')),
  destination_key TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  result TEXT NOT NULL CHECK (result IN ('pending','sent','confirmed','delivered','failed_retryable','failed_terminal','failed','uncertain','unknown_after_crash','partial','interrupted','cancelled','unheard','redelivered','superseded','marked_artifact')),
  external_message_id TEXT,
  units_planned INTEGER,
  units_sent INTEGER,
  audible_started_at TEXT,
  audible_ended_at TEXT,
  interruption_reason TEXT,
  error_code TEXT,
  error_detail_redacted TEXT,
  UNIQUE (generation_id, medium, destination_key, attempt_no),
  CHECK (units_planned IS NULL OR units_planned >= 0),
  CHECK (units_sent IS NULL OR units_sent >= 0),
  CHECK (medium <> 'discord_voice' OR result <> 'delivered')
) STRICT;
CREATE INDEX ix_delivery_reconcile ON delivery_attempts(result, started_at);
CREATE INDEX ix_delivery_generation ON delivery_attempts(generation_id, medium, attempt_no);

CREATE TABLE voice_drains (
  delivery_attempt_id TEXT NOT NULL REFERENCES delivery_attempts(delivery_attempt_id),
  chunk_ordinal INTEGER NOT NULL CHECK (chunk_ordinal >= 0),
  chunk_hash TEXT NOT NULL,
  planned_duration_ms INTEGER NOT NULL CHECK (planned_duration_ms >= 0),
  drain_started_at TEXT,
  drain_completed_at TEXT,
  result TEXT NOT NULL CHECK (result IN ('pending','drained','partial','interrupted','failed','unknown_after_crash')),
  PRIMARY KEY (delivery_attempt_id, chunk_ordinal)
) STRICT;

CREATE TABLE summaries (
  summary_id TEXT PRIMARY KEY,
  logical_room_id TEXT NOT NULL REFERENCES logical_rooms(logical_room_id),
  summary_kind TEXT NOT NULL,
  coverage_start_sequence INTEGER NOT NULL,
  coverage_end_sequence INTEGER NOT NULL,
  based_on_room_version INTEGER NOT NULL,
  summary_text TEXT,
  content_hash TEXT NOT NULL,
  record_version INTEGER NOT NULL CHECK (record_version > 0),
  status TEXT NOT NULL CHECK (status IN ('active','superseded','tombstoned')),
  replaced_by_id TEXT REFERENCES summaries(summary_id),
  created_at TEXT NOT NULL,
  UNIQUE (logical_room_id, summary_kind, coverage_start_sequence, coverage_end_sequence, record_version),
  CHECK (coverage_start_sequence <= coverage_end_sequence),
  CHECK (status = 'tombstoned' OR summary_text IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX uq_summary_active_slot ON summaries(logical_room_id, summary_kind, coverage_start_sequence, coverage_end_sequence) WHERE status = 'active';

CREATE TABLE semantic_memories (
  memory_id TEXT PRIMARY KEY,
  person_id TEXT REFERENCES people(person_id),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('dm','guild','person','character','logical_room','unbound_channel')),
  scope_id TEXT NOT NULL,
  predicate_key TEXT NOT NULL,
  value_json TEXT CHECK (value_json IS NULL OR json_valid(value_json)),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  valid_from TEXT,
  valid_to TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','superseded','corrected','tombstoned')),
  superseded_by_id TEXT REFERENCES semantic_memories(memory_id),
  created_at TEXT NOT NULL,
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
  CHECK (status = 'tombstoned' OR value_json IS NOT NULL)
) STRICT;
CREATE INDEX ix_semantic_scope_predicate ON semantic_memories(scope_type, scope_id, predicate_key, status);

CREATE TABLE episodic_memories (
  episodic_memory_id TEXT PRIMARY KEY,
  person_id TEXT REFERENCES people(person_id),
  logical_room_id TEXT REFERENCES logical_rooms(logical_room_id),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('dm','guild','person','character','logical_room','unbound_channel')),
  scope_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('active','superseded','corrected','tombstoned')),
  superseded_by_id TEXT REFERENCES episodic_memories(episodic_memory_id),
  CHECK (status = 'tombstoned' OR payload_json IS NOT NULL)
) STRICT;

CREATE TABLE procedural_memories (
  procedural_memory_id TEXT PRIMARY KEY,
  author_type TEXT NOT NULL CHECK (author_type = 'operator'),
  author_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('guild','character','logical_room')),
  scope_id TEXT NOT NULL,
  rule_text TEXT,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','superseded','tombstoned')),
  superseded_by_id TEXT REFERENCES procedural_memories(procedural_memory_id),
  CHECK (status = 'tombstoned' OR rule_text IS NOT NULL)
) STRICT;

CREATE TABLE memory_provenance (
  provenance_id TEXT PRIMARY KEY,
  memory_kind TEXT NOT NULL CHECK (memory_kind IN ('summary','semantic','episodic','procedural')),
  memory_id TEXT NOT NULL,
  source_event_id TEXT REFERENCES events(event_id),
  source_memory_id TEXT,
  role TEXT NOT NULL,
  evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
  CHECK (source_event_id IS NOT NULL OR source_memory_id IS NOT NULL),
  UNIQUE (memory_kind, memory_id, source_event_id, source_memory_id, role)
) STRICT;
CREATE INDEX ix_provenance_source_event ON memory_provenance(source_event_id);

CREATE TABLE corrections (
  correction_id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('event','summary','semantic','episodic','procedural')),
  target_id TEXT NOT NULL,
  replacement_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_event_id TEXT REFERENCES events(event_id),
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  UNIQUE (target_kind, target_id, replacement_id)
) STRICT;

CREATE TABLE worker_jobs (
  job_id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('ready','leased','succeeded','dead_letter','cancelled')),
  priority INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
  last_error_code TEXT,
  last_error_redacted TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (job_type, dedupe_key)
) STRICT;
CREATE INDEX ix_jobs_claim ON worker_jobs(status, available_at, priority, job_id);
CREATE INDEX ix_jobs_lease ON worker_jobs(status, lease_expires_at);

CREATE TABLE forget_requests (
  forget_request_id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('person','room','guild','dm','character','time_range','fact_id')),
  subject_id TEXT NOT NULL,
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested','processing','completed','failed')),
  version INTEGER NOT NULL CHECK (version > 0),
  completed_at TEXT,
  verification_json TEXT CHECK (verification_json IS NULL OR json_valid(verification_json)),
  idempotency_key TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE deletion_tombstones (
  tombstone_id TEXT PRIMARY KEY,
  forget_request_id TEXT NOT NULL REFERENCES forget_requests(forget_request_id),
  target_table TEXT NOT NULL,
  target_id TEXT NOT NULL,
  redaction_state TEXT NOT NULL CHECK (redaction_state IN ('pending','redacted','deleted','verified')),
  created_at TEXT NOT NULL,
  verified_at TEXT,
  evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
  UNIQUE (forget_request_id, target_table, target_id)
) STRICT;
CREATE INDEX ix_deletion_tombstones_target ON deletion_tombstones(target_table, target_id);

CREATE TABLE migration_record_maps (
  migration_record_map_id TEXT PRIMARY KEY,
  migration_source_record_id TEXT NOT NULL REFERENCES migration_source_records(migration_source_record_id),
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  mapping_status TEXT NOT NULL CHECK (mapping_status IN ('migrated','quarantined','superseded','deleted')),
  mapped_at TEXT NOT NULL,
  UNIQUE (migration_source_record_id, target_kind, target_id)
) STRICT;
CREATE INDEX ix_migration_record_maps_target ON migration_record_maps(target_kind, target_id);
`
