/** RIFF chunk-walking behavior: duration from real chunks, explicit rejection of broken streams. */
import { describe, expect, it } from 'vitest'
import { parseWave } from '../src/wav.js'
import { extensiblePcmWav, pcmWav, riffWav } from './fixtures.js'

describe('parseWave', () => {
  it('measures duration from the data chunk and byte rate', () => {
    const wav = pcmWav({ sampleRate: 16000, frames: 16000 })
    expect(parseWave(wav)).toMatchObject({ durationSeconds: 1, sampleRate: 16000, channels: 1, bitsPerSample: 16, dataBytes: 32000 })
  })

  it('walks past leading chunks instead of assuming a 44-byte header', () => {
    const wav = pcmWav({ frames: 8000, extraChunk: { id: 'LIST', body: Buffer.from('INFOhello') } })
    expect(parseWave(wav).durationSeconds).toBeCloseTo(0.5)
  })

  it('accepts WAVE_FORMAT_EXTENSIBLE PCM', () => {
    const info = parseWave(extensiblePcmWav(1600))
    expect(info.durationSeconds).toBeCloseTo(0.1)
    expect(info.sampleRate).toBe(16000)
  })

  it('accepts a zero-length data chunk as a zero-second recording', () => {
    const fmt = Buffer.alloc(16)
    fmt.writeUInt16LE(1, 0)
    fmt.writeUInt16LE(1, 2)
    fmt.writeUInt32LE(16000, 4)
    fmt.writeUInt32LE(32000, 8)
    fmt.writeUInt16LE(2, 12)
    fmt.writeUInt16LE(16, 14)
    expect(parseWave(riffWav(fmt, Buffer.alloc(0)))).toMatchObject({ durationSeconds: 0, dataBytes: 0 })
  })

  it('rejects non-WAV bytes', () => {
    expect(() => parseWave(new Uint8Array([1, 2, 3]))).toThrow('not a RIFF/WAVE')
    expect(() => parseWave(Buffer.from('RIFF----not wave!!!'))).toThrow('not a RIFF/WAVE')
  })

  it('rejects non-PCM formats', () => {
    const wav = Buffer.from(pcmWav())
    wav.writeUInt16LE(6, 20) // a-law
    expect(() => parseWave(wav)).toThrow('not PCM')
  })

  it('rejects truncated chunks and missing pieces', () => {
    const wav = pcmWav()
    expect(() => parseWave(wav.subarray(0, 10))).toThrow('not a RIFF/WAVE')
    const badSize = Buffer.from(wav)
    badSize.writeUInt32LE(wav.length, 4) // RIFF size larger than the bytes present
    expect(() => parseWave(badSize)).toThrow('declares')
  })

  it('rejects degenerate headers and duplicate data chunks', () => {
    const zeroRate = pcmWav()
    zeroRate.writeUInt32LE(0, 24)
    expect(() => parseWave(zeroRate)).toThrow('degenerate')

    const fmt = Buffer.alloc(16)
    fmt.writeUInt16LE(1, 0)
    fmt.writeUInt16LE(1, 2)
    fmt.writeUInt32LE(16000, 4)
    fmt.writeUInt32LE(32000, 8)
    fmt.writeUInt16LE(2, 12)
    fmt.writeUInt16LE(16, 14)
    const twice = riffWav(fmt, Buffer.alloc(0))
    // Concatenate a second data chunk into the same stream.
    const again = Buffer.concat([twice, Buffer.concat([Buffer.from('data', 'ascii'), Buffer.from([0, 0, 0, 0])])])
    const patched = Buffer.from(again)
    patched.writeUInt32LE(again.length - 8, 4)
    expect(() => parseWave(patched)).toThrow('more than one data chunk')
  })
})
