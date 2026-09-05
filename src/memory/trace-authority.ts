import type {
  AppendEventInput,
  AuthorizationContext,
  BeginDeliveryInput,
  BeginGenerationInput,
  CausalEdge,
  DeliveryAttempt,
  DeliveryTransition,
  GenerationAttempt,
  GenerationState,
  InboundEventEnvelope,
  OutputSegment,
} from '@proj-airi/memory-domain'

export interface AppendedEvent {
  readonly envelope: InboundEventEnvelope
  readonly deduplicated: boolean
}

export interface BegunGeneration {
  readonly generation: GenerationAttempt
  readonly edges: readonly CausalEdge[]
  readonly deduplicated: boolean
}

/** Durable shadow trace operations; transport sending remains owned by Discord adapters. */
export interface TraceMemoryAuthority {
  appendEvent: (authorization: AuthorizationContext, input: AppendEventInput) => Promise<AppendedEvent>
  beginGeneration: (authorization: AuthorizationContext, input: BeginGenerationInput) => Promise<BegunGeneration>
  transitionGeneration: (authorization: AuthorizationContext, generation: GenerationAttempt, from: GenerationState, to: GenerationState, at: import('@proj-airi/memory-domain').Timestamp) => Promise<GenerationAttempt>
  appendSegments: (authorization: AuthorizationContext, generation: GenerationAttempt, segments: readonly Omit<OutputSegment, 'generationId'>[]) => Promise<readonly OutputSegment[]>
  beginDelivery: (authorization: AuthorizationContext, input: BeginDeliveryInput) => Promise<DeliveryAttempt>
  transitionDelivery: (authorization: AuthorizationContext, transition: DeliveryTransition) => Promise<DeliveryAttempt>
}
