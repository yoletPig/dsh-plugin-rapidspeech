/** Local RapidSpeech.cpp transcription provider; external mode never spawns anything. */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls in the `speechToText` service declaration the registry row mounts before this plugin.
import type {} from '@deepseek-ai/dsh-experimental-speech-to-text'
// Type-only: brings the Loader's `loader/volatile-update` event into the cordis Events map.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { modelSelectionChanged, resolveEndpoint, snapshotConfig, type LoaderConfig } from './config.js'
import { createLifecycle } from './lifecycle.js'
import { createRapidspeechProvider } from './provider.js'

export { Config } from './config.js'

export const name = 'rapidspeech-asr'
export const inject = ['speechToText', 'subprocess']

/**
 * Register the recognizer over an external rs-server, or one this plugin spawns and owns.
 * The model-selection fields are volatile: the plugin page rewrites them in place and this
 * apply rebuilds the provider and its managed server without unloading the row.
 * @param ctx - host registry; `speechToText` and `subprocess` are ready before apply runs.
 * @param config - validated endpoint and lifecycle settings; volatile model fields are live cells.
 */
export function apply(ctx: Context, config: LoaderConfig): void {
  if (config.managementMode === 'external') {
    // Only the external endpoint must pass the local-service policy; managed mode picks its own port.
    resolveEndpoint(config.endpoint, config.allowedHosts)
  }
  let snapshot = snapshotConfig(config)
  /** Teardown of the currently registered provider; undefined once unload finished. */
  let running: (() => Promise<void>) | undefined
  /** Serializes model switches; each awaits the previous teardown before registering anew. */
  let queue: Promise<void> = Promise.resolve()
  /** Set by unload; a queued switch past its teardown must not register again. */
  let stopped = false

  const start = (): void => {
    const lifecycle = createLifecycle(ctx, snapshot)
    const provider = createRapidspeechProvider(ctx, snapshot, lifecycle)
    ctx.logger.info('RapidSpeech provider %s registered (%s mode)', snapshot.providerId, snapshot.managementMode)
    const unregister = ctx.speechToText.register(provider)
    // Managed mode walks the design-doc startup path immediately when the assets are
    // already on disk and current. Missing or updated assets stay `unprepared` so the
    // first download/upgrade waits for the user's explicit consent in the preparation UI.
    if (snapshot.managementMode === 'managed') {
      void lifecycle.filesReady().then(ready => { if (ready) lifecycle.preparation.prepare() })
    }
    running = async () => {
      await unregister()
      await lifecycle.dispose()
      ctx.logger.info('RapidSpeech provider %s unregistered', snapshot.providerId)
    }
  }

  const restart = (): void => {
    queue = queue.then(async () => {
      // Captured at execution time so back-to-back switches tear down their immediate predecessor.
      const previous = running
      running = undefined
      await previous?.()
      if (!stopped) start()
    })
  }

  ctx.effect(() => {
    start()
    const stopListening = ctx.on('loader/volatile-update', (paths) => {
      // Volatile cells are committed before this event; re-snapshot and rebuild only
      // when a model-selection field actually moved. Other config keeps its values.
      const next = snapshotConfig(config)
      if (!modelSelectionChanged(snapshot, next)) {
        ctx.logger.debug('RapidSpeech volatile update ignored (paths: %j)', paths)
        return
      }
      ctx.logger.info('RapidSpeech model selection changed (%s -> %s); swapping the recognizer',
        snapshot.modelId, next.modelId)
      snapshot = next
      restart()
    })
    return async () => {
      stopListening()
      stopped = true
      // A queued switch must finish its teardown before unload concludes.
      await queue
      await running?.()
      running = undefined
    }
  })
}
