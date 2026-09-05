import { Buffer } from 'node:buffer'
import { createHmac, randomBytes } from 'node:crypto'

/**
 * Run-scoped identifier redaction for the G8-1 evaluator (IMP-802).
 *
 * Every raw identifier a scenario touches — Discord snowflake, durable room
 * id, person id, generation id, segment id, delivery id — is replaced by a
 * run-scoped HMAC before it reaches a diagnostic or a report. The redaction
 * key is generated once per run and is never written to any published artifact;
 * it exists only in memory and (when the CLI keeps it) in the private run
 * output directory.
 *
 * This reuses the A8 soak's redaction shape (`kind:hex16`) so a reviewer reads
 * both tools' reports the same way, and so the report's redaction-shape scan
 * accepts the evaluator's diagnostics by construction.
 */

/** Generates a fresh 256-bit run-scoped redaction key as 64 hex chars. */
export function newRedactionKey(): string {
  return randomBytes(32).toString('hex')
}

/**
 * The redactor a run builds once and shares across every scenario.
 *
 * Raw ids are HMAC'd rather than plainly hashed so a published report cannot be
 * attacked by enumerating the small Discord-snowflake space. `kind` is folded
 * into the HMAC input, so the same raw id in two roles does not correlate.
 */
export function createRedactor(redactionKey: string): (kind: string, rawId: string) => string {
  const key = Buffer.from(redactionKey, 'hex')
  return (kind, rawId) => `${kind}:${createHmac('sha256', key).update(`${kind}\0${rawId}`).digest('hex').slice(0, 16)}`
}

/** The shape every redacted identifier must match: `kind:hex16`. */
export const REDACTED_SHAPE = /^[a-z][a-z0-9_]*:[0-9a-f]{16}$/

/** True when `value` looks like a redacted identifier. */
export function isRedacted(value: string): boolean {
  return REDACTED_SHAPE.test(value)
}

/**
 * Patterns that must never appear anywhere in a published report.
 *
 * Bare long digit runs catch real Discord snowflakes and the synthetic
 * snowflakes this evaluator mints; UUIDs and the runtime's durable-id prefixes
 * catch internal identifiers. These are matched against the whole serialized
 * report so a forgotten field cannot defeat redaction.
 *
 * Word fragments that the tool's own static strings contain (`generation`,
 * `delivery`, `room`) are deliberately excluded to avoid false positives.
 */
export const PROHIBITED_CONTENT_PATTERNS: readonly { readonly id: string, readonly pattern: RegExp }[] = Object.freeze([
  { id: 'discord-snowflake', pattern: /\b\d{17,20}\b/ },
  { id: 'uuid', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  { id: 'raw-durable-identifier', pattern: /(?:^|["\s])(?:configured:|discord:(?:guild|dm|user):|room:)/ },
  { id: 'canary-token', pattern: /\bcanary-[0-9a-f]{16}\b/ },
  // The redaction key is 64 hex chars but so are legitimate SHA-256 digests
  // (dataset digest, normalized result digest), so a bare 64-hex pattern would
  // false-positive on every report. The key is never serialized into a report
  // by construction; a leaked key is caught by the field-name scan below.
  { id: 'redaction-key-field', pattern: /"(?:redactionKey|redaction_key|privateKey|secret)"\s*:/ },
])

/** Content categories that must be scrubbed from any published text. */
export const SCRUBBED_KINDS = Object.freeze(['snowflake', 'room', 'person', 'generation', 'segment', 'delivery', 'binding', 'event', 'path', 'canary', 'key'])

/**
 * Scans a serialized artifact for prohibited content.
 *
 * Returns the ids of the first violated patterns. The caller turns each into a
 * redaction-scan failure, which is a nonzero-exit safety condition (CLI exit
 * code 4) rather than a scenario failure.
 */
export function prohibitedContentFindings(serialized: string): readonly string[] {
  const findings: string[] = []
  for (const rule of PROHIBITED_CONTENT_PATTERNS) {
    if (rule.pattern.test(serialized))
      findings.push(rule.id)
  }
  return Object.freeze(findings)
}
