#!/usr/bin/env bash
# Import past App Store sales days into a FounderData deployment (docs/MOBILE-API.md section 5).
#
#   scripts/asc-backfill.sh https://founderdata.example.com [--from 2026-01-01] [--to 2026-10-28] [--password-file PATH]
#
# Logs in with the admin password, then calls POST /api/appstore/backfill until it answers next: null.
# Each call imports up to 30 days (fewer on the free plan), so a year takes a handful of calls.
# Apple keeps daily reports for 365 days, so the default start is 365 days ago. The default end is yesterday (UTC).
# The password comes from a file (default ~/.config/founderdata/admin-password) and is never printed.
set -euo pipefail

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

base=""
from=""
to=""
password_file="$HOME/.config/founderdata/admin-password"
while [ $# -gt 0 ]; do
  case "$1" in
    --from) from="${2:?--from needs a date}"; shift 2 ;;
    --to) to="${2:?--to needs a date}"; shift 2 ;;
    --password-file) password_file="${2:?--password-file needs a path}"; shift 2 ;;
    -h|--help) usage 0 ;;
    -*) echo "Unknown option $1" >&2; usage 1 ;;
    *) base="$1"; shift ;;
  esac
done
base="${base:-${FOUNDERDATA_URL:-}}"
[ -n "$base" ] || { echo "Give the deployment URL as the first argument or set FOUNDERDATA_URL." >&2; usage 1; }
base="${base%/}"
[ -r "$password_file" ] || { echo "Cannot read the password file $password_file." >&2; exit 1; }
command -v node >/dev/null || { echo "node is required." >&2; exit 1; }

day() { node -e 'const d=new Date(Date.now()+Number(process.argv[1])*864e5);console.log(d.toISOString().slice(0,10))' -- "$1"; }
from="${from:-$(day -365)}"
to="${to:-$(day -1)}"
for d in "$from" "$to"; do
  [[ "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "Dates look like 2026-10-28, not $d." >&2; exit 1; }
done

jar="$(mktemp)"
trap 'rm -f "$jar"' EXIT

# The password goes from the file to curl through a pipe, so it never shows in the process list or the output.
login_status="$(
  node -e 'const fs=require("fs");process.stdout.write(JSON.stringify({password:fs.readFileSync(process.argv[1],"utf8").replace(/\r?\n$/,"")}))' "$password_file" |
    curl -sS -o /dev/null -w '%{http_code}' -c "$jar" -H 'content-type: application/json' --data @- "$base/api/auth/login"
)"
[ "$login_status" = "200" ] || { echo "Login failed (HTTP $login_status). Check the URL and the password file." >&2; exit 1; }

total=0
cursor="$from"
while :; do
  body="$(curl -sS -b "$jar" -w '\n%{http_code}' -H 'content-type: application/json' --data "{\"from\":\"$cursor\",\"to\":\"$to\"}" "$base/api/appstore/backfill")"
  status="${body##*$'\n'}"
  json="${body%$'\n'*}"
  summary="$(node -e '
    const r = JSON.parse(process.argv[1]);
    const n = (r.imported || []).length;
    console.log([n, r.next || "", r.error || ""].join("|"));
  ' "$json" 2>/dev/null)" || { echo "Unexpected answer (HTTP $status): $json" >&2; exit 1; }
  IFS='|' read -r n next error <<<"$summary"
  if [ "$status" != "200" ]; then
    echo "Stopped at ${next:-$cursor} (HTTP $status): ${error:-$json}" >&2
    exit 1
  fi
  total=$((total + n))
  echo "Imported $n day$([ "$n" = 1 ] || echo s)${next:+, continuing at $next}"
  [ -n "$next" ] || break
  [ "$next" != "$cursor" ] || { echo "No progress at $cursor." >&2; exit 1; }
  cursor="$next"
done
echo "Done: $total days from $from to $to."
