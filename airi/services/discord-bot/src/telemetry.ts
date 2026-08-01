export const TELEMETRY_EVENTS = [
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
  'gemini_first_token',
  'gemini_rate_limited',
  'gemini_cooldown_active',
  'tts_cache_hit',
  'tts_cache_miss',
  'tts_synthesis_started',
  'tts_synthesis_completed',
  'playback_enqueued',
  'playback_started',
  'playback_completed',
  'playback_cancelled',
  'playback_invariant_violation',
] as const

export type TelemetryEventName = typeof TELEMETRY_EVENTS[number]
export type TelemetryValue = string | number | boolean | null
export type TelemetryFields = Record<string, TelemetryValue | undefined>

export interface TelemetryRecord {
  event: TelemetryEventName
  timestamp: number
  fields: Record<string, TelemetryValue>
}

export type TelemetrySink = (record: TelemetryRecord) => void

const SENSITIVE_FIELD = /^(?:api.?key|authorization|token|secret|audio|pcm|prompt|cache.?contents?|environment)/i

/** Build safe, structured records without ever accepting binary or object payloads. */
export class Telemetry {
  constructor(private readonly sink: TelemetrySink, private readonly now: () => number = Date.now) {}

  emit(event: TelemetryEventName, fields: TelemetryFields = {}): TelemetryRecord {
    const safeFields: Record<string, TelemetryValue> = {}
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && !SENSITIVE_FIELD.test(key))
        safeFields[key] = value
    }
    const record = { event, timestamp: this.now(), fields: safeFields }
    this.sink(record)
    return record
  }
}

export interface DerivedTelemetryMetrics {
  discardRate: number
  discardByReason: Record<string, number>
  fillerFilterRate: number
  duplicateFilterRate: number
  ttsCacheHitRate: number
  gemini429Count: number
  cancelledStaleResultCount: number
  averageAsrLatencyMs?: number
  averageGeminiFirstTokenMs?: number
  averageFirstAudibleMs?: number
  averageTtsRealTimeFactor?: number
  averagePlaybackQueueWaitMs?: number
  averageResponsePlaybackMs?: number
}

/** Incremental aggregation suitable for logs, tests, or a future metrics exporter. */
export class TelemetryMetrics {
  private counts = new Map<TelemetryEventName, number>()
  private discards = new Map<string, number>()
  private filters = new Map<string, number>()
  private samples = new Map<string, number[]>()

  add(record: TelemetryRecord): void {
    this.counts.set(record.event, (this.counts.get(record.event) ?? 0) + 1)
    const reason = typeof record.fields.reason === 'string' ? record.fields.reason : undefined
    if (record.event === 'utterance_discarded' && reason)
      this.discards.set(reason, (this.discards.get(reason) ?? 0) + 1)
    if (record.event === 'transcript_filtered' && reason)
      this.filters.set(reason, (this.filters.get(reason) ?? 0) + 1)

    this.sample(record, 'asrLatencyMs')
    this.sample(record, 'geminiFirstTokenMs')
    this.sample(record, 'firstAudibleMs')
    this.sample(record, 'queueWaitMs')
    this.sample(record, 'responsePlaybackMs')
    const synthesisMs = record.fields.synthesisMs
    const durationMs = record.fields.durationMs
    if (record.event === 'tts_synthesis_completed' && typeof synthesisMs === 'number' && typeof durationMs === 'number' && durationMs > 0)
      this.push('ttsRealTimeFactor', synthesisMs / durationMs)
  }

  snapshot(): DerivedTelemetryMetrics {
    const received = this.count('utterance_received') + this.count('utterance_discarded')
    const filtered = [...this.filters.values()].reduce((sum, count) => sum + count, 0)
    const cacheRequests = this.count('tts_cache_hit') + this.count('tts_cache_miss')
    return {
      discardRate: received ? this.count('utterance_discarded') / received : 0,
      discardByReason: Object.fromEntries(this.discards),
      fillerFilterRate: filtered ? (this.filters.get('filler') ?? 0) / filtered : 0,
      duplicateFilterRate: filtered ? (this.filters.get('duplicate') ?? 0) / filtered : 0,
      ttsCacheHitRate: cacheRequests ? this.count('tts_cache_hit') / cacheRequests : 0,
      gemini429Count: this.count('gemini_rate_limited'),
      cancelledStaleResultCount: this.discards.get('stale_result') ?? 0,
      averageAsrLatencyMs: this.average('asrLatencyMs'),
      averageGeminiFirstTokenMs: this.average('geminiFirstTokenMs'),
      averageFirstAudibleMs: this.average('firstAudibleMs'),
      averageTtsRealTimeFactor: this.average('ttsRealTimeFactor'),
      averagePlaybackQueueWaitMs: this.average('queueWaitMs'),
      averageResponsePlaybackMs: this.average('responsePlaybackMs'),
    }
  }

  private count(event: TelemetryEventName): number {
    return this.counts.get(event) ?? 0
  }

  private sample(record: TelemetryRecord, field: string): void {
    const value = record.fields[field]
    if (typeof value === 'number' && Number.isFinite(value))
      this.push(field, value)
  }

  private push(metric: string, value: number): void {
    this.samples.set(metric, [...(this.samples.get(metric) ?? []), value])
  }

  private average(metric: string): number | undefined {
    const values = this.samples.get(metric)
    if (!values?.length)
      return undefined
    return values.reduce((sum, value) => sum + value, 0) / values.length
  }
}
