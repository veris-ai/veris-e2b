import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: false, // declarations emitted by `tsc --emitDeclarationOnly` (see build script)
  sourcemap: true,
  clean: true,
  target: 'node20',
  shims: true,
})
