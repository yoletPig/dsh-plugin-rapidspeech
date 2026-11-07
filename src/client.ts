/** HTTP client for the rs-server OpenAI-compatible transcription endpoint. */

/** Wire failure before or during one request; the server side stays untouched. */
export class TranscriptionHttpError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'TranscriptionHttpError'
  }
}

/** One successful round trip. */
export interface TranscriptionResult {
  readonly text: string
  /** Wall-clock seconds spent on the request, including upload, queueing, and inference. */
  readonly elapsedSeconds: number
}

/** Maximum response body excerpt kept in error messages. */
const ERROR_EXCERPT_BYTES = 200

/**
 * Post one recording to `/v1/audio/transcriptions`.
 *
 * Cancellation aborts the fetch only; it does not stop inference already
 * running inside the C++ server, which keeps serving its queue.
 */
export class RapidspeechClient {
  constructor(
    private readonly base: URL,
    private readonly model: string,
    private readonly timeoutMs: number,
  ) {}

  /**
   * Upload one complete WAV recording and read back plain text.
   * @param audio - complete WAV bytes.
   * @param signal - caller cancellation.
   * @returns transcript text and elapsed wall-clock time.
   * @throws TranscriptionHttpError on transport, status, or payload-shape failures.
   */
  async transcribe(audio: Uint8Array, signal: AbortSignal): Promise<TranscriptionResult> {
    const started = performance.now()
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = AbortSignal.any([signal, timeout])
    // An already-aborted signal must not reach fetch: undici may have begun streaming the
    // multipart body and then rejects into an unhandled stream error that would take the
    // host down. Reject here instead, before any request exists.
    if (combined.aborted) {
      throw new TranscriptionHttpError(signal.aborted
        ? 'Transcription cancelled'
        : `Transcription exceeded ${this.timeoutMs} ms`)
    }
    const form = new FormData()
    form.set('file', new Blob([audio], { type: 'audio/wav' }), 'recording.wav')
    form.set('model', this.model)
    const url = new URL('/v1/audio/transcriptions', this.base)
    let response: Response
    try {
      response = await fetch(url, { method: 'POST', body: form, signal: combined })
    } catch (error) {
      if (signal.aborted) throw new TranscriptionHttpError('Transcription cancelled', undefined)
      if (timeout.aborted) {
        throw new TranscriptionHttpError(`Transcription exceeded ${this.timeoutMs} ms`, undefined)
      }
      const reason = error instanceof Error ? error.message : String(error)
      throw new TranscriptionHttpError(`Transcription request failed: ${reason}`, undefined)
    }
    if (!response.ok) {
      throw new TranscriptionHttpError(
        `ASR HTTP ${response.status}: ${await excerpt(response)}`, response.status,
      )
    }
    let body: unknown
    try {
      body = await response.json()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new TranscriptionHttpError(`ASR response is not JSON: ${reason}`, response.status)
    }
    const text = (body as { text?: unknown } | null)?.text
    if (typeof text !== 'string') {
      throw new TranscriptionHttpError('ASR response is missing a text field', response.status)
    }
    return { text, elapsedSeconds: (performance.now() - started) / 1000 }
  }
}

/**
 * Read a bounded text excerpt of an error response for diagnostics.
 * @param response - the failed response, unconsumed.
 * @returns up to {@link ERROR_EXCERPT_BYTES} characters of the body.
 */
async function excerpt(response: Response): Promise<string> {
  try {
    const text = await response.text()
    return text.slice(0, ERROR_EXCERPT_BYTES)
  } catch {
    return '(unreadable body)'
  }
}
