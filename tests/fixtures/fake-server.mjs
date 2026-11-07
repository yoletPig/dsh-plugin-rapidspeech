/** Stand-in rs-server: serves /health and the transcription endpoint with controllable failures. */
import { createServer } from 'node:http'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}
const port = Number(option('port', '0'))
const bindDelayMs = Number(option('delay', '0'))
/** Exit this many milliseconds after the first health hit; 0 disables. */
const dieInMs = Number(option('die-in', '0'))
let dying = false

const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200)
    response.end()
    if (dieInMs > 0 && !dying) {
      dying = true
      setTimeout(() => { process.exit(0) }, dieInMs)
    }
    return
  }
  if (request.method === 'POST' && request.url === '/v1/audio/transcriptions') {
    let size = 0
    request.on('data', (chunk) => { size += chunk.length })
    request.on('end', () => {
      if (size < 100) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: 'empty' }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ text: 'fake transcript' }))
    })
    return
  }
  response.writeHead(404)
  response.end()
})

const listen = () => { server.listen(port, '127.0.0.1') }
if (bindDelayMs > 0) setTimeout(listen, bindDelayMs)
else listen()
