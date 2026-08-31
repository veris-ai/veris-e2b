import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string }

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: false, // declarations emitted by `tsc --emitDeclarationOnly` (see build script)
  sourcemap: true,
  clean: true,
  target: 'node20',
  // Assets ship INSIDE dist/ so proxy-mode resolves them next to its own
  // module — a '../assets' traversal breaks under any bundler that hoists dist/.
  publicDir: 'assets',
  // The version the control plane version-gates on: injected from package.json
  // so a release bump can't leave a stale literal behind.
  define: { __SDK_VERSION__: JSON.stringify(version) },
  shims: true,
})
