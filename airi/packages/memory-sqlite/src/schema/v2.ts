/** Additive repository support for IMP-202. Migration 1 remains immutable. */
export const schemaV2 = String.raw`
ALTER TABLE people ADD COLUMN kind TEXT NOT NULL DEFAULT 'account_subject' CHECK (kind IN ('account_subject','bot_account','system_account','legacy_unresolved'));
ALTER TABLE people ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','restricted','deleted','tombstoned','unresolved'));
ALTER TABLE people ADD COLUMN alias_revision INTEGER NOT NULL DEFAULT 0 CHECK (alias_revision >= 0);
ALTER TABLE people ADD COLUMN updated_at TEXT;

CREATE TABLE external_identities (
  external_identity_id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people(person_id),
  platform TEXT NOT NULL CHECK (platform = 'discord'),
  external_subject_key TEXT NOT NULL,
  link_status TEXT NOT NULL DEFAULT 'active' CHECK (link_status IN ('active','link_pending','unlinked','revoked','deleted')),
  verification_method TEXT NOT NULL CHECK (verification_method = 'platform_event'),
  verification_strength TEXT NOT NULL CHECK (verification_strength = 'platform_asserted'),
  verified_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  bot INTEGER NOT NULL CHECK (bot IN (0,1)),
  system INTEGER NOT NULL CHECK (system IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  UNIQUE (platform, external_subject_key),
  UNIQUE (person_id, platform)
) STRICT;

CREATE TABLE current_discord_profiles (
  external_identity_id TEXT PRIMARY KEY REFERENCES external_identities(external_identity_id),
  username TEXT,
  global_name TEXT,
  avatar_hash TEXT,
  bot INTEGER NOT NULL CHECK (bot IN (0,1)),
  system INTEGER NOT NULL CHECK (system IN (0,1)),
  observed_at TEXT NOT NULL,
  source_snapshot_id TEXT REFERENCES actor_snapshots(snapshot_id),
  supplied_fields TEXT NOT NULL CHECK (json_valid(supplied_fields)),
  profile_revision INTEGER NOT NULL DEFAULT 1 CHECK (profile_revision > 0)
) STRICT;

CREATE TABLE current_discord_guild_profiles (
  external_identity_id TEXT NOT NULL REFERENCES external_identities(external_identity_id),
  guild_id TEXT NOT NULL,
  guild_nickname TEXT,
  guild_avatar_hash TEXT,
  observed_at TEXT NOT NULL,
  source_snapshot_id TEXT REFERENCES actor_snapshots(snapshot_id),
  supplied_fields TEXT NOT NULL CHECK (json_valid(supplied_fields)),
  profile_revision INTEGER NOT NULL DEFAULT 1 CHECK (profile_revision > 0),
  PRIMARY KEY (external_identity_id, guild_id)
) STRICT;

CREATE TABLE actor_snapshot_details (
  snapshot_id TEXT PRIMARY KEY REFERENCES actor_snapshots(snapshot_id),
  observation_key TEXT NOT NULL UNIQUE,
  discord_user_id TEXT NOT NULL,
  guild_id TEXT,
  display_name_at_event TEXT NOT NULL,
  guild_avatar_hash TEXT,
  bot INTEGER,
  system INTEGER,
  source_event_type TEXT NOT NULL,
  completeness TEXT NOT NULL CHECK (completeness IN ('user_complete','user_partial','member_complete','member_partial')),
  supplied_fields TEXT NOT NULL CHECK (json_valid(supplied_fields)),
  CHECK (bot IS NULL OR bot IN (0,1)),
  CHECK (system IS NULL OR system IN (0,1))
) STRICT;

CREATE TABLE alias_repository_records (
  alias_id TEXT PRIMARY KEY REFERENCES aliases(alias_id),
  normalization_key TEXT NOT NULL,
  normalization_version TEXT NOT NULL,
  spoken_form TEXT,
  character_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('proposed','pending_confirmation','active','superseded','rejected','revoked','expired','quarantined')),
  preferred INTEGER NOT NULL DEFAULT 0 CHECK (preferred IN (0,1)),
  confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  authority TEXT NOT NULL CHECK (authority IN ('self_explicit','self_confirmed','platform_observed','target_confirmed_third_party','operator_administrative','migration','llm_proposed','third_party_unconfirmed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
) STRICT;
CREATE INDEX ix_alias_repository_lookup ON alias_repository_records(normalization_key, status);
CREATE TRIGGER enforce_one_active_preferred_alias_insert
BEFORE INSERT ON alias_repository_records
WHEN NEW.status = 'active' AND NEW.preferred = 1
BEGIN
  SELECT RAISE(ABORT, 'duplicate active preferred alias') WHERE EXISTS (
    SELECT 1 FROM alias_repository_records r
    JOIN aliases old_alias ON old_alias.alias_id = r.alias_id
    JOIN aliases new_alias ON new_alias.alias_id = NEW.alias_id
    WHERE r.status = 'active' AND r.preferred = 1 AND old_alias.valid_to IS NULL
      AND old_alias.person_id = new_alias.person_id AND old_alias.scope_type = new_alias.scope_type AND old_alias.scope_id = new_alias.scope_id
  );
END;

CREATE TABLE alias_evidence (
  evidence_id TEXT PRIMARY KEY,
  evidence_kind TEXT NOT NULL,
  source_snapshot_id TEXT REFERENCES actor_snapshots(snapshot_id),
  target_person_id TEXT NOT NULL REFERENCES people(person_id),
  source_external_identity_id TEXT REFERENCES external_identities(external_identity_id),
  created_at TEXT NOT NULL,
  authorization_context TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE
) STRICT;
CREATE TABLE alias_evidence_links (
  alias_id TEXT NOT NULL REFERENCES aliases(alias_id),
  evidence_id TEXT NOT NULL REFERENCES alias_evidence(evidence_id),
  relation TEXT NOT NULL CHECK (relation IN ('supports','corrects','rejects','supersedes','quarantines')),
  PRIMARY KEY (alias_id, evidence_id, relation)
) STRICT;
`
