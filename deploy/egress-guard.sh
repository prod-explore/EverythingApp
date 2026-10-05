#!/usr/bin/env bash
#
# EverythingApp — network-layer egress guard (the backstop behind playwright-mcp/src/urlSafety.ts).
#
# Internet-facing containers (the browser agent today, code sandboxes in N3) may reach the PUBLIC
# internet freely but must not reach the operator's own networks: LAN (router, NAS, Skarpa, n8n),
# the Docker host and its other bridges, link-local / cloud-metadata addresses. This installs the
# standard Docker-recommended pattern: a dedicated chain hooked into DOCKER-USER (forwarded
# traffic) plus an INPUT rule (traffic aimed at the host itself).
#
#   sudo deploy/egress-guard.sh apply      install / refresh rules (idempotent)
#   sudo deploy/egress-guard.sh remove     remove rules and the chain
#   sudo deploy/egress-guard.sh status     show the rules
#   DRY_RUN=1 deploy/egress-guard.sh apply print the commands instead of running them
#
# Environment:
#   EGRESS_BRIDGES  space-separated bridge names to guard   (default: "br-ea-browser br-ea-sandbox")
#                   br-ea-browser = browser-egress network in docker-compose.yml
#                   br-ea-sandbox = the code-sandbox network the supervisor creates (N3)
#   EGRESS_ALLOW    space-separated "IP" or "IP:PORT" exceptions reachable from the guarded bridges,
#                   e.g. the quarantine model on your PC:  EGRESS_ALLOW="192.168.1.50:11434"
#
# Notes:
#  - Replies to connections opened FROM outside (host -> published port) are allowed: only NEW
#    connections towards private ranges are dropped.
#  - Traffic inside one bridge (web server <-> playwright-mcp) is untouched here; the browser's
#    requests to such addresses are blocked by the application guard instead.
#  - IPv4 only. Docker does not enable IPv6 on these bridges by default; if you enabled it, mirror
#    these rules with ip6tables.
#  - Persist across reboots with deploy/ea-egress-guard.service (systemd).
set -euo pipefail

CHAIN="EA-EGRESS"
BRIDGES=(${EGRESS_BRIDGES:-br-ea-browser br-ea-sandbox})
ALLOW=(${EGRESS_ALLOW:-})
PRIVATE=(0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4)

run() {
  if [[ "${DRY_RUN:-0}" == "1" ]]; then echo "+ $*"; else "$@"; fi
}
ipt() { run iptables "$@"; }
exists() { [[ "${DRY_RUN:-0}" == "1" ]] && return 1; iptables "$@" 2>/dev/null; }

remove() {
  for br in "${BRIDGES[@]}"; do
    while exists -C INPUT -i "$br" -m conntrack --ctstate NEW -j DROP; do ipt -D INPUT -i "$br" -m conntrack --ctstate NEW -j DROP; done
  done
  while exists -C DOCKER-USER -j "$CHAIN"; do ipt -D DOCKER-USER -j "$CHAIN"; done
  if exists -L "$CHAIN" -n; then ipt -F "$CHAIN"; ipt -X "$CHAIN"; fi
}

apply() {
  # DOCKER-USER exists once Docker has started; create it defensively so the unit can run early.
  exists -L DOCKER-USER -n || { ipt -N DOCKER-USER; ipt -A DOCKER-USER -j RETURN; }
  remove
  ipt -N "$CHAIN"
  # 1. replies / related traffic of connections that were allowed
  ipt -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  for br in "${BRIDGES[@]}"; do
    # 2. bridge-local traffic is not ours to judge here
    ipt -A "$CHAIN" -i "$br" -o "$br" -j RETURN
    # 3. explicit operator exceptions (e.g. the quarantine model on the PC)
    for entry in "${ALLOW[@]}"; do
      ip="${entry%%:*}"; port=""
      [[ "$entry" == *:* ]] && port="${entry##*:}"
      if [[ -n "$port" ]]; then
        ipt -A "$CHAIN" -i "$br" -d "$ip" -p tcp --dport "$port" -j RETURN
      else
        ipt -A "$CHAIN" -i "$br" -d "$ip" -j RETURN
      fi
    done
    # 4. no NEW connections from the bridge to private/reserved ranges
    for cidr in "${PRIVATE[@]}"; do
      ipt -A "$CHAIN" -i "$br" -d "$cidr" -m conntrack --ctstate NEW -j DROP
    done
    # 5. nor to the host itself (its LAN IP, docker gateway, services bound on 0.0.0.0)
    ipt -I INPUT 1 -i "$br" -m conntrack --ctstate NEW -j DROP
  done
  # Everything else (public internet) falls through to Docker's own rules.
  ipt -A "$CHAIN" -j RETURN
  ipt -I DOCKER-USER 1 -j "$CHAIN"
}

case "${1:-}" in
  apply)  apply ;;
  remove) remove ;;
  status) iptables -S "$CHAIN"; iptables -S INPUT | grep -E "$(IFS='|'; echo "${BRIDGES[*]}")" || true ;;
  *) echo "usage: $0 apply|remove|status" >&2; exit 2 ;;
esac
