/** RIFF/WAVE chunk parsing: recording duration must come from the actual data, never a fixed 44-byte header. */

/** Header facts extracted from one recording. */
export interface WaveInfo {
  /** Seconds of audio in the data chunk, computed from the declared byte rate. */
  readonly durationSeconds: number
  readonly sampleRate: number
  readonly channels: number
  readonly bitsPerSample: number
  /** Bytes of sample data; zero for a valid header with an empty data chunk. */
  readonly dataBytes: number
}

/** PCM format codes accepted in `fmt `: plain PCM and WAVE_FORMAT_EXTENSIBLE wrapping PCM. */
const WAVE_FORMAT_PCM = 0x0001
const WAVE_FORMAT_EXTENSIBLE = 0xfffe
/** First two bytes of the extensible GUID KSDATAFORMAT_SUBTYPE_PCM. */
const PCM_SUBFORMAT_PREFIX = 0x0001

function readTag(data: Buffer, offset: number): string {
  return data.toString('ascii', offset, offset + 4)
}

/**
 * Parse one complete recording by walking its RIFF chunks.
 * @param audio - untrusted WAV request bytes.
 * @returns header facts including the measured duration.
 * @throws when the bytes are not a PCM RIFF/WAVE stream or the chunks are inconsistent.
 */
export function parseWave(audio: Uint8Array): WaveInfo {
  const data = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength)
  if (data.length < 12 || readTag(data, 0) !== 'RIFF' || readTag(data, 8) !== 'WAVE') {
    throw new Error('Audio is not a RIFF/WAVE stream')
  }
  if (data.readUInt32LE(4) !== data.length - 8) {
    throw new Error(`RIFF size declares ${data.readUInt32LE(4)} bytes but ${data.length - 8} are present`)
  }
  let sampleRate = 0
  let channels = 0
  let bitsPerSample = 0
  let byteRate = 0
  let dataBytes = -1
  let sawFormat = false
  // Walk chunks; each chunk header is 8 bytes and payloads pad to an even offset.
  for (let offset = 12; offset + 8 <= data.length;) {
    const id = readTag(data, offset)
    const declared = data.readUInt32LE(offset + 4)
    const available = data.length - offset - 8
    if (declared > available) throw new Error(`WAV chunk ${JSON.stringify(id)} declares ${declared} bytes but only ${available} remain`)
    const body = offset + 8
    if (id === 'fmt ') {
      if (declared < 16) throw new Error('WAV fmt chunk is too short')
      const format = data.readUInt16LE(body)
      const isPcm = format === WAVE_FORMAT_PCM
        || (format === WAVE_FORMAT_EXTENSIBLE && declared >= 40
          && data.readUInt16LE(body + 24) === PCM_SUBFORMAT_PREFIX)
      if (!isPcm) throw new Error(`WAV audio format ${format} is not PCM`)
      channels = data.readUInt16LE(body + 2)
      sampleRate = data.readUInt32LE(body + 4)
      byteRate = data.readUInt32LE(body + 8)
      bitsPerSample = data.readUInt16LE(body + 14)
      if (channels < 1 || sampleRate < 1 || byteRate < 1 || bitsPerSample < 1) {
        throw new Error('WAV fmt chunk carries degenerate channel, rate, or width values')
      }
      sawFormat = true
    } else if (id === 'data') {
      if (dataBytes >= 0) throw new Error('WAV stream contains more than one data chunk')
      dataBytes = declared
    }
    offset = body + declared + (declared % 2)
  }
  if (!sawFormat) throw new Error('WAV stream has no fmt chunk')
  if (dataBytes < 0) throw new Error('WAV stream has no data chunk')
  return {
    durationSeconds: dataBytes / byteRate,
    sampleRate,
    channels,
    bitsPerSample,
    dataBytes,
  }
}
