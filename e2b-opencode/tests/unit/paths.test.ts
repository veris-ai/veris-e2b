import { describe, it, expect } from 'vitest'
import { resolveIn, shq } from '../../.opencode/plugin/e2b/tools/paths'

const REPO = '/home/user/project'

describe('resolveIn', () => {
  it('anchors a bare filename in the repo', () => {
    expect(resolveIn(REPO, 'src/a.ts')).toBe(`${REPO}/src/a.ts`)
  })
  it('leaves a path already inside the repo alone', () => {
    expect(resolveIn(REPO, `${REPO}/src/a.ts`)).toBe(`${REPO}/src/a.ts`)
  })
  it('respects an absolute path elsewhere in the sandbox', () => {
    expect(resolveIn(REPO, '/etc/hosts')).toBe('/etc/hosts')
  })
  it('collapses duplicate slashes', () => {
    expect(resolveIn(REPO, '/a//b')).toBe('/a//b')
    expect(resolveIn(REPO, 'a//b')).toBe(`${REPO}/a/b`)
  })
  it('returns the repo for an empty path', () => {
    expect(resolveIn(REPO, '')).toBe(REPO)
  })
})

describe('shq', () => {
  it('quotes a plain value', () => {
    expect(shq('abc')).toBe("'abc'")
  })
  // These strings reach a shell, so the escaping is the security boundary.
  it('neutralises embedded single quotes', () => {
    expect(shq("a'b")).toBe("'a'\\''b'")
  })
  it('neutralises command substitution and separators', () => {
    expect(shq('$(rm -rf /)')).toBe("'$(rm -rf /)'")
    expect(shq('a; rm -rf /')).toBe("'a; rm -rf /'")
  })
})
