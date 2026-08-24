import { describe, it, expect } from 'vitest'
import { buildNetwork, vendorHosts, dataPlaneHosts } from '../../src/network'
import type { EgressCredential, ServiceInfo } from '../../src/control-plane'

const cred: EgressCredential = {
  socks_address: 'gw.veris.ai:1080',
  username: 'v1.aaaaaaaaaaaaaaaaaaaaaaaaa',
  password: 'secret',
  ca_pem: 'PEM',
  canary_host: 'canary.gw.veris.ai',
}

const services: ServiceInfo[] = [
  { name: 'stripe', status: 'ready', url: 'https://x/s/1/stripe', control_url: 'https://x/s/1/stripe',
    routes: [{ host: 'api.stripe.com' }, { host: 'files.stripe.com' }] },
  { name: 'postgres', status: 'ready', url: 'postgresql://u:p@pg.veris.ai:5432/db', control_url: 'https://x/s/1/postgres',
    env_hint: 'DATABASE_URL', routes: null },
]

describe('vendorHosts / dataPlaneHosts', () => {
  it('collects sorted vendor hostnames from routes', () => {
    expect(vendorHosts(services)).toEqual(['api.stripe.com', 'files.stripe.com'])
  })
  it('extracts the DSN host of a non-http data plane', () => {
    expect(dataPlaneHosts(services)).toEqual(['pg.veris.ai'])
  })
})

describe('buildNetwork', () => {
  it('strict: deny-all + vendor hosts + canary + data plane, egressProxy set, no catch-all', () => {
    const n = buildNetwork({ credential: cred, services, mode: 'strict' })
    expect(n.denyOut).toBeDefined()
    expect(n.allowOut).toContain('api.stripe.com')
    expect(n.allowOut).toContain('canary.gw.veris.ai')
    expect(n.allowOut).toContain('pg.veris.ai')
    expect(n.allowOut).not.toContain('0.0.0.0/0')
    expect(n.egressProxy).toMatchObject({ address: 'gw.veris.ai:1080', username: cred.username, password: 'secret' })
  })
  it('open: adds the 0.0.0.0/0 catch-all', () => {
    const n = buildNetwork({ credential: cred, services, mode: 'open' })
    expect(n.allowOut).toContain('0.0.0.0/0')
  })
  it('merges caller allowOut additions', () => {
    const n = buildNetwork({ credential: cred, services, mode: 'strict', allowOut: ['registry.npmjs.org'] })
    expect(n.allowOut).toContain('registry.npmjs.org')
  })
})
