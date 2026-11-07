/** Provider behavior: input guards, empty-audio short-circuit, and transcript field mapping. */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createRapidspeechProvider } from '../src/provider.js'
import { pcmWav } from './fixtures.js'

const fakeCtx = { logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} } } as unknown as Context

/** External-mode lifecycle stand-in: fixed base, no preparation, no ownership. */
const fakeLifecycle = (url: URL) => ({
  preparation: { snapshot: () => ({ phase: 'ready' as const }), subscribe: () => () => {}, prepare: () => {}, cancel: async () => {} },
  filesReady: () => true,
  ensureReady: async () => url,
  run: async <T,>(work: (base: URL) => Promise<T>) => await work(url),
  armIdle: () => {},
  dispose: async () => {},
})

const startServer = async (reply: (requestBody: string) => [number, string]): Promise<{ server: Server; url: URL; bodies: string[] }> => {
  const bodies: string[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk })
    request.on('end', () => {
      bodies.push(body)
      const [status, payload] = reply(body)
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(payload)
    })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  return { server, url, bodies }
}

const config = (url: URL, overrides?: { languages?: string[]; maxAudioBytes?: number }) => ({
  providerId: 'rapidspeech-local',
  displayName: 'RapidSpeech (local)',
  managementMode: 'external' as const,
  endpoint: url.toString(),
  serverBinaryPath: undefined,
  modelPath: undefined,
  modelId: 'xasr-q8_0',
  serverLibraryPath: undefined,
  modelSha256: undefined,
  extraServerArgs: [],
  model: 'rapidspeech-asr',
  languages: overrides?.languages ?? ['auto', 'zh', 'en'],
  stripControlTokens: true,
  requestTimeoutMs: 5_000,
  maxAudioBytes: overrides?.maxAudioBytes ?? 32 * 1024 * 1024,
  allowedHosts: [],
  prepareTimeoutMs: 10_000,
  downloadTimeoutMs: 60_000,
  graceMs: 500,
  idleTimeoutMs: 0,
  maxLogBytes: 64 * 1024,
})

describe('createRapidspeechProvider', () => {
  it('maps the server text and measured WAV duration into a Transcript', async () => {
    const { server, url, bodies } = await startServer(() => [200, JSON.stringify({ text: '测试文本' })])
    try {
      const provider = createRapidspeechProvider(fakeCtx, config(url), fakeLifecycle(url))
      const transcript = await provider.transcribe({ audio: pcmWav({ frames: 32000 }), language: 'zh' }, new AbortController().signal)
      expect(transcript.text).toBe('测试文本')
      expect(transcript.audioSeconds).toBeCloseTo(2)
      expect(transcript.inferenceSeconds).toBeGreaterThanOrEqual(0)
      // One multipart part carries the model field per the rs-server contract.
      expect(bodies[0]).toContain('name="model"')
      expect(bodies[0]).toContain('rapidspeech-asr')
      expect(bodies[0]).toContain('filename="recording.wav"')
    } finally {
      server.close()
    }
  })

  it('short-circuits zero-length recordings without a network round trip', async () => {
    const { server, url, bodies } = await startServer(() => [200, JSON.stringify({ text: 'x' })])
    try {
      const provider = createRapidspeechProvider(fakeCtx, config(url), fakeLifecycle(url))
      const transcript = await provider.transcribe({ audio: pcmWav({ frames: 0 }), language: 'auto' }, new AbortController().signal)
      expect(transcript).toEqual({ text: '', audioSeconds: 0, inferenceSeconds: 0 })
      expect(bodies).toHaveLength(0)
    } finally {
      server.close()
    }
  })

  it('rejects unsupported languages and oversized audio before any request', async () => {
    const { server, url, bodies } = await startServer(() => [200, JSON.stringify({ text: 'x' })])
    try {
      const provider = createRapidspeechProvider(fakeCtx, config(url, { languages: ['zh'] }), fakeLifecycle(url))
      await expect(() => provider.transcribe({ audio: pcmWav(), language: 'fr' }, new AbortController().signal)).rejects.toThrow('Unsupported RapidSpeech language')
      const limited = createRapidspeechProvider(fakeCtx, config(url, { maxAudioBytes: 1024 }), fakeLifecycle(url))
      await expect(() => limited.transcribe({ audio: pcmWav({ frames: 4000 }), language: 'zh' }, new AbortController().signal)).rejects.toThrow('byte limit')
      expect(bodies).toHaveLength(0)
    } finally {
      server.close()
    }
  })

  it('propagates server failures as transcription errors', async () => {
    const { server, url } = await startServer(() => [400, JSON.stringify({ error: 'bad audio' })])
    try {
      const provider = createRapidspeechProvider(fakeCtx, config(url), fakeLifecycle(url))
      await expect(() => provider.transcribe({ audio: pcmWav(), language: 'zh' }, new AbortController().signal))
        .rejects.toThrow('ASR HTTP 400')
    } finally {
      server.close()
    }
  })

  it('exposes host-local provider facts', async () => {
    const { server, url } = await startServer(() => [200, '{}'])
    try {
      const provider = createRapidspeechProvider(fakeCtx, config(url), fakeLifecycle(url))
      expect(provider.info).toMatchObject({ id: 'rapidspeech-local', location: 'host-local' })
      expect(provider.info.languages).toEqual(['auto', 'zh', 'en'])
    } finally {
      server.close()
    }
  })
})
