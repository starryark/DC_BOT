import type { AvatarBehavior, AvatarBehaviorSet } from '@proj-airi/discord-avatar-protocol'

import type { VoiceManager } from '../voice/voice-manager'

import { randomUUID } from 'node:crypto'

import { parsePublisherOutbound, SCHEMA_VERSION } from '@proj-airi/discord-avatar-protocol'

const RECONNECT_MAX_MS = 30_000

interface ActiveState {
  guildId: string
  channelId: string
  sessionId: string
  sequence: number
  behavior: AvatarBehavior
  connected: boolean
}

export interface AvatarPublisherOptions {
  enabled: boolean
  url: string
  token: string
  createSocket?: (url: string) => WebSocket
}

export class AvatarPublisher {
  private readonly states = new Map<string, ActiveState>()
  private readonly outbox: AvatarBehaviorSet[] = []
  private socket?: WebSocket
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private reconnectAttempt = 0
  private started = false
  private authenticated = false
  private inFlight = false

  constructor(private readonly options: AvatarPublisherOptions) {}

  bindVoice(voice: VoiceManager): void {
    voice.on('sessionStart', ({ guildId, channelId }) => this.sessionStart(guildId, channelId))
    voice.on('sessionEnd', ({ guildId, channelId }) => this.sessionEnd(guildId, channelId))
  }

  start(): void {
    if (!this.options.enabled || this.started)
      return
    this.started = true
    this.connect()
  }

  stop(): void {
    if (!this.started)
      return
    this.started = false
    this.authenticated = false
    this.inFlight = false
    if (this.reconnectTimer)
      clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    const socket = this.socket
    this.socket = undefined
    try {
      socket?.close(1000, 'Publisher stopped')
    }
    catch {}
  }

  sessionStart(guildId: string, channelId: string): void {
    const previous = this.states.get(guildId)
    if (previous && previous.channelId !== channelId)
      this.sessionEnd(guildId, previous.channelId)
    const state: ActiveState = {
      guildId,
      channelId,
      sessionId: randomUUID(),
      sequence: 0,
      behavior: 'idle',
      connected: true,
    }
    this.states.set(guildId, state)
    this.enqueue(state)
  }

  sessionEnd(guildId: string, channelId: string): void {
    const state = this.states.get(guildId)
    if (!state || state.channelId !== channelId || !state.connected)
      return
    state.connected = false
    state.behavior = 'idle'
    state.sequence++
    this.enqueue(state)
    this.states.delete(guildId)
  }

  setBehavior(guildId: string, channelId: string, behavior: AvatarBehavior): boolean {
    const state = this.states.get(guildId)
    if (!state || state.channelId !== channelId || !state.connected)
      return false
    state.behavior = behavior
    state.sequence++
    this.enqueue(state)
    return true
  }

  activeChannel(guildId: string): string | undefined {
    return this.states.get(guildId)?.channelId
  }

  private connect(): void {
    if (!this.started || this.socket)
      return
    this.reconnectTimer = undefined
    let socket: WebSocket
    try {
      socket = (this.options.createSocket ?? (url => new WebSocket(url)))(this.options.url)
    }
    catch {
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    socket.addEventListener('open', () => {
      if (this.socket !== socket || !this.started)
        return
      this.reconnectAttempt = 0
      this.authenticated = true
      this.inFlight = false
      if (!this.safeSend(socket, {
        schemaVersion: SCHEMA_VERSION,
        type: 'publisher.hello',
        token: this.options.token,
      })) {
        return
      }
      // A fresh sequence restores state both after a relay restart and after a
      // retained relay acknowledges a replayed in-flight update as duplicate.
      for (const state of this.states.values()) {
        state.sequence++
        this.enqueue(state, false)
      }
      this.flush()
    })
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket)
        return
      try {
        const message = parsePublisherOutbound(String(event.data))
        if (message.type === 'heartbeat') {
          this.safeSend(socket, {
            schemaVersion: SCHEMA_VERSION,
            type: 'pong',
            timestamp: message.timestamp,
          })
        }
        else if (message.type === 'state.result') {
          const pending = this.outbox[0]
          if (pending
            && pending.guildId === message.guildId
            && pending.channelId === message.channelId
            && pending.sessionId === message.sessionId
            && pending.sequence === message.sequence) {
            this.outbox.shift()
            this.inFlight = false
            this.flush()
          }
        }
      }
      catch {
        // Invalid relay frames never affect voice state or expose their content.
      }
    })
    socket.addEventListener('close', () => {
      if (this.socket !== socket)
        return
      this.socket = undefined
      this.authenticated = false
      this.inFlight = false
      if (this.started)
        this.scheduleReconnect()
    })
    socket.addEventListener('error', () => {
      try {
        socket.close()
      }
      catch {}
    })
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer)
      return
    const delay = Math.min(500 * 2 ** this.reconnectAttempt++, RECONNECT_MAX_MS)
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }

  private enqueue(state: ActiveState, flush = true): void {
    this.outbox.push({
      schemaVersion: SCHEMA_VERSION,
      type: 'avatar.behavior.set',
      guildId: state.guildId,
      channelId: state.channelId,
      sessionId: state.sessionId,
      sequence: state.sequence,
      timestamp: Date.now(),
      connected: state.connected,
      behavior: state.behavior,
      speaking: false,
      mouthOpen: 0,
    })
    if (flush)
      this.flush()
  }

  private flush(): void {
    const pending = this.outbox[0]
    if (pending && this.socket && this.authenticated && !this.inFlight)
      this.inFlight = this.safeSend(this.socket, pending)
  }

  private safeSend(socket: WebSocket, message: object): boolean {
    if (this.socket !== socket || socket.readyState !== socket.OPEN)
      return false
    try {
      socket.send(JSON.stringify(message))
      return true
    }
    catch {
      try {
        socket.close()
      }
      catch {}
      return false
    }
  }
}
