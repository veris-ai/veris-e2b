import { CA_CERT_PATH } from './trust'

export const BUNDLED_CA_PATCH_SCRIPT = '/tmp/veris-patch-bundled-cas.sh'
export const BUNDLED_CA_SUFFIXES = [
  'pip/_vendor/certifi/cacert.pem', 'certifi/cacert.pem', 'botocore/cacert.pem',
  'stripe/data/ca-certificates.crt', 'httplib2/cacerts.txt',
] as const

// Same suffix-based policy as the Daytona runner: never patch an arbitrary
// cacert.pem fixture or client certificate. Rerun after installing dependencies.
export function bundledCaPatchScript(): string {
  const find = BUNDLED_CA_SUFFIXES.map(suffix =>
    `find / -xdev \\( -path /proc -o -path /sys -o -path /dev \\) -prune -o -path '*/${suffix}' -type f -print 2>/dev/null`).join('; ')
  return [
    `marker=$(sed -n 2p ${CA_CERT_PATH} 2>/dev/null)`,
    `[ -n "$marker" ] || { echo 'Veris CA is missing' >&2; exit 1; }`,
    `{ ${find}; } | sort -u | { n=0; skipped=0`,
    'while IFS= read -r f; do',
    '  grep -qF "$marker" "$f" && continue',
    '  if [ ! -w "$f" ]; then echo "Cannot patch $f: not writable" >&2; skipped=1; continue; fi',
    `  { printf '\\n'; cat ${CA_CERT_PATH}; } >> "$f" || { skipped=1; continue; }`,
    '  n=$((n+1)); echo "the Veris CA was appended to $f"',
    'done',
    'echo "$n bundled CA file(s) patched"',
    'exit "$skipped"; }',
  ].join('\n') + '\n'
}
