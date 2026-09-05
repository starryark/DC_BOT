import type { BrainProvider, BrainRequest } from '../providers/brain/types'

import { describe, expect, it, vi } from 'vitest'

import { buildDiscordActorEvidence } from '../memory/discord-actor-snapshot'
import { BrainRateLimitError } from '../providers/brain/errors'
import { MentionResponder } from './mention-responder'

function event(overrides: Record<string, unknown> = {}) {
  return {
    type: 'discord-mention' as const,
    eventId: 'event-1',
    turnId: 'turn-1',
    guildId: 'guild-1',
    channelId: 'channel-1',
    userId: 'user-1',
    displayName: 'Mayuri',
    actorEvidence: buildDiscordActorEvidence({ userId: 'user-1', displayName: 'Mayuri', observedAtEpochMs: 1, source: 'gateway' }),
    timestamp: 1,
    messageId: 'message-1',
    text: 'hello',
    ...overrides,
  }
}

function textOf(request: BrainRequest): string {
  return request.contents
    .flatMap(content => content.parts ?? [])
    .map(part => 'text' in part ? part.text : '')
    .join('\n')
}

function fakeBrain(responses: Array<string | Error>): BrainProvider & { requests: BrainRequest[] } {
  const requests: BrainRequest[] = []
  return {
    requests,
    async* generate(request) {
      requests.push(request)
      const response = responses.shift()
      if (response instanceof Error)
        throw response
      yield response ?? 'ok'
    },
  }
}

function mention(responder: MentionResponder, overrides: Record<string, unknown> = {}, context: Record<string, unknown> = {}) {
  return responder.respond({
    event: event(overrides),
    context: { isDirectMessage: false, isThread: false, ...context },
  })
}

describe('mentionResponder', () => {
  it('removes ACT and DELAY control syntax from returned and remembered text', async () => {
    const brain = fakeBrain([
      '<|ACT:"emotion":{"name":"happy","intensity":0.8}|>Hello<|DELAY:1|> there',
      'second answer',
    ])
    const responder = new MentionResponder({ brain })

    await expect(mention(responder)).resolves.toBe('Hello there')
    await mention(responder, { text: 'continue' })
    const history = textOf(brain.requests[1]!)
    expect(history).toContain('Hello there')
    expect(history).not.toContain('<|ACT:')
    expect(history).not.toContain('<|DELAY:')
  })

  it('redacts prompt-local person references from returned and remembered text', async () => {
    const brain = fakeBrain(['p_1 met MEMORY_PERSON_2 and P3.', 'second answer'])
    const responder = new MentionResponder({ brain })

    await expect(mention(responder)).resolves.toBe('someone met someone and someone.')
    await mention(responder, { text: 'continue' })
    const history = textOf(brain.requests[1]!)
    expect(history).toContain('someone met someone and someone.')
    expect(history).not.toMatch(/\b(?:p_1|MEMORY_PERSON_2|P3)\b/u)
  })

  it('continues history in one channel', async () => {
    const brain = fakeBrain(['first answer', 'second answer'])
    const responder = new MentionResponder({ brain })
    await mention(responder, { text: 'first question' })
    await mention(responder, { text: 'follow up' })
    expect(textOf(brain.requests[1]!)).toContain('first question')
    expect(textOf(brain.requests[1]!)).toContain('first answer')
  })

  it('uses current input only when active durable context is valid but empty', async () => {
    const brain = fakeBrain(['first answer', 'second answer'])
    const responder = new MentionResponder({ brain })
    await responder.respond({ event: event({ text: 'legacy secret' }), context: { isDirectMessage: false, isThread: false }, memoryContext: { status: 'available', text: '' } })
    await responder.respond({ event: event({ text: 'current question' }), context: { isDirectMessage: false, isThread: false }, memoryContext: { status: 'available', text: '' } })

    const prompt = textOf(brain.requests[1]!)
    expect(prompt).toContain('current question')
    expect(prompt).not.toContain('legacy secret')
    expect(prompt).not.toContain('first answer')
  })

  it('does not call the model when active durable context is required but unavailable', async () => {
    const brain = fakeBrain(['must not run'])
    const responder = new MentionResponder({ brain })

    await expect(responder.respond({ event: event(), context: { isDirectMessage: false, isThread: false }, memoryContext: { status: 'required_unavailable', error: new Error('context failed') } })).rejects.toThrow('context failed')
    expect(brain.requests).toHaveLength(0)
  })

  it.each([
    ['guild channels', event({ channelId: 'other-channel' }), { isDirectMessage: false, isThread: false }],
    ['a parent channel and thread', event({ channelId: 'thread-1' }), { isDirectMessage: false, isThread: true }],
    ['DM users', event({ guildId: undefined, channelId: 'dm-2', userId: 'user-2' }), { isDirectMessage: true, isThread: false }],
  ])('isolates history between %s', async (_label, secondEvent, secondContext) => {
    const brain = fakeBrain(['secret answer', 'isolated answer'])
    const responder = new MentionResponder({ brain })
    await mention(responder, { text: 'room secret' })
    await responder.respond({ event: secondEvent, context: secondContext })
    expect(textOf(brain.requests[1]!)).not.toContain('room secret')
    expect(textOf(brain.requests[1]!)).not.toContain('secret answer')
  })

  it('marks replied-to text as untrusted and bounds it', async () => {
    const brain = fakeBrain(['ok'])
    const responder = new MentionResponder({ brain })
    await mention(responder, { text: 'what do you think?' }, {
      repliedToText: `needle-${'x'.repeat(2_000)}-forbidden-tail`,
    })
    const prompt = textOf(brain.requests[0]!)
    expect(prompt.toLowerCase()).toContain('untrusted')
    expect(prompt).toContain('needle-')
    expect(prompt).not.toContain('forbidden-tail')
    expect(prompt.length).toBeLessThan(1_800)
  })

  it('uses a meaningful placeholder for empty mention input', async () => {
    const brain = fakeBrain(['ok'])
    const responder = new MentionResponder({ brain })
    await mention(responder, { text: '   ' })
    const prompt = textOf(brain.requests[0]!)
    expect(prompt.trim().length).toBeGreaterThan(0)
    expect(prompt).not.toMatch(/undefined|null/)
  })

  it('turns typed rate limits into a readable retry response', async () => {
    const brain = fakeBrain([new BrainRateLimitError('private upstream detail', { retryAfterMs: 61_000 })])
    const responder = new MentionResponder({ brain })
    const response = await mention(responder)
    expect(response).toMatch(/rate|limit|try again|retry/i)
    expect(response).toMatch(/61\s*(second|sec)|2\s*(minute|min)/i)
    expect(response).not.toContain('private upstream detail')
  })

  it('does not commit a failed generation to history', async () => {
    const brain = fakeBrain([new Error('secret failure'), 'recovered'])
    const responder = new MentionResponder({ brain })
    await expect(mention(responder, { text: 'failed input' })).rejects.toThrow()
    await mention(responder, { text: 'next input' })
    expect(textOf(brain.requests[1]!)).not.toContain('failed input')
  })

  it('serializes same-room requests and preserves their history order', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const starts: string[] = []
    let invocation = 0
    const brain: BrainProvider = {
      async* generate(request) {
        const current = invocation++ === 0 ? 'one' : 'two'
        starts.push(current)
        if (current === 'one')
          await gate
        if (current === 'two') {
          expect(textOf(request)).toContain('one')
          expect(textOf(request)).toContain('one answer')
        }
        yield `${current} answer`
      },
    }
    const responder = new MentionResponder({ brain })
    const first = mention(responder, { text: 'one' })
    const second = mention(responder, { text: 'two' })
    await vi.waitFor(() => expect(starts).toEqual(['one']))
    release()
    await Promise.all([first, second])
    expect(starts).toEqual(['one', 'two'])
  })

  it('allows generation in different rooms to overlap', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const starts: string[] = []
    const brain: BrainProvider = {
      async* generate(request) {
        starts.push(request.guildId)
        await gate
        yield 'ok'
      },
    }
    const responder = new MentionResponder({ brain })
    const first = mention(responder, { guildId: 'guild-a', channelId: 'a' })
    const second = mention(responder, { guildId: 'guild-b', channelId: 'b' })
    await vi.waitFor(() => expect(starts).toHaveLength(2))
    release()
    await Promise.all([first, second])
  })

  it('caps accumulated streamed model output', async () => {
    const brain: BrainProvider = {
      async* generate() {
        for (let i = 0; i < 20; i++)
          yield 'x'.repeat(1_000)
      },
    }
    const responder = new MentionResponder({ brain })
    const response = await mention(responder)
    expect(response.length).toBeGreaterThan(0)
    expect(response.length).toBeLessThanOrEqual(12_000)
  })
})
