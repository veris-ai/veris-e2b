import { describe, it, expect } from 'vitest'
import { applyReplacement } from '../../.opencode/plugin/e2b/tools/replace'

describe('applyReplacement', () => {
  it('replaces a unique occurrence', () => {
    expect(applyReplacement('a b c', 'b', 'X', false, 'f.ts')).toBe('a X c')
  })

  // The refusal matters more than the replacement: silently editing the wrong
  // one of several matches is the worst outcome this tool can produce.
  it('refuses an ambiguous match unless replaceAll', () => {
    expect(() => applyReplacement('b b', 'b', 'X', false, 'f.ts')).toThrow(/appears 2 times/)
    expect(applyReplacement('b b', 'b', 'X', true, 'f.ts')).toBe('X X')
  })

  it('refuses a missing match rather than writing the file unchanged', () => {
    expect(() => applyReplacement('a', 'zzz', 'X', false, 'f.ts')).toThrow(/not found/)
  })

  it('rejects empty and no-op edits', () => {
    expect(() => applyReplacement('a', '', 'X', false, 'f.ts')).toThrow(/must not be empty/)
    expect(() => applyReplacement('a', 'a', 'a', false, 'f.ts')).toThrow(/identical/)
  })

  it('treats oldString literally, not as a regex', () => {
    expect(applyReplacement('a.c', 'a.c', 'X', false, 'f.ts')).toBe('X')
    expect(() => applyReplacement('abc', 'a.c', 'X', false, 'f.ts')).toThrow(/not found/)
  })

  it('does not let $& in newString expand', () => {
    expect(applyReplacement('hello', 'hello', '$& world', false, 'f.ts')).toBe('$& world')
  })
})
