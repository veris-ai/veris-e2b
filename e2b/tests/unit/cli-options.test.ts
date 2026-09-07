import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { parseOptions, shellQuote, UsageError, WORK_DIR } from '../../src/cli-options'

describe('CLI arguments', () => {
  it('uses E2B templates, strict allowances and a separate timeout for the box', () => {
    expect(parseOptions(['provision', '--sandbox', 'twin-1', '--template', 'my-template', '--allow-out', 'registry.npmjs.org', '--allow-out', 'pypi.org', '--env', 'A=x=y', '--timeout', '120', '--allow-public-traffic']))
      .toEqual({ verb: 'provision', twinId: 'twin-1', template: 'my-template', workDir: WORK_DIR, timeoutMs: 120000,
        allowOut: ['registry.npmjs.org', 'pypi.org'], env: { A: 'x=y' }, publicTraffic: true })
  })

  it('preserves actual argv, including quotes, empty args and shell syntax as data', () => {
    const words = ['a b', '', "it's", '$(echo INJECTED)', '$PWD', '; echo nope', '--help', 'a\nb']
    const opts = parseOptions(['exec', 'box-1', '--env', 'X=', '--', 'printf', '%s\n', ...words])
    expect(opts.verb).toBe('exec')
    if (opts.verb !== 'exec') return
    expect(execFileSync('sh', ['-c', opts.command], { encoding: 'utf8' })).toBe(words.join('\n') + '\n')
    expect(opts.env).toEqual({ X: '' })
    expect(shellQuote("x'y")).toBe("'x'\\''y'")
  })

  it.each(['provision', 'push', 'exec', 'teardown'])('prints help for %s without credentials or required arguments', verb => {
    expect(parseOptions([verb, '--help']).verb).toBe('help')
  })

  it.each([
    ['toString'], ['unknown'], ['provision'], ['provision', '--sandbox', 'twin', '--image', 'node:20'],
    ['provision', '--sandbox', '../twin'], ['provision', '--sandbox', 'twin', '--workdir', '/'],
    ['provision', '--sandbox', 'twin', '--timeout', '0'], ['exec', 'box', '--timeout', 'Infinity', '--', 'true'],
    ['push', 'box', '--repo', 'https://github.com/a/b'], ['teardown', 'box', 'other'], ['exec', 'box'],
    ['provision', '--sandbox', 'twin', '--env', 'VERIS_API_KEY=secret'],
    ['exec', 'box', '--env', 'E2B_API_KEY=secret', '--', 'true'],
    ['exec', 'box', '--env', 'A;echo=1', '--', 'true'], ['push', 'box', '--', 'unexpected'],
  ])('rejects invalid or unsupported arguments: %j', (...args) => {
    expect(() => parseOptions(args)).toThrow(UsageError)
  })
})
