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
    .runCmd('sudo corepack enable && corepack prepare yarn@3.2.1 --activate')
    .runCmd(`git clone --filter=blob:none https://github.com/medusajs/medusa.git /home/user/medusa && cd /home/user/medusa && git checkout ${BASE}`)
    .runCmd('cd /home/user/medusa && yarn install --inline-builds 2>&1 | tail -5'),
  {
    environmentId: 'eguk42zv4iv1fetl75nboxyt9',   // medusa-dev: stripe + postgres
    apiBase: process.env.VERIS_API_BASE,           // dev control plane — the default doesn't resolve
    startCmd: 'sudo service postgresql start && sudo -u postgres createuser -s user 2>/dev/null; sudo -u postgres createdb -O user medusa_test 2>/dev/null; true',
  },
)

mark('building…')
await Template.build(box, { alias: 'medusa-fixer', cpuCount: 4, memoryMB: 8192 })
mark('template medusa-fixer built')
