import { describe, expect, it } from 'vitest'

import { AvatarPublisher } from './publisher'

class FakeSocket {
  readonly OPEN = 1
  readyState = 1
  sent: string[] = []
  closed = 0
  private listeners = new Map<string, Array<(event: { data?: string }) => void>>()

  addEventListener(type: string, listener: (event: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  send(value: string) {
    this.sent.push(value)
  }

  close() {
    this.closed++
    this.emit('close')
  }

  emit(type: string, data?: string) {
    for (const listener of this.listeners.get(type) ?? [])
      listener({ data })
  }
}

function messages(socket: FakeSocket) {
  return socket.sent.map(value => JSON.parse(value))
}

describe('avatar publisher', () => {
  it('keeps one update in flight and advances only after acknowledgement', () => {
    const socket = new FakeSocket()
    const publisher = new AvatarPublisher({
      enabled: true,
      url: 'ws://relay/ws/publisher',
      token: 'token',
      createSocket: () => socket as never,
    })
    publisher.start()
    socket.emit('open')
    publisher.sessionStart('g', 'c')
    publisher.setBehavior('g', 'c', 'thinking')
    expect(messages(socket).filter(message => message.type === 'avatar.behavior.set')).toHaveLength(1)
    const pending = messages(socket).at(-1)
    socket.emit('message', JSON.stringify({
      schemaVersion: 1,
      type: 'state.result',
      guildId: pending.guildId,
      channelId: pending.channelId,
      sessionId: pending.sessionId,
      sequence: pending.sequence,
      status: 'accepted',
    }))
    expect(messages(socket).filter(message => message.type === 'avatar.behavior.set')).toHaveLength(2)
  })

  it('is lifecycle-idempotent and emits one offline tombstone', () => {
    const socket = new FakeSocket()
    let constructions = 0
    const publisher = new AvatarPublisher({
      enabled: true,
      url: 'ws://relay/ws/publisher',
      token: 'token',
      createSocket: () => {
        constructions++
        return socket as never
      },
    })
    publisher.start()
    publisher.start()
    expect(constructions).toBe(1)
    socket.emit('open')
    publisher.sessionStart('g', 'c')
    publisher.sessionEnd('g', 'c')
    publisher.sessionEnd('g', 'c')
    publisher.stop()
    publisher.stop()
    expect(socket.closed).toBe(1)
  })
})
