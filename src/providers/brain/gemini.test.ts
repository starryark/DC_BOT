import type { BrainRequest } from './types'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const generateContentStream = vi.fn()

// The provider reaches the network through exactly this one SDK entry point, so
// stubbing it keeps the retry policy under test without a live endpoint.
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContentStream }
  },
  ThinkingLevel: { MINIMAL: 0, LOW: 1, MEDIUM: 2, HIGH: 3 },
}))

const { GeminiBrainProvider } = await import('./gemini')
const { BrainRequestAbortedError } = await import('./errors')

/**
 * The shape `@google/genai` produced in run `t002-08057db3-20260805a`: a numeric
 * `status` alongside the server envelope embedded in the message.
 */
function unavailable(): Error {
  return Object.assign(new Error(JSON.stringify({
    error: {
      code: 503,
      message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.',
      status: 'UNAVAILABLE',
    },
  })), { status: 503 })
}

/** A finished stream that yields each supplied string as one chunk. */
function streamOf(...texts: string[]): AsyncIterable<{ text: string }> {
  return {
    async* [Symbol.asyncIterator]() {
      for (const text of texts)
        yield { text }
    },
  }
}

function request(): BrainRequest {
  return {
    guildId: 'g1',
    userId: 'u1',
    turnId: 't1',
    systemInstruction: 'be brief',
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    generationProfile: { thinkingLevel: 'low', maxOutputTokens: 1024, responseLengthClass: 'casual' },
  }
}

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []
  for await (const chunk of iterable)
    out.push(chunk)
  return out
}

describe('geminiBrainProvider — transient 503 retry (DEFECT-005)', () => {
  beforeEach(() => {
    generateContentStream.mockReset()
    process.env.GEMINI_API_KEY = 'test-key'
  })

  // ROOT CAUSE:
  //
  // A 503 UNAVAILABLE propagated out of the provider as an ordinary failure.
  // It travelled up through the mention responder into the gateway listener's
  // catch block, where recording the failure re-raised it, and with no 'error'
  // listener on the discord.js Client the process died mid-soak.
  //
  // The 503 is transient by the API's own description, so the provider now
  // retries it a bounded number of times before giving up.
  it('retries an initial 503 and returns the reply', async () => {
    generateContentStream
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValueOnce(streamOf('recovered reply'))

    const provider = new GeminiBrainProvider()
    const chunks = await collect(provider.generate(request(), new AbortController().signal))

    expect(chunks).toEqual(['recovered reply'])
    expect(generateContentStream).toHaveBeenCalledTimes(2)
  })

  it('gives up and surfaces the error after the bounded attempts', async () => {
    generateContentStream.mockRejectedValue(unavailable())

    const provider = new GeminiBrainProvider()
    await expect(collect(provider.generate(request(), new AbortController().signal))).rejects.toThrow(/UNAVAILABLE/)

    // Initial attempt plus the two configured backoffs.
    expect(generateContentStream).toHaveBeenCalledTimes(3)
  })

  // The critical bound: a retry replays the whole request, so once text has
  // reached the caller it has already been chunked, synthesized and — in the
  // voice path — spoken aloud. Retrying there would duplicate the reply.
  it('never retries once a token has been yielded', async () => {
    generateContentStream.mockImplementationOnce(() => Promise.resolve({
      async* [Symbol.asyncIterator]() {
        yield { text: 'first half' }
        throw unavailable()
      },
    }))

    const provider = new GeminiBrainProvider()
    const chunks: string[] = []
    await expect((async () => {
      for await (const chunk of provider.generate(request(), new AbortController().signal))
        chunks.push(chunk)
    })()).rejects.toThrow(/UNAVAILABLE/)

    expect(chunks).toEqual(['first half'])
    expect(generateContentStream).toHaveBeenCalledTimes(1)
  })

  // Retrying an obsolete turn is worse than dropping it, so a barge-in during
  // the backoff abandons the turn instead of waiting it out.
  it('abandons the backoff when the turn is cancelled', async () => {
    const controller = new AbortController()
    generateContentStream.mockImplementationOnce(() => {
      controller.abort()
      return Promise.reject(unavailable())
    })

    const provider = new GeminiBrainProvider()
    await expect(collect(provider.generate(request(), controller.signal))).rejects.toThrow(BrainRequestAbortedError)
    expect(generateContentStream).toHaveBeenCalledTimes(1)
  })

  it('does not retry a non-transient failure', async () => {
    generateContentStream.mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 }))

    const provider = new GeminiBrainProvider()
    await expect(collect(provider.generate(request(), new AbortController().signal))).rejects.toThrow('bad request')
    expect(generateContentStream).toHaveBeenCalledTimes(1)
  })
})
