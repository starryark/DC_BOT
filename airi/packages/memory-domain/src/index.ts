/**
 * `@proj-airi/memory-domain` — transport-neutral shared-memory contracts.
 *
 * This package is the single source of the identity, scope, event, causality,
 * delivery, and memory-layer types used by both the Discord text path and the
 * voice path. It has no runtime dependencies and imports nothing from Discord,
 * a database, an HTTP client, or a model provider (ADR-002, AC-003).
 *
 * See `docs/memory/implementation-status.md` for the gate status that governs
 * what may be built on top of it.
 */

export * from './addressing'
export * from './aliases'
export * from './authorization'
export * from './capabilities'
export * from './causality'
export * from './corrections'
export * from './delivery'
export * from './errors'
export * from './events'
export * from './fixtures'
export * from './generation'
export * from './identity'
export * from './ids'
export * from './memory-records'
export * from './port'
export * from './provenance'
export * from './rooms'
