/** Domain-shaped layered-memory persistence for IMP-206. Legacy v1 tables remain untouched. */
export const schemaV6 = `
CREATE TABLE summary_repository_records (
  summary_id TEXT PRIMARY KEY,
  logical_room_id TEXT NOT NULL REFERENCES logical_rooms(logical_room_id),
  text TEXT NOT NULL,
  model_ref TEXT NOT NULL,
  stale INTEGER NOT NULL CHECK (stale IN (0,1)),
  superseded_by TEXT REFERENCES summary_repository_records(summary_id),
  tombstoned_by TEXT,
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  recorded_at TEXT NOT NULL,
  provenance_source TEXT NOT NULL CHECK (provenance_source IN ('userStated','operator','assistantSpeculation','derived')),
  extraction_method TEXT NOT NULL CHECK (extraction_method IN ('explicitCommand','llmExtraction','ruleExtraction','operatorEntry','summarization')),
  stated_at TEXT NOT NULL,
  authored_by TEXT,
  input_hash TEXT NOT NULL,
  CHECK (valid_until IS NULL OR valid_until >= valid_from)
) STRICT;
CREATE INDEX ix_summary_repository_room ON summary_repository_records(logical_room_id, recorded_at, summary_id);

CREATE TABLE summary_source_event_records (
  summary_id TEXT NOT NULL REFERENCES summary_repository_records(summary_id),
  source_event_id TEXT NOT NULL REFERENCES inbound_event_records(event_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (summary_id, source_event_id),
  UNIQUE (summary_id, ordinal)
) STRICT;

CREATE TABLE semantic_fact_repository_records (
  fact_id TEXT PRIMARY KEY,
  person_id TEXT REFERENCES people(person_id),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('platform','character','guild','logical_room','dm')),
  scope_id TEXT,
  predicate TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  supersedes TEXT UNIQUE REFERENCES semantic_fact_repository_records(fact_id),
  superseded_by TEXT UNIQUE REFERENCES semantic_fact_repository_records(fact_id),
  tombstoned_by TEXT,
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  recorded_at TEXT NOT NULL,
  provenance_source TEXT NOT NULL CHECK (provenance_source IN ('userStated','operator','assistantSpeculation','derived')),
  extraction_method TEXT NOT NULL CHECK (extraction_method IN ('explicitCommand','llmExtraction','ruleExtraction','operatorEntry','summarization')),
  stated_at TEXT NOT NULL,
  authored_by TEXT,
  input_hash TEXT NOT NULL,
  CHECK (valid_until IS NULL OR valid_until >= valid_from),
  CHECK ((supersedes IS NULL) OR (supersedes <> fact_id)),
  CHECK ((superseded_by IS NULL) OR (superseded_by <> fact_id))
) STRICT;
CREATE INDEX ix_semantic_fact_as_of ON semantic_fact_repository_records(scope_kind, scope_id, predicate, valid_from, valid_until, fact_id);

CREATE TABLE episodic_repository_records (
  episodic_id TEXT PRIMARY KEY,
  person_id TEXT REFERENCES people(person_id),
  logical_room_id TEXT NOT NULL REFERENCES logical_rooms(logical_room_id),
  occurred_at TEXT NOT NULL,
  summary TEXT NOT NULL,
  tombstoned_by TEXT,
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  recorded_at TEXT NOT NULL,
  provenance_source TEXT NOT NULL CHECK (provenance_source IN ('userStated','operator','assistantSpeculation','derived')),
  extraction_method TEXT NOT NULL CHECK (extraction_method IN ('explicitCommand','llmExtraction','ruleExtraction','operatorEntry','summarization')),
  stated_at TEXT NOT NULL,
  authored_by TEXT,
  input_hash TEXT NOT NULL,
  CHECK (valid_until IS NULL OR valid_until >= valid_from)
) STRICT;
CREATE INDEX ix_episodic_repository_room ON episodic_repository_records(logical_room_id, occurred_at, episodic_id);

CREATE TABLE procedural_repository_records (
  proc_id TEXT PRIMARY KEY,
  rule TEXT NOT NULL,
  tombstoned_by TEXT,
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  recorded_at TEXT NOT NULL,
  provenance_source TEXT NOT NULL CHECK (provenance_source = 'operator'),
  extraction_method TEXT NOT NULL CHECK (extraction_method IN ('explicitCommand','operatorEntry')),
  stated_at TEXT NOT NULL,
  authored_by TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  CHECK (valid_until IS NULL OR valid_until >= valid_from)
) STRICT;

CREATE TABLE memory_source_event_records (
  memory_kind TEXT NOT NULL CHECK (memory_kind IN ('summary','semantic','episodic','procedural')),
  memory_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL REFERENCES inbound_event_records(event_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (memory_kind, memory_id, source_event_id),
  UNIQUE (memory_kind, memory_id, ordinal)
) STRICT;
CREATE INDEX ix_memory_source_event ON memory_source_event_records(source_event_id, memory_kind, memory_id);
CREATE TRIGGER validate_memory_source_owner
BEFORE INSERT ON memory_source_event_records
BEGIN
  SELECT CASE
    WHEN NEW.memory_kind='summary' AND NOT EXISTS (SELECT 1 FROM summary_repository_records WHERE summary_id=NEW.memory_id) THEN RAISE(ABORT, 'missing summary provenance owner')
    WHEN NEW.memory_kind='semantic' AND NOT EXISTS (SELECT 1 FROM semantic_fact_repository_records WHERE fact_id=NEW.memory_id) THEN RAISE(ABORT, 'missing semantic provenance owner')
    WHEN NEW.memory_kind='episodic' AND NOT EXISTS (SELECT 1 FROM episodic_repository_records WHERE episodic_id=NEW.memory_id) THEN RAISE(ABORT, 'missing episodic provenance owner')
    WHEN NEW.memory_kind='procedural' AND NOT EXISTS (SELECT 1 FROM procedural_repository_records WHERE proc_id=NEW.memory_id) THEN RAISE(ABORT, 'missing procedural provenance owner')
  END;
END;

CREATE TABLE semantic_correction_records (
  correction_id TEXT PRIMARY KEY,
  previous_fact_id TEXT NOT NULL UNIQUE REFERENCES semantic_fact_repository_records(fact_id),
  replacement_fact_id TEXT NOT NULL UNIQUE REFERENCES semantic_fact_repository_records(fact_id),
  effective_at TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  CHECK (previous_fact_id <> replacement_fact_id)
) STRICT;
`
