// The Veris API key on a twin service's control_url, and nowhere else.
//
// Split sandboxes serve /veris/* on /c/<sandbox>/<svc> and require the same
// X-API-Key the SDK sends to /v1. The data-plane `url` (/s/…, same host) and the
// vendor hostnames it answers for are unauthenticated and reachable from the
// code under test — the thing being tested, not a party to trust with the org's
// key — so the key is attached only to a URL on the control URL's own origin
// AND under its path, and every control request refuses redirects, so a 3xx
// cannot walk the key anywhere else. And only when the service advertises
// control_auth: 'api_key': on an older or pinned sandbox (control_auth null or
// absent, or an API that predates the field) control_url IS the /s/ data URL —
// the twin itself — and the key must not go there, so none is sent.
import type { ServiceInfo } from './control-plane'
import { VerisControlAuthError } from './errors'

export const API_KEY_HEADER = 'X-API-Key'
const CONTROL_TIMEOUT_MS = 30_000

function parse(url: string | URL): URL | null {
  try {
    const u = new URL(String(url))
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null
  } catch { return null }
}

/** True only for a URL on the control URL's origin and under its path. */
export function isControlRequest(url: string | URL, controlUrl: string): boolean {
  const target = parse(url)
  const base = parse(controlUrl)
  if (!target || !base || target.origin !== base.origin) return false
  return target.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/')
}

/** Whether this service's control_url is the keyed kind. */
export function usesApiKey(svc: ServiceInfo): boolean {
  return svc.control_auth === 'api_key'
}

export function controlHeaders(svc: ServiceInfo, url: string | URL, apiKey: string | undefined,
  extra: Record<string, string> = {}): Record<string, string> {
  const headers = { ...extra }
  if (apiKey && usesApiKey(svc) && isControlRequest(url, svc.control_url)) headers[API_KEY_HEADER] = apiKey
  return headers
}

/** Turn a control-plane 401 into an error that names the credential. */
export function throwForControlAuth(svc: ServiceInfo, status: number, what: string, apiKey: string | undefined): void {
  if (status !== 401) return
  const sent = !usesApiKey(svc)
    ? "was not sent (the service does not advertise control_auth: 'api_key')"
    : apiKey ? 'was rejected' : 'was not sent (no API key available)'
  throw new VerisControlAuthError(
    `service '${svc.name}' control plane refused ${what} (401): the Veris API key ${sent} — ` +
    'check VERIS_API_KEY / veris.apiKey, and that the key belongs to the org that owns this sandbox',
    svc.name, { phase: 'receipt' })
}

export interface ControlFetchInit {
  method?: string
  query?: URLSearchParams | Record<string, string>
  headers?: Record<string, string>
  body?: string
}

/** One request to `${control_url}${path}`: key scoped, redirects refused, 401 named. */
export async function controlFetch(svc: ServiceInfo, path: string, init: ControlFetchInit,
  apiKey: string | undefined): Promise<Response> {
  const url = new URL(`${svc.control_url.replace(/\/$/, '')}${path}`)
  for (const [key, value] of new URLSearchParams(init.query ?? {})) url.searchParams.set(key, value)
  const method = init.method ?? 'GET'
  const res = await fetch(url, {
    method, body: init.body, redirect: 'error', signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    headers: controlHeaders(svc, url, apiKey, init.headers),
  })
  throwForControlAuth(svc, res.status, `${method} ${path.split('?')[0]}`, apiKey)
  return res
}
