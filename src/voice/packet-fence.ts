import { Buffer } from 'node:buffer'

export interface PacketConnection {
  prepareAudioPacket: (opus: Buffer) => Buffer | undefined
  dispatchAudio: () => boolean | undefined
}

/** Final application gate before the SDK sends its prepared RTP/Opus packet. */
export function fenceVoicePackets(connection: PacketConnection, options: {
  currentEpoch: () => number | undefined
  eligible: (epoch: number) => boolean
  nowNs: () => bigint
  submitted: (event: { epoch?: number, silence: boolean, monotonicNs: string }) => void
}): { invalidate: () => void, dispose: () => void } {
  const prepare = connection.prepareAudioPacket
  const dispatch = connection.dispatchAudio
  let generation = 0
  let pending: { generation: number, epoch?: number, silence: boolean } | undefined
  connection.prepareAudioPacket = (opus) => {
    const result = prepare.call(connection, opus)
    pending = result ? { generation, epoch: options.currentEpoch(), silence: opus.equals(Buffer.from([0xF8, 0xFF, 0xFE])) } : undefined
    return result
  }
  connection.dispatchAudio = () => {
    const packet = pending
    pending = undefined
    if (!packet || (!packet.silence && (packet.generation !== generation || packet.epoch === undefined || !options.eligible(packet.epoch))))
      return false
    const sent = dispatch.call(connection)
    if (sent)
      options.submitted({ epoch: packet.epoch, silence: packet.silence, monotonicNs: options.nowNs().toString() })
    return sent
  }
  return {
    invalidate: () => { generation++ },
    dispose: () => {
      generation++
      pending = undefined
      connection.prepareAudioPacket = prepare
      connection.dispatchAudio = dispatch
    },
  }
}
