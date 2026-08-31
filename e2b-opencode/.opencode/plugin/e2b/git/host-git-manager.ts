/**
 * Copyright Veris AI, Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * git, run on the engineer's machine. Modelled on @daytona/opencode's
 * host-git-manager (Apache-2.0), with the SSH remote replaced by bundle files:
 * E2B has no SSH endpoint, and a bundle needs no listening service, no
 * credentials and no open port in either direction.
 */

import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { logger } from '../core/logger'

export type GitResult = { status: number; stdout: string; stderr: string }

export function execGit(args: string[], opts: { cwd: string }): GitResult {
  const res = spawnSync('git', args, { cwd: opts.cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? (res.error ? String(res.error) : ''),
  }
}

export class HostGitManager {
  hasRepo(cwd: string): boolean {
    return execGit(['rev-parse', '--git-dir'], { cwd }).status === 0
  }

  /** HEAD's commit, or undefined in a repo with no commits yet. */
  headOid(cwd: string): string | undefined {
    const res = execGit(['rev-parse', 'HEAD'], { cwd })
    return res.status === 0 ? res.stdout.trim() || undefined : undefined
  }

  /** Branch names already taken, so opencode/N picks an unused number. */
  branchNames(cwd: string): string[] {
    const res = execGit(['branch', '--format=%(refname:short)'], { cwd })
    if (res.status !== 0) return []
    return res.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  }

  /** A scratch directory for one bundle round-trip. Caller removes it. */
  makeTempDir(): string {
    return mkdtempSync(join(tmpdir(), 'veris-oc-'))
  }

  removeTempDir(dir: string): void {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A leftover temp directory is not worth failing a sync over.
    }
  }

  /**
   * Bundle local HEAD for shipping into the sandbox. Returns undefined when the
   * repo has no commits — a fresh `git init` is a legitimate starting state, and
   * the sandbox just gets an empty repo instead.
   */
  bundleHead(cwd: string, bundlePath: string): boolean {
    if (!this.headOid(cwd)) {
      logger.info('Local repo has no commits; sandbox starts from an empty repo.')
      return false
    }
    const res = execGit(['bundle', 'create', '-q', bundlePath, 'HEAD'], { cwd })
    if (res.status !== 0) throw new Error(`Failed to bundle local HEAD: ${res.stderr}`)
    return true
  }

  /**
   * Adopt a bundle produced in the sandbox onto a local branch. The branch is
   * force-updated: the plugin owns opencode/N and the README says so, because
   * anything else would make a sync fail on the engineer's own edits.
   */
  fetchBundleToBranch(cwd: string, bundlePath: string, localBranch: string): void {
    const verify = execGit(['bundle', 'verify', bundlePath], { cwd })
    if (verify.status !== 0) {
      throw new Error(`Sandbox bundle is not usable here: ${verify.stderr.trim()}`)
    }
    const res = execGit(['fetch', '-q', bundlePath, `+opencode:${localBranch}`], { cwd })
    if (res.status !== 0) {
      throw new Error(`Failed to fetch sandbox bundle into ${localBranch}: ${res.stderr}`)
    }
    logger.info(`Pulled sandbox changes into ${localBranch}`)
  }

  /** The tip we last pulled, used as the basis for the next incremental bundle. */
  branchOid(cwd: string, branch: string): string | undefined {
    const res = execGit(['rev-parse', '--verify', '--quiet', branch], { cwd })
    return res.status === 0 ? res.stdout.trim() || undefined : undefined
  }
}
