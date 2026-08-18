// Build the medusa-fixer template: Medusa monorepo at the study's base commit,
// deps installed, Postgres captured running, Veris layer in split mode.
import { Template } from 'e2b'
import { withVeris } from '../src/index.mjs'

const BASE = 'b0520082670752ec09b34ea9fac2a1b9422b8cdd'
const t0 = Date.now()
const mark = (l) => console.log(`[t+${((Date.now() - t0) / 1000).toFixed(0)}s] ${l}`)

const box = withVeris(
  Template()
    .fromBaseImage()
    .runCmd('apt-get update -qq && apt-get install -y -qq postgresql postgresql-contrib ripgrep jq', { user: 'root' })
    // Debian's postgresql-common creates the cluster with `ssl = on` against the
    // ssl-cert package's snakeoil certificate. In an E2B build that certificate
    // is not there when the cluster first starts (measured 2026-08-17/18 on this
    // template: /var/log/postgresql/postgresql-15-main.log shows `FATAL: could
    // not load server certificate file "/etc/ssl/certs/ssl-cert-snakeoil.pem":
    // No such file or directory` at build time, and every clone boots with
    // Postgres down). Nothing here needs TLS on loopback; turn it off before
    // the first start.
    .runCmd('pg_conftool 15 main set ssl off', { user: 'root' })
    .runCmd('sudo corepack enable && corepack prepare yarn@3.2.1 --activate')
    .runCmd(`git clone --filter=blob:none https://github.com/medusajs/medusa.git /home/user/medusa && cd /home/user/medusa && git checkout ${BASE}`)
    .runCmd('cd /home/user/medusa && yarn install --inline-builds 2>&1 | tail -5'),
  {
    environmentId: 'eguk42zv4iv1fetl75nboxyt9',   // medusa-dev: stripe + postgres
    apiBase: process.env.VERIS_API_BASE,           // dev control plane — the default doesn't resolve
    // Start Postgres and WAIT for it before handing over to the veris
    // supervisor: withVeris chains `startCmd && boot.sh`, so a start command
    // that swallows failure (`; true`) lets the template snapshot with the
    // database down and every clone inherits that. If pg_isready never
    // answers, the build fails loudly ("Template is not ready") instead.
    startCmd: 'sudo service postgresql start && for i in $(seq 1 30); do pg_isready -q && break; sleep 1; done && pg_isready -q && { sudo -u postgres createuser -s user 2>/dev/null; sudo -u postgres createdb -O user medusa_test 2>/dev/null; true; }',
  },
)

mark('building…')
await Template.build(box, { alias: 'medusa-fixer', cpuCount: 4, memoryMB: 8192 })
mark('template medusa-fixer built')
