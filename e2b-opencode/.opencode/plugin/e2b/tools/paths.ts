/**
 * Copyright Veris AI, Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * The agent is told the project lives at repoPath, but models still emit host
 * paths and bare filenames. Normalising here keeps every tool honest about
 * which machine a path refers to.
 */
export function resolveIn(repoPath: string, filePath: string): string {
  if (!filePath) return repoPath
  if (filePath.startsWith(repoPath)) return filePath
  if (filePath.startsWith('/')) return filePath
  return `${repoPath}/${filePath}`.replace(/\/+/g, '/')
}

/** Single-quote a value for safe interpolation into a shell command. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
