import type { IngressActorEvidence } from './discord-actor-snapshot'

export type PrivacyOperation
  = | { kind: 'status' }
    | { kind: 'show' }
    | { kind: 'export' }
    | { kind: 'remember', predicate: string, value: string }
    | { kind: 'correct', factId: string, value: string }
    | { kind: 'forget' }

export interface PrivacyCommandInput {
  /** Stable content-free identity supplied by the transport, normally the Discord interaction ID. */
  requestId: string
  operation: PrivacyOperation
  actorEvidence: IngressActorEvidence
  discordUserId: string
  guildId?: string
  channelId: string
  channelKind: 'dm' | 'guildText' | 'thread'
  observedAt: number
}

export interface PrivacyCommandResult {
  operationId: string
  message: string
  code?: 'capability_disabled'
  attachment?: { name: string, data: string }
}

export interface PrivacyMemoryAuthority {
  execute: (input: PrivacyCommandInput) => Promise<PrivacyCommandResult>
}
