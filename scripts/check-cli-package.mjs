// Validate the artifact consumers receive, without publishing or cloud access.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = mkdtempSync(join(tmpdir(), 'veris-e2b-pack-'))
try {
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', temp, '--cache', join(temp, 'cache')], {
    cwd: join(root, 'e2b'), encoding: 'utf8',
  }))
  execFileSync('tar', ['xzf', join(temp, pack.filename), '-C', temp])
  const unpacked = join(temp, 'package')
  const pkg = JSON.parse(readFileSync(join(unpacked, 'package.json'), 'utf8'))
  assert.equal(pkg.bin['veris-e2b'], './dist/cli-entry.js')
  assert.ok(readFileSync(join(unpacked, pkg.bin['veris-e2b']), 'utf8').startsWith('#!/usr/bin/env node\n'))
  for (const name of ['dist/boot.sh', 'dist/index.js', 'dist/index.cjs', 'dist/index.d.ts', 'docs/cli.md']) {
    assert.ok(pack.files.some(f => f.path === name), `missing ${name}`)
  }
  assert.ok(!pack.files.some(f => f.path.includes('node_modules/')))
  assert.ok(pack.size < 1048576, 'package exceeds release size limit')
  // Reuse installed dependencies only; imports/entrypoints themselves resolve
  // from the extracted tarball, not from a workspace source or stale dist tree.
  symlinkSync(join(root, 'node_modules'), join(unpacked, 'node_modules'), 'dir')
  const env = { ...process.env, E2B_API_KEY: '', VERIS_API_KEY: '' }
  const run = (...args) => execFileSync(process.execPath, args, { cwd: unpacked, env, encoding: 'utf8' })
  const bin = join(unpacked, pkg.bin['veris-e2b'])
  assert.equal(run(bin, '--version').trim(), pkg.version)
  for (const verb of ['run', 'provision', 'push', 'exec', 'teardown']) assert.match(run(bin, verb, '--help'), new RegExp(`usage: veris-e2b ${verb}`))
  run('--input-type=module', '-e', 'import { Sandbox } from "./dist/index.js"; if (typeof Sandbox.create !== "function") process.exit(1)')
  run('-e', 'if (typeof require("./dist/index.cjs").Sandbox.create !== "function") process.exit(1)')
  console.log(`CLI package verified: ${pack.files.length} files, ${pack.size} bytes; five help commands, version, ESM and CJS imports pass`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
