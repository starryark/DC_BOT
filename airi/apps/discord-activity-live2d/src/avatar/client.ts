import type { useAvatarStore } from '../stores/avatar'

import { parseViewerOutbound, SCHEMA_VERSION } from '@proj-airi/discord-avatar-protocol'

export interface AvatarClientOptions {
  url: string
  getToken: () => Promise<string>
  guildId: string
  channelId: string
  store: ReturnType<typeof useAvatarStore>
  createSocket?: (url: string) => WebSocket
}

export class AvatarClient {
  private socket?: WebSocket
  private started = false
  private attempt = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private generation = 0
  private awaitsReplacement = true

  constructor(private readonly options: AvatarClientOptions) {}

  start(): void {
    if (this.started)
      return
    this.started = true
    void this.connect(++this.generation)
  }

  close(): void {
    if (!this.started)
      return
    this.started = false
    this.generation++
    if (this.reconnectTimer)
      clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    const socket = this.socket
    this.socket = undefined
    try {
      socket?.close(1000, 'Activity closed')
    }
    catch {}
    this.options.store.status = 'disconnected'
  }

  private async connect(generation: number): Promise<void> {
    if (!this.started || generation !== this.generation)
      return
    this.reconnectTimer = undefined
    this.options.store.status = this.attempt ? 'reconnecting' : 'connecting'
    let token: string
    let socket: WebSocket
    try {
      token = await this.options.getToken()
      if (!this.started || generation !== this.generation)
        return
      socket = (this.options.createSocket ?? (url => new WebSocket(url)))(this.options.url)
    }
    catch {
      this.scheduleReconnect(generation)
      return
    }
    this.socket = socket
    this.awaitsReplacement = true
    socket.addEventListener('open', () => {
      if (!this.current(socket, generation))
        return
      try {
        socket.send(JSON.stringify({ schemaVersion: SCHEMA_VERSION, type: 'viewer.hello', token }))
        socket.send(JSON.stringify({
          schemaVersion: SCHEMA_VERSION,
          type: 'state.subscribe',
          guildId: this.options.guildId,
          channelId: this.options.channelId,
        }))
      }
      catch {
        socket.close()
      }
    })
    socket.addEventListener('message', (event) => {
      if (!this.current(socket, generation))
        return
      try {
        const message = parseViewerOutbound(String(event.data))
        if (message.type === 'heartbeat') {
          socket.send(JSON.stringify({
            schemaVersion: SCHEMA_VERSION,
            type: 'pong',
            timestamp: message.timestamp,
          }))
        }
        else if (message.type === 'avatar.state.snapshot') {
          const accepted = this.awaitsReplacement
            ? this.options.store.replace(message, this.options.guildId, this.options.channelId)
            : this.options.store.apply(message, this.options.guildId, this.options.channelId)
          if (accepted) {
            this.awaitsReplacement = false
            this.attempt = 0
            this.options.store.status = 'authenticated'
          }
        }
      }
      catch {
        // User-facing state stays sanitized; malformed frames may contain secrets.
      }
    })
    socket.addEventListener('close', () => {
      if (!this.current(socket, generation))
        return
      this.socket = undefined
      this.options.store.status = this.started ? 'reconnecting' : 'disconnected'
      if (this.started)
        this.scheduleReconnect(generation)
    })
    socket.addEventListener('error', () => {
      try {
        socket.close()
      }
      catch {}
    })
  }

  private current(socket: WebSocket, generation: number): boolean {
    return this.started && generation === this.generation && this.socket === socket
  }

  private scheduleReconnect(generation: number): void {
    if (!this.started || generation !== this.generation || this.reconnectTimer)
      return
    this.options.store.status = 'reconnecting'
    const delay = Math.min(500 * 2 ** this.attempt++, 30_000)
    this.reconnectTimer = setTimeout(() => void this.connect(generation), delay)
  }
}
