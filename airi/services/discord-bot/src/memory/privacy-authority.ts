import type { IngressActorEvidence } from './discord-actor-snapshot'

export type PrivacyOperation
  = | { kind: 'status' }
    | { kind: 'show' }
    | { kind: 'export' }
    | { kind: 'remember', predicate: string, value: string }
    | { kind: 'correct', factId: string, value: string }
    | { kind: 'forget' }

export interface PrivacyCommandInput {
  operation: PrivacyOperation
  actorEvidence: IngressActorEvidence
  discordUserId: string
  guildId?: string
  channelId: string
  channelKind: 'dm' | 'guildText' | 'thread'
  observedAt: number
}

export interface PrivacyCommandResult {
  message: string
  attachment?: { name: string, data: string }
}

export interface PrivacyMemoryAuthority {
  execute: (input: PrivacyCommandInput) => Promise<PrivacyCommandResult>
}
