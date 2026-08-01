import type { Readable } from 'node:stream'

import type { GptSoVitsLang, TtsProvider, TtsRequest } from './types'

import { Readable as NodeReadable } from 'node:stream'

import { useLogg } from '@guiiai/logg'

import { config } from '../../config'
import { resolveTtsLanguage } from './language'

/**
 * GPT-SoVITS TTS provider calling the native `api_v2.py` `/tts` endpoint
 * directly (plan.md §7: "no middle TTS proxy"). The AIRI stage-ui GPT-SoVITS
 * provider was used only as a reference for the parameter-naming convention.
 *
 * Voice = trained Kurisu Makise weights (loaded once on the GPT-SoVITS side,
 * via the config or `/set_*_weights`) + a per-request reference audio clip
 * that conditions the loaded model.
 *
 * Language fields are populated independently (Language_Fix_Proposal §13):
 *
 *   text_lang   = language of the text being synthesized (from the request;
 *                 `auto` defers to GPT-SoVITS' LangSegmenter)
 *   prompt_lang = language of the Kurisu reference clip (config, always `ja`)
 *
 * NOTE: the Kurisu model was trained on zh/ja only — English output quality is
 * limited (plan.md §27), but it must still synthesize without erroring once the
 * NLTK `averaged_perceptron_tagger_eng` resource is provisioned.
 */
export class GptSoVitsTtsProvider implements TtsProvider {
  private logger = useLogg('GptSoVitsTts').useGlobalConfig()
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(baseUrl?: string, timeoutMs?: number) {
    this.baseUrl = (baseUrl ?? config().tts.baseUrl).replace(/\/$/, '')
    this.timeoutMs = timeoutMs ?? config().tts.requestTimeoutMs
  }

  async synthesize(request: TtsRequest, signal: AbortSignal): Promise<Readable> {
    const cfg = config().tts
    if (!cfg.refAudioPath)
      throw new Error('GPT_SOVITS_REF_AUDIO is not set — a reference clip is required')

    // text_lang: the caller's resolved target language. `auto` is a first-class
    // value in GPT-SoVITS' `v2_languages`. Fall back to text detection only when
    // the caller didn't supply one at all.
    const textLang: GptSoVitsLang = request.language
      ?? resolveTtsLanguage({ text: request.text, textLangFallback: cfg.textLangFallback }).language

    // prompt_lang: always the configured Kurisu reference language, independent
    // of the synthesized target language (Language_Fix_Proposal §4, §15).
    const promptLang = cfg.promptLang || 'ja'

    const body = {
      text: request.text,
      text_lang: textLang,
      ref_audio_path: cfg.refAudioPath,
      prompt_text: cfg.promptText,
      prompt_lang: promptLang,
      media_type: 'wav',
      // Start with whole synthesis (mode 0) for correctness (plan.md §28).
      streaming_mode: cfg.streamingMode,
      speed_factor: 1.0,
      text_split_method: 'cut5',
    }

    // Distinguish the two language fields explicitly (§13, §33) — a single
    // ambiguous `language` field is what previously hid the routing bug.
    this.logger.withFields({
      textLanguage: textLang,
      promptLanguage: promptLang,
      streamingMode: cfg.streamingMode,
      chars: request.text.length,
    }).log('Synthesizing')

    // Combine the caller's abort with our timeout so a stuck GPT-SoVITS can't
    // hang a guild's playback queue.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const onAbort = () => controller.abort()
    if (signal.aborted)
      controller.abort()
    else
      signal.addEventListener('abort', onAbort, { once: true })

    try {
      const res = await fetch(`${this.baseUrl}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => res.statusText)
        throw new Error(this.describeHttpError(res.status, detail))
      }

      // Stream the audio bytes back to the voice transport. `res.body` is a
      // web ReadableStream; wrap it as a Node Readable for @discordjs/voice.
      const stream = NodeReadable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>)
      const cleanup = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
      stream.once('end', cleanup)
      // A transport may close before emitting `end`. It is still terminal and
      // must release the timeout and parent abort listener.
      stream.once('close', cleanup)
      stream.on('error', (err) => {
        cleanup()
        this.logger.withError(err).error('TTS stream error')
      })
      return stream
    }
    catch (err) {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      throw this.wrapNetworkError(err)
    }
  }

  /** Turn an HTTP failure into an actionable, non-secret-bearing message (§34). */
  private describeHttpError(status: number, detail: string): string {
    if (status === 400 && detail.includes('averaged_perceptron_tagger_eng')) {
      return 'GPT-SoVITS English frontend is missing the NLTK `averaged_perceptron_tagger_eng` resource. '
        + 'Run .\\setup-gpt-sovits.cmd (or start GPT-SoVITS with NLTK_DATA pointing at a populated location) before synthesizing English.'
    }
    return `GPT-SoVITS ${status}: ${detail}`
  }

  /** Surface connection failures with the configured address instead of a bare `fetch failed`. */
  private wrapNetworkError(err: unknown): unknown {
    if (err instanceof TypeError && /^fetch failed/i.test(err.message)) {
      const cause = (err as Error & { cause?: { code?: string } }).cause
      if (cause?.code === 'ECONNREFUSED') {
        return new Error(
          `GPT-SoVITS TTS service is not reachable at ${this.baseUrl} (connection refused). `
          + 'Wait for it to finish loading, or start it before invoking TTS.',
        )
      }
    }
    return err
  }
}
