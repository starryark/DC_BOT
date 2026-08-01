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
 */
export async function runBoundedTtsPipeline<TChunk, TAudio>(
  chunks: AsyncIterable<TChunk>,
  options: BoundedTtsPipelineOptions<TChunk, TAudio>,
): Promise<{ chunksSeen: number, chunksPrepared: number }> {
  const iterator = chunks[Symbol.asyncIterator]()
  let nextIndex = 0
  let chunksSeen = 0
  let chunksPrepared = 0

  const prepareNext = async (): Promise<PreparedTtsChunk<TChunk, TAudio> | null> => {
    while (!options.isCancelled()) {
      const next = await iterator.next()
      if (next.done)
        return null
      const chunkIndex = nextIndex++
      chunksSeen++
      options.onChunk?.(next.value, chunkIndex)
      const audio = await options.synthesize(next.value, chunkIndex)
      if (audio != null && !options.isCancelled()) {
        chunksPrepared++
        return { chunk: next.value, chunkIndex, audio }
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
