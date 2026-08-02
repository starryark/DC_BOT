import { schemaV1 } from '../schema/v1.js'
import { schemaV2 } from '../schema/v2.js'
import { schemaV3 } from '../schema/v3.js'
import { schemaV4 } from '../schema/v4.js'

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
  {
    version: 3,
    name: 'room_binding_authorization_repositories',
    checksum: 'c4bac88f79afa93560b3f8a9ca165d075dd5b3aa03350538a006d4dad7ef3ca4',
    sql: schemaV3,
  },
  {
    version: 4,
    name: 'event_causality_repositories',
    checksum: 'cbe385b24720f051a3389fbeb2b1663564ff9beb43c68fe86b41c4ba875512f7',
    sql: schemaV4,
  },
])

export const latestSchemaVersion = migrations.at(-1)?.version ?? 0
