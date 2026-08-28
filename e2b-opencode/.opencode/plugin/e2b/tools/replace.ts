/**
 * Copyright Veris AI, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Exact-string replacement with the same refusal the built-in edit tool has: an
 * ambiguous match is an error, because silently editing the wrong occurrence is
 * the worst outcome available.
 */
export function applyReplacement(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  path: string,
): string {
  if (oldString === '') throw new Error('oldString must not be empty')
  if (oldString === newString) throw new Error('oldString and newString are identical')

  const count = content.split(oldString).length - 1
  if (count === 0) throw new Error(`oldString not found in ${path}`)
  if (count > 1 && !replaceAll) {
    throw new Error(`oldString appears ${count} times in ${path}; pass replaceAll or include more context`)
  }
  // Not String.replace: even with a string pattern it expands $&, $`, $' and $1
  // in the REPLACEMENT, which silently corrupts any code containing them —
  // regexes, sed scripts, shell. Splice by index instead.
  if (replaceAll) return content.split(oldString).join(newString)
  const at = content.indexOf(oldString)
  return content.slice(0, at) + newString + content.slice(at + oldString.length)
}
