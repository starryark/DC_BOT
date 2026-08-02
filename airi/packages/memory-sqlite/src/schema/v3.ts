/** Additive room repository state for IMP-203. */
export const schemaV3 = `
CREATE TABLE physical_room_records (
  physical_room_id TEXT PRIMARY KEY,
  locator_key TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL CHECK (platform = 'discord'),
  channel_id TEXT NOT NULL,
  channel_kind TEXT NOT NULL CHECK (channel_kind IN ('dm','guild_text','thread','guild_voice')),
  guild_id TEXT,
  participant_person_id TEXT,
  display_name TEXT,
  parent_channel_id TEXT,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','archived','inaccessible','deleted')),
  observed_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  CHECK ((channel_kind = 'dm' AND guild_id IS NULL AND participant_person_id IS NOT NULL) OR (channel_kind <> 'dm' AND guild_id IS NOT NULL AND participant_person_id IS NULL))
) STRICT;

CREATE TABLE logical_room_repository_records (
  logical_room_id TEXT PRIMARY KEY REFERENCES logical_rooms(logical_room_id),
  character_id TEXT NOT NULL,
  privacy_domain TEXT NOT NULL CHECK (privacy_domain IN ('guild','dm')),
  guild_id TEXT,
  singleton_physical_room_id TEXT REFERENCES physical_room_records(physical_room_id),
  binding_revision INTEGER NOT NULL DEFAULT 0 CHECK (binding_revision >= 0),
  CHECK ((privacy_domain = 'guild' AND guild_id IS NOT NULL) OR (privacy_domain = 'dm' AND guild_id IS NULL)),
  UNIQUE (character_id, singleton_physical_room_id)
) STRICT;

CREATE TABLE room_binding_records (
  binding_id TEXT PRIMARY KEY,
  physical_room_id TEXT NOT NULL REFERENCES physical_room_records(physical_room_id),
  logical_room_id TEXT NOT NULL REFERENCES logical_rooms(logical_room_id),
  character_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  active_version INTEGER
) STRICT;

CREATE TABLE room_binding_versions (
  binding_id TEXT NOT NULL REFERENCES room_binding_records(binding_id),
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('active','suspended','retired','superseded')),
  binding_kind TEXT NOT NULL CHECK (binding_kind IN ('explicit','configured')),
  cross_channel_history INTEGER NOT NULL CHECK (cross_channel_history IN (0,1)),
  direction TEXT NOT NULL CHECK (direction IN ('bidirectional','physicalToLogical')),
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  authorized_by TEXT NOT NULL,
  authorization_revision INTEGER NOT NULL CHECK (authorization_revision > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (binding_id, version),
  CHECK (valid_until IS NULL OR valid_until >= valid_from)
) STRICT;
CREATE UNIQUE INDEX uq_binding_active_applicable ON room_binding_records(physical_room_id, character_id) WHERE active_version IS NOT NULL;
CREATE INDEX ix_binding_physical ON room_binding_records(physical_room_id, character_id);
CREATE INDEX ix_binding_logical ON room_binding_records(logical_room_id, character_id);
`
