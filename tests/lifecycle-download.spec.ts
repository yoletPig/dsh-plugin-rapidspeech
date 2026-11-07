/** Managed download flow: missing assets are fetched over HTTP, verified, extracted, and booted. */
import { spawn as nodeSpawn, execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLifecycle } from '../src/lifecycle.js'
import { pcmWav } from './fixtures.js'

const FAKE_SERVER = new URL('./fixtures/fake-server.mjs', import.meta.url).pathname

let workspace = ''
let cache = ''
let assetServer: Server | undefined
let assetBase = ''
const modelBytes = Buffer.alloc(1024 * 1024, 9)
const modelSha256 = createHash('sha256').update(modelBytes).digest('hex')

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'rapidspeech-dl-src-'))
  cache = await mkdtemp(join(tmpdir(), 'rapidspeech-dl-cache-'))
  // The wrapper retargets the managed argv at the fake server, exactly like real installs.
  const wrapper = ['#!/usr/bin/env bash', `exec node ${JSON.stringify(FAKE_SERVER)} "$@"`, ''].join('\n')
  const binDir = join(workspace, 'pkg')
  await mkdir(binDir, { recursive: true })
  await writeFile(join(binDir, 'rs-server'), wrapper).then(() => chmod(join(binDir, 'rs-server'), 0o755))
  await writeFile(join(workspace, 'model.gguf'), modelBytes)
  const tarball = join(workspace, 'rapidspeech-linux-x64.tar.gz')
  await new Promise<void>((resolve, reject) => {
    execFile('tar', ['-czf', tarball, '-C', binDir, 'rs-server'], error => { error == null ? resolve() : reject(error) })
  })
  const tarballBytes = await import('node:fs/promises').then(fs => fs.readFile(tarball))
  assetServer = createServer((request, response) => {
    const body = request.url === '/pkg/rapidspeech-linux-x64.tar.gz' ? tarballBytes
      : request.url === '/models/sense-voice.gguf' ? modelBytes
      : null
    if (body === null) { response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'content-length': String(body.length) })
    response.end(body)
  })
  const server = assetServer!
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  assetBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  assetServer?.closeAllConnections?.()
  await new Promise<void>(resolve => { assetServer?.close(() => resolve()) })
})

const collect = (stream: NodeJS.ReadableStream | null) => {
  let text = ''
  stream?.on('data', (chunk: Buffer) => { text += chunk.toString() })
  return { readFrom: (offset: number) => ({ text: text.slice(offset), nextOffset: text.length, lossy: false }) }
}

const spawner = (children: ChildProcess[]) => ({
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const child = nodeSpawn(spec.argv[0]!, spec.argv.slice(1), {
      cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    const done = new Promise<SubprocessOutcome>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (exitCode, signal) => { resolve({ exitCode, signal: signal ?? null }) })
    })
    return {
      done,
      collected: { stdout: collect(child.stdout), stderr: collect(child.stderr) },
      terminate: () => { child.kill('SIGTERM') },
      waitForExit: async () => { await done; return true },
    } as unknown as SubprocessHandle
  },
})

const fakeCtx = (children: ChildProcess[]) => ({
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
  subprocess: spawner(children),
}) as unknown as Context

const downloadConfig = (overrides?: Partial<Parameters<typeof createLifecycle>[1]>) => ({
  providerId: 'rapidspeech-local',
  displayName: 'RapidSpeech (local)',
  managementMode: 'managed' as const,
  endpoint: 'http://127.0.0.1:8080',
  serverBinaryPath: undefined,
  modelPath: undefined,
  dataRoot: cache,
  binaryDownloadUrl: `${assetBase}/pkg/rapidspeech-linux-x64.tar.gz`,
  binaryDownloadSha256: undefined,
  modelDownloadUrl: `${assetBase}/models/sense-voice.gguf`,
  modelId: 'xasr-q8_0',
  serverLibraryPath: undefined,
  modelSha256,
  extraServerArgs: [] as string[],
  model: 'rapidspeech-asr',
  languages: ['auto', 'zh', 'en'],
  stripControlTokens: true,
  requestTimeoutMs: 5_000,
  maxAudioBytes: 32 * 1024 * 1024,
  allowedHosts: [] as string[],
  prepareTimeoutMs: 10_000,
  downloadTimeoutMs: 60_000,
  graceMs: 500,
  idleTimeoutMs: 0,
  maxLogBytes: 64 * 1024,
  ...overrides,
})

describe('managed download flow', () => {
  let children: ChildProcess[] = []
  beforeAll(() => { children = [] })

  it('downloads missing assets, publishes progress, and reaches ready', async () => {
    const lifecycle = createLifecycle(fakeCtx(children), downloadConfig())
    expect(lifecycle.filesReady()).toBe(false)
    const phases: string[] = []
    lifecycle.preparation.subscribe(() => { phases.push(lifecycle.preparation.snapshot().phase) })
    const base = await lifecycle.ensureReady(new AbortController().signal)
    expect(base.hostname).toBe('127.0.0.1')
    expect(phases).toContain('downloading')
    expect(lifecycle.preparation.snapshot()).toMatchObject({ phase: 'ready' })
    // The cache now holds the extracted binary and the verified model.
    expect(lifecycle.filesReady()).toBe(true)
    const transcript = await lifecycle.run(async url => {
      const form = new FormData()
      form.set('file', new Blob([pcmWav({ frames: 8000 })], { type: 'audio/wav' }), 'clip.wav')
      form.set('model', 'rapidspeech-asr')
      const response = await fetch(new URL('/v1/audio/transcriptions', url), { method: 'POST', body: form })
      if (!response.ok) throw new Error(`probe HTTP ${response.status}`)
      return (await response.json() as { text: string }).text
    })
    expect(transcript).toBe('fake transcript')
    await lifecycle.dispose()
  })

  it('fails with a clear message when a wrong model hash arrives', async () => {
    const cache2 = await mkdtemp(join(tmpdir(), 'rapidspeech-dl-bad-'))
    const lifecycle = createLifecycle(fakeCtx(children),
      downloadConfig({ dataRoot: cache2, modelSha256: 'a'.repeat(64) }))
    await expect(() => lifecycle.ensureReady(new AbortController().signal)).rejects.toThrow('SHA-256 mismatch')
    expect(lifecycle.preparation.snapshot()).toMatchObject({ phase: 'failed' })
    await lifecycle.dispose()
  })

  it('does not re-download on the next prepare', async () => {
    // filesReady is now true; a fresh lifecycle over the same cache must spawn directly.
    const lifecycle = createLifecycle(fakeCtx(children), downloadConfig({ dataRoot: cache }))
    const base = await lifecycle.ensureReady(new AbortController().signal)
    expect(base.hostname).toBe('127.0.0.1')
    await lifecycle.dispose()
  })
})
