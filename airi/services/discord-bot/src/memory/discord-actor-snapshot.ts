import type { ActorSnapshot, AnonymousActor } from '@proj-airi/memory-domain/identity'

import { timestampFromEpochMs } from '@proj-airi/memory-domain/ids'

/** Plain Discord data observed at an existing ingress boundary. */
export interface DiscordActorObservation {
  readonly userId?: string
  readonly username?: string
  readonly globalName?: string | null
  readonly guildNickname?: string | null
  readonly displayName?: string | null
  readonly avatarUrl?: string | null
  readonly guildId?: string
  readonly observedAtEpochMs: number
  readonly source: 'gateway' | 'restFetch'
  readonly anonymousReason?: 'missingUserId' | 'systemMessage' | 'cacheMiss'
}

/** Attribution evidence captured before internal person resolution exists. */
export type IngressActorEvidence
  = | { readonly kind: 'attributed', readonly snapshot: Readonly<ActorSnapshot> }
    | { readonly kind: 'anonymous', readonly actor: Readonly<AnonymousActor> }

function nonEmpty(value: string | null | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized || undefined
}

/**
 * Freezes actor evidence using only values already present at ingress.
 * It performs no fetch, cache lookup, identity merge, or persistence work.
 */
export function buildDiscordActorEvidence(observation: DiscordActorObservation): IngressActorEvidence {
  const userId = nonEmpty(observation.userId)
  const username = nonEmpty(observation.username)
  const globalName = nonEmpty(observation.globalName)
  const guildNickname = nonEmpty(observation.guildNickname)
  const displayName = nonEmpty(observation.displayName)
  const observedAt = timestampFromEpochMs(observation.observedAtEpochMs)
  const displayNameAtEvent = guildNickname ?? displayName ?? globalName ?? username ?? userId ?? 'Unknown Discord actor'

  if (!userId || observation.anonymousReason === 'systemMessage') {
    return Object.freeze({
      kind: 'anonymous',
      actor: Object.freeze({
        kind: 'anonymous',
        displayNameAtEvent,
        observedAt,
        reason: observation.anonymousReason ?? 'missingUserId',
      }),
    })
  }

  return Object.freeze({
    kind: 'attributed',
    snapshot: Object.freeze({
      platform: 'discord',
      platformUserId: userId,
      username,
      globalName,
      guildNickname,
      displayNameAtEvent,
      avatarRef: nonEmpty(observation.avatarUrl),
      guildId: nonEmpty(observation.guildId),
      observedAt,
      source: observation.source,
    }),
  })
}
