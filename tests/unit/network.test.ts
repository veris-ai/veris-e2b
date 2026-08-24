import { describe, it, expect } from 'vitest'
import { buildNetwork, vendorHosts, dataPlaneHosts, dataPlaneEnv } from '../../src/network'
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

describe('dataPlaneHosts — real DSN shapes', () => {
  const svc = (url: string) => ({ name: 'dp', status: 'ready', url, control_url: 'https://x', env_hint: 'X', routes: null })
  it('extracts hosts from every common DSN form', () => {
    expect(dataPlaneHosts([svc('postgresql://u:p@host:5432')])).toEqual(['host'])       // no trailing /
    expect(dataPlaneHosts([svc('postgres://host.example.com/db')])).toEqual(['host.example.com']) // no creds
    expect(dataPlaneHosts([svc('redis://redis.veris.ai:6379')])).toEqual(['redis.veris.ai'])
    expect(dataPlaneHosts([svc('postgresql://u:p@[2001:db8::1]:5432/db')])).toEqual(['2001:db8::1']) // ipv6, no brackets
  })
  it('allows every host of a multi-host DSN', () => {
    expect(dataPlaneHosts([svc('mongodb://u:p@m1:27017,m2:27017/db')])).toEqual(['m1', 'm2'])
  })
})

describe('dataPlaneEnv — the env NAME is control-plane input', () => {
  const svc = (env_hint: string, url = 'postgresql://u:p@pg.veris.ai:5432/db') =>
    ({ name: 'dp', status: 'ready', url, control_url: 'https://x', env_hint, routes: null })

  it('injects a conventional hint', () => {
    expect(dataPlaneEnv([svc('DATABASE_URL')])).toEqual({ DATABASE_URL: 'postgresql://u:p@pg.veris.ai:5432/db' })
  })
  it('refuses process-controlling names', () => {
    for (const bad of ['PATH', 'NODE_OPTIONS', 'BASH_ENV', 'LD_PRELOAD', 'PYTHONPATH']) {
      expect(dataPlaneEnv([svc(bad)])).toEqual({})
    }
  })
  it('refuses malformed names', () => {
    for (const bad of ['lower', '1LEADING', 'HAS-DASH', 'HAS SPACE', 'X'.repeat(65)]) {
      expect(dataPlaneEnv([svc(bad)])).toEqual({})
    }
  })
  it('ignores http services (they are not a data plane)', () => {
    expect(dataPlaneEnv([svc('API_URL', 'https://x/s/1/stripe')])).toEqual({})
  })
})
