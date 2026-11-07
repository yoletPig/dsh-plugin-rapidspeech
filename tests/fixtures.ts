/** Test fixtures that build real RIFF/WAVE byte streams. */

/** Minimal PCM WAV with an exact 44-byte header, like browser recordings. */
export function pcmWav(options?: {
  sampleRate?: number
  channels?: number
  bits?: number
  frames?: number
  extraChunk?: { id: string; body: Buffer }
}): Buffer {
  const sampleRate = options?.sampleRate ?? 16000
  const channels = options?.channels ?? 1
  const bits = options?.bits ?? 16
  const frames = options?.frames ?? 160
  const blockAlign = channels * bits / 8
  const data = Buffer.alloc(frames * blockAlign)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * blockAlign, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  const extra = options?.extraChunk
  if (extra === undefined) return Buffer.concat([header, data])
  const chunk = Buffer.alloc(8 + extra.body.length + (extra.body.length % 2))
  chunk.write(extra.id, 0, 'ascii')
  chunk.writeUInt32LE(extra.body.length, 4)
  extra.body.copy(chunk, 8)
  const wav = Buffer.concat([header.subarray(0, 36), chunk, header.subarray(36), data])
  // The extra chunk grew the file; restate the RIFF size so the stream stays self-consistent.
  wav.writeUInt32LE(wav.length - 8, 4)
  return wav
}

/** WAVE_FORMAT_EXTENSIBLE (0xFFFE) WAV wrapping a PCM subformat. */
export function extensiblePcmWav(frames = 160): Buffer {
  const sampleRate = 16000
  const channels = 1
  const bits = 16
  const blockAlign = channels * bits / 8
  const data = Buffer.alloc(frames * blockAlign)
  const fmt = Buffer.alloc(40)
  fmt.writeUInt16LE(0xfffe, 0)
  fmt.writeUInt16LE(channels, 2)
  fmt.writeUInt32LE(sampleRate, 4)
  fmt.writeUInt32LE(sampleRate * blockAlign, 8)
  fmt.writeUInt16LE(blockAlign, 12)
  fmt.writeUInt16LE(bits, 14)
  fmt.writeUInt16LE(22, 16)
  fmt.writeUInt16LE(bits, 18)
  fmt.writeUInt32LE(0x0003, 20)
  // GUID 00000001-0000-0010-8000-00aa00389b71 with the PCM prefix in LE.
  fmt.set([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71], 24)
  return riffWav(fmt, data)
}

/** Assemble one RIFF/WAVE stream from raw fmt and data bodies. */
export function riffWav(fmt: Buffer, data: Buffer): Buffer {
  const parts: Buffer[] = []
  const push = (id: string, body: Buffer): void => {
    const head = Buffer.alloc(8)
    head.write(id, 0, 'ascii')
    head.writeUInt32LE(body.length, 4)
    parts.push(head, body, ...(body.length % 2 === 1 ? [Buffer.alloc(1)] : []))
  }
  push('fmt ', fmt)
  push('data', data)
  const body = Buffer.concat(parts)
  const header = Buffer.alloc(12)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(4 + body.length, 4)
  header.write('WAVE', 8, 'ascii')
  return Buffer.concat([header, body])
}
