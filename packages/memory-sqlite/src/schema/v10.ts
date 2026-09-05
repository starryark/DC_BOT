/** Persists the content-free G6 layered selection beside its generation. */
export const schemaV10 = `
CREATE TABLE generation_layered_context_manifests (
  generation_id TEXT PRIMARY KEY REFERENCES generation_attempt_records(generation_id),
  format_version INTEGER NOT NULL CHECK (format_version = 1),
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  manifest_hash TEXT NOT NULL
) STRICT;
`
