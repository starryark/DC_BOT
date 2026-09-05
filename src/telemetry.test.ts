import type { TelemetryRecord } from './telemetry'

import { describe, expect, it } from 'vitest'

import { Telemetry, TELEMETRY_EVENTS, TelemetryMetrics } from './telemetry'

describe('telemetry contract', () => {
  it('contains every required Wave 3D lifecycle event', () => {
    expect(TELEMETRY_EVENTS).toEqual(expect.arrayContaining([
      'guild_phase_changed',
      'utterance_received',
      'utterance_merged',
      'utterance_discarded',
      'transcript_filtered',
      'conversation_group_opened',
      'conversation_group_flushed',
      'response_epoch_started',
      'response_cancelled',
      'gemini_request_started',
      'gemini_rate_limited',
      'gemini_cooldown_active',
      'tts_cache_hit',
      'tts_cache_miss',
      'tts_synthesis_started',
      'tts_synthesis_completed',
      'tts_http_headers_received',
      'tts_first_audio_byte',
      'tts_audio_stream_completed',
      'playback_enqueued',
      'playback_started',
      'playback_completed',
      'playback_cancelled',
      'playback_invariant_violation',
    ]))
  })

  it('emits primitive structured fields and removes sensitive names', () => {
    const records: TelemetryRecord[] = []
    const telemetry = new Telemetry(record => records.push(record), () => 1234)
    telemetry.emit('tts_cache_hit', {
      guildId: 'g1',
      cacheTier: 'memory',
      apiKey: 'never-log-this',
      authorizationHeader: 'never-log-this',
      promptText: 'private prompt',
      undefinedValue: undefined,
    })
    expect(records).toEqual([{
      event: 'tts_cache_hit',
      timestamp: 1234,
      fields: { guildId: 'g1', cacheTier: 'memory' },
    }])
  })

  it('calculates rates, counts, latency averages, and TTS real-time factor', () => {
    const metrics = new TelemetryMetrics()
    const add = (event: TelemetryRecord['event'], fields: TelemetryRecord['fields'] = {}) => metrics.add({ event, fields, timestamp: 0 })
    add('utterance_received', { asrLatencyMs: 100 })
    add('utterance_discarded', { reason: 'busy' })
    add('transcript_filtered', { reason: 'filler' })
    add('transcript_filtered', { reason: 'duplicate' })
    add('tts_cache_hit', { cacheTier: 'disk' })
    add('tts_cache_miss')
    add('gemini_rate_limited')
    add('gemini_first_token', { geminiFirstTokenMs: 250 })
    add('playback_started', { firstAudibleMs: 400, queueWaitMs: 20 })
    add('playback_completed', { responsePlaybackMs: 800 })
    add('tts_synthesis_completed', { synthesisMs: 100, durationMs: 200 })

    expect(metrics.snapshot()).toEqual({
      discardRate: 0.5,
      discardByReason: { busy: 1 },
      fillerFilterRate: 0.5,
      duplicateFilterRate: 0.5,
      ttsCacheHitRate: 0.5,
      gemini429Count: 1,
      cancelledStaleResultCount: 0,
      averageAsrLatencyMs: 100,
      averageGeminiFirstTokenMs: 250,
      averageFirstAudibleMs: 400,
      averageTtsRealTimeFactor: 0.5,
      averagePlaybackQueueWaitMs: 20,
      averageResponsePlaybackMs: 800,
    })
  })
})
