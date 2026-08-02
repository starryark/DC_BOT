import { schemaV1 } from '../schema/v1.js'
import { schemaV2 } from '../schema/v2.js'

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
  {
    version: 2,
    name: 'identity_alias_repositories',
    checksum: '259421eed89d09f73a66083737b009b7ec21602257591e93e69a4a7326c054d7',
    sql: schemaV2,
  },
])

export const latestSchemaVersion = migrations.at(-1)?.version ?? 0
