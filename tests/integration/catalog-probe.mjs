// Prints the exact speech snapshot (providers + preparation + selection) the Web UI consumes.
export const name = 'rapidspeech-catalog-probe'
export const inject = ['speechToText']

export function apply(ctx) {
  ctx.effect(() => async () => {})
  setTimeout(() => {
    const snapshot = ctx.speechToText.snapshot()
    console.log('[catalog-probe] providers:', JSON.stringify(snapshot.providers, null, 1))
    console.log('[catalog-probe] selection:', JSON.stringify(snapshot.selection))
    console.log('[catalog-probe] RESULT: DONE')
    setTimeout(() => process.exit(0), 300)
  }, 3000)
}
