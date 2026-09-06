/** A synthesized item waiting for its ordered playback slot. */
export interface PreparedTtsChunk<TChunk, TAudio> {
  chunk: TChunk
  chunkIndex: number
  audio: TAudio
}

export interface BoundedTtsPipelineOptions<TChunk, TAudio> {
  synthesize: (chunk: TChunk, chunkIndex: number) => Promise<TAudio | null>
  play: (chunk: PreparedTtsChunk<TChunk, TAudio>) => Promise<void>
  isCancelled: () => boolean
  signal?: AbortSignal
  cancelSource?: () => void
  discard?: (audio: TAudio) => void
  onChunk?: (chunk: TChunk, chunkIndex: number) => void
}

/** Pull the current phrase and one lookahead; never retain an eager text queue. */
export async function runBoundedTtsPipeline<TChunk, TAudio>(
  chunks: AsyncIterable<TChunk>,
  options: BoundedTtsPipelineOptions<TChunk, TAudio>,
): Promise<{ chunksSeen: number, chunksPrepared: number }> {
  const iterator = chunks[Symbol.asyncIterator]()
  let chunksSeen = 0
  let chunksPrepared = 0
  let closing = false
  let completed = false
  let current: PreparedTtsChunk<TChunk, TAudio> | null = null
  const cancelled = () => closing || options.signal?.aborted || options.isCancelled()

  const prepare = async (): Promise<PreparedTtsChunk<TChunk, TAudio> | null> => {
    while (!cancelled()) {
      const next = await interruptible(iterator.next(), options.signal)
      if (next.done || cancelled())
        return null
      const chunkIndex = chunksSeen++
      options.onChunk?.(next.value, chunkIndex)
      const prepared = options.synthesize(next.value, chunkIndex).then((audio) => {
        if (audio != null && cancelled()) { options.discard?.(audio); return null }
        return audio
      })
      const audio = await interruptible(prepared, options.signal)
      if (audio != null) {
        if (cancelled()) {
          options.discard?.(audio)
          return null
        }
        chunksPrepared++
        return { chunk: next.value, chunkIndex, audio }
      }
    }
    return null
  }

  try {
    current = await prepare()
    while (current && !cancelled()) {
      const playback = options.play(current).catch((error) => {
        closing = true
        options.cancelSource?.()
        throw error
      })
      // Observe both promises immediately, including failures during playback.
      const [played, prepared] = await Promise.allSettled([playback, prepare()])
      if (played.status === 'rejected') {
        if (prepared.status === 'fulfilled' && prepared.value)
          options.discard?.(prepared.value.audio)
        throw played.reason
      }
      if (prepared.status === 'rejected')
        throw prepared.reason
      current = prepared.value
      if (current && cancelled())
        options.discard?.(current.audio)
    }
    completed = true
    return { chunksSeen, chunksPrepared }
  }
  finally {
    closing = true
    if (!completed) {
      options.cancelSource?.()
      if (current)
        options.discard?.(current.audio)
    }
    const returned = iterator.return?.()
    if (options.signal?.aborted)
      void returned?.catch(() => {})
    else
      await returned
  }
}

async function interruptible<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal)
    return work
  if (signal.aborted) {
    void work.catch(() => {})
    throw new DOMException('Speech pipeline cancelled', 'AbortError')
  }
  let stop!: () => void
  const aborted = new Promise<never>((_, reject) => {
    stop = () => reject(new DOMException('Speech pipeline cancelled', 'AbortError'))
    signal.addEventListener('abort', stop, { once: true })
  })
  try { return await Promise.race([work, aborted]) }
  finally { signal.removeEventListener('abort', stop) }
}
