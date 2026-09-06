import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import { PCM_PROTOCOL, VoiceModelBridge } from './model-bridge'

class FakeSocket extends EventEmitter {
  writableLength = 0
  writes: any[] = []
  setNoDelay() { return this }
  write(raw: string) { this.writes.push(JSON.parse(raw)); return true }
  destroy() { this.emit('close'); return this }
  send(record: object) { this.emit('data', Buffer.from(`${JSON.stringify({ protocol: PCM_PROTOCOL, ...record })}\n`)) }
}

async function connected() {
  const socket = new FakeSocket()
  const bridge = new VoiceModelBridge({ port: 18766, token: 'fixture', createSocket: () => socket as unknown as Socket })
  const ready = bridge.start()
  socket.emit('connect')
  socket.send({ type: 'ready', speech_available: true })
  await ready
  return { bridge, socket }
}

describe('voice service client', () => {
  it('keeps users separate and advances source coordinates across dropped writes', async () => {
    const { bridge, socket } = await connected()
    try {
      const frame = { guildId: 'g', channelId: 'c', userId: 'u1', pcm: Buffer.alloc(640) }
      bridge.capture(frame)
      bridge.capture({ ...frame, userId: 'u2' })
      socket.send({ type: 'source.opened', source_epoch: 0, stream_id: 's1' })
      socket.send({ type: 'source.opened', source_epoch: 1, stream_id: 's2' })
      expect(socket.writes.filter(r => r.type === 'source.pcm').map(r => r.stream_id)).toEqual(['s1', 's2'])
      socket.writableLength = 65536
      bridge.capture(frame)
      socket.writableLength = 0
      bridge.capture(frame)
      expect(socket.writes.at(-1).start_sample).toBe(640)
      bridge.end('g', 'u1')
      expect(socket.writes.at(-1)).toMatchObject({ type: 'source.close', end_sample: 960 })
    }
    finally { bridge.close() }
  })

  it('caps pre-open audio and rejects old source decisions', async () => {
    const { bridge, socket } = await connected()
    let decisions = 0
    bridge.on('decision', () => decisions++)
    const frame = { guildId: 'g', channelId: 'c', userId: 'u', pcm: Buffer.alloc(640), ssrc: 1 }
    for (let i = 0; i < 100; i++) bridge.capture(frame)
    socket.send({ type: 'source.opened', source_epoch: 0, stream_id: 'old' })
    expect(socket.writes.filter(r => r.type === 'source.pcm')).toHaveLength(16)
    bridge.capture({ ...frame, ssrc: 2 })
    socket.send({ type: 'floor.decision', stream_id: 'old', guild_id: 'g', decision: 'TAKE_TURN', revision_id: 'r', floor_epoch: 1, text: 'old', language: 'en' })
    expect(decisions).toBe(0)
    bridge.close()
  })

  it('propagates cancelled speech and ignores its later packets', async () => {
    const { bridge, socket } = await connected()
    const abort = new AbortController()
    const promise = bridge.synthesize({ guild_id: 'g', stream_id: 's', revision_id: 'r', floor_epoch: 1 }, 'hello', 'en', abort.signal)
    const id = socket.writes.at(-1).speech_id
    const rejected = expect(promise).rejects.toThrow('cancelled')
    abort.abort()
    await rejected
    socket.send({ type: 'speech.chunk', speech_id: id, pcm_s16le_b64: Buffer.alloc(3840).toString('base64'), sample_rate_hz: 48000, channels: 2 })
    expect(socket.writes.filter(r => r.type === 'speech.credit')).toHaveLength(0)
    bridge.close()
  })
})
