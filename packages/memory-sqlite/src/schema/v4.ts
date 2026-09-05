/** Additive event and causal repository state for IMP-204. */
export const schemaV4 = `
CREATE TABLE inbound_event_records (
  event_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('user_text','user_voice','command','system')),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('attributed','anonymous')),
  author_person_id TEXT REFERENCES people(person_id),
  actor_json TEXT NOT NULL CHECK (json_valid(actor_json)),
  physical_room_id TEXT NOT NULL REFERENCES physical_room_records(physical_room_id),
  logical_room_id TEXT NOT NULL REFERENCES logical_rooms(logical_room_id),
  room_sequence INTEGER NOT NULL CHECK (room_sequence > 0),
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  retention_class TEXT NOT NULL CHECK (retention_class IN ('transcript','command','systemMetadata')),
  envelope_hash TEXT NOT NULL,
  CHECK ((actor_kind = 'attributed' AND author_person_id IS NOT NULL) OR (actor_kind = 'anonymous' AND author_person_id IS NULL)),
  UNIQUE (logical_room_id, room_sequence)
) STRICT;
CREATE INDEX ix_inbound_events_order ON inbound_event_records(logical_room_id, physical_room_id, occurred_at, event_id);

CREATE TABLE inbound_event_lifecycle (
  transition_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES inbound_event_records(event_id),
  from_state TEXT NOT NULL CHECK (from_state IN ('recorded','superseded','redacted','tombstoned')),
  to_state TEXT NOT NULL CHECK (to_state IN ('recorded','superseded','redacted','tombstoned')),
  transitioned_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  UNIQUE (event_id, ordinal)
) STRICT;

CREATE TABLE generation_causal_edges (
  generation_id TEXT NOT NULL REFERENCES assistant_generations(generation_id),
  inbound_event_id TEXT NOT NULL REFERENCES inbound_event_records(event_id),
  cause_role TEXT NOT NULL CHECK (cause_role IN ('trigger','context','correction','operator')),
  PRIMARY KEY (generation_id, inbound_event_id, cause_role)
) STRICT;
CREATE INDEX ix_causal_edges_event ON generation_causal_edges(inbound_event_id, generation_id, cause_role);
`
