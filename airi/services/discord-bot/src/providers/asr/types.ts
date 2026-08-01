/**
 * ASR provider interface (plan.md §11). Discord classes know only this
 * interface — never "Qwen" by name.
 */
export interface AsrResult {
  text: string
  /** BCP-ish code: `zh` | `en` | `ja` | `und` | other. */
  language: string
  inferenceMs: number
  /** Honest backend capability report; current Qwen service does not decoder-bias. */
  hotwordMode?: 'native' | 'prompt' | 'post-normalization' | 'unsupported'
}

export interface AsrInput {
  /** 16 kHz mono PCM16 WAV (header + samples). */
  wav: Buffer
  sampleRate: 16000
  languageHint?: 'ja' | 'zh' | 'en'
  hotwords?: string[]
}

export interface AsrProvider {
  transcribe: (input: AsrInput) => Promise<AsrResult>

  /** Lightweight liveness check used at startup / before sending audio. */
  health: () => Promise<{ ready: boolean }>
}
