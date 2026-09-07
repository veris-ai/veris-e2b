import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Sandbox } from './sandbox'
import { shellQuote, UPLOAD_EXCLUDES } from './cli-options'
import type { CodeOptions } from './cli-options'

const say = (text: string) => { process.stderr.write(`${text}\n`) }

/** Pack before creating/connecting, so bad local inputs cannot alter a box. */
export function prepareCode(opts: CodeOptions): Buffer | undefined {
  if (opts.repo) return undefined
  return execFileSync('tar', ['czf', '-', ...UPLOAD_EXCLUDES.map(x => `--exclude=${x}`), '-C', opts.source, '.'], {
    maxBuffer: 1024 * 1024 * 1024, env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
}

export async function putCode(sbx: Sandbox, workDir: string, opts: CodeOptions, archive?: Buffer): Promise<void> {
  if (opts.repo) {
    const helper = `/tmp/veris-git-askpass-${randomUUID()}.sh`
    const token = new URL(opts.repo).hostname === 'github.com' ? (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) : undefined
    const envs = { ...await sbx.veris.getTrustEnv(), GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1',
      GIT_TRACE: '0', GIT_TRACE_CURL: '0', GIT_CURL_VERBOSE: '0',
      ...(token ? { VERIS_GIT_TOKEN: token, GIT_ASKPASS: helper } : { GIT_ASKPASS: '/bin/false' }) }
    try {
      if (token) {
        // No secret in the file or in the clone URL/argv. Refuse prompts for
        // other hosts; redirects and credential helpers are disabled below.
        await sbx.files.write(helper, `#!/bin/sh\ncase "$1" in\n  "Username for 'https://github.com': ") printf '%s\\n' x-access-token ;;\n  "Password for 'https://x-access-token@github.com': ") printf '%s\\n' "$VERIS_GIT_TOKEN" ;;\n  *) exit 1 ;;\nesac\n`)
        await sbx.commands.run(`chmod 700 ${shellQuote(helper)}`, { timeoutMs: 30_000 })
      }
      const args = ['git', '-c', 'credential.helper=', '-c', 'http.followRedirects=false', 'clone', '--depth', '1',
        ...(opts.ref ? ['--branch', opts.ref, '--single-branch'] : []), '--', opts.repo, workDir]
      await sbx.commands.run(args.map(shellQuote).join(' '), { envs, timeoutMs: 120_000 })
      say(`Cloned ${opts.repo} into ${workDir}`)
    } catch {
      // Provider/git exceptions may contain authentication diagnostics.
      throw new Error('Repository clone failed; check git, an empty work directory, branch/tag, credentials, and allowed download hosts')
    } finally {
      if (token) await sbx.files.remove(helper).catch(() => { say(`Could not remove askpass helper ${helper}; it contains no token`) })
    }
    return
  }
  if (!archive) throw new Error('local upload was not prepared')
  const remote = `/tmp/veris-upload-${randomUUID()}.tgz`
  try {
    await sbx.files.write(remote, archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer)
    await sbx.commands.run(`tar -xzf ${shellQuote(remote)} -C ${shellQuote(workDir)}`, { timeoutMs: 120_000 })
    say(`Uploaded ${archive.length} bytes into ${workDir}; exclusions: ${UPLOAD_EXCLUDES.join(', ')}`)
  } finally {
    await sbx.files.remove(remote).catch(() => { say(`Could not remove temporary upload ${remote}; it expires with the box`) })
  }
}
