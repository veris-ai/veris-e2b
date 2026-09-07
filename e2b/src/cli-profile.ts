// Match the Veris CLI / Daytona runner profile precedence without exporting keys
// into the parent shell or sending them to the remote workload.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { MissingCredentialsError, VerisError } from './errors'

export function credentials(env: NodeJS.ProcessEnv = process.env, path = join(homedir(), '.veris', 'twin.yaml')): { apiKey: string; apiBase: string } {
  let file: unknown
  try { file = parse(readFileSync(path, 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // YAML errors can contain the key's source line. Never print the parser error.
      throw new VerisError(`cannot read Veris profile file ${path}`, { phase: 'credentials' })
    }
  }
  const mapping = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  if (file != null && !mapping(file)) throw new VerisError(`${path} must contain a profile mapping`, { phase: 'credentials' })
  const data = (file ?? {}) as Record<string, unknown>
  const name = env.VERIS_PROFILE || (typeof data.active_profile === 'string' ? data.active_profile : 'default')
  const profiles = mapping(data.profiles) ? data.profiles : {}
  const profile = mapping(profiles[name]) ? profiles[name] : {}
  const apiKey = env.VERIS_API_KEY || (typeof profile.api_key === 'string' ? profile.api_key : undefined)
  if (!apiKey) throw new MissingCredentialsError(`no Veris API key: set VERIS_API_KEY or run veris login; profile '${name}' in ${path} has no key`, { phase: 'credentials' })
  const apiBase = (env.VERIS_API_BASE || (typeof profile.api_base === 'string' ? profile.api_base : undefined) || 'https://svc.api.veris.ai').replace(/\/+$/, '')
  return { apiKey, apiBase }
}
