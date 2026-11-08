// Full first-user flow: prepare() downloads binary + model from the real origins,
// spawns rs-server, and transcribes a sample through the registry.
import { readFile } from 'node:fs/promises'

export const name = 'rapidspeech-prepare-probe'
export const inject = ['speechToText']

const WAV_PATH = process.env.PROBE_WAV ?? '/home/yyl/RapidSpeech.cpp/output.wav'

export function apply(ctx) {
  ctx.effect(() => async () => {})
  setTimeout(() => {
    const run = async () => {
      try {
        const audio = new Uint8Array(await readFile(WAV_PATH))
        const spec = ctx.speechToText.resolve({ audio })
        const provider = spec.provider
        console.log('[prepare-probe] provider:', provider.info.id,
          'downloadSources:', JSON.stringify(provider.info.downloadSources))
        const started = Date.now()
        provider.preparation?.prepare()
        // Follow the preparation state machine until ready (or failure).
        for (;;) {
          const state = provider.preparation.snapshot()
          if (state.phase === 'ready') { console.log(`[prepare-probe] ready in ${((Date.now() - started) / 1000).toFixed(1)}s`); break }
          if (state.phase === 'failed') { console.log('[prepare-probe] FAILED:', state.message); process.exit(1) }
          if (state.phase === 'downloading') {
            process.stdout.write(`\r[prepare-probe] downloading ${state.resource}: ${Math.round((state.completedBytes ?? 0) / 1024)} KiB`)
          }
          await new Promise(resolve => { setTimeout(resolve, 500) })
        }
        const transcript = await ctx.speechToText.transcribe(spec, new AbortController().signal)
        console.log('\n[prepare-probe] TRANSCRIPT:', JSON.stringify(transcript))
        console.log('[prepare-probe] RESULT: PASS')
      } catch (error) {
        console.log('\n[prepare-probe] RESULT: FAIL', error?.stack ?? String(error))
      } finally {
        setTimeout(() => process.exit(0), 500)
      }
    }
    void run()
  }, 1500)
}
