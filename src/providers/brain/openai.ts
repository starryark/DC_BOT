import type { BrainProvider, BrainRequest } from './types'

import { BrainRateLimitError, BrainRequestAbortedError } from './errors'

export interface OpenAiBrainOptions {
  apiKey: string
  model: string
  fetch?: typeof fetch
}

/** Optional Responses provider for complex turns; no tools or speculative retries. */
export class OpenAiBrainProvider implements BrainProvider {
  private active = 0

  constructor(private readonly options: OpenAiBrainOptions) {
    if (!options.apiKey || /[\r\n]/u.test(options.apiKey) || !options.model)
      throw new Error('OpenAI escalation credentials/model are missing')
  }

  async* generate(request: BrainRequest, signal: AbortSignal): AsyncIterable<string> {
    if (signal.aborted)
      throw new BrainRequestAbortedError()
    if (this.active >= 2)
      throw new BrainRateLimitError('Escalation capacity exhausted', { retryAfterMs: 1000, model: this.options.model })
    this.active++
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const cancelRead = () => { void reader?.cancel().catch(() => {}) }
    try {
      const input = request.contents.map((content) => {
        if (content.parts?.some(part => part.text === undefined))
          throw new Error('Text escalation cannot silently discard non-text context')
        return { role: content.role === 'model' ? 'assistant' : 'user',
          content: content.parts?.map(part => part.text).join('') || '' }
      })
      const response = await (this.options.fetch ?? fetch)('https://api.openai.com/v1/responses', {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.options.apiKey}` },
        body: JSON.stringify({ model: this.options.model, instructions: request.systemInstruction,
          input, stream: true, store: false, max_output_tokens: Math.min(8192, request.generationProfile.maxOutputTokens) }),
      })
      if (response.status === 429) {
        await response.body?.cancel()
        const seconds = Number(response.headers.get('retry-after'))
        throw new BrainRateLimitError('Escalation provider rate limited', {
          retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 300000) : 30000,
          model: this.options.model,
        })
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw new Error('Escalation provider request failed')
      }
      reader = response.body.getReader()
      signal.addEventListener('abort', cancelRead, { once: true })
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let buffer = ''
      let text = ''
      let completed = false
      while (true) {
        const next = await reader.read()
        if (signal.aborted)
          throw new BrainRequestAbortedError()
        if (next.done)
          break
        buffer += decoder.decode(next.value, { stream: true })
        if (buffer.length > 262144)
          throw new Error('Escalation event buffer exceeded')
        let boundary: RegExpExecArray | null
        while ((boundary = /\r?\n\r?\n/u.exec(buffer)) !== null) {
          if (signal.aborted)
            throw new BrainRequestAbortedError()
          const event = buffer.slice(0, boundary.index)
          buffer = buffer.slice(boundary.index + boundary[0].length)
          const payload = event.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /u, '')).join('\n')
          if (!payload || payload === '[DONE]')
            continue
          const record = JSON.parse(payload)
          if (completed)
            throw new Error('Unexpected events after response completion')
          if (record.type === 'response.output_text.delta' || record.type === 'response.refusal.delta') {
            if (typeof record.delta !== 'string' || text.length + record.delta.length > 65536)
              throw new Error('Escalation response bound exceeded')
            text += record.delta
            yield record.delta
          }
          else if (record.type === 'response.completed') {
            if (record.response?.status !== 'completed')
              throw new Error('Escalation response incomplete')
            const output = record.response.output as { type: string, content?: { type: string, text?: string, refusal?: string }[] }[]
            if (!Array.isArray(output) || output.some(item => item.type === 'function_call'))
              throw new Error('Unexpected tool call from text-only escalation')
            const final = output.filter(item => item.type === 'message').flatMap(item => item.content ?? [])
              .map(part => part.type === 'output_text' ? part.text ?? '' : part.type === 'refusal' ? part.refusal ?? '' : '').join('')
            if (!final.startsWith(text) || final.length > 65536)
              throw new Error('Terminal response contradicted streamed text')
            if (final.length > text.length)
              yield final.slice(text.length)
            completed = true
          }
          else if (['error', 'response.failed', 'response.incomplete'].includes(record.type)) {
            throw new Error('Escalation response failed')
          }
        }
      }
      if (!completed)
        throw new Error('Escalation stream ended before completion')
    }
    catch (error) {
      if (signal.aborted)
        throw new BrainRequestAbortedError()
      if (error instanceof BrainRateLimitError)
        throw error
      throw new Error('OpenAI escalation request or stream failed')
    }
    finally {
      await reader?.cancel().catch(() => {})
      signal.removeEventListener('abort', cancelRead)
      reader?.releaseLock()
      this.active--
    }
  }
}

export class EscalatingBrainProvider implements BrainProvider {
  constructor(private readonly primary: BrainProvider, private readonly escalation: BrainProvider) {}

  generate(request: BrainRequest, signal: AbortSignal): AsyncIterable<string> {
    const complex = request.generationProfile.responseLengthClass === 'detailed'
      || request.generationProfile.thinkingLevel === 'high'
    return (complex ? this.escalation : this.primary).generate(request, signal)
  }
}
