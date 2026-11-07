/** Model catalog: ids, per-origin sources, and the no-fallback source selection rule. */
import { describe, expect, it } from 'vitest'
import { assetBasename, resolveModelAsset } from '../src/config.js'
import { CATALOG_IDS, MODEL_CATALOG, catalogEntry, selectSource } from '../src/models.js'

describe('model catalog', () => {
  it('exposes the published ASR models with at least one source each', () => {
    expect(CATALOG_IDS).toEqual(['xasr-q8_0', 'sense-voice-small-q4_k', 'funasr-nano-q4_k_m'])
    for (const entry of MODEL_CATALOG) {
      expect(entry.sources.length).toBeGreaterThan(0)
      expect(entry.sha256).toMatch(/^[\da-f]{64}$/)
      for (const source of entry.sources) {
        expect(assetBasename(source.url)).toBe(entry.fileName)
      }
    }
  })

  it('serves X-ASR from ModelScope only', () => {
    const entry = catalogEntry('xasr-q8_0')!
    expect(selectSource(entry).url).toContain('modelscope.cn')
    expect(selectSource(entry, 'https://www.modelscope.cn').url).toContain('X-ASR')
    expect(() => selectSource(entry, 'https://huggingface.co')).toThrow('does not serve model xasr-q8_0')
  })

  it('offers mirrors for SenseVoice and pins the default source', () => {
    const entry = catalogEntry('sense-voice-small-q4_k')!
    expect(selectSource(entry).origin).toBe('https://huggingface.co')
    expect(selectSource(entry, 'https://hf-mirror.com').url).toContain('hf-mirror.com')
    expect(selectSource(entry, 'https://www.modelscope.cn').url).toContain('modelscope.cn')
  })

  it('carries model-specific languages', () => {
    expect(catalogEntry('sense-voice-small-q4_k')!.languages).toContain('yue')
    expect(catalogEntry('xasr-q8_0')!.languages).toEqual(['auto', 'zh', 'en'])
  })
})

describe('resolveModelAsset', () => {
  const base = {
    providerId: 'p', displayName: 'd', managementMode: 'managed' as const, endpoint: 'http://127.0.0.1:8080',
    serverBinaryPath: '/x/rs-server', modelPath: undefined, dataRoot: '/cache',
    binaryDownloadUrl: undefined, binaryDownloadSha256: undefined, modelDownloadUrl: undefined,
    serverLibraryPath: undefined, modelSha256: undefined, extraServerArgs: [], model: 'm',
    languages: ['auto'], stripControlTokens: true, requestTimeoutMs: 1, maxAudioBytes: 100,
    allowedHosts: [], prepareTimeoutMs: 1, downloadTimeoutMs: 1, graceMs: 1, idleTimeoutMs: 0,
    maxLogBytes: 1,
  }

  it('prefers the explicit model path and disables downloads', () => {
    const model = resolveModelAsset({ ...base, modelPath: '/models/x.gguf', modelId: 'xasr-q8_0' })
    expect(model.fileName).toBe('x.gguf')
    expect(model.url).toBeUndefined()
    expect(model.sources).toHaveLength(0)
  })

  it('uses a manual URL with a single implicit source', () => {
    const model = resolveModelAsset({ ...base, modelDownloadUrl: 'https://example.com/mine.gguf?token=x', modelId: 'xasr-q8_0' })
    expect(model.fileName).toBe('mine.gguf')
    expect(model.url).toContain('mine.gguf')
    expect(model.sources).toHaveLength(0)
  })

  it('resolves catalog models with sources, hash, and languages', () => {
    const model = resolveModelAsset({ ...base, modelId: 'sense-voice-small-q4_k' })
    expect(model.catalog!.id).toBe('sense-voice-small-q4_k')
    expect(model.url).toContain('huggingface.co')
    expect(model.languages).toContain('yue')
  })

  it('rejects unknown model ids at resolution time', () => {
    expect(() => resolveModelAsset({ ...base, modelId: 'nope' })).toThrow('Unknown RapidSpeech modelId')
  })
})
