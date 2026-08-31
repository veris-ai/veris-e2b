/**
 * Copyright Veris AI, Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * git, run inside the sandbox. Mirrors @daytona/opencode's sandbox-git-manager
 * (Apache-2.0); only the exec call differs.
 */

import type { Sandbox } from '@veris-ai/e2b'
import { logger } from '../core/logger'

/** The branch the agent's work lives on inside the sandbox. */
export const SANDBOX_BRANCH = 'opencode'

/** Where an incoming bundle lands before it becomes the branch. Outside
 *  refs/heads/ so fetching into it is never refused. */
const STAGING_REF = 'refs/veris/incoming'

export class SandboxGitManager {
  constructor(
    private readonly sandbox: Sandbox,
    private readonly repoPath: string,
  ) {}

  private async run(command: string, opts: { cwd?: string } = {}) {
    return this.sandbox.commands.run(command, {
      cwd: opts.cwd ?? this.repoPath,
      timeoutMs: 120_000,
      // The agent's own commands are the code under test; git plumbing is not,
      // so a non-zero exit here is inspected rather than thrown.
      onStderr: () => {},
    }).catch((err: any) => ({
      exitCode: typeof err?.exitCode === 'number' ? err.exitCode : 1,
      stdout: err?.stdout ?? '',
      stderr: err?.stderr ?? String(err),
    }))
  }

  async ensureDirectory(): Promise<void> {
    const res = await this.run(`mkdir -p ${this.repoPath}`, { cwd: '/' })
    if (res.exitCode !== 0) throw new Error(`Failed to create ${this.repoPath}: ${res.stderr}`)
  }

  /** An empty repo on SANDBOX_BRANCH, with an identity so commits succeed. */
  async ensureRepo(): Promise<void> {
    await this.ensureDirectory()
    // Deliberately NOT `git init -b opencode`: that leaves opencode as the
    // checked-out branch, and git refuses to fetch into a checked-out branch of
    // a non-bare repo — which is exactly what adoptBundle() needs to do.
    const res = await this.run(
      `git rev-parse --git-dir >/dev/null 2>&1 || ` +
        `(git init -q . && ` +
        `git config user.email "agent@veris.ai" && ` +
        `git config user.name "OpenCode (Veris sandbox)")`,
    )
    if (res.exitCode !== 0) throw new Error(`Failed to init repo in sandbox: ${res.stderr}`)
  }

  /** Commit everything the agent touched. False when there was nothing to commit. */
  async autoCommit(): Promise<boolean> {
    const status = await this.run('git status --porcelain')
    if (status.exitCode === 0 && !status.stdout.trim()) {
      logger.info(`No changes to commit in sandbox at ${this.repoPath}`)
      return false
    }
    const res = await this.run(
      `git add -A && git commit -q -m "opencode: $(date -u +%FT%TZ)" --allow-empty-message`,
    )
    if (res.exitCode !== 0) {
      throw new Error(`Failed to commit in sandbox: ${res.stderr || res.stdout}`)
    }
    return true
  }

  async getHeadOid(): Promise<string | undefined> {
    const res = await this.run('git rev-parse HEAD')
    return res.exitCode === 0 ? res.stdout.trim() || undefined : undefined
  }

  async getCurrentBranch(): Promise<string> {
    const res = await this.run('git rev-parse --abbrev-ref HEAD')
    return res.exitCode === 0 ? res.stdout.trim() : SANDBOX_BRANCH
  }

  /**
   * Adopt the history in `bundlePath` as SANDBOX_BRANCH and check it out, so
   * the agent starts from exactly the commit the engineer had locally.
   */
  async adoptBundle(bundlePath: string): Promise<void> {
    // Land the history on a staging ref first. refs/veris/* is outside
    // refs/heads/, so the fetch is legal whatever is checked out; `checkout -B`
    // then moves the branch onto it, which is legal even when it is current.
    const res = await this.run(
      `git fetch -q "${bundlePath}" +HEAD:${STAGING_REF} && ` +
        `git checkout -q -B ${SANDBOX_BRANCH} ${STAGING_REF} && ` +
        `git reset -q --hard ${STAGING_REF}`,
    )
    if (res.exitCode !== 0) {
      throw new Error(`Failed to adopt bundle in sandbox: ${res.stderr || res.stdout}`)
    }
  }

  /**
   * Bundle SANDBOX_BRANCH for transport home. `basis` limits it to what the
   * host does not already have; without one the whole branch is bundled.
   * Returns false when there is nothing new, which is the common idle case.
   */
  async createBundle(bundlePath: string, basis?: string): Promise<boolean> {
    if (basis) {
      const known = await this.run(`git cat-file -e ${basis}^{commit}`)
      if (known.exitCode === 0) {
        const inc = await this.run(`git bundle create -q "${bundlePath}" ${basis}..${SANDBOX_BRANCH}`)
        if (inc.exitCode === 0) return true
        // "Refusing to create empty bundle" is the no-new-commits case.
        if (/empty bundle/i.test(inc.stderr)) return false
        logger.warn(`Incremental bundle failed, falling back to full: ${inc.stderr}`)
      }
    }
    // A repo that never adopted a bundle has no such branch; that is "nothing to
    // send", not a failure.
    const exists = await this.run(`git rev-parse --verify --quiet refs/heads/${SANDBOX_BRANCH}`)
    if (exists.exitCode !== 0) return false

    const full = await this.run(`git bundle create -q "${bundlePath}" ${SANDBOX_BRANCH}`)
    if (full.exitCode !== 0) {
      if (/empty bundle/i.test(full.stderr)) return false
      throw new Error(`Failed to bundle in sandbox: ${full.stderr || full.stdout}`)
    }
    return true
  }

  async readBundle(bundlePath: string): Promise<Uint8Array> {
    return this.sandbox.files.read(bundlePath, { format: 'bytes' })
  }

  async writeBundle(bundlePath: string, bytes: ArrayBuffer): Promise<void> {
    await this.sandbox.files.write(bundlePath, bytes)
  }

  async removeFile(path: string): Promise<void> {
    await this.run(`rm -f "${path}"`, { cwd: '/' })
  }
}
