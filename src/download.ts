/** Verified downloads: streamed to a temp file, hashed, then moved into place atomically. */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Upper bound on any downloaded asset; guards against runaway responses. */
export const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024 * 1024

/** Failure with a classified reason, mirroring SpeechDownloadFailure's vocabulary. */
export class DownloadError extends Error {
  constructor(message: string, readonly reason: 'network' | 'timeout' | 'http' | 'integrity' | 'storage',
    readonly status?: number) {
    super(message)
    this.name = 'DownloadError'
  }
}

export interface DownloadProgress {
  readonly completedBytes: number
  readonly totalBytes?: number
}

export interface DownloadOptions {
  readonly signal: AbortSignal
  /** Wall-clock budget for the whole download. */
  readonly timeoutMs: number
  /** Expected SHA-256; the file never lands when the hash differs. */
  readonly sha256?: string | undefined
  /** Progress callback; may fire more often than the UI consumes. */
  readonly onProgress?: (progress: DownloadProgress) => void
}

/**
 * Download one asset to `destination`.
 * @param url - asset origin.
 * @param destination - final file path; written atomically via a sibling temp file.
 * @param options - deadline, integrity, and progress.
 * @throws DownloadError with a stable reason on any failure path.
 */
export async function downloadFile(url: string, destination: string, options: DownloadOptions): Promise<void> {
  const { signal, timeoutMs, sha256, onProgress } = options
  const deadline = Date.now() + timeoutMs
  signal.throwIfAborted()
  await mkdir(dirname(destination), { recursive: true })
  const temp = `${destination}.download-${process.pid}-${Date.now()}`
  try {
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) })
      .catch((error: unknown) => {
        throw signal.aborted
          ? new DownloadError('Download cancelled', 'network')
          : new DownloadError(`Download request failed: ${describe(error)}`, 'network')
      })
    if (!response.ok) {
      await response.body?.cancel()
      throw new DownloadError(`Download HTTP ${response.status} for ${url}`, 'http', response.status)
    }
    const declared = response.headers.get('content-length')
    const total = declared !== null && /^\d+$/.test(declared) ? Number(declared) : undefined
    if (total !== undefined && total > MAX_DOWNLOAD_BYTES) {
      throw new DownloadError(`Download exceeds the ${MAX_DOWNLOAD_BYTES} byte cap`, 'integrity')
    }
    const hash = createHash('sha256')
    let completed = 0
    let lastReport = 0
    const writer = createWriteStream(temp)
    try {
      for await (const chunk of response.body ?? []) {
        signal.throwIfAborted()
        if (Date.now() > deadline) throw new DownloadError(`Download exceeded ${timeoutMs} ms`, 'timeout')
        const bytes = chunk as Buffer
        completed += bytes.length
        if (completed > MAX_DOWNLOAD_BYTES) throw new DownloadError('Download exceeds the size cap', 'integrity')
        hash.update(bytes)
        if (!writer.write(bytes)) {
          await new Promise<void>((resolve, reject) => {
            writer.once('drain', resolve)
            writer.once('error', reject)
          })
        }
        if (onProgress !== undefined && Date.now() - lastReport > 200) {
          lastReport = Date.now()
          onProgress({ completedBytes: completed, ...(total !== undefined ? { totalBytes: total } : {}) })
        }
      }
      await new Promise<void>((resolve, reject) => { writer.end(() => resolve()); writer.once('error', reject) })
    } catch (error) {
      throw error instanceof DownloadError ? error
        : new DownloadError(`Download stream failed: ${describe(error)}`, 'network')
    }
    const actual = hash.digest('hex')
    if (sha256 !== undefined && actual !== sha256) {
      throw new DownloadError(`Downloaded asset SHA-256 mismatch: expected ${sha256}, got ${actual}`, 'integrity')
    }
    await rename(temp, destination)
    onProgress?.({ completedBytes: completed, totalBytes: total ?? completed })
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Extract one `.tar.gz` asset into `destinationDir`, rejecting absolute or
 * escaping member paths (no shell involved; bsdtar ships with Windows 10+).
 * @param archive - path to the tarball.
 * @param destinationDir - extraction root, created when missing.
 */
export async function extractTarGz(archive: string, destinationDir: string): Promise<void> {
  await mkdir(destinationDir, { recursive: true })
  await stat(archive)
  await new Promise<void>((resolve, reject) => {
    execFile('tar', ['-xzf', archive, '-C', destinationDir, '--no-same-owner'], { timeout: 120_000 },
      (error, _stdout, stderr) => {
        // execFile resolves with a null error on success.
        if (error == null) resolve()
        else reject(new DownloadError(`Archive extraction failed: ${String(stderr).trim().slice(-200) || String(error)}`, 'storage'))
      })
  })
}

/**
 * Remove a directory and recreate it empty.
 * @param dir - cache directory to reset.
 */
export async function resetDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
}

/**
 * Look for one file name directly inside a directory.
 * @param dir - directory to scan (non-recursive).
 * @param name - exact file name.
 * @returns the joined path, or undefined when absent.
 */
export async function findInDir(dir: string, name: string): Promise<string | undefined> {
  try {
    const names = await readdir(dir)
    return names.includes(name) ? join(dir, name) : undefined
  } catch {
    return undefined
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
