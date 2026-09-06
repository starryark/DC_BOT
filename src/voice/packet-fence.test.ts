import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { fenceVoicePackets } from './packet-fence'

describe('final packet admission', () => {
  it('drops prepared obsolete voice while preserving codec silence frames', () => {
    let sends = 0
    let eligible = true
    const events: object[] = []
    const connection = { prepareAudioPacket: (bytes: Buffer) => bytes, dispatchAudio: () => { sends++; return true } }
    const original = connection.dispatchAudio
    const fence = fenceVoicePackets(connection, { currentEpoch: () => 1, eligible: () => eligible,
      nowNs: () => 123n, submitted: event => events.push(event) })
    connection.prepareAudioPacket(Buffer.from([1, 2, 3]))
    eligible = false
    expect(connection.dispatchAudio()).toBe(false)
    expect(sends).toBe(0)
    for (let i = 0; i < 5; i++) {
      connection.prepareAudioPacket(Buffer.from([0xF8, 0xFF, 0xFE]))
      expect(connection.dispatchAudio()).toBe(true)
    }
    expect(sends).toBe(5)
    expect(events).toHaveLength(5)
    eligible = true
    connection.prepareAudioPacket(Buffer.from([4, 5, 6]))
    fence.invalidate()
    expect(connection.dispatchAudio()).toBe(false)
    expect(connection.dispatchAudio()).toBe(false)
    connection.prepareAudioPacket(Buffer.from([7, 8, 9]))
    expect(connection.dispatchAudio()).toBe(true)
    fence.dispose()
    expect(connection.dispatchAudio).toBe(original)
  })
})
