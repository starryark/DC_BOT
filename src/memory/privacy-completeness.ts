import type { DeletionCompletenessReport } from '@proj-airi/memory-sqlite'

import type { SpoolStorageCensus } from './write-spool'

import { inspectSpoolStorage } from './write-spool'

/**
 * The complete privacy census for one memory runtime root (G7 pass condition 4).
 *
 * `deletionCompletenessReport` enumerates every storage class the *database*
 * holds and is authoritative about all of them. It is deliberately not
 * authoritative about the degraded write spool: those are files under the
 * runtime root, and teaching a SQLite package to stat the filesystem would put
 * the wrong knowledge in the wrong package. So the database report names that
 * class and declares it externally owned, and this module — which already lives
 * beside the spool and knows the runtime layout — supplies its state and
 * combines the two.
 *
 * The combination is what makes a completeness claim honest: SQLite deletion
 * completeness alone is not deletion completeness while raw user content sits
 * outside it.
 *
 * How the external spool interacts with subject forget and age-based retention:
 *
 * - **Pending records** are unreplayed accepted writes, and each is the only
 *   durable copy of one. They carry no resolved person or room — a degraded
 *   process has no authority to allocate either — so neither a forget nor a
 *   retention pass can select within them, and deleting one to satisfy a
 *   subject request would destroy another subject's message just as easily as
 *   the requester's. The disposition is therefore *replay first*: recovery
 *   commits them into the authority, where they become ordinary events that
 *   forget and retention already reach. Until then this report is incomplete,
 *   which is the honest answer rather than a deletion claim.
 *
 * - **Consumed records** are duplicates of content the authority already holds
 *   and governs. Compaction erases their bytes at the next recovery pass, and
 *   any that remain are counted here.
 *
 * - **Quarantine entries** are content-free evidence; there is nothing in them
 *   for a forget or retention pass to erase. A file still carrying record
 *   bodies — written by an older build, or edited by hand — is reported as
 *   carrying content and blocks completeness.
 *
 * The backup boundary follows from the same split: `createVerifiedBackup` and
 * `restoreVerifiedBackup` copy and re-delete the SQLite file only, so restore
 * obligation replay protects database content and says nothing about the spool.
 * The spool's lifecycle is replay and compaction, not backup and restore.
 */
export interface PrivacyCompletenessReport {
  /** Every storage class the database owns, with its machine-checked invariants. */
  readonly sqlite: DeletionCompletenessReport
  readonly external: { readonly degradedWriteSpool: SpoolStorageCensus }
  /** True only when no class — database or external — has outstanding content or a failed invariant. */
  readonly complete: boolean
  /** Why `complete` is false, one content-free reason per blocker. */
  readonly blockers: readonly string[]
}

export interface PrivacyCompletenessInput {
  /**
   * The database half, already computed by `deletionCompletenessReport`.
   *
   * Passed in rather than derived here so this module never holds a SQLite
   * connection: the Discord runtime's authority boundary allows exactly one
   * import of the SQLite implementation, and a privacy report is not it.
   */
  readonly sqlite: DeletionCompletenessReport
  /** The runtime's reserved spool directory; it need not exist. */
  readonly spoolDirectory: string
}

/** Combines database deletion completeness with the external spool's state. */
export function privacyCompletenessReport(input: PrivacyCompletenessInput): PrivacyCompletenessReport {
  const sqlite = input.sqlite
  const spool = inspectSpoolStorage(input.spoolDirectory)
  const blockers: string[] = []

  if (!sqlite.verifiedObligations.passed)
    blockers.push('a completed deletion obligation no longer verifies in the authority')
  if (!sqlite.lexicalIndexConsistent)
    blockers.push('a lexical index row points at a canonical record whose deletion completed')
  if (!sqlite.optionalStoresAbsent)
    blockers.push('an unexpected vector or graph store is present in the authority')
  if (spool.pendingRecords > 0)
    blockers.push(`${spool.pendingRecords} accepted write(s) are still unreplayed in the degraded write spool and are outside every deletion pass`)
  if (spool.unreadableRecords > 0)
    blockers.push(`${spool.unreadableRecords} unreadable spool line(s) are still on disk and have not been dispositioned`)
  if (spool.retainedConsumedRecords > 0)
    blockers.push(`${spool.retainedConsumedRecords} replayed spool record(s) still hold raw content on disk and have not been compacted`)
  if (spool.quarantineCarriesContent)
    blockers.push('the spool quarantine still carries raw record bodies')

  return { sqlite, external: { degradedWriteSpool: spool }, complete: blockers.length === 0, blockers }
}
