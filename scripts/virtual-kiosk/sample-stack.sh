#!/usr/bin/env bash
# Samples the virtual kiosk stack every 10 seconds while the CI scenarios run (.github/workflows/ci.yml reads it only
# when they fail): load, whether each local server answers and how fast, which loopback ports listen, and the heaviest
# stack processes. A stalled Worker, kiosk service or screen proxy then shows in the samples.
# Usage: bash scripts/virtual-kiosk/sample-stack.sh [port base, default 43300]
base="${1:-43300}"
while true; do
  echo "== $(date -u +%H:%M:%S) load $(cut -d' ' -f1-3 /proc/loadavg)"
  for url in "http://127.0.0.1:${base}/api/status" "http://localhost:$((base + 2))/setup/status" "http://127.0.0.1:$((base + 10))/health" "http://127.0.0.1:$((base + 20))/health"; do
    echo "$url $(curl -s -o /dev/null -m 3 -w '%{http_code} %{time_total}s' "$url")"
  done
  ss -ltnH "( sport >= :${base} and sport <= :$((base + 99)) )" | awk '{print "listen", $4}'
  ps -eo pid,etimes,pcpu,rss,args --sort=-pcpu | grep -E 'workerd|wrangler|virtual-kiosk|kiosk-process|chrom' | grep -v grep | head -n 8 | cut -c1-160
  sleep 10
done
