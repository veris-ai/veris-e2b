import { describe, it, expect } from 'vitest'
import { sanitizeTrustEnv, vendoredTrustEnv, SYSTEM_BUNDLE, CA_CERT_PATH } from '../../src/trust'

describe('sanitizeTrustEnv', () => {
  it('keeps known vars with path-shaped values', () => {
    const out = sanitizeTrustEnv({ SSL_CERT_FILE: '/custom/bundle.crt', NODE_EXTRA_CA_CERTS: CA_CERT_PATH })
    expect(out.SSL_CERT_FILE).toBe('/custom/bundle.crt')
    expect(out.NODE_EXTRA_CA_CERTS).toBe(CA_CERT_PATH)
  })
  it('drops unknown keys (no arbitrary env injection)', () => {
    const out = sanitizeTrustEnv({ EVIL: '/etc/passwd', LD_PRELOAD: '/x.so', SSL_CERT_FILE: SYSTEM_BUNDLE })
    expect(out).not.toHaveProperty('EVIL')
    expect(out).not.toHaveProperty('LD_PRELOAD')
    expect(out.SSL_CERT_FILE).toBe(SYSTEM_BUNDLE)
  })
  it('drops non-path values (shell metacharacters, relative paths)', () => {
    const out = sanitizeTrustEnv({ SSL_CERT_FILE: '/ok/a.crt', CURL_CA_BUNDLE: 'x; rm -rf /', REQUESTS_CA_BUNDLE: 'relative' })
    expect(out.SSL_CERT_FILE).toBe('/ok/a.crt')
    expect(out).not.toHaveProperty('CURL_CA_BUNDLE')
    expect(out).not.toHaveProperty('REQUESTS_CA_BUNDLE')
  })
  it('falls back to the vendored map when nothing valid remains', () => {
    expect(sanitizeTrustEnv({ EVIL: 'x' })).toEqual(vendoredTrustEnv())
    expect(sanitizeTrustEnv(undefined)).toEqual(vendoredTrustEnv())
  })
})
