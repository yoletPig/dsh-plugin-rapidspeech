// One-shot: persist the recognition selection back to the registered provider.
export const name = 'rapidspeech-configure-probe'
export const inject = ['speechToText']

export function apply(ctx) {
  ctx.effect(() => async () => {})
  setTimeout(async () => {
    try {
      await ctx.speechToText.configure({ providerId: 'rapidspeech-local' })
      const snapshot = ctx.speechToText.snapshot()
      console.log('[configure-probe] selection now:', JSON.stringify(snapshot.selection))
      console.log('[configure-probe] RESULT: PASS')
    } catch (error) {
      console.log('[configure-probe] RESULT: FAIL', error?.stack ?? String(error))
    } finally {
      setTimeout(() => process.exit(0), 300)
    }
  }, 3000)
}
