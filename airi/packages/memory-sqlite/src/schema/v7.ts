/** Transaction composition, idempotency, lease fencing, and reconciliation evidence for IMP-207. */
export const schemaV7 = `
ALTER TABLE worker_jobs ADD COLUMN payload_hash TEXT;
ALTER TABLE worker_jobs ADD COLUMN lease_token TEXT;

CREATE TABLE idempotency_records (
  namespace TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (namespace, idempotency_key)
) STRICT;

CREATE TABLE reconciliation_evidence_records (
  evidence_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES worker_jobs(job_id),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('observation','decision')),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  policy_version TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  UNIQUE (job_id, ordinal)
) STRICT;
CREATE INDEX ix_reconciliation_evidence_job ON reconciliation_evidence_records(job_id, ordinal);
CREATE TRIGGER reconciliation_evidence_no_update BEFORE UPDATE ON reconciliation_evidence_records
BEGIN SELECT RAISE(ABORT, 'reconciliation evidence is append-only'); END;
CREATE TRIGGER reconciliation_evidence_no_delete BEFORE DELETE ON reconciliation_evidence_records
BEGIN SELECT RAISE(ABORT, 'reconciliation evidence is append-only'); END;
`
