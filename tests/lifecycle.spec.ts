/** Managed lifecycle: spawn → health → transcribe → idle/termination, plus validation failures. */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLifecycle } from '../src/lifecycle.js'
import { pcmWav } from './fixtures.js'

const FAKE_SERVER = new URL('./fixtures/fake-server.mjs', import.meta.url).pathname

let workspace = ''

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'rapidspeech-lifecycle-'))
  // The managed argv is `<binary> --asr-model <model> ... --port <port>`; a shell wrapper
  // retargets it at the fake server while keeping the executable-permission check real.
  const wrapper = [
    '#!/usr/bin/env bash',
    `exec node ${JSON.stringify(FAKE_SERVER)} "$@"`,
    '',
  ].join('\n')
  await writeFile(join(workspace, 'rs-server'), wrapper)
  await chmod(join(workspace, 'rs-server'), 0o755)
  await writeFile(join(workspace, 'model.gguf'), Buffer.alloc(2048, 7))
})

afterAll(async () => {
  // Children are terminated by lifecycle.dispose; the temp dir is cleaned by the OS.
})

/** Bounded stderr/stdout collector shaped like the subprocess service's readFrom surface. */
const collect = (stream: NodeJS.ReadableStream | null) => {
  let text = ''
  stream?.on('data', (chunk: Buffer) => { text += chunk.toString() })
  return {
    readFrom(offset: number) {
      return { text: text.slice(offset), nextOffset: text.length, lossy: false }
    },
  }
}

/** Real child processes behind the structural spawn surface the lifecycle consumes. */
const spawner = (children: ChildProcess[]) => ({
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const child = nodeSpawn(spec.argv[0]!, spec.argv.slice(1), {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ['ignore', 'pipe', 'pipe'],
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

const managedConfig = (overrides?: Partial<Parameters<typeof createLifecycle>[1]>) => ({
  providerId: 'rapidspeech-local',
  displayName: 'RapidSpeech (local)',
  managementMode: 'managed' as const,
  endpoint: 'http://127.0.0.1:8080',
  serverBinaryPath: join(workspace, 'rs-server'),
  modelPath: join(workspace, 'model.gguf'),
  modelId: 'xasr-q8_0',
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

const wait = (ms: number): Promise<void> => { return new Promise(resolve => { setTimeout(resolve, ms) }) }

describe('managed lifecycle', () => {
  let children: ChildProcess[] = []

  beforeAll(() => { children = [] })

  it('spawns, becomes healthy, serves transcriptions, and terminates on dispose', async () => {
    const lifecycle = createLifecycle(fakeCtx(children), managedConfig())
    expect(lifecycle.preparation.snapshot()).toMatchObject({ phase: 'unprepared' })
    const base = await lifecycle.ensureReady(new AbortController().signal)
    expect(base.hostname).toBe('127.0.0.1')
    expect(lifecycle.preparation.snapshot()).toMatchObject({ phase: 'ready' })
    const transcript = await lifecycle.run(async url =>
      await new RapidspeechProbe(url).transcribe(pcmWav({ frames: 8000 })))
    expect(transcript).toBe('fake transcript')
    await lifecycle.dispose()
    await wait(50)
    expect(children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true)
  })

  it('marks failed when the binary is missing', async () => {
    const lifecycle = createLifecycle(fakeCtx(children), managedConfig({ serverBinaryPath: join(workspace, 'absent') }))
    await expect(() => lifecycle.ensureReady(new AbortController().signal)).rejects.toThrow('server binary is missing')
    expect(lifecycle.preparation.snapshot()).toMatchObject({ phase: 'failed' })
    await lifecycle.dispose()
  })

  it('marks failed on model SHA-256 mismatch and passes on the correct hash', async () => {
    const wrong = createLifecycle(fakeCtx(children), managedConfig({ modelSha256: 'f'.repeat(64) }))
    await expect(() => wrong.ensureReady(new AbortController().signal)).rejects.toThrow('SHA-256 mismatch')
    expect(wrong.preparation.snapshot()).toMatchObject({ phase: 'failed' })
    await wrong.dispose()

    const real = createHash('sha256').update(Buffer.alloc(2048, 7)).digest('hex')
    const right = createLifecycle(fakeCtx(children), managedConfig({ modelSha256: real }))
    const base = await right.ensureReady(new AbortController().signal)
    expect(base.protocol).toBe('http:')
    await right.dispose()
  })

  it('cancels a slow prepare and can prepare again afterwards', { timeout: 15_000 }, async () => {
    const lifecycle = createLifecycle(fakeCtx(children), managedConfig({ extraServerArgs: ['--delay', '1500'] }))
    lifecycle.preparation.prepare()
    await wait(100)
    await lifecycle.preparation.cancel()
    expect(lifecycle.preparation.snapshot()).toMatchObject({ phase: 'unprepared' })
    const base = await lifecycle.ensureReady(new AbortController().signal)
    expect(base.hostname).toBe('127.0.0.1')
    await lifecycle.dispose()
  })

  it('publishes standby after an unexpected exit and respawns on the next use', async () => {
    const lifecycle = createLifecycle(fakeCtx(children), managedConfig({ extraServerArgs: ['--die-in', '120'] }))
    const base = await lifecycle.ensureReady(new AbortController().signal)
    expect(lifecycle.preparation.snapshot()).toMatchObject({ phase: 'ready' })
    await wait(400)
    expect(lifecycle.preparation.snapshot()).toMatchObject({ phase: 'standby' })
    const respawned = await lifecycle.ensureReady(new AbortController().signal)
    expect(respawned.port).not.toBe(base.port)
    expect(lifecycle.preparation.snapshot()).toMatchObject({ phase: 'ready' })
    await lifecycle.dispose()
  })

  it('reclaims the server after the idle timeout and respawns later', async () => {
    const lifecycle = createLifecycle(fakeCtx(children), managedConfig({ idleTimeoutMs: 200 }))
    await lifecycle.ensureReady(new AbortController().signal)
    lifecycle.armIdle()
    await wait(500)
    expect(lifecycle.preparation.snapshot()).toMatchObject({ phase: 'standby' })
    await lifecycle.ensureReady(new AbortController().signal)
    expect(lifecycle.preparation.snapshot()).toMatchObject({ phase: 'ready' })
    await lifecycle.dispose()
  })
})

/** Minimal direct HTTP probe so lifecycle tests do not depend on the client module. */
class RapidspeechProbe {
  constructor(private readonly base: URL) {}

  async transcribe(audio: Buffer): Promise<string> {
    const form = new FormData()
    form.set('file', new Blob([audio], { type: 'audio/wav' }), 'clip.wav')
    form.set('model', 'rapidspeech-asr')
    const response = await fetch(new URL('/v1/audio/transcriptions', this.base), { method: 'POST', body: form })
    if (!response.ok) throw new Error(`probe HTTP ${response.status}`)
    return (await response.json() as { text: string }).text
  }
}
