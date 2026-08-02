import { schemaV1 } from '../schema/v1.js'

/** A deterministic, forward-only SQLite schema change. */
export interface Migration {
  readonly version: number
  readonly name: string
  readonly checksum: string
  readonly sql: string
}

export const migrations: readonly Migration[] = Object.freeze([
  {
    version: 1,
    name: 'initial_shared_memory_schema',
    checksum: 'eb437ff3cf9bca1ab28719bff3d526d57e2f6bcdbb98ab48c545ec618518baf9',
    sql: schemaV1,
  },
])

export const latestSchemaVersion = migrations.at(-1)?.version ?? 0
