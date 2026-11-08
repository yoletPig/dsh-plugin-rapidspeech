/** Local RapidSpeech.cpp transcription provider; external mode never spawns anything. */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls in the `speechToText` service declaration the registry row mounts before this plugin.
import type {} from '@deepseek-ai/dsh-experimental-speech-to-text'
import { Config, resolveEndpoint } from './config.js'
import { createLifecycle } from './lifecycle.js'
import { createRapidspeechProvider } from './provider.js'

export { Config } from './config.js'

export const name = 'rapidspeech-asr'
export const inject = ['speechToText', 'subprocess']

/**
 * Register the recognizer over an external rs-server, or one this plugin spawns and owns.
 * @param ctx - host registry; `speechToText` and `subprocess` are ready before apply runs.
 * @param config - validated endpoint and lifecycle settings.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.managementMode === 'external') {
    // Only the external endpoint must pass the local-service policy; managed mode picks its own port.
    resolveEndpoint(config.endpoint, config.allowedHosts)
  }
  const lifecycle = createLifecycle(ctx, config)
  const provider = createRapidspeechProvider(ctx, config, lifecycle)
  ctx.effect(() => {
    ctx.logger.info('RapidSpeech provider %s registered (%s mode)', config.providerId, config.managementMode)
    const unregister = ctx.speechToText.register(provider)
    // Managed mode walks the design-doc startup path immediately when the assets are
    // already on disk and current. Missing or updated assets stay `unprepared` so the
    // first download/upgrade waits for the user's explicit consent in the preparation UI.
    if (config.managementMode === 'managed') {
      void lifecycle.filesReady().then(ready => { if (ready) lifecycle.preparation.prepare() })
    }
    // Deregistration first lets in-flight transcriptions settle against a live server;
    // lifecycle teardown afterwards kills only the process this plugin spawned.
    return async () => {
      await unregister()
      await lifecycle.dispose()
      ctx.logger.info('RapidSpeech provider %s unregistered', config.providerId)
    }
  })
}
