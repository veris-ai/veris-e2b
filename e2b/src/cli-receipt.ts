import type { Receipt } from './receipt'

export function reportReceipt(receipt: Receipt, twinId: string, commandExit: number, required: string[]): number {
  const problems: string[] = []
  const entries = Object.entries(receipt.services)
  const total = entries.reduce((n, [, entry]) => n + (entry?.requests ?? 0), 0)
  const capped = entries.some(([, entry]) => entry?.capped)
  const lines = [`Veris receipt — twin ${twinId}`, `  interception: ${receipt.mode}; integrity: ${receipt.integrity}`,
    `  ${capped ? 'at least ' : ''}${total} new application request(s) reached the twin:`]
  for (const [name, entry] of entries) {
    lines.push(`  ${name}: ${entry?.capped ? 'at least ' : ''}${entry?.requests ?? 0}`)
    for (const row of entry?.entries.slice(0, 20) ?? []) lines.push(`    #${row.id} ${row.tier} ${row.method} ${row.path} -> ${row.status ?? 'no response'}`)
    if ((entry?.entries.length ?? 0) > 20) lines.push('    … remaining entries omitted from display')
  }
  if (receipt.mode !== 'gateway' || receipt.integrity !== 'verified' || receipt.leaks.length) problems.push('gateway integrity was not verified without blind spots')
  if (required.length) {
    for (const name of required) if (!(receipt.services[name]?.requests)) problems.push(`'${name}' received ZERO application requests in this flow`)
  } else if (!total) problems.push('the twin received ZERO application requests in this flow')
  if (capped) lines.push('  Trace read hit its page budget; counts are lower bounds. Read the remaining trace for a complete audit.')
  process.stdout.write(lines.join('\n') + '\n')
  for (const problem of problems) process.stderr.write(`Receipt failed: ${problem}\n`)
  return commandExit || (problems.length ? 1 : 0)
}
