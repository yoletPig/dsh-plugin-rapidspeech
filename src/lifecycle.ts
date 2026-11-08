/** Managed rs-server process lifecycle: owned spawn, health, idle reclamation, deterministic termination. */
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, open, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the `subprocess` service declaration mounted by the base bundle.
import type {} from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { SpeechPreparation, SpeechPreparationState } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { assetBasename, resolveManagedTarget, resolveModelAsset, type Config } from './config.js'
import { downloadFile, extractTarGz, type DownloadOutcome } from './download.js'
import { selectSource } from './models.js'

/** Persisted download facts for the managed cache; drives update detection. */
interface CacheMeta {
  readonly binaryUrl?: string
  /** ETag/Last-Modified captured at download time; detects new releases at the same URL. */
  readonly binaryTag?: string
  readonly modelSha?: string
  readonly updatedAt?: string
}

/** The slice of `ctx.subprocess` this module uses; structural so tests can fake it. */
export interface SubprocessSpawner {
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
}

/** Where the transcription client should talk once the server is ready. */
export interface RapidspeechLifecycle {
  /** Host-owned preparation state for the provider roster UI; absent in external mode. */
  readonly preparation: SpeechPreparation
  /**
   * Whether the binary and model already exist locally and match the configured
   * origins/hashes; gates download-free auto-preparation. Includes one HEAD
   * probe of the binary URL, so treat it as a startup-time check.
   */
  filesReady(): Promise<boolean>
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
    filesReady: async () => true,
    async ensureReady() { return base },
    async run(work) { return await work(base) },
    armIdle() {},
    async dispose() {},
  }
}

/** Managed lifecycle owning exactly one spawned rs-server. */
function managedLifecycle(ctx: Context, config: Config): RapidspeechLifecycle {
  const target = resolveManagedTarget(config)
  const model = resolveModelAsset(config)
  const metaPath = config.dataRoot !== undefined ? join(config.dataRoot, 'cache-meta.json') : undefined
  let state: SpeechPreparationState = { phase: 'unprepared' }
  const listeners = new Set<() => void>()
  let handle: SubprocessHandle | undefined
  let base: URL | undefined
  let prepareTask: Promise<URL> | undefined
  let prepareController: AbortController | undefined
  /** Origin chosen in the preparation UI for the running task; undefined keeps the default. */
  let downloadSource: string | undefined
  let admissionClosed = false
  const active = new Set<Promise<unknown>>()
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  const readMeta = (): CacheMeta | undefined => {
    if (metaPath === undefined || !existsSync(metaPath)) return undefined
    try {
      return JSON.parse(readFileSync(metaPath, 'utf8')) as CacheMeta
    } catch {
      return undefined
    }
  }

  let binaryTag: string | undefined
  const writeMeta = async (): Promise<void> => {
    if (metaPath === undefined) return
    await mkdir(dirname(metaPath), { recursive: true })
    const meta: CacheMeta = {
      ...(target.binaryUrl !== undefined ? { binaryUrl: target.binaryUrl, ...(binaryTag !== undefined ? { binaryTag } : {}) } : {}),
      ...(model.sha256 !== undefined ? { modelSha: model.sha256 } : {}),
      updatedAt: new Date().toISOString(),
    }
    await writeFile(metaPath, JSON.stringify(meta, null, 1))
  }

  /**
   * Whether the cached assets no longer match the configured origins/hashes.
   * Absent metadata (caches written before this field existed) counts as
   * fresh, so upgrades never trigger a surprise re-download. The binary
   * compare includes a HEAD probe because the default URL ("latest") keeps
   * its name across releases; the model is pinned by hash instead.
   */
  const cacheStale = async (signal: AbortSignal): Promise<boolean> => {
    const meta = readMeta()
    if (meta === undefined) return false
    if (config.serverBinaryPath === undefined && target.binaryUrl !== undefined) {
      if (meta.binaryUrl !== undefined && meta.binaryUrl !== target.binaryUrl) return true
      if (meta.binaryTag !== undefined) {
        const current = await probeBinaryTag(target.binaryUrl, signal)
        if (current !== undefined && current !== meta.binaryTag) return true
      }
    }
    if (config.modelPath === undefined && model.sha256 !== undefined
      && meta.modelSha !== undefined && meta.modelSha !== model.sha256) return true
    return false
  }

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
    signal: AbortSignal, sha256?: string): Promise<DownloadOutcome> => {
    publish({ phase: 'downloading', resource, completedBytes: 0 })
    return await downloadFile(url, destination, {
      signal,
      timeoutMs: config.downloadTimeoutMs,
      sha256,
      onProgress: ({ completedBytes, totalBytes }) => {
        publish({ phase: 'downloading', resource, completedBytes,
          ...(totalBytes !== undefined ? { totalBytes } : {}) })
      },
    })
  }

  /** Fetch whichever managed asset is missing or stale; fresh matching files never re-download. */
  const ensureAssets = async (signal: AbortSignal): Promise<void> => {
    let updated = false
    const binaryMissing = !existsSync(target.binaryPath)
    const binaryStale = binaryMissing
      || (config.serverBinaryPath === undefined && target.binaryUrl !== undefined
        && await cacheStale(signal))
    if (binaryStale) {
      if (!target.canDownloadBinary) {
        throw new Error(`RapidSpeech server binary is missing: ${target.binaryPath} (set serverBinaryPath, or dataRoot with binaryDownloadUrl)`)
      }
      if (existsSync(target.binaryPath)) await rm(target.binaryPath, { force: true })
      const archive = join(config.dataRoot!, 'bin', assetBasename(target.binaryUrl!))
      const outcome = await downloadAsset(target.binaryUrl!, archive, 'rs-server binary', signal, config.binaryDownloadSha256)
      await extractTarGz(archive, dirname(target.binaryPath))
      await rm(archive, { force: true })
      if (!existsSync(target.binaryPath)) {
        throw new Error(`Downloaded archive did not contain the server executable at its root: ${target.binaryUrl}`)
      }
      binaryTag = outcome.tag
      updated = true
    }
    const modelStale = !existsSync(target.modelPath)
      || (config.modelPath === undefined && model.sha256 !== undefined && readMeta()?.modelSha !== undefined && readMeta()?.modelSha !== model.sha256)
    if (modelStale) {
      if (!target.canDownloadModel || model.url === undefined) {
        throw new Error(`RapidSpeech model is missing: ${target.modelPath} (set modelPath, or dataRoot with modelId/modelDownloadUrl)`)
      }
      // The UI's origin choice pins one source; an origin that does not serve this
      // model fails without fallback. Manual URLs have no advertised sources.
      const url = model.sources.length > 0 ? selectSource(model.catalog!, downloadSource).url : model.url
      if (existsSync(target.modelPath)) await rm(target.modelPath, { force: true })
      await downloadAsset(url, target.modelPath, model.displayName, signal, model.sha256)
      updated = true
    }
    if (updated) await writeMeta()
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
        // The idle clock starts even without a first transcription; a prepared
        // server that nobody uses must still be reclaimed.
        armIdle()
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
    if (model.sha256 === undefined) return
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
    if (actual !== model.sha256) {
      throw new Error(`RapidSpeech model SHA-256 mismatch: expected ${model.sha256}, got ${actual}`)
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
        // Windows crashes report as exit codes (0xC0000005 access violation,
        // 0xC000001D illegal instruction); surface them next to the stderr tail.
        const outcome: SubprocessOutcome | undefined = await spawned.done.catch(() => undefined)
        const code = outcome !== undefined && outcome.exitCode !== undefined && outcome.exitCode !== null
          ? `exit code ${outcome.exitCode}` +
            (outcome.exitCode < 0 ? ` (0x${(outcome.exitCode >>> 0).toString(16).toUpperCase()})` : '')
          : outcome !== undefined && outcome.signal !== null && outcome.signal !== undefined ? `signal ${outcome.signal}`
          : 'unknown cause'
        throw new Error(`RapidSpeech server exited during startup (${code}): ${await stderrTail(spawned)}`)
      }
      if (settled.healthy) return
      await new Promise(resolve => { setTimeout(resolve, HEALTH_INTERVAL_MS) })
    }
  }

  /** Schedule idle reclamation; a no-op while transcriptions are in flight. */
  const armIdle = (): void => {
    clearTimeout(idleTimer)
    if (config.idleTimeoutMs === 0 || handle === undefined || active.size > 0) return
    idleTimer = setTimeout(() => {
      void stop().catch((error: unknown) => { ctx.logger.warn('RapidSpeech idle stop failed', error) })
    }, config.idleTimeoutMs)
  }

  const preparation: SpeechPreparation = {
    snapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    prepare: (options) => {
      if (admissionClosed || prepareTask !== undefined || base !== undefined) return
      downloadSource = options?.downloadSource
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
    // Stale caches read as not-ready so an updated release/model goes through
    // the preparation UI's consent step instead of silently re-downloading.
    filesReady: async () =>
      existsSync(target.binaryPath) && existsSync(target.modelPath) && !(await cacheStale(new AbortController().signal)),
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
    armIdle,
    async dispose() {
      admissionClosed = true
      prepareController?.abort(new Error('RapidSpeech provider disposed'))
      await Promise.allSettled([...active])
      await stop()
      listeners.clear()
    },
  }
}

/** HEAD one asset for its change tag; network failures read as "cannot tell", never stale. */
async function probeBinaryTag(url: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      redirect: 'follow',
    })
    await response.body?.cancel()
    return response.headers.get('etag') ?? response.headers.get('last-modified') ?? undefined
  } catch {
    return undefined
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
