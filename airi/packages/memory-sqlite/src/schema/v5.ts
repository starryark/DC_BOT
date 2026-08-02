/** Additive generation, output, and delivery repository state for IMP-205. */
export const schemaV5 = `
CREATE TABLE generation_identifiers (
  generation_id TEXT PRIMARY KEY
) STRICT;
INSERT INTO generation_identifiers(generation_id) SELECT generation_id FROM assistant_generations;
CREATE TRIGGER register_legacy_generation_identifier
AFTER INSERT ON assistant_generations
BEGIN
  INSERT OR IGNORE INTO generation_identifiers(generation_id) VALUES (NEW.generation_id);
END;

ALTER TABLE generation_causal_edges RENAME TO generation_causal_edges_v4;
CREATE TABLE generation_causal_edges (
  generation_id TEXT NOT NULL REFERENCES generation_identifiers(generation_id),
  inbound_event_id TEXT NOT NULL REFERENCES inbound_event_records(event_id),
  cause_role TEXT NOT NULL CHECK (cause_role IN ('trigger','context','correction','operator')),
  PRIMARY KEY (generation_id, inbound_event_id, cause_role)
) STRICT;
INSERT INTO generation_causal_edges SELECT * FROM generation_causal_edges_v4;
DROP TABLE generation_causal_edges_v4;
CREATE INDEX ix_causal_edges_event ON generation_causal_edges(inbound_event_id, generation_id, cause_role);

CREATE TABLE generation_attempt_records (
  generation_id TEXT PRIMARY KEY REFERENCES generation_identifiers(generation_id),
  idempotency_key TEXT NOT NULL UNIQUE,
  logical_room_id TEXT NOT NULL REFERENCES logical_rooms(logical_room_id),
  character_id TEXT NOT NULL,
  current_state TEXT NOT NULL CHECK (current_state IN ('prepared','running','generated','persisted','failed','cancelled','superseded')),
  observed_room_version INTEGER NOT NULL CHECK (observed_room_version >= 0),
  context_manifest_hash TEXT NOT NULL,
  observed_binding_version INTEGER NOT NULL CHECK (observed_binding_version >= 0),
  captured_at TEXT NOT NULL,
  model_ref TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  input_hash TEXT NOT NULL
) STRICT;
CREATE INDEX ix_generation_attempt_scope ON generation_attempt_records(logical_room_id, character_id, generation_id);

CREATE TABLE generation_snapshot_events (
  generation_id TEXT NOT NULL REFERENCES generation_attempt_records(generation_id),
  event_id TEXT NOT NULL REFERENCES inbound_event_records(event_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (generation_id, event_id),
  UNIQUE (generation_id, ordinal)
) STRICT;

CREATE TABLE generation_lifecycle_records (
  transition_id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES generation_attempt_records(generation_id),
  from_state TEXT NOT NULL CHECK (from_state IN ('prepared','running','generated','persisted','failed','cancelled','superseded')),
  to_state TEXT NOT NULL CHECK (to_state IN ('prepared','running','generated','persisted','failed','cancelled','superseded')),
  transitioned_at TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  UNIQUE (generation_id, ordinal)
) STRICT;

CREATE TABLE output_segment_records (
  segment_id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES generation_attempt_records(generation_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  modality TEXT NOT NULL CHECK (modality IN ('text','voice')),
  exact_text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  UNIQUE (generation_id, ordinal)
) STRICT;
CREATE INDEX ix_output_segment_generation ON output_segment_records(generation_id, ordinal);

CREATE TABLE delivery_attempt_records (
  delivery_id TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL REFERENCES output_segment_records(segment_id),
  transport TEXT NOT NULL CHECK (transport IN ('discord_text','discord_voice')),
  destination_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  current_state TEXT NOT NULL CHECK (current_state IN ('pending','delivering','delivered','partiallyDelivered','failed','interrupted','unheard','unknownAfterCrash','reconciled','abandoned')),
  current_evidence_json TEXT NOT NULL CHECK (json_valid(current_evidence_json)),
  started_at TEXT NOT NULL,
  last_transition_at TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  UNIQUE (segment_id, transport, destination_id, attempt_number)
) STRICT;
CREATE INDEX ix_delivery_unresolved ON delivery_attempt_records(current_state, started_at, delivery_id);

CREATE TABLE delivery_lifecycle_records (
  transition_id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES delivery_attempt_records(delivery_id),
  from_state TEXT NOT NULL CHECK (from_state IN ('pending','delivering','delivered','partiallyDelivered','failed','interrupted','unheard','unknownAfterCrash','reconciled','abandoned')),
  to_state TEXT NOT NULL CHECK (to_state IN ('pending','delivering','delivered','partiallyDelivered','failed','interrupted','unheard','unknownAfterCrash','reconciled','abandoned')),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  transitioned_at TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  UNIQUE (delivery_id, ordinal)
) STRICT;
`
