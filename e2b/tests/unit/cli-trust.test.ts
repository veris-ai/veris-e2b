import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { bundledCaPatchScript } from '../../src/cli-trust'
import { CA_CERT_PATH } from '../../src/trust'
import { shellQuote } from '../../src/cli-options'

it('patches known SDK bundles after installation, only once, leaving unrelated CA fixtures intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2b-trust-'))
  try {
    const ca = join(dir, 'veris-ca.crt')
    writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nUNIQUE_VERIS_MARKER\n-----END CERTIFICATE-----\n')
    const bundle = join(dir, 'site packages', 'stripe', 'data', 'ca-certificates.crt')
    mkdirSync(dirname(bundle), { recursive: true }); writeFileSync(bundle, 'PUBLIC_ROOTS\n')
    const fixture = join(dir, 'cacert.pem'); writeFileSync(fixture, 'FIXTURE\n')
    // Confine the production scanner to the disposable test filesystem.
    const script = bundledCaPatchScript().replaceAll('find / -xdev', `find ${shellQuote(dir)} -xdev`).replaceAll(CA_CERT_PATH, shellQuote(ca))
    expect(execFileSync('sh', ['-c', script], { encoding: 'utf8' })).toContain('1 bundled CA file(s) patched')
    expect(execFileSync('sh', ['-c', script], { encoding: 'utf8' })).toContain('0 bundled CA file(s) patched')
    expect(readFileSync(bundle, 'utf8').match(/UNIQUE_VERIS_MARKER/g)).toHaveLength(1)
    expect(readFileSync(fixture, 'utf8')).toBe('FIXTURE\n')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
