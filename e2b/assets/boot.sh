#!/bin/bash
# veris-e2b supervisor. Runs ONCE as the E2B template's start command:
# does the privileged setup (kernel redirect, CA trust), then parks in a wait
# loop. The template snapshot is taken mid-wait, so every sandbox cloned from
# the template resumes this process already running, rules already live in
# the kernel — and no run ever needs root.
#
# A clone wakes it two ways:
#   - zero-touch: /etc/veris/baked.env holds the coordinates (written at
#     build by withVeris({ apiKey, environmentId })); the supervisor detects
#     the clone by the wall-clock jump a snapshot resume produces.
#   - handshake: a run writes /veris/run.env (wakeVeris() does this); its
#     values override baked ones.
#
# Public-template mode: baked MINT_CA_AT=boot defers CA minting from build to
# first wake, so a published template carries no shared CA private key.
set -eu
if [ "$(id -u)" != "0" ]; then exec sudo -n bash "$0" "$@"; fi
exec >>/veris/boot.log 2>&1

echo "boot: $(date -u +%FT%TZ) uid=$(id -u)"
[ -f /etc/veris/baked.env ] && MINT_CA_AT="$(. /etc/veris/baked.env; echo "${MINT_CA_AT:-build}")" || MINT_CA_AT=build

mint_ca() {
  # The mint is a throwaway serve whose only job is to write the CA, so it is
  # driven by --config. The coordinates reach this script as process env
  # (the default transport), and veris-proxy reads VERIS_ENVIRONMENT_ID as
  # --environment: seeing both, it refuses ("Pick one") and no CA is written.
  # Strip them for this subprocess only -- the real serve below still gets them.
  su veris -s /bin/bash -c \
    'env -u VERIS_ENVIRONMENT_ID -u VERIS_API_KEY -u VERIS_API_BASE \
       /usr/local/bin/veris-proxy serve --config /etc/veris/dummy.json \
       --ca-dir /veris/ca --ready-file /tmp/ca-ready >/dev/null 2>&1 &
     for i in $(seq 1 100); do [ -f /tmp/ca-ready ] && break; sleep 0.2; done
     kill %1 2>/dev/null; wait 2>/dev/null; true'
  [ -f /veris/ca/veris-ca.pem ] || { echo "boot: CA mint FAILED"; exit 1; }
  cp /veris/ca/veris-ca.pem /usr/local/share/ca-certificates/veris-ca.crt
  update-ca-certificates >/dev/null
  KEYTOOL="$(command -v keytool || ls /opt/*/bin/keytool 2>/dev/null | head -1 || true)"
  if [ -n "$KEYTOOL" ]; then
    "$KEYTOOL" -importcert -noprompt -cacerts -storepass changeit \
      -alias veris -file /veris/ca/veris-ca.pem >/dev/null
  fi
  chmod -R a+rX /veris/ca
  echo "boot: CA minted and trusted"
}

# --- one-time, captured by the snapshot -------------------------------------
if ! nft list table ip veris >/dev/null 2>&1; then
  nft -f /etc/veris/redirect.nft
  echo "boot: redirect installed"
fi
if [ "$MINT_CA_AT" != "boot" ] && [ ! -f /veris/ca/veris-ca.pem ]; then
  mint_ca
fi

touch /veris/template-ready

# Env transport: when this script is spawned as a fresh root command WITH the
# coordinates already in its process environment (startVeris/setupVeris do
# this via the SDK's per-command envs), skip the park entirely — no file ever
# carries the secret. The build-time invocation never takes this path: its
# sudo re-exec strips the environment.
if [ -n "${VERIS_API_KEY:-}" ] && [ -n "${VERIS_ENVIRONMENT_ID:-}" ]; then
  if pgrep -x veris-proxy >/dev/null 2>&1; then
    echo "boot: proxy already running; env-start is a no-op"; exit 0
  fi
  touch /veris/external-start   # tell any parked supervisor to stand down
  echo "boot: coordinates in process env — starting immediately (no run.env)"
else
# Zero-touch (self-start on clone resume) is only safe when the baked
# coordinates are COMPLETE — otherwise the clock-jump wake races the runtime
# run.env write and the proxy starts half-configured. Split mode parks until
# run.env arrives.
ZERO_TOUCH=no
if [ -f /etc/veris/baked.env ]; then
  ( . /etc/veris/baked.env
    [ -n "${VERIS_API_KEY:-}" ] && [ -n "${VERIS_ENVIRONMENT_ID:-}" ] ) && ZERO_TOUCH=yes
fi
echo "boot: parked (zero_touch=$ZERO_TOUCH; wake: clock-jump if fully baked, else /veris/run.env)"

# --- park; wake on snapshot-resume (clock jump, fully-baked only) or run.env --
prev=$(date +%s)
while :; do
  sleep 0.25
  now=$(date +%s)
  if [ -f /veris/external-start ]; then echo "boot: an env-transport start took over; parking supervisor exits"; exit 0; fi
  if [ "$ZERO_TOUCH" = "yes" ] && [ $((now - prev)) -gt 5 ]; then echo "boot: clock jumped $((now - prev))s -> resumed in a clone"; break; fi
  if [ -f /veris/run.env ]; then echo "boot: woken by run.env"; break; fi
  prev=$now
done
fi

# Public-template mode: each clone mints its own CA on first wake.
[ -f /veris/ca/veris-ca.pem ] || mint_ca

# Precedence, most explicit first: process env (env-transport start) beats
# run.env beats baked.env. Capture explicit values before sourcing files.
ENV_KEY="${VERIS_API_KEY:-}"; ENV_EID="${VERIS_ENVIRONMENT_ID:-}"; ENV_BASE="${VERIS_API_BASE:-}"
set -a
[ -f /etc/veris/baked.env ] && . /etc/veris/baked.env
[ -f /veris/run.env ] && . /veris/run.env
set +a
[ -n "$ENV_KEY" ] && export VERIS_API_KEY="$ENV_KEY"
[ -n "$ENV_EID" ] && export VERIS_ENVIRONMENT_ID="$ENV_EID"
[ -n "$ENV_BASE" ] && export VERIS_API_BASE="$ENV_BASE"
true
: "${VERIS_API_KEY:?boot: no VERIS_API_KEY (bake via withVeris opts, or wakeVeris())}"
: "${VERIS_ENVIRONMENT_ID:?boot: no VERIS_ENVIRONMENT_ID (bake via withVeris opts, or wakeVeris())}"
echo "boot: starting proxy as veris for env ${VERIS_ENVIRONMENT_ID}"

PROXY_PATH="/usr/local/bin:/usr/bin:/bin"
for d in /opt/*/bin; do [ -d "$d" ] && PROXY_PATH="$d:$PROXY_PATH"; done

exec setpriv --reuid=veris --regid=veris --init-groups \
  env HOME=/home/veris PATH="$PROXY_PATH" \
      VERIS_API_KEY="${VERIS_API_KEY}" VERIS_API_BASE="${VERIS_API_BASE:-}" \
  /usr/local/bin/veris-proxy serve --transparent --redirect-external \
    --environment "${VERIS_ENVIRONMENT_ID}" --ttl-minutes "${VERIS_TTL_MINUTES:-30}" \
    --ca-dir /veris/ca --write-env /veris/trust.env --env-trust-only \
    --ready-file /veris/ready --log-level info >>/veris/serve.log 2>&1
