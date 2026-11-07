/** Model-output normalization shared by every backend. */

/** SenseVoice control tokens (language, emotion, ITN markers) never belong in a draft. */
const CONTROL_TOKEN = /<\|[^|<>]*\|>/g

/**
 * Remove leading/inline control tokens one backend may emit.
 * @param text - raw transcript text.
 * @returns cleaned text; empty when nothing spoken remained.
 */
export function stripControlTokens(text: string): string {
  return text.replace(CONTROL_TOKEN, '').trim()
}
