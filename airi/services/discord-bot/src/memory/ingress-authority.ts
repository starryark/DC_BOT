import type { AnonymousActor, AttributedActor, AuthorizationContext, CurrentPresentation, PhysicalLocation, RoomResolution } from '@proj-airi/memory-domain'

import type { IngressActorEvidence } from './discord-actor-snapshot'

export interface ResolveIngressInput {
  readonly authorization: AuthorizationContext
  readonly actorEvidence: IngressActorEvidence
  readonly location: PhysicalLocation
  readonly observationKey: string
  readonly displayName?: string
  readonly parentChannelId?: string
}

export interface ResolvedIngress {
  readonly actor: AttributedActor | AnonymousActor
  readonly presentation?: CurrentPresentation
  readonly room: RoomResolution
}

/** Authorized identity and room boundary shared by text, commands, and voice. */
export interface IngressMemoryAuthority {
  resolve: (input: ResolveIngressInput) => Promise<ResolvedIngress>
}
