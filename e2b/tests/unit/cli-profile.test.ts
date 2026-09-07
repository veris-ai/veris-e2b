import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { credentials } from '../../src/cli-profile'

let dir: string, file: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'e2b-profile-')); file = join(dir, 'twin.yaml') })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

it('works with environment credentials and no profile file', () => {
  expect(credentials({ VERIS_API_KEY: 'env-key' }, file)).toEqual({ apiKey: 'env-key', apiBase: 'https://svc.api.veris.ai' })
})

it('matches active/selected profile and environment override precedence', () => {
  writeFileSync(file, 'active_profile: dev\nprofiles:\n  dev:\n    api_key: dev-key\n    api_base: https://dev.example/\n  test:\n    api_key: test-key\n    api_base: https://test.example\n')
  expect(credentials({}, file)).toEqual({ apiKey: 'dev-key', apiBase: 'https://dev.example' })
  expect(credentials({ VERIS_PROFILE: 'test', VERIS_API_KEY: 'env-key' }, file)).toEqual({ apiKey: 'env-key', apiBase: 'https://test.example' })
  expect(credentials({ VERIS_API_BASE: 'https://override.example/' }, file)).toEqual({ apiKey: 'dev-key', apiBase: 'https://override.example' })
})

it('names missing credential sources', () => {
  expect(() => credentials({ VERIS_PROFILE: 'dev' }, file)).toThrow(/veris login.*dev/)
})

it('does not echo credential material from malformed YAML', () => {
  writeFileSync(file, 'profiles: [SECRET_KEY_WITH_BAD_YAML')
  expect(() => credentials({}, file)).toThrow('cannot read Veris profile file')
  try { credentials({}, file) } catch (error) { expect(String(error)).not.toContain('SECRET_KEY') }
})

it('rejects invalid profile shapes and treats non-string keys as missing', () => {
  writeFileSync(file, '[]')
  expect(() => credentials({}, file)).toThrow('profile mapping')
  writeFileSync(file, 'profiles:\n  default:\n    api_key: [bad]\n')
  expect(() => credentials({}, file)).toThrow('no Veris API key')
})
