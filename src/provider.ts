/** The SpeechProvider bridge between the Harness registry and rs-server. */
import type { Context } from '@deepseek-ai/cordis'
import type { SpeechProvider, SpeechProviderId, SpeechInput, Transcript } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { resolveModelAsset, type Config } from './config.js'
import type { RapidspeechLifecycle } from './lifecycle.js'
import { RapidspeechClient, TranscriptionHttpError } from './client.js'
import { stripControlTokens } from './text.js'
import { parseWave } from './wav.js'

/** Headroom over the model file for the server's compute buffers, plus shared libraries. */
const SETUP_DISK_OVERHEAD_BYTES = 96 * 1024 * 1024

/**
 * Build the provider registered under `ctx.speechToText`.
 * @param ctx - host context, used only for diagnostics.
 * @param config - validated plugin configuration.
 * @param lifecycle - server lifecycle; managed mode prepares on first use.
 * @returns one replaceable recognizer over the configured or managed endpoint.
 */
export function createRapidspeechProvider(ctx: Context, config: Config, lifecycle: RapidspeechLifecycle): SpeechProvider {
  const model = resolveModelAsset(config)
  // Catalog models carry their own language facts; manual models keep the config's hint list.
  const languages = model.languages ?? config.languages
  const clients = new Map<string, RapidspeechClient>()
  const clientFor = (base: URL): RapidspeechClient => {
    const key = base.origin
    let client = clients.get(key)
    if (client === undefined) {
      client = new RapidspeechClient(base, config.model, config.requestTimeoutMs)
      clients.set(key, client)
    }
    return client
  }
  return {
    info: {
      id: config.providerId as SpeechProviderId,
      name: config.displayName,
      location: 'host-local',
      languages,
      // Advertise the model's origins only when a download can actually happen;
      // explicit paths and external servers never offer a preparation choice.
      ...(config.managementMode === 'managed' && config.modelPath === undefined && model.sources.length > 0
        ? { downloadSources: model.sources.map(source => source.origin) }
        : {}),
      ...(model.catalog !== undefined
        ? { setupEstimate: {
            recommendedDiskBytes: model.catalog.bytes + SETUP_DISK_OVERHEAD_BYTES,
            expectedMemoryBytes: model.catalog.bytes * 2,
            minimumMinutes: 1,
            maximumMinutes: 10,
          } }
        : {}),
    },
    ...(config.managementMode === 'managed' ? { preparation: lifecycle.preparation } : {}),
    async transcribe(input: SpeechInput, signal: AbortSignal): Promise<Transcript> {
      signal.throwIfAborted()
      if (!languages.includes(input.language)) {
        throw new TranscriptionHttpError(`Unsupported RapidSpeech language: ${input.language}`)
      }
      if (input.audio.byteLength > config.maxAudioBytes) {
        throw new TranscriptionHttpError('Speech audio exceeds the configured byte limit')
      }
      // A header without a data chunk still parses; nothing reaches the server.
      const wave = parseWave(input.audio)
      if (wave.dataBytes === 0) return { text: '', audioSeconds: 0, inferenceSeconds: 0 }
      const { text: raw, elapsedSeconds } = await lifecycle.run(async base =>
        await clientFor(base).transcribe(input.audio, signal))
      const text = config.stripControlTokens ? stripControlTokens(raw) : raw
      lifecycle.armIdle()
      ctx.logger.debug('RapidSpeech transcribed %.1fs of audio in %.1fs', wave.durationSeconds, elapsedSeconds)
      return { text, audioSeconds: wave.durationSeconds, inferenceSeconds: elapsedSeconds }
    },
  }
}
