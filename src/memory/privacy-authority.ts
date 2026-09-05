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
  /**
   * The durable privacy-operation record this answer came from. Absent in the
   * degraded posture, where no durable operation exists to identify — minting
   * an id there would name durable state that was never written.
   */
  operationId?: string
  message: string
  /**
   * Why the answer is a refusal rather than a result. `memory_degraded` means
   * the durable authority is unavailable: nothing was read, stored, or deleted.
   */
  code?: 'capability_disabled' | 'memory_degraded'
  attachment?: { name: string, data: string }
}

export interface PrivacyMemoryAuthority {
  execute: (input: PrivacyCommandInput) => Promise<PrivacyCommandResult>
}
