// @veris-ai/e2b — Veris dependency-sandbox interception for E2B.
//
// The headline surface is the Sandbox class: a drop-in subclass of e2b's
// Sandbox whose vendor API calls are answered by a per-run Veris twin.
//
//   import { Sandbox } from '@veris-ai/e2b'
//   const sbx = await Sandbox.create()
//   await sbx.commands.run('npm test')     // api.stripe.com → your Veris twin
//   await sbx.veris.assertTouched('stripe')
//   await sbx.kill()
//
// Everything from `e2b` is re-exported so apps depend only on this package.
export * from 'e2b'

export { Sandbox, default } from './sandbox'
export type { SandboxOpts, SandboxConnectOpts, VerisOpts, VerisMode } from './sandbox'
export type { VerisApi, TouchMatcher } from './veris-api'
export type { Receipt, ReceiptEntry, ReceiptRequest, ReceiptLeak } from './receipt'
export type { EgressMode } from './network'
export type { ServiceInfo as VerisServiceInfo, RouteEntry, EgressCredential } from './control-plane'
export {
  VerisError,
  MissingCredentialsError,
  VerisGatewayUnreachableError,
  VerisGatewayNotOfferedError,
  ReceiptIntegrityError,
  VerisUntouchedError,
  TwinExpiredError,
  TemplateUnsupportedError,
} from './errors'
export type { VerisErrorPhase } from './errors'
export { SDK_VERSION } from './version'

// ---- Deprecated v1 free-function surface (proxy mode) --------------------
// Kept working for v1 callers; each JSDoc names its class equivalent. These
// operate on plain e2b Sandbox instances, as they always did.
export {
  withVeris,
  setupVeris,
  startVeris,
  wakeVeris,
  verisReady,
  verisTrustEnv,
  verisSandboxId,
  verisReceipt,
  verisDataPlaneEnv,
  verisTeardown,
  resolveBinary,
} from './legacy/functions'
export type {
  WithVerisOpts,
  SetupVerisOpts,
  StartVerisOpts,
  VerisReceiptOpts,
  LegacyReceiptEntry,
} from './legacy/functions'
