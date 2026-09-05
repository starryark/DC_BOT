/** Durable, reconstructable pre-model context evidence. */
export const schemaV8 = `
CREATE TABLE generation_context_manifests (
  generation_id TEXT PRIMARY KEY REFERENCES generation_attempt_records(generation_id),
  format_version INTEGER NOT NULL CHECK (format_version = 1),
  logical_room_version INTEGER NOT NULL CHECK (logical_room_version >= 0),
  binding_revision INTEGER NOT NULL CHECK (binding_revision >= 0),
  max_items INTEGER NOT NULL CHECK (max_items >= 0),
  max_characters INTEGER NOT NULL CHECK (max_characters >= 0),
  candidate_read_limit INTEGER NOT NULL CHECK (candidate_read_limit >= 0),
  truncated INTEGER NOT NULL CHECK (truncated IN (0,1))
) STRICT;

CREATE TABLE generation_context_manifest_items (
  generation_id TEXT NOT NULL REFERENCES generation_context_manifests(generation_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  source_type TEXT NOT NULL CHECK (source_type IN ('inbound','assistant_output')),
  inbound_event_id TEXT REFERENCES inbound_event_records(event_id),
  output_segment_id TEXT REFERENCES output_segment_records(segment_id),
  delivery_id TEXT REFERENCES delivery_attempt_records(delivery_id),
  delivery_state TEXT CHECK (delivery_state IN ('pending','delivering','delivered','partiallyDelivered','failed','interrupted','unheard','unknownAfterCrash','reconciled','abandoned')),
  delivery_state_at TEXT,
  PRIMARY KEY (generation_id, ordinal),
  CHECK (
    (source_type='inbound' AND inbound_event_id IS NOT NULL AND output_segment_id IS NULL AND delivery_id IS NULL AND delivery_state IS NULL AND delivery_state_at IS NULL)
    OR
    (source_type='assistant_output' AND inbound_event_id IS NULL AND output_segment_id IS NOT NULL AND delivery_id IS NOT NULL AND delivery_state IS NOT NULL AND delivery_state_at IS NOT NULL)
  )
) STRICT;
CREATE UNIQUE INDEX ux_generation_manifest_inbound ON generation_context_manifest_items(generation_id,inbound_event_id) WHERE source_type='inbound';
CREATE UNIQUE INDEX ux_generation_manifest_assistant ON generation_context_manifest_items(generation_id,output_segment_id,delivery_id) WHERE source_type='assistant_output';

CREATE TABLE privacy_operation_records (
  operation_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('status','show','export','remember','correct','forget')),
  scope_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  outcome_code TEXT CHECK (outcome_code IN ('succeeded','capability_disabled','failed')),
  forget_request_id TEXT REFERENCES forget_requests(forget_request_id),
  CHECK ((completed_at IS NULL AND outcome_code IS NULL AND forget_request_id IS NULL)
    OR (completed_at IS NOT NULL AND outcome_code IS NOT NULL)),
  CHECK (forget_request_id IS NULL OR operation_kind='forget')
) STRICT;
CREATE INDEX ix_privacy_operations_requested_at ON privacy_operation_records(requested_at,operation_id);
`
