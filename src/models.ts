/** Downloadable ASR model catalog: one entry per model, one source per distribution site. */

/** One distribution site for a model artifact. */
export interface ModelDownloadSource {
  /** Advertised origin string; the preparation UI offers these verbatim. */
  readonly origin: string
  /** Complete asset URL at this origin. */
  readonly url: string
}

/** One downloadable model with every known mirror. */
export interface ModelCatalogEntry {
  readonly id: string
  readonly displayName: string
  readonly fileName: string
  readonly bytes: number
  /** Pinned integrity hash; undefined leaves verification to the deployment. */
  readonly sha256: string | undefined
  readonly sources: readonly ModelDownloadSource[]
  /** Language hints the model itself supports. */
  readonly languages: readonly string[]
}

const HF = 'https://huggingface.co'
const HF_MIRROR = 'https://hf-mirror.com'
const MODELSCOPE = 'https://www.modelscope.cn'
const REPO = 'RapidAI/RapidSpeech'

/** The ASR models rs-server consumes, with the origins RapidAI publishes them on. */
export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  {
    id: 'xasr-q8_0',
    displayName: 'X-ASR (q8_0, 178 MB)',
    fileName: 'xasr-q8_0.gguf',
    bytes: 178_311_424,
    sha256: 'd3308e7f283f9e3403f5f787d48dbff57b335b6fbb05899074ce48d009d9de57',
    sources: [
      { origin: MODELSCOPE, url: `${MODELSCOPE}/models/${REPO}/resolve/main/ASR/X-ASR/xasr-q8_0.gguf` },
    ],
    languages: ['auto', 'zh', 'en'],
  },
  {
    id: 'sense-voice-small-q4_k',
    displayName: 'SenseVoiceSmall (q4_k, 182 MB)',
    fileName: 'sense-voice-small-q4_k.gguf',
    bytes: 182_305_088,
    sha256: '0a2457c53b6c3f3e504df16585dcd0ede9ef5ae023325c70ed547801a9453c0a',
    sources: [
      { origin: HF, url: `${HF}/${REPO}/resolve/main/ASR/SenseVoice/sense-voice-small-q4_k.gguf` },
      { origin: HF_MIRROR, url: `${HF_MIRROR}/${REPO}/resolve/main/ASR/SenseVoice/sense-voice-small-q4_k.gguf` },
      { origin: MODELSCOPE, url: `${MODELSCOPE}/models/${REPO}/resolve/main/ASR/SenseVoice/sense-voice-small-q4_k.gguf` },
    ],
    languages: ['auto', 'zh', 'en', 'yue', 'ja', 'ko'],
  },
  {
    id: 'funasr-nano-q4_k_m',
    displayName: 'FunASR-Nano (q4_k_m, 692 MB)',
    fileName: 'funasr-nano-q4_k_m.gguf',
    bytes: 692_140_864,
    sha256: '82c5bc2aea12a852ce55bf78183d0c23624454df181da59b1b9e1fef8292e6ab',
    sources: [
      { origin: HF, url: `${HF}/${REPO}/resolve/main/ASR/FunasrNano/funasr-nano-q4_k_m.gguf` },
      { origin: MODELSCOPE, url: `${MODELSCOPE}/models/${REPO}/resolve/main/ASR/FunASRNano/funasr-nano-q4_k_m.gguf` },
    ],
    languages: ['auto', 'zh', 'en'],
  },
]

export const CATALOG_IDS: readonly string[] = MODEL_CATALOG.map(entry => entry.id)

/**
 * Look up one catalog entry.
 * @param id - configured model id.
 * @returns the entry, or undefined when the id is unknown.
 */
export function catalogEntry(id: string): ModelCatalogEntry | undefined {
  return MODEL_CATALOG.find(entry => entry.id === id)
}

/**
 * Pick the concrete source for one preparation task.
 * @param entry - the catalog entry being downloaded.
 * @param downloadSource - origin chosen in the UI, or undefined for the default (first) source.
 * @returns the source to download from.
 * @throws when the chosen origin does not serve this model; no fallback, ever.
 */
export function selectSource(entry: ModelCatalogEntry, downloadSource?: string): ModelDownloadSource {
  if (downloadSource === undefined) return entry.sources[0]!
  const chosen = entry.sources.find(source => source.origin === downloadSource)
  if (chosen === undefined) {
    throw new Error(`Download source ${downloadSource} does not serve model ${entry.id}; available: ${entry.sources.map(source => source.origin).join(', ')}`)
  }
  return chosen
}
