import { describe, expect, it } from 'vitest'
import { EscalatingBrainProvider, OpenAiBrainProvider } from './openai'
import type { BrainRequest } from './types'
import { BrainRequestAbortedError } from './errors'

const request: BrainRequest = { guildId: 'g', userId: 'u', systemInstruction: 'system',
  contents: [{ role: 'user', parts: [{ text: 'question' }] }],
  generationProfile: { thinkingLevel: 'low', maxOutputTokens: 128, responseLengthClass: 'casual' } }

function sse(...records: object[]): string {
  return records.map(record => `data: ${JSON.stringify(record)}\n\n`).join('')
}

function terminal(text: string) {
  return { type: 'response.completed', response: { status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }] } }
}

async function collect(source: AsyncIterable<string>) {
  const values = []
  for await (const value of source) values.push(value)
  return values
}

describe('Responses escalation', () => {
  it('preserves prompts, disables storage, and streams before final tail', async () => {
    let payload: any
    const backend: typeof fetch = async (_url, options) => {
      payload = JSON.parse(options!.body as string)
      return new Response(sse({ type: 'response.output_text.delta', delta: 'Hello' }, terminal('Hello there')))
    }
    const provider = new OpenAiBrainProvider({ apiKey: 'fixture', model: 'gpt-6-astra', fetch: backend })
    expect(await collect(provider.generate(request, new AbortController().signal))).toEqual(['Hello', ' there'])
    expect(payload).toMatchObject({ model: 'gpt-6-astra', store: false, stream: true, instructions: 'system' })
    expect(payload.input).toEqual([{ role: 'user', content: 'question' }])
  })

  it('does not emit buffered events after cancellation', async () => {
    const backend: typeof fetch = async () => new Response(sse(
      { type: 'response.output_text.delta', delta: 'first' },
      { type: 'response.output_text.delta', delta: 'second' }, terminal('firstsecond')))
    const provider = new OpenAiBrainProvider({ apiKey: 'fixture', model: 'model', fetch: backend })
    const abort = new AbortController()
    const stream = provider.generate(request, abort.signal)[Symbol.asyncIterator]()
    expect((await stream.next()).value).toBe('first')
    abort.abort()
    await expect(stream.next()).rejects.toBeInstanceOf(BrainRequestAbortedError)
  })

  it('never retries a truncated response', async () => {
    let calls = 0
    const backend: typeof fetch = async () => { calls++; return new Response(sse({ type: 'response.output_text.delta', delta: 'partial' })) }
    const provider = new OpenAiBrainProvider({ apiKey: 'fixture', model: 'model', fetch: backend })
    await expect(collect(provider.generate(request, new AbortController().signal))).rejects.toThrow('stream failed')
    expect(calls).toBe(1)
  })

  it('keeps casual turns on the primary provider', async () => {
    const primary = { async* generate() { yield 'primary' } }
    const secondary = { async* generate() { yield 'escalated' } }
    const router = new EscalatingBrainProvider(primary, secondary)
    expect(await collect(router.generate(request, new AbortController().signal))).toEqual(['primary'])
    expect(await collect(router.generate({ ...request, generationProfile: { ...request.generationProfile, responseLengthClass: 'detailed' } }, new AbortController().signal))).toEqual(['escalated'])
  })
})
