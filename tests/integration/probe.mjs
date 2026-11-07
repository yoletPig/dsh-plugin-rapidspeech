// Probe plugin: mounts into the rapidspeech profile and exercises the real
// speechToText service end-to-end (provider registry -> rs-server -> Transcript).
import { readFile } from 'node:fs/promises'

export const name = 'rapidspeech-probe'
export const inject = ['speechToText']

const WAV_PATH = process.env.PROBE_WAV ?? '/home/yyl/RapidSpeech.cpp/output.wav'

export function apply(ctx) {
  const providers = ctx.speechToText.listProviders()
  console.log('[probe] registered providers:', JSON.stringify(providers.map(p => ({
    id: p.id, name: p.name, location: p.location, languages: p.languages,
  }))))
  ctx.effect(() => async () => {})
  const run = async () => {
    try {
      const audio = new Uint8Array(await readFile(WAV_PATH))
      const spec = ctx.speechToText.resolve({ audio }) // defaultProvider + default language
      console.log('[probe] resolved provider:', spec.provider.info.id, 'language:', spec.language)
      if (spec.provider.preparation !== undefined) {
        console.log('[probe] preparation before:', JSON.stringify(spec.provider.preparation.snapshot()))
      }
      const transcript = await ctx.speechToText.transcribe(spec, new AbortController().signal)
      console.log('[probe] TRANSCRIPT:', JSON.stringify(transcript))
      if (spec.provider.preparation !== undefined) {
        console.log('[probe] preparation after:', JSON.stringify(spec.provider.preparation.snapshot()))
      }
      console.log('[probe] RESULT: PASS')
    } catch (error) {
      console.log('[probe] RESULT: FAIL', error?.stack ?? String(error))
    } finally {
      // Give the logger a beat, then leave.
      setTimeout(() => process.exit(0), 500)
    }
  }
  // Run after mount settles.
  setTimeout(run, 1500)
}
