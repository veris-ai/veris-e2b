#!/usr/bin/env node
// Bump both packages in lockstep, and the cross-dependency with them.
//
// They version together, and npm will not do the second half for you: bumping
// @veris-ai/e2b to 0.2.0 while the plugin still asks for ^0.1.0 publishes a
// plugin that resolves an SDK it was never built against.
//
// Under 0.x the caret is narrow -- ^0.1.0 means >=0.1.0 <0.2.0 -- so the
// lockstep guarantee is npm-enforced for free. At 1.0.0 and above ^1.0.0 would
// let the plugin float onto any 1.x SDK, so this must switch to an exact pin
// before the first stable major.
//
//   node scripts/version.mjs 0.2.0
import { readFileSync, writeFileSync } from 'node:fs'

const next = process.argv[2]
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(next ?? '')) {
  console.error('usage: node scripts/version.mjs <semver>   e.g. 0.2.0, 1.0.0-rc.1')
  process.exit(2)
}

if (/^[1-9]\d*\./.test(next)) {
  console.error(`refusing ${next}: at 1.0.0+ a caret range stops guaranteeing lockstep.`)
  console.error('Switch this script to write an exact pin first -- see the comment above.')
  process.exit(2)
}

const edit = (path, fn) => {
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  fn(pkg)
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n')
  return pkg.name
}

edit('e2b/package.json', (p) => { p.version = next })
edit('e2b-opencode/package.json', (p) => {
  p.version = next
  p.dependencies['@veris-ai/e2b'] = `^${next}`
})

console.log(`both packages -> ${next} (plugin now depends on ^${next})`)
console.log(`next: update CHANGELOG.md, commit, then run the release workflow`)
