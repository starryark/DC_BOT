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
  onChunk?: (chunk: TChunk, chunkIndex: number) => void
}

/**
 * Run streaming TTS with one-chunk lookahead.
 *
 * While chunk N plays, the model may produce and synthesize N+1. The iterator
 * is not advanced to N+2 until N has completed, so cancellation can waste at
 * most one synthesized, unplayed chunk.
 *
 * The depth of one is a structural invariant of this loop, not a setting. It
 * used to be surfaced as `TTS_PREFETCH_CHUNKS`, clamped to the range [1, 1] —
 * an operator control that could take exactly one value. Deeper lookahead would
 * raise the cancellation-waste bound above one chunk and needs a change here,
 * not in configuration.
 */
export async function runBoundedTtsPipeline<TChunk, TAudio>(
  chunks: AsyncIterable<TChunk>,
  options: BoundedTtsPipelineOptions<TChunk, TAudio>,
): Promise<{ chunksSeen: number, chunksPrepared: number }> {
  let nextIndex = 0
  let chunksSeen = 0
  let chunksPrepared = 0

  // Eagerly consume the incoming chunks stream in the background to prevent upstream HTTP connection
  // timeouts (e.g. from Gemini) while waiting for slow TTS playback.
  const sourceIterator = chunks[Symbol.asyncIterator]()
  const chunkQueue: TChunk[] = []
  let sourceDone = false
  let sourceError: unknown
  let waitingResolve: (() => void) | undefined

  const consumeSource = async () => {
    try {
      while (!options.isCancelled()) {
        const next = await sourceIterator.next()
        if (next.done) {
          sourceDone = true
          break
        }
        chunkQueue.push(next.value)
        if (waitingResolve) {
          const resolve = waitingResolve
          waitingResolve = undefined
          resolve()
        }
      }
    }
    catch (e) {
      sourceError = e
    }
    if (waitingResolve) {
      const resolve = waitingResolve
      waitingResolve = undefined
      resolve()
    }
  }

  // Start consuming immediately (floating promise intentionally ignored).
  void consumeSource()

  const prepareNext = async (): Promise<PreparedTtsChunk<TChunk, TAudio> | null> => {
    while (!options.isCancelled()) {
      // eslint-disable-next-line no-unmodified-loop-condition -- sourceDone and sourceError are mutated by the consumeSource closure above
      while (chunkQueue.length === 0 && !sourceDone && sourceError === undefined && !options.isCancelled()) {
        await new Promise<void>((resolve) => {
          waitingResolve = resolve
        })
      }
      if (sourceError !== undefined) {
        throw sourceError
      }
      if (options.isCancelled() || (chunkQueue.length === 0 && sourceDone)) {
        return null
      }

      const value = chunkQueue.shift()!
      const chunkIndex = nextIndex++
      chunksSeen++
      options.onChunk?.(value, chunkIndex)
      const audio = await options.synthesize(value, chunkIndex)
      if (audio != null && !options.isCancelled()) {
        chunksPrepared++
        return { chunk: value, chunkIndex, audio }
      }
    }
    return null
  }

  let current = await prepareNext()
  while (current && !options.isCancelled()) {
    const playback = options.play(current)
    // This is the sole lookahead slot. `prepareNext` cannot advance again until
    // this promise is consumed after current playback settles.
    const successor = prepareNext()
    await playback
    if (options.isCancelled())
      break
    current = await successor
  }

  return { chunksSeen, chunksPrepared }
}
