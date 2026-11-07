/** Managed rs-server process lifecycle: owned spawn, health, idle reclamation, deterministic termination. */
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the `subprocess` service declaration mounted by the base bundle.
import type {} from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { SpeechPreparation, SpeechPreparationState } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { assetBasename, resolveManagedTarget, type Config } from './config.js'
import { downloadFile, extractTarGz } from './download.js'

/** The slice of `ctx.subprocess` this module uses; structural so tests can fake it. */
export interface SubprocessSpawner {
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
}

/** Where the transcription client should talk once the server is ready. */
export interface RapidspeechLifecycle {
  /** Host-owned preparation state for the provider roster UI; absent in external mode. */
  readonly preparation: SpeechPreparation
  /** Whether the binary and model already exist locally; gates download-free auto-preparation. */
  filesReady(): boolean
  /**
   * Return a healthy base URL, preparing the managed server on demand.
   * Concurrent callers join the running task; each caller's own abort still applies.
   */
  ensureReady(signal: AbortSignal): Promise<URL>
  /** Run one transcription against the ready server; tracked so unload settles it first. */
  run<T>(work: (base: URL) => Promise<T>): Promise<T>
  /** Stop the managed server once idle for the configured period; the next use respawns it. */
  armIdle(): void
  /** Terminate the owned server after tracked work settles; external servers are left running. */
  dispose(): Promise<void>
}

/** Poll interval between health probes while the server loads its model. */
const HEALTH_INTERVAL_MS = 250

/**
 * Build the lifecycle for one provider instance.
 * @param ctx - host context; only its logger and (managed mode) subprocess service are used.
 * @param config - validated plugin configuration.
 * @returns the lifecycle; in external mode it never spawns and reports permanent readiness.
 */
export function createLifecycle(ctx: Context, config: Config): RapidspeechLifecycle {
  if (config.managementMode === 'external') return externalLifecycle(config)
  return managedLifecycle(ctx, config)
}

/** External servers are user-owned: no spawn, no kill, no preparation UI. */
function externalLifecycle(config: Config): RapidspeechLifecycle {
  const base = new URL(config.endpoint)
  return {
    preparation: { snapshot: () => ({ phase: 'ready' }), subscribe: () => () => {}, prepare: () => {}, cancel: async () => {} },
    filesReady: () => true,
    async ensureReady() { return base },
    async run(work) { return await work(base) },
    armIdle() {},
    async dispose() {},
  }
}

/** Managed lifecycle owning exactly one spawned rs-server. */
function managedLifecycle(ctx: Context, config: Config): RapidspeechLifecycle {
  const target = resolveManagedTarget(config)
  let state: SpeechPreparationState = { phase: 'unprepared' }
  const listeners = new Set<() => void>()
  let handle: SubprocessHandle | undefined
  let base: URL | undefined
  let prepareTask: Promise<URL> | undefined
  let prepareController: AbortController | undefined
  let admissionClosed = false
  const active = new Set<Promise<unknown>>()
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  const publish = (next: SpeechPreparationState): void => {
    state = next
    for (const listener of listeners) listener()
  }

  const childEnv = (): NodeJS.ProcessEnv => {
    if (process.platform === 'win32') return {}
    const libraryPath = config.serverLibraryPath ?? dirname(target.binaryPath)
    return { LD_LIBRARY_PATH: [libraryPath, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') }
  }

  /** Read the collected stderr tail for startup-failure diagnostics. */
  const stderrTail = async (spawned: SubprocessHandle): Promise<string> => {
    const collected = spawned.collected.stderr
    if (collected === undefined) return '(stderr not collected)'
    const tail = collected.readFrom(0)
    return tail.text.trim().length > 0 ? tail.text.trim().slice(-400) : '(no stderr output)'
  }

  const stop = async (): Promise<void> => {
    clearTimeout(idleTimer); idleTimer = undefined
    const owned = handle
    handle = undefined
    base = undefined
    if (owned === undefined) return
    owned.terminate()
    await owned.waitForExit()
    // Idle reclamation and cancellation both land here; the roster must show the gap.
    if (!admissionClosed) publish({ phase: 'standby' })
  }

  const onExit = (spawned: SubprocessHandle): void => {
    if (handle === spawned) {
      handle = undefined
      base = undefined
      if (!admissionClosed) publish({ phase: 'standby' })
    }
  }

  /** Download one asset, publishing byte progress; verified and atomic inside downloadFile. */
  const downloadAsset = async (url: string, destination: string, resource: string,
    signal: AbortSignal, sha256?: string): Promise<void> => {
    publish({ phase: 'downloading', resource, completedBytes: 0 })
    await downloadFile(url, destination, {
      signal,
      timeoutMs: config.downloadTimeoutMs,
      sha256,
      onProgress: ({ completedBytes, totalBytes }) => {
        publish({ phase: 'downloading', resource, completedBytes,
          ...(totalBytes !== undefined ? { totalBytes } : {}) })
      },
    })
  }

  /** Fetch whichever managed asset is missing; existing files never re-download. */
  const ensureAssets = async (signal: AbortSignal): Promise<void> => {
    if (!existsSync(target.binaryPath)) {
      if (!target.canDownloadBinary) {
        throw new Error(`RapidSpeech server binary is missing: ${target.binaryPath} (set serverBinaryPath, or dataRoot with binaryDownloadUrl)`)
      }
      const archive = join(config.dataRoot!, 'bin', assetBasename(config.binaryDownloadUrl!))
      await downloadAsset(config.binaryDownloadUrl!, archive, 'rs-server binary', signal, config.binaryDownloadSha256)
      await extractTarGz(archive, dirname(target.binaryPath))
      await rm(archive, { force: true })
      if (!existsSync(target.binaryPath)) {
        throw new Error(`Downloaded archive did not contain rs-server at its root: ${config.binaryDownloadUrl}`)
      }
    }
    if (!existsSync(target.modelPath)) {
      if (!target.canDownloadModel) {
        throw new Error(`RapidSpeech model is missing: ${target.modelPath} (set modelPath, or dataRoot with modelDownloadUrl)`)
      }
      await downloadAsset(config.modelDownloadUrl!, target.modelPath, 'ASR model', signal, config.modelSha256)
    }
  }

  const startPrepare = (signal: AbortSignal): Promise<URL> => {
    let task: Promise<URL> | undefined
    task = (async (): Promise<URL> => {
      try {
        publish({ phase: 'checking', step: 'check', startedAt: Date.now() })
        await ensureAssets(signal)
        signal.throwIfAborted()
        await validateFiles()
        // A fresh OS-assigned port removes conflict handling; the probe-bind window is local and brief.
        const port = await freePort()
        publish({ phase: 'loading', step: 'load', startedAt: Date.now() })
        const spawned = ctx.subprocess.spawn({
          argv: [target.binaryPath, '--asr-model', target.modelPath, '--host', '127.0.0.1', '--port', String(port), ...config.extraServerArgs],
          cwd: dirname(target.binaryPath),
          graceMs: config.graceMs,
          env: childEnv(),
          stdio: { stdin: 'ignore', stdout: { maxBytes: config.maxLogBytes }, stderr: { maxBytes: config.maxLogBytes } },
        })
        handle = spawned
        const candidate = new URL(`http://127.0.0.1:${port}`)
        try {
          await waitHealthy(candidate, spawned)
        } catch (error) {
          spawned.terminate()
          await spawned.waitForExit().catch(() => undefined)
          if (handle === spawned) handle = undefined
          throw error
        }
        base = candidate
        publish({ phase: 'ready' })
        // An unexpected exit (crash, OOM) becomes standby so the next use respawns.
        void spawned.done.then(() => { onExit(spawned) }, () => { onExit(spawned) })
        return candidate
      } catch (error) {
        if (!admissionClosed) {
          publish(prepareController?.signal.aborted === true
            ? { phase: 'cancelled' }
            : { phase: 'failed', message: error instanceof Error ? error.message : String(error) })
        }
        throw error
      } finally {
        if (prepareTask === task) {
          prepareTask = undefined
          prepareController = undefined
        }
      }
    })()
    return task
  }

  const ensureReady = async (signal: AbortSignal): Promise<URL> => {
    if (admissionClosed) throw new Error('RapidSpeech provider is unloading')
    signal.throwIfAborted()
    if (base !== undefined) return base
    prepareController ??= new AbortController()
    const task = prepareTask ?? startPrepare(prepareController.signal)
    await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
      }),
    ])
    signal.throwIfAborted()
    // The winning task published `base`; if it lost the race it either failed (rejected above) or still owns the spawn.
    return base ?? await task
  }

  /** Verify the binary is executable and the model exists (and matches, when a hash is configured). */
  const validateFiles = async (): Promise<void> => {
    try {
      accessSync(target.binaryPath, fsConstants.X_OK)
      if (!statSync(target.binaryPath).isFile()) throw new Error('not a file')
    } catch {
      throw new Error(`RapidSpeech server binary is missing or not executable: ${target.binaryPath}`)
    }
    let modelStat
    try {
      modelStat = statSync(target.modelPath)
    } catch {
      throw new Error(`RapidSpeech model file is missing: ${target.modelPath}`)
    }
    if (!modelStat.isFile() || modelStat.size === 0) throw new Error(`RapidSpeech model is not a file: ${target.modelPath}`)
    if (config.modelSha256 === undefined) return
    const hash = createHash('sha256')
    const file = await open(target.modelPath, 'r')
    try {
      const chunk = Buffer.alloc(1024 * 1024)
      for (;;) {
        const { bytesRead } = await file.read(chunk, 0, chunk.length, null)
        if (bytesRead === 0) break
        hash.update(chunk.subarray(0, bytesRead))
      }
    } finally {
      await file.close()
    }
    const actual = hash.digest('hex')
    if (actual !== config.modelSha256) {
      throw new Error(`RapidSpeech model SHA-256 mismatch: expected ${config.modelSha256}, got ${actual}`)
    }
  }

  /** Poll /health until it answers, the server exits, or the deadline passes. */
  const waitHealthy = async (candidate: URL, spawned: SubprocessHandle): Promise<void> => {
    const deadline = Date.now() + config.prepareTimeoutMs
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(`RapidSpeech server did not become healthy within ${config.prepareTimeoutMs} ms`)
      }
      const settled = await Promise.race([
        probeHealth(candidate).then(healthy => ({ healthy }), () => ({ healthy: false })),
        spawned.done.then(() => ({ exited: true as const }), () => ({ exited: true as const })),
      ])
      if ('exited' in settled) {
        throw new Error(`RapidSpeech server exited during startup: ${await stderrTail(spawned)}`)
      }
      if (settled.healthy) return
      await new Promise(resolve => { setTimeout(resolve, HEALTH_INTERVAL_MS) })
    }
  }

  const preparation: SpeechPreparation = {
    snapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    prepare: () => {
      if (admissionClosed || prepareTask !== undefined || base !== undefined) return
      prepareController = new AbortController()
      prepareTask = startPrepare(prepareController.signal)
      void prepareTask.catch(() => undefined)
    },
    cancel: async () => {
      prepareController?.abort(new Error('Speech preparation cancelled'))
      const task = prepareTask
      if (task !== undefined) await task.catch(() => undefined)
      await stop()
      if (!admissionClosed) publish({ phase: 'unprepared' })
    },
  }

  return {
    preparation,
    filesReady: () => existsSync(target.binaryPath) && existsSync(target.modelPath),
    ensureReady,
    async run(work) {
      const ready = await ensureReady(new AbortController().signal)
      const promise = work(ready)
      active.add(promise)
      try {
        return await promise
      } finally {
        active.delete(promise)
      }
    },
    armIdle() {
      clearTimeout(idleTimer)
      if (config.idleTimeoutMs === 0 || handle === undefined || active.size > 0) return
      idleTimer = setTimeout(() => {
        void stop().catch((error: unknown) => { ctx.logger.warn('RapidSpeech idle stop failed', error) })
      }, config.idleTimeoutMs)
    },
    async dispose() {
      admissionClosed = true
      prepareController?.abort(new Error('RapidSpeech provider disposed'))
      await Promise.allSettled([...active])
      await stop()
      listeners.clear()
    },
  }
}

/** Probe /health once; rs-server answers 200 with an empty body when ready. */
async function probeHealth(base: URL): Promise<boolean> {
  const response = await fetch(new URL('/health', base), { signal: AbortSignal.timeout(1000) })
  await response.body?.cancel()
  return response.ok
}

/** Bind an ephemeral loopback listener to let the OS pick a free port, then release it. */
async function freePort(): Promise<number> {
  const server: Server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const port = (server.address() as AddressInfo).port
  await new Promise<void>(resolve => { server.close(() => resolve()) })
  return port
}
