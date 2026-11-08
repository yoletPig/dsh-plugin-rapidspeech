/** Endpoint policy: loopback by default, explicit whitelist for anything remote. */
import { describe, expect, it } from 'vitest'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { Config, modelSelectionChanged, resolveEndpoint, snapshotConfig } from '../src/config.js'

describe('resolveEndpoint', () => {
  it('accepts loopback endpoints without extra configuration', () => {
    expect(resolveEndpoint('http://127.0.0.1:8080', []).hostname).toBe('127.0.0.1')
    expect(resolveEndpoint('http://localhost:8080', []).hostname).toBe('localhost')
    // WHATWG URL keeps IPv6 brackets in hostname; the policy accepts both spellings.
    expect(resolveEndpoint('http://[::1]:8080', []).hostname).toBe('[::1]')
  })

  it('rejects remote hosts that are not whitelisted', () => {
    expect(() => resolveEndpoint('http://10.1.2.3:8080', [])).toThrow('allowedHosts')
    expect(() => resolveEndpoint('http://asr.example.com', [])).toThrow('allowedHosts')
  })

  it('accepts whitelisted remote hosts, case-insensitively', () => {
    expect(resolveEndpoint('http://asr.example.com:9000', ['ASR.example.com']).hostname).toBe('asr.example.com')
  })

  it('rejects unusable URLs and non-http schemes', () => {
    expect(() => resolveEndpoint('not a url', [])).toThrow('not a valid URL')
    expect(() => resolveEndpoint('ftp://127.0.0.1:8080', [])).toThrow('http or https')
  })
})

/** A fake volatile cell matching the cosmokit reference protocol the Loader commits through. */
const cell = (initial: unknown) => {
  let value = initial
  return {
    get: () => value,
    [Symbol.for('cosmokit.volatile.write')]: (next: unknown) => { value = next },
  }
}

describe('volatile model selection', () => {
  it('parses the four model-selection fields into live cells and snapshots them back', () => {
    const parsed = Config({ providerId: 'p', modelId: 'sense-voice-small-q4_k', modelPath: '/x.gguf' })
    expect(typeof parsed.modelId?.get).toBe('function')
    expect(typeof parsed.modelPath?.get).toBe('function')
    expect(parsed.modelId?.get()).toBe('sense-voice-small-q4_k')
    expect(parsed.modelPath?.get()).toBe('/x.gguf')
    // Untouched optional fields resolve to undefined cells, not absent keys.
    expect(parsed.modelSha256?.get()).toBeUndefined()

    const snapshot = snapshotConfig(parsed as never)
    expect(snapshot.modelId).toBe('sense-voice-small-q4_k')
    expect(snapshot.modelPath).toBe('/x.gguf')
    expect(snapshot.modelSha256).toBeUndefined()
  })

  it('resolves a catalog modelId through the snapshot unchanged', () => {
    const parsed = Config({})
    const snapshot = snapshotConfig(parsed as never)
    expect(snapshot.modelId).toBe('xasr-q8_0')
    // dataRoot defaults to the dsh home cache so wholesale row overrides stay switchable.
    expect(snapshot.dataRoot).toBe(dshHomePath('rapidspeech'))
  })

  it('reports model-selection differences across snapshots only', () => {
    const before = snapshotConfig({ modelId: 'xasr-q8_0' } as never)
    expect(modelSelectionChanged(before, before)).toBe(false)
    expect(modelSelectionChanged(before, { ...before, displayName: 'renamed' })).toBe(false)
    expect(modelSelectionChanged(before, { ...before, modelId: 'funasr-nano-q4_k_m' })).toBe(true)
    expect(modelSelectionChanged(before, { ...before, modelPath: '/other.gguf' })).toBe(true)
  })

  it('leaves already-plain values untouched', () => {
    const plain = snapshotConfig({ modelId: 'xasr-q8_0', modelPath: cell(undefined) } as never)
    expect(plain.modelId).toBe('xasr-q8_0')
    expect(plain.modelPath).toBeUndefined()
  })
})
