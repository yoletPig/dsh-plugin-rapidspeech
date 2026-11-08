/** Volatile model hot-swap: the apply-level restart chain behind the plugin page's writes. */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.js'

/** A protocol-complete volatile cell, as the Loader commits values into running references. */
const cell = (initial: unknown) => {
  let value = initial
  return {
    get: () => value,
    [Symbol.for('cosmokit.volatile.write')]: (next: unknown) => { value = next },
  }
}

interface Harness {
  /** Ordered lifecycle events: one `register` per provider, one `unregister` per teardown. */
  events: string[]
  emitVolatile(paths: string[][]): void
  teardown(): Promise<void>
}

/**
 * Mount `apply` against a structural context: `effect` runs immediately and captures
 * its teardown; `on` records the volatile-update handler; the speech registry records
 * provider registrations in order.
 */
const mount = (config: Record<string, unknown>): Harness => {
  const listeners: Array<(paths: string[][]) => void> = []
  let effectTeardown: (() => Promise<void>) | undefined
  const events: string[] = []

  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    effect: (fn: () => unknown) => { effectTeardown = fn() as () => Promise<void> },
    on: (event: string, handler: (paths: string[][]) => void) => {
      expect(event).toBe('loader/volatile-update')
      listeners.push(handler)
      return () => { listeners.splice(listeners.indexOf(handler), 1) }
    },
    speechToText: {
      register: (provider: { info: { id: string; languages: string[] } }) => {
        events.push(`register:${provider.info.languages.join(',')}`)
        return async () => { events.push('unregister') }
      },
    },
  } as unknown as Context

  apply(ctx, config as never)
  return {
    events,
    emitVolatile(paths) { for (const listener of [...listeners]) listener(paths) },
    async teardown() { await effectTeardown?.() },
  }
}

const externalConfig = (modelId: string) => ({
  providerId: 'rapidspeech-local',
  displayName: 'RapidSpeech (local)',
  managementMode: 'external',
  endpoint: 'http://127.0.1:8080',
  modelId: cell(modelId),
  modelPath: cell(undefined),
  modelDownloadUrl: cell(undefined),
  modelSha256: cell(undefined),
  languages: ['auto', 'zh', 'en'],
})

describe('volatile model hot-swap', () => {
  it('rebuilds the provider registration when a model field moves', async () => {
    const config = externalConfig('xasr-q8_0')
    const harness = mount(config)
    expect(harness.events).toEqual(['register:auto,zh,en'])

    // The settings page wrote a different catalog model; the Loader committed the cell.
    config.modelId = cell('sense-voice-small-q4_k')
    harness.emitVolatile([['modelId']])
    await vi.waitFor(() => { expect(harness.events).toContain('register:auto,zh,en,yue,ja,ko') })
    // The SenseVoice catalog entry advertises its own language set on the replacement.
    await harness.teardown()
  })

  it('ignores volatile updates that leave the model selection untouched', async () => {
    const config = externalConfig('xasr-q8_0')
    const harness = mount(config)
    harness.emitVolatile([['somethingElse']])
    // Let microtasks flush; a wrongly-queued restart would surface as a second register.
    await new Promise(resolve => { setTimeout(resolve, 10) })
    expect(harness.events).toEqual(['register:auto,zh,en'])
    await harness.teardown()
  })

  it('tears the previous registration down before registering the replacement', async () => {
    const config = externalConfig('xasr-q8_0')
    const harness = mount(config)
    config.modelId = cell('funasr-nano-q4_k_m')
    harness.emitVolatile([['modelId']])
    await vi.waitFor(() => { expect(harness.events.length).toBeGreaterThan(2) })
    expect(harness.events).toEqual(['register:auto,zh,en', 'unregister', 'register:auto,zh,en'])
    await harness.teardown()
  })

  it('unregisters exactly once per registration across a swap and unload', async () => {
    const config = externalConfig('xasr-q8_0')
    const harness = mount(config)
    config.modelId = cell('sense-voice-small-q4_k')
    harness.emitVolatile([['modelId']])
    await vi.waitFor(() => { expect(harness.events.length).toBeGreaterThan(2) })
    await harness.teardown()
    await harness.teardown()
    expect(harness.events).toEqual([
      'register:auto,zh,en', 'unregister', 'register:auto,zh,en,yue,ja,ko', 'unregister',
    ])
  })
})
