import type { CapabilityAdvertisement } from './capabilities'

import { describe, expect, it } from 'vitest'

import {
  ALL_CAPABILITIES,
  assertAdvertisementAllowed,
  capabilityForLexicalQuery,
  M1_FORBIDDEN_CAPABILITIES,
  M1_SQLITE_CAPABILITIES,
  needsCjkTokenizer,
  requireCapability,
  TEST_FAKE_CAPABILITIES,
} from './capabilities'
import { hasMemoryErrorCode, indicatesNonDurableWrite, MemoryError } from './errors'
import { asEventId, asTimestamp, compareTimestamps, isTimestamp, isValidId, timestampFromEpochMs } from './ids'
import { MEMORY_PORT_CONTRACT_VERSION, REQUIRED_M1_CAPABILITIES, RETRIEVAL_STAGE_ORDER } from './port'

const SQLITE: CapabilityAdvertisement = { schemaVersion: 1, capabilities: M1_SQLITE_CAPABILITIES, backend: 'sqlite' }

describe('branded ids', () => {
  it('accepts opaque tokens and rejects display text', () => {
    expect(isValidId('person-alex-one')).toBe(true)
    expect(isValidId('discord:user:100000000000000001')).toBe(true)
    expect(isValidId('Discord group')).toBe(false)
    expect(isValidId('')).toBe(false)
    expect(isValidId('x'.repeat(129))).toBe(false)
  })

  it('reports the kind that failed so the adapter can be found', () => {
    expect(() => asEventId('two words')).toThrowError(/EventId/)
  })
})

describe('timestamps', () => {
  it('requires RFC 3339 UTC', () => {
    expect(isTimestamp('2026-08-02T10:00:00Z')).toBe(true)
    expect(isTimestamp('2026-08-02T10:00:00.123Z')).toBe(true)
    expect(isTimestamp('2026-08-02T10:00:00+09:00')).toBe(false)
    expect(isTimestamp('2026-08-02 10:00:00')).toBe(false)
  })

  it('rejects a local-offset instant, because two adapters would order events differently', () => {
    expect(() => asTimestamp('2026-08-02T10:00:00+09:00')).toThrowError(/UTC/)
  })

  it('formats from epoch milliseconds and orders chronologically', () => {
    const early = timestampFromEpochMs(Date.UTC(2026, 7, 2, 10, 0, 0))
    const late = timestampFromEpochMs(Date.UTC(2026, 7, 2, 10, 0, 1))
    expect(compareTimestamps(early, late)).toBeLessThan(0)
    expect(compareTimestamps(late, early)).toBeGreaterThan(0)
    expect(compareTimestamps(early, early)).toBe(0)
  })
})

describe('error taxonomy', () => {
  it('defaults to non-retryable, because retrying a contract violation just fails again', () => {
    expect(new MemoryError('INVALID_PAYLOAD', 'nope').retryable).toBe(false)
    expect(new MemoryError('TIMEOUT', 'slow', { retryable: true }).retryable).toBe(true)
  })

  it('narrows by code', () => {
    const error = new MemoryError('SCOPE_LEAK_DETECTED', 'leak')
    expect(hasMemoryErrorCode(error, 'SCOPE_LEAK_DETECTED')).toBe(true)
    expect(hasMemoryErrorCode(error, 'TIMEOUT')).toBe(false)
    expect(hasMemoryErrorCode(new Error('plain'), 'TIMEOUT')).toBe(false)
  })

  // ADR-016 / artifact 09 F-1: a failed write must never be reported as remembered.
  it('identifies failures that mean the write is not durable', () => {
    expect(indicatesNonDurableWrite(new MemoryError('PERSISTENCE_FAILED', 'db down'))).toBe(true)
    expect(indicatesNonDurableWrite(new MemoryError('UNAVAILABLE', 'closed'))).toBe(true)
    expect(indicatesNonDurableWrite(new MemoryError('TIMEOUT', 'slow'))).toBe(true)
    expect(indicatesNonDurableWrite(new MemoryError('EMPTY_CONTENT', 'nothing to store'))).toBe(false)
  })
})

// FIND-002 / FIND-004: gated capabilities are gated on evidence, not configuration.
describe('capability gating (ADR-001, ADR-011)', () => {
  it('does not advertise vector, graph, or remote transport in milestone 1', () => {
    expect(M1_SQLITE_CAPABILITIES).not.toContain('vector_search')
    expect(M1_SQLITE_CAPABILITIES).not.toContain('graph_search')
    expect(M1_SQLITE_CAPABILITIES).not.toContain('remote_transport')
  })

  it.each(Object.keys(M1_FORBIDDEN_CAPABILITIES))('refuses an advertisement claiming %s', (capability) => {
    expect(() => assertAdvertisementAllowed({
      schemaVersion: 1,
      capabilities: [...M1_SQLITE_CAPABILITIES, capability as never],
      backend: 'sqlite',
    })).toThrowError(/may not be advertised/)
  })

  it('accepts the milestone-1 SQLite advertisement', () => {
    expect(() => assertAdvertisementAllowed(SQLITE)).not.toThrow()
  })

  it('gives the deterministic fake the same capability set (AC-3)', () => {
    expect(TEST_FAKE_CAPABILITIES).toEqual(M1_SQLITE_CAPABILITIES)
  })

  it('rejects an operation whose capability is unadvertised rather than degrading', () => {
    expect(() => requireCapability(SQLITE, 'vector_search', 'searchMemory'))
      .toThrowError(/does not advertise/)
    expect(() => requireCapability(SQLITE, 'durable_events', 'appendEvent')).not.toThrow()
  })

  it('advertises every capability the contract knows about, or deliberately omits it', () => {
    for (const capability of M1_SQLITE_CAPABILITIES)
      expect(ALL_CAPABILITIES).toContain(capability)
  })

  it('requires the milestone-1 minimum set', () => {
    for (const capability of REQUIRED_M1_CAPABILITIES)
      expect(M1_SQLITE_CAPABILITIES).toContain(capability)
  })
})

// RISK-M / TEST-I18N-RETRIEVAL / SCN-025 / TEST-010.
describe('multilingual capability split', () => {
  it('recognizes scripts that a whitespace tokenizer cannot segment', () => {
    expect(needsCjkTokenizer('今日は暑い')).toBe(true)
    expect(needsCjkTokenizer('我住在东京')).toBe(true)
    expect(needsCjkTokenizer('서울에 살아요')).toBe(true)
    expect(needsCjkTokenizer('I live in Tokyo')).toBe(false)
  })

  it('routes a CJK query to the CJK capability, not the Latin one', () => {
    expect(capabilityForLexicalQuery('I live in Tokyo')).toBe('fulltext_latin')
    expect(capabilityForLexicalQuery('東京に住んでいます')).toBe('fulltext_cjk')
  })

  it('makes a CJK query fail loudly on a Latin-only backend instead of returning nothing', () => {
    expect(() => requireCapability(SQLITE, capabilityForLexicalQuery('東京に住んでいます'), 'searchMemory'))
      .toThrowError(/fulltext_cjk/)
    expect(() => requireCapability(SQLITE, capabilityForLexicalQuery('Tokyo'), 'searchMemory')).not.toThrow()
  })

  it('handles a mixed-script query as CJK', () => {
    expect(capabilityForLexicalQuery('I live in 東京')).toBe('fulltext_cjk')
  })
})

describe('port contract', () => {
  it('publishes a contract version', () => {
    expect(MEMORY_PORT_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  // ADR-011 / REQ-RETRIEVAL-002: authorization happens before this list runs at all.
  it('orders retrieval stages with the gated modes last', () => {
    expect(RETRIEVAL_STAGE_ORDER).toEqual(['structured', 'lexical', 'vector', 'graph'])
    expect(RETRIEVAL_STAGE_ORDER.indexOf('vector')).toBeGreaterThan(RETRIEVAL_STAGE_ORDER.indexOf('lexical'))
  })
})
