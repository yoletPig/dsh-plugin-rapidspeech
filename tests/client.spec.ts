/** HTTP client contract: payload shape, status errors, response validation, and cancellation. */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { RapidspeechClient, TranscriptionHttpError } from '../src/client.js'
import { pcmWav } from './fixtures.js'

/** One server that validates a multipart body arrives and answers with a transcript. */
const listen = async (): Promise<{ server: Server; url: URL }> => {
  const server = createServer((request, response) => {
    const respond = (status: number, body: string): void => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(body)
    }
    let size = 0
    request.on('data', (chunk: Buffer) => { size += chunk.length })
    request.on('end', () => {
      // The multipart body must arrive with the recording inside it.
      if (size < 100) return respond(400, '{"error":"empty"}')
      respond(200, JSON.stringify({ text: '你好世界' }))
    })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  return { server, url: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`) }
}

/** One-shot server that answers every request with the given status and body. */
const staticServer = async (status: number, body: string, type: string): Promise<{ server: Server; url: URL }> => {
  const server = createServer((request, response) => {
    request.on('data', () => {})
    request.on('end', () => {
      response.writeHead(status, { 'content-type': type })
      response.end(body)
    })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  return { server, url: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`) }
}

/** Server that accepts the request and never answers. */
const hangingServer = async (): Promise<{ server: Server; url: URL }> => {
  const server = createServer(() => {})
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  return { server, url: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`) }
}

const closeAll = async (...servers: Server[]): Promise<void> => {
  await Promise.all(servers.map(server => new Promise<void>(resolve => { server.close(() => resolve()) })))
}

describe('RapidspeechClient', () => {
  const audio = pcmWav()

  it('posts the recording and returns transcript text with elapsed time', async () => {
    const { server, url } = await listen()
    try {
      const result = await new RapidspeechClient(url, 'rapidspeech-asr', 5_000).transcribe(audio, new AbortController().signal)
      expect(result.text).toBe('你好世界')
      expect(result.elapsedSeconds).toBeGreaterThanOrEqual(0)
    } finally {
      await closeAll(server)
    }
  })

  it('reports non-2xx status with a body excerpt', async () => {
    const { server, url } = await staticServer(500, 'server exploded', 'text/plain')
    try {
      const failure = new RapidspeechClient(url, 'm', 5_000)
      await expect(() => failure.transcribe(audio, new AbortController().signal)).rejects.toThrow('ASR HTTP 500: server exploded')
    } finally {
      await closeAll(server)
    }
  })

  it('rejects non-JSON payloads', async () => {
    const { server, url } = await staticServer(200, 'not json', 'text/plain')
    try {
      const failure = new RapidspeechClient(url, 'm', 5_000)
      await expect(() => failure.transcribe(audio, new AbortController().signal)).rejects.toThrow('not JSON')
    } finally {
      await closeAll(server)
    }
  })

  it('rejects JSON without a text field', async () => {
    const { server, url } = await staticServer(200, JSON.stringify({ result: 'oops' }), 'application/json')
    try {
      const failure = new RapidspeechClient(url, 'm', 5_000)
      await expect(() => failure.transcribe(audio, new AbortController().signal)).rejects.toThrow('missing a text field')
    } finally {
      await closeAll(server)
    }
  })

  it('surfaces connection refusal as a transport error', async () => {
    const { server, url } = await staticServer(200, '{}', 'application/json')
    const port = Number(url.port)
    await closeAll(server)
    const failure = new RapidspeechClient(new URL(`http://127.0.0.1:${port}`), 'm', 5_000)
    await expect(() => failure.transcribe(audio, new AbortController().signal)).rejects.toThrow(TranscriptionHttpError)
  })

  it('honors a pre-aborted caller signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const { server, url } = await listen()
    try {
      await expect(() => new RapidspeechClient(url, 'm', 5_000).transcribe(audio, controller.signal))
        .rejects.toThrow('cancelled')
    } finally {
      await closeAll(server)
    }
  })

  it('honors the request timeout', async () => {
    const { server, url } = await hangingServer()
    try {
      const failure = new RapidspeechClient(url, 'm', 50)
      await expect(() => failure.transcribe(audio, new AbortController().signal)).rejects.toThrow('exceeded 50 ms')
      // Let undici finish tearing down the aborted socket before the server disappears.
      await new Promise(resolve => { setTimeout(resolve, 50) })
    } finally {
      await closeAll(server)
    }
  })
})
