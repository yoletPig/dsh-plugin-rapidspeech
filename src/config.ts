/** Deployment configuration for the local RapidSpeech.cpp transcription provider. */
import { basename, isAbsolute, join } from 'node:path'
import { isVolatile, type Volatile } from '@deepseek-ai/cosmokit'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from './limits.js'
import { CATALOG_IDS, catalogEntry, type ModelDownloadSource } from './models.js'

/** Hosts that count as loopback for the endpoint guard. */
const LOOPBACK_HOST_PATTERN = /^(?:localhost(?:\.|$)|127\.\d+\.\d+\.\d+$|::1$|::$|\[::1\]$)/

/** Local service, timeouts, and recognition surface settings. */
export interface Config {
  /** Unique registration id; consumers select this exact id. */
  providerId: string
  /** Display name shown in the provider roster. */
  displayName: string
  /** `external` talks to an already-running rs-server at `endpoint`; `managed` spawns and owns one. */
  managementMode: 'external' | 'managed'
  /** Base URL of the rs-server endpoint; used in `external` mode only. */
  endpoint: string
  /** Absolute rs-server executable; required in `managed` mode. */
  serverBinaryPath?: string | undefined
  /** Absolute ASR GGUF model file; editable live from the plugin page, overriding `modelId`. */
  modelPath?: string | undefined
  /**
   * Absolute cache directory for downloaded binary and model; enables auto-download in
   * `managed` mode. Defaults to the dsh home cache so catalog models stay switchable
   * even when a patch layer replaces the row's whole config.
   */
  dataRoot?: string | undefined
  /** Tarball URL for the platform rs-server; used when the binary is missing from `dataRoot`. */
  binaryDownloadUrl?: string | undefined
  /** Expected SHA-256 of the downloaded binary tarball; omission skips archive verification. */
  binaryDownloadSha256?: string | undefined
  /** GGUF URL used when `modelPath` is absent; editable live from the plugin page. */
  modelDownloadUrl?: string | undefined
  /** Built-in catalog model to download when `modelPath`/`modelDownloadUrl` are absent; editable live. */
  modelId: string
  /** Directory holding rs-server's shared libraries; defaults to the binary's directory. */
  serverLibraryPath?: string | undefined
  /** Expected SHA-256 of the model file; verifies both downloads and existing files. */
  modelSha256?: string | undefined
  /** Extra argv appended to the managed rs-server command line. */
  extraServerArgs: string[]
  /** Model field posted alongside the recording; rs-server ignores it today but keeps it for compatibility. */
  model: string
  /** Language hints this provider accepts; `auto` relies on the model's own detection. */
  languages: string[]
  /** Remove SenseVoice-style `<|…|>` control tokens from transcript text. */
  stripControlTokens: boolean
  /** Deadline for one transcription request, including server queueing and inference. */
  requestTimeoutMs: number
  /** Maximum accepted recording size before it is handed to the HTTP client. */
  maxAudioBytes: number
  /** Explicitly whitelisted non-loopback hostnames; empty restricts the endpoint to local services. */
  allowedHosts: string[]
  /** Deadline for validating files, spawning the managed server, and reaching health. */
  prepareTimeoutMs: number
  /** Deadline for one asset download (binary tarball or model). */
  downloadTimeoutMs: number
  /** Managed server termination grace period. */
  graceMs: number
  /** Idle period before stopping the managed server; zero keeps it running until unload. */
  idleTimeoutMs: number
  /** Maximum collected stderr/stdout tail bytes kept for diagnostics. */
  maxLogBytes: number
}

/**
 * Validate deployment-varying choices at plugin activation; invalid rows fail the load.
 * The four model-selection fields are volatile: the plugin page rewrites them while the
 * row stays mounted, and the provider hot-swaps the model instead of restarting dsh.
 */
// The inferred schemastery types fight `exactOptionalPropertyTypes` over the volatile
// fields' meta defaults; the load-bearing types are `LoaderConfig` (apply boundary)
// and `Config` (everything downstream), so the annotation keeps the output side only.
export const Config: z<any, LoaderConfig> = z.object({
  providerId: z.string().min(1).default('rapidspeech-local'),
  displayName: z.string().min(1).default('RapidSpeech (local)'),
  managementMode: z.union(['external', 'managed']).default('external'),
  endpoint: z.string().min(1).pattern(/^https?:\/\//).default('http://127.0.0.1:8080'),
  serverBinaryPath: z.union([z.string().min(1), z.const(undefined)]),
  modelPath: z.union([z.string().min(1), z.const(undefined)]).volatile(),
  dataRoot: z.union([z.string().min(1), z.const(undefined)]).default(dshHomePath('rapidspeech')),
  binaryDownloadUrl: z.union([z.string().pattern(/^https:\/\//), z.const(undefined)]),
  binaryDownloadSha256: z.union([z.string().pattern(/^[\da-f]{64}$/), z.const(undefined)]),
  modelDownloadUrl: z.union([z.string().pattern(/^https:\/\//), z.const(undefined)]).volatile(),
  modelId: z.string().min(1).default('xasr-q8_0').volatile(),
  serverLibraryPath: z.union([z.string().min(1), z.const(undefined)]),
  modelSha256: z.union([z.string().pattern(/^[\da-f]{64}$/), z.const(undefined)]).volatile(),
  extraServerArgs: z.array(z.string().min(1)).default([]),
  model: z.string().min(1).default('rapidspeech-asr'),
  languages: z.array(z.string().min(1)).min(1)
    .default(['auto', 'zh', 'en']),
  stripControlTokens: z.boolean().default(true),
  requestTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(120_000),
  maxAudioBytes: z.natural().min(46).default(32 * 1024 * 1024),
  allowedHosts: z.array(z.string().min(1)).default([]),
  prepareTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(120_000),
  downloadTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(1_800_000),
  graceMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(1000),
  idleTimeoutMs: z.natural().max(MAX_TIMER_DELAY_MS).default(300_000),
  maxLogBytes: z.natural().min(1).default(64 * 1024),
})

/**
 * Check the endpoint against the local-service policy: any loopback host is
 * accepted, anything else must appear in `allowedHosts`.
 * @param endpoint - configured base URL.
 * @param allowedHosts - explicit non-loopback whitelist.
 * @returns the parsed origin URL.
 * @throws when the URL is unusable or the host is neither loopback nor whitelisted.
 */
export function resolveEndpoint(endpoint: string, allowedHosts: readonly string[] | undefined): URL {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch (cause) {
    throw new Error(`RapidSpeech endpoint is not a valid URL: ${endpoint}`, { cause })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`RapidSpeech endpoint must use http or https: ${endpoint}`)
  }
  const host = url.hostname.toLowerCase()
  const loopback = LOOPBACK_HOST_PATTERN.test(host)
  const allowed = (allowedHosts ?? []).some(entry => entry.toLowerCase() === host)
  if (!loopback && !allowed) {
    throw new Error(`RapidSpeech endpoint must be a local service or listed in allowedHosts: ${host}`)
  }
  return url
}

/** Config fields the plugin page rewrites while the row stays mounted. */
export const VOLATILE_MODEL_KEYS = ['modelId', 'modelPath', 'modelDownloadUrl', 'modelSha256'] as const

/** One volatile field name. */
export type VolatileModelKey = typeof VOLATILE_MODEL_KEYS[number]

/**
 * The config as the Loader hands it to `apply`: the four model-selection fields are
 * live cells (committed in place by `loader/volatile-update`), everything else is plain.
 */
export type LoaderConfig = Omit<Config, VolatileModelKey> & {
  modelId: Volatile<string>
  modelPath: Volatile<string | undefined>
  modelDownloadUrl: Volatile<string | undefined>
  modelSha256: Volatile<string | undefined>
}

/** Read one maybe-volatile field as its current plain snapshot. */
function plainValue<T>(value: T | Volatile<T>): T {
  return (isVolatile(value) ? value.get() : value) as T
}

/**
 * Unwrap volatile references into a plain config snapshot. The Loader hands volatile
 * fields to `apply` as live cells; every resolver and provider below wants plain values.
 * @param config - the raw context config as delivered by the Loader.
 * @returns a detached snapshot safe to keep across the model switch.
 */
export function snapshotConfig(config: LoaderConfig): Config {
  return {
    ...config,
    modelId: plainValue(config.modelId),
    modelPath: plainValue(config.modelPath),
    modelDownloadUrl: plainValue(config.modelDownloadUrl),
    modelSha256: plainValue(config.modelSha256),
  }
}

/** Whether two config snapshots disagree on any model-selection field. */
export function modelSelectionChanged(before: Config, after: Config): boolean {
  return VOLATILE_MODEL_KEYS.some(key => before[key] !== after[key])
}

/** Where the managed server's assets live and whether each can be downloaded. */
export interface ManagedTarget {
  /** Resolved absolute rs-server path (explicit or under `dataRoot`). */
  readonly binaryPath: string
  /** Resolved absolute model path (explicit or under `dataRoot`). */
  readonly modelPath: string
  /** Binary download URL: the explicit config value, or the platform release asset. */
  readonly binaryUrl: string | undefined
  /** The binary is meant to live in the `dataRoot` cache, so a missing file can be downloaded. */
  readonly canDownloadBinary: boolean
  /** The model is meant to live in the `dataRoot` cache, so a missing file can be downloaded. */
  readonly canDownloadModel: boolean
}

/** The resolved model asset: where it comes from and how it may be downloaded. */
export interface ResolvedModel {
  /** File name used under `dataRoot`'s models directory. */
  readonly fileName: string
  /** Human-readable name for preparation progress. */
  readonly displayName: string
  /** Complete download URL, when the model is download-capable. */
  readonly url: string | undefined
  /** Pinned integrity hash for the download, when known. */
  readonly sha256: string | undefined
  /** Origins the preparation UI may offer; empty for explicit paths and manual URLs. */
  readonly sources: readonly ModelDownloadSource[]
  /** Catalog entry backing the asset, when the model came from the catalog. */
  readonly catalog: import('./models.js').ModelCatalogEntry | undefined
  /** Languages the model supports (catalog models only; undefined falls back to config). */
  readonly languages: readonly string[] | undefined
}

/**
 * Resolve the model asset under the configured precedence: explicit `modelPath`,
 * then manual `modelDownloadUrl`, then the built-in catalog by `modelId`.
 * @param config - validated plugin configuration.
 * @returns the resolved asset.
 * @throws when `modelId` names no catalog entry.
 */
export function resolveModelAsset(config: Config): ResolvedModel {
  if (config.modelPath !== undefined) {
    return {
      fileName: basename(config.modelPath), displayName: 'custom model file', url: undefined,
      sha256: config.modelSha256, sources: [], catalog: undefined, languages: undefined,
    }
  }
  if (config.modelDownloadUrl !== undefined) {
    return {
      fileName: assetBasename(config.modelDownloadUrl), displayName: 'custom model URL',
      url: config.modelDownloadUrl, sha256: config.modelSha256, sources: [], catalog: undefined,
      languages: undefined,
    }
  }
  const entry = catalogEntry(config.modelId)
  if (entry === undefined) {
    throw new Error(`Unknown RapidSpeech modelId: ${config.modelId}; available: ${CATALOG_IDS.join(', ')}`)
  }
  return {
    fileName: entry.fileName, displayName: entry.displayName, url: entry.sources[0]?.url,
    sha256: entry.sha256, sources: entry.sources, catalog: entry, languages: entry.languages,
  }
}

/** Releases origin the built-in binary download falls back to. */
export const PLUGIN_RELEASE_ORIGIN = 'https://github.com/yoletPig/dsh-plugin-rapidspeech/releases/latest/download'

/** CI asset name for this platform; the Windows build ships rs-server.exe. */
export function platformBinaryAsset(): string {
  return `rapidspeech-${process.platform}-${process.arch}.tar.gz`
}

/** Complete platform asset URL used when `binaryDownloadUrl` is not configured. */
export function platformBinaryUrl(): string {
  return `${PLUGIN_RELEASE_ORIGIN}/${platformBinaryAsset()}`
}

/** File name of the server executable on this platform. */
export function serverBinaryName(): string {
  return process.platform === 'win32' ? 'rs-server.exe' : 'rs-server'
}

/** File name of a download URL, query stripped. */
export function assetBasename(url: string): string {
  const path = new URL(url).pathname
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (name.length === 0) throw new Error(`Download URL has no file name: ${url}`)
  return decodeURIComponent(name)
}

/**
 * Resolve where the managed server's binary and model must live: explicit
 * paths win; otherwise both sit inside `dataRoot` and a missing file can be
 * downloaded when the asset resolves to a URL.
 * @param config - validated plugin configuration.
 * @returns the target paths and download capability flags.
 * @throws when managed mode cannot resolve one of the assets at all.
 */
export function resolveManagedTarget(config: Config): ManagedTarget {
  const { dataRoot } = config
  const binaryUrl = config.binaryDownloadUrl ?? (dataRoot !== undefined ? platformBinaryUrl() : undefined)
  const binaryPath = config.serverBinaryPath ?? (dataRoot !== undefined ? join(dataRoot, 'bin', serverBinaryName()) : undefined)
  const model = resolveModelAsset(config)
  const modelPath = config.modelPath ?? (dataRoot !== undefined && model.url !== undefined ? join(dataRoot, 'models', model.fileName) : undefined)
  if (binaryPath === undefined || modelPath === undefined) {
    throw new Error('RapidSpeech managed mode requires serverBinaryPath and modelPath, or dataRoot with a downloadable model')
  }
  for (const [name, path] of [['serverBinaryPath', binaryPath], ['modelPath', modelPath]] as const) {
    if (!isAbsolute(path)) throw new Error(`RapidSpeech ${name} must be an absolute path: ${path}`)
  }
  return {
    binaryPath,
    modelPath,
    binaryUrl,
    canDownloadBinary: config.serverBinaryPath === undefined && binaryUrl !== undefined,
    canDownloadModel: config.modelPath === undefined && dataRoot !== undefined && model.url !== undefined,
  }
}

/** Platform families the managed server supports today; Windows arrives with the V2 packaging pass. */
export function supportedManagedPlatform(): boolean {
  return (process.platform === 'linux' || process.platform === 'win32') && process.arch === 'x64'
}
