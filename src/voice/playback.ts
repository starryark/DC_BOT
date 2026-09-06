import { useLogg } from '@guiiai/logg'

/**
 * Serialized per-guild playback (Optimize.md §5.2, `architecture-contract.md` §5).
 *
 * `@discordjs/voice` destroys and replaces the active resource when
 * `AudioPlayer.play()` is called while another is playing. The previous
 * implementation made that the normal path: it built a fresh player per chunk,
 * stopped whatever was playing, and resolved its promise at *play start* — so
 * chunk N+1 cut off chunk N mid-sentence, and the turn queue considered a turn
 * finished while it was still audible (`baseline-findings.md` §2).
 *
 * This scheduler is the single owner of `play()`. Items queue, play in
 * submission order, and their promise settles only when the resource reaches
 * idle or fails. Nothing else in the codebase may call `play()`.
 *
 * The Discord types are kept out deliberately: the scheduler talks to a
 * {@link PlaybackPlayer} port, which `VoiceManager` implements over the real
 * `AudioPlayer`. That keeps the ordering/cancellation logic unit-testable
 * without a live gateway connection.
 */

/** Bound on queued-but-unplayed items. Overflow is dropped and logged, never grown. */
const MAX_QUEUE_DEPTH = 32

/** Observers the scheduler installs on the player exactly once. */
export interface PlaybackPlayerHandlers {
  /** The active resource finished or was stopped. */
  onIdle: () => void
  onError: (error: Error) => void
}

/**
 * Minimal player surface. `resource` is opaque — the scheduler never inspects
 * it, it only forwards what {@link GuildPlaybackSchedulerOptions.createResource}
 * produced.
 */
export interface PlaybackPlayer {
  play: (resource: unknown) => void
  /** Stop active audio; false means it was already idle and no Idle will follow. */
  stop: () => boolean
  /** Register handlers once; returns an unsubscribe used on dispose. */
  observe: (handlers: PlaybackPlayerHandlers) => () => void
}

export interface PlaybackItem {
  id: string
  guildId: string
  turnId: string
  /** The response generation this audio belongs to; stale epochs never play. */
  responseEpoch: number
  chunkIndex: number
  /** Audio payload handed to `createResource`. */
  audio: unknown
}

export type PlaybackStopReason = 'disconnect' | 'cancelled' | 'shutdown' | 'barge_in'

export type PlaybackStatus
  /** Played to completion. */
  = | 'played'
  /** Removed by epoch cancellation, `stopAll`, or a newer epoch. */
    | 'cancelled'
  /** The player raised an error while this item was active. */
    | 'failed'
  /** Rejected because the queue was full. */
    | 'dropped'

export interface PlaybackResult {
  status: PlaybackStatus
  /** Wall-clock ms the item spent playing; 0 when it never started. */
  durationMs: number
  error?: Error
}

export interface PlaybackSnapshot {
  playing: boolean
  queueDepth: number
  latestEpoch: number
  currentItemId?: string
  currentEpoch?: number
}

export interface GuildPlaybackSchedulerOptions {
  guildId: string
  player: PlaybackPlayer
  /** Build the playable resource for an item. Called once, immediately before `play()`. */
  createResource: (item: PlaybackItem) => unknown
  /** Injected clock, present so duration assertions are deterministic in tests. */
  now?: () => number
}

interface ActivePlayback {
  item: PlaybackItem
  startedAt: number
  settle: (result: PlaybackResult) => void
  /** Guards against a late idle event settling an item twice. */
  settled: boolean
}

interface QueuedPlayback {
  item: PlaybackItem
  enqueuedAt: number
  settle: (result: PlaybackResult) => void
}

export class GuildPlaybackScheduler {
  private readonly logger = useLogg('Playback').useGlobalConfig()
  private readonly guildId: string
  private readonly player: PlaybackPlayer
  private readonly createResource: (item: PlaybackItem) => unknown
  private readonly now: () => number
  private readonly unobserve: () => void

  private queue: QueuedPlayback[] = []
  private active?: ActivePlayback
  /** Highest epoch ever enqueued; anything older is stale by definition. */
  private latestEpoch = 0
  private cancelledEpochs = new Set<number>()
  private drainWaiters: Array<{ epoch: number, resolve: () => void }> = []
  private disposed = false
  /** Wait for the stopped resource's Idle before a replacement may start. */
  private awaitingStopIdle = false

  constructor(options: GuildPlaybackSchedulerOptions) {
    this.guildId = options.guildId
    this.player = options.player
    this.createResource = options.createResource
    this.now = options.now ?? Date.now
    // Registered once for the session's lifetime — per-resource listeners were
    // how the old implementation leaked handlers across a long response.
    this.unobserve = this.player.observe({
      onIdle: () => this.onIdle(),
      onError: error => this.onError(error),
    })
  }

  /**
   * Queue an item and resolve when it has finished playing.
   *
   * Never rejects: a cancelled, dropped or failed item resolves with the
   * corresponding {@link PlaybackStatus} so callers can `await` a whole
   * response without wrapping every chunk in try/catch.
   */
  enqueue(item: PlaybackItem): Promise<PlaybackResult> {
    if (this.disposed)
      return Promise.resolve({ status: 'cancelled', durationMs: 0 })

    if (item.responseEpoch > this.latestEpoch) {
      this.latestEpoch = item.responseEpoch
      for (const cancelled of this.cancelledEpochs)
        if (cancelled < this.latestEpoch) this.cancelledEpochs.delete(cancelled)
    }

    if (this.isStale(item.responseEpoch)) {
      this.logger.withFields({ guildId: this.guildId, itemId: item.id, epoch: item.responseEpoch, latestEpoch: this.latestEpoch }).log('playback_cancelled')
      return Promise.resolve({ status: 'cancelled', durationMs: 0 })
    }

    if (this.queue.length >= MAX_QUEUE_DEPTH) {
      this.logger.withFields({ guildId: this.guildId, itemId: item.id, queueDepth: this.queue.length }).warn('playback_dropped_queue_full')
      return Promise.resolve({ status: 'dropped', durationMs: 0 })
    }

    return new Promise<PlaybackResult>((resolve) => {
      this.queue.push({ item, enqueuedAt: this.now(), settle: resolve })
      this.logger.withFields({
        guildId: this.guildId,
        turnId: item.turnId,
        responseEpoch: item.responseEpoch,
        chunkIndex: item.chunkIndex,
        queueDepth: this.queue.length,
      }).log('playback_enqueued')
      this.pump()
    })
  }

  /** Drop every pending item of `epoch`, and stop it if it is currently playing. */
  cancelEpoch(epoch: number): void {
    if (epoch >= this.latestEpoch) {
      if (this.cancelledEpochs.size >= 128 && !this.cancelledEpochs.has(epoch))
        throw new Error('Too many future playback cancellations')
      this.cancelledEpochs.add(epoch)
    }

    const keep: QueuedPlayback[] = []
    for (const entry of this.queue) {
      if (entry.item.responseEpoch === epoch)
        entry.settle({ status: 'cancelled', durationMs: 0 })
      else
        keep.push(entry)
    }
    this.queue = keep

    if (this.active && this.active.item.responseEpoch === epoch)
      this.settleActive('cancelled')

    this.notifyDrained()
  }

  /** Stop everything: clear the queue, stop the active resource, settle all promises. */
  async stopAll(reason: PlaybackStopReason): Promise<void> {
    const cleared = this.queue.length
    for (const entry of this.queue)
      entry.settle({ status: 'cancelled', durationMs: 0 })
    this.queue = []

    if (this.active)
      this.settleActive('cancelled')

    this.logger.withFields({ guildId: this.guildId, reason, cleared }).log('playback_cancelled')
    this.notifyDrained()
  }

  /** Resolve once no queued or active item belongs to `epoch`. */
  awaitDrained(epoch: number): Promise<void> {
    if (!this.hasWork(epoch))
      return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.drainWaiters.push({ epoch, resolve })
    })
  }

  getSnapshot(): PlaybackSnapshot {
    return {
      playing: this.active != null,
      queueDepth: this.queue.length,
      latestEpoch: this.latestEpoch,
      currentItemId: this.active?.item.id,
      currentEpoch: this.active?.item.responseEpoch,
    }
  }

  /** Detach the player observers. The scheduler rejects further work afterwards. */
  dispose(): void {
    if (this.disposed)
      return
    this.disposed = true
    void this.stopAll('shutdown')
    this.unobserve()
  }

  canSubmitEpoch(epoch: number): boolean {
    return !this.disposed && !this.isStale(epoch)
  }

  private isStale(epoch: number): boolean {
    return epoch < this.latestEpoch || this.cancelledEpochs.has(epoch)
  }

  /**
   * Start the next item if nothing is active.
   *
   * This is the ONLY place `play()` is reached from. The `active` guard is the
   * invariant that makes replacement impossible; if it is ever violated we log
   * it rather than silently destroying audible audio.
   */
  private pump(): void {
    if (this.disposed || this.awaitingStopIdle)
      return

    if (this.active) {
      // Not an error — the queue is doing its job. Only a caller reaching past
      // the scheduler could actually replace a resource, and that is what the
      // invariant log below is for.
      return
    }

    let next = this.queue.shift()
    // Drop anything that went stale while it waited.
    while (next && this.isStale(next.item.responseEpoch)) {
      next.settle({ status: 'cancelled', durationMs: 0 })
      next = this.queue.shift()
    }
    if (!next) {
      this.notifyDrained()
      return
    }

    let resource: unknown
    try {
      resource = this.createResource(next.item)
    }
    catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      this.logger.withError(err).withFields({ guildId: this.guildId, itemId: next.item.id }).error('playback_resource_failed')
      next.settle({ status: 'failed', durationMs: 0, error: err })
      this.pump()
      return
    }

    this.active = {
      item: next.item,
      startedAt: this.now(),
      settle: next.settle,
      settled: false,
    }

    this.logger.withFields({
      guildId: this.guildId,
      turnId: next.item.turnId,
      responseEpoch: next.item.responseEpoch,
      chunkIndex: next.item.chunkIndex,
      queueWaitMs: this.now() - next.enqueuedAt,
    }).log('playback_started')

    try {
      this.player.play(resource)
    }
    catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      this.logger.withError(err).withFields({ guildId: this.guildId }).error('playback_invariant_violation')
      this.settleActive('failed', err)
    }
  }

  /**
   * The player went idle. Attribute it to the active item only — an idle event
   * that arrives after we already settled (stop-on-cancel) belongs to a
   * resource nobody is waiting on.
   */
  private onIdle(): void {
    if (this.awaitingStopIdle) {
      this.awaitingStopIdle = false
      this.pump()
      return
    }
    if (!this.active || this.active.settled)
      return
    this.settleActive('played')
  }

  private onError(error: Error): void {
    this.logger.withError(error).withFields({ guildId: this.guildId, itemId: this.active?.item.id }).error('playback_failed')
    if (this.active && !this.active.settled)
      this.settleActive('failed', error)
  }

  /**
   * Settle the active item and start the next one.
   *
   * `stop()` is called for a cancellation so the underlying player releases the
   * resource; the resulting idle event is ignored because `settled` is already
   * true by then.
   */
  private settleActive(status: PlaybackStatus, error?: Error): void {
    const active = this.active
    if (!active || active.settled)
      return

    active.settled = true
    this.active = undefined
    const durationMs = status === 'played' || status === 'failed' ? this.now() - active.startedAt : 0

    if (status === 'cancelled') {
      // Discord emits Idle asynchronously after stop(). Starting the next
      // resource before that event would let the old Idle settle the new item.
      this.awaitingStopIdle = true
      try {
        if (!this.player.stop())
          this.awaitingStopIdle = false
      }
      catch (err) {
        this.awaitingStopIdle = false
        this.logger.withError(err).withFields({ guildId: this.guildId }).error('playback_stop_failed')
      }
    }

    this.logger.withFields({
      guildId: this.guildId,
      turnId: active.item.turnId,
      responseEpoch: active.item.responseEpoch,
      chunkIndex: active.item.chunkIndex,
      durationMs,
      status,
    }).log(status === 'played' ? 'playback_completed' : 'playback_cancelled')

    active.settle({ status, durationMs, error })
    if (!this.awaitingStopIdle)
      this.pump()
    this.notifyDrained()
  }

  private hasWork(epoch: number): boolean {
    if (this.active?.item.responseEpoch === epoch)
      return true
    return this.queue.some(q => q.item.responseEpoch === epoch)
  }

  private notifyDrained(): void {
    if (this.drainWaiters.length === 0)
      return
    const stillWaiting: Array<{ epoch: number, resolve: () => void }> = []
    for (const waiter of this.drainWaiters) {
      if (this.hasWork(waiter.epoch))
        stillWaiting.push(waiter)
      else
        waiter.resolve()
    }
    this.drainWaiters = stillWaiting
  }
}
