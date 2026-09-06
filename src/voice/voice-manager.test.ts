import type { VoiceConnectionState } from '@discordjs/voice'
import type { BaseGuildVoiceChannel, Client } from 'discord.js'
import type { GuildVoiceSession, UserCaptureSession } from './types'
import { Buffer } from 'node:buffer'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VoiceManager } from './voice-manager'

vi.mock('../utils/opus', async () => {
  const { PassThrough } = await import('node:stream')
  return { OpusDecoder: class extends PassThrough {} }
})
vi.mock('../config', () => ({ config: () => ({ voice: {
  bargeInEnabled: false, maxUtteranceMs: 30_000, endSilenceMs: 500,
} }) }))

function fixture() {
  const manager = new VoiceManager({} as Client)
  const receive = new PassThrough()
  const session = {
    guildId: 'guild', channelId: 'channel', users: new Map(),
    connection: { receiver: { subscribe: () => receive, ssrcMap: new Map([['user', { audioSSRC: 42 }]]) } },
  } as unknown as GuildVoiceSession
  const capture = {
    userId: 'user', displayName: 'User', pcmChunks: [], totalBytes: 0,
    speechStartedAt: 0, lastPacketAt: 0, state: 'idle',
  } as unknown as UserCaptureSession
  manager['sessions'].set('guild', session)
  manager['captures'].set('guild:user', capture)
  manager['subscribeUser'](session, 'user', 'User')
  const decoder = manager['decoders'].get('guild:user')!
  const abort = vi.fn()
  const frame = vi.fn()
  manager.on('pcmAbort', abort)
  manager.on('pcmFrame', frame)
  decoder.emit('data', Buffer.alloc(640))
  expect(frame).toHaveBeenCalledTimes(1)
  return { manager, receive, session, capture, decoder, abort, frame }
}

describe('voice decoder source lifecycle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('aborts corrupt PCM once, clears endpoint timers and refuses late packets', () => {
    const { manager, capture, decoder, abort, frame } = fixture()
    decoder.emit('error', new Error('corrupt packet'))
    decoder.emit('close')
    decoder.emit('data', Buffer.alloc(640))
    expect(abort).toHaveBeenCalledExactlyOnceWith({ guildId: 'guild', userId: 'user' })
    expect(frame).toHaveBeenCalledTimes(1)
    expect(manager['decoders'].size).toBe(0)
    expect(capture).toMatchObject({ totalBytes: 0, pcmChunks: [], state: 'idle', speechStartedAt: 0, lastPacketAt: 0 })
    expect(capture.finalizeTimer).toBeUndefined()
    expect(capture.transportSsrc).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retires a closed receiver even before its decoder closes', () => {
    const { manager, receive, decoder, abort } = fixture()
    receive.emit('close')
    decoder.emit('close')
    expect(abort).toHaveBeenCalledTimes(1)
    expect(manager['decoders'].size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores an old decoder closing after a replacement is registered', () => {
    const { manager, capture, decoder, abort, frame } = fixture()
    const replacement = new PassThrough()
    manager['decoders'].set('guild:user', replacement)
    decoder.emit('data', Buffer.alloc(640))
    decoder.emit('close')
    expect(manager['decoders'].get('guild:user')).toBe(replacement)
    expect(abort).not.toHaveBeenCalled()
    expect(frame).toHaveBeenCalledTimes(1)
    expect(capture.totalBytes).toBe(640)
    clearTimeout(capture.finalizeTimer)
  })

  it('ignores destruction and speaking-end callbacks from an old connection', async () => {
    const { manager, session, capture, abort } = fixture()
    const replacement = { ...session }
    manager['sessions'].set('guild', replacement)
    await manager.handleVoiceConnectionStateChange(session)(
      { status: 'ready' } as VoiceConnectionState,
      { status: 'destroyed' } as VoiceConnectionState,
    )
    clearTimeout(capture.finalizeTimer)
    capture.finalizeTimer = undefined
    capture.state = 'speaking'
    manager['handleSpeakingEnd'](session, {} as BaseGuildVoiceChannel)('user')
    expect(manager['sessions'].get('guild')).toBe(replacement)
    expect(abort).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('discards member lookup completing after a rejoin', async () => {
    const { manager, session, capture } = fixture()
    let finish!: () => void
    const lookup = new Promise<void>(resolve => { finish = resolve })
    const channel = {
      members: new Map(), guild: { members: { fetch: () => lookup } },
    } as unknown as BaseGuildVoiceChannel
    const pending = manager['handleSpeakingStart'](session, channel)('new-user')
    manager['sessions'].set('guild', { ...session })
    finish()
    await pending
    expect(manager['captures'].has('guild:new-user')).toBe(false)
    clearTimeout(capture.finalizeTimer)
  })
})
