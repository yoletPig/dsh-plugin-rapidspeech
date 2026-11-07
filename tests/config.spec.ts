/** Endpoint policy: loopback by default, explicit whitelist for anything remote. */
import { describe, expect, it } from 'vitest'
import { resolveEndpoint } from '../src/config.js'

describe('resolveEndpoint', () => {
  it('accepts loopback endpoints without extra configuration', () => {
    expect(resolveEndpoint('http://127.0.0.1:8080', []).hostname).toBe('127.0.0.1')
    expect(resolveEndpoint('http://localhost:8080', []).hostname).toBe('localhost')
    // WHATWG URL keeps IPv6 brackets in hostname; the policy accepts both spellings.
    expect(resolveEndpoint('http://[::1]:8080', []).hostname).toBe('[::1]')
  })

  it('rejects remote hosts that are not whitelisted', () => {
    expect(() => resolveEndpoint('http://10.1.2.3:8080', [])).toThrow('allowedHosts')
    expect(() => resolveEndpoint('http://asr.example.com', [])).toThrow('allowedHosts')
  })

  it('accepts whitelisted remote hosts, case-insensitively', () => {
    expect(resolveEndpoint('http://asr.example.com:9000', ['ASR.example.com']).hostname).toBe('asr.example.com')
  })

  it('rejects unusable URLs and non-http schemes', () => {
    expect(() => resolveEndpoint('not a url', [])).toThrow('not a valid URL')
    expect(() => resolveEndpoint('ftp://127.0.0.1:8080', [])).toThrow('http or https')
  })
})
