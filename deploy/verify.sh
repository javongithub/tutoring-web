#!/usr/bin/env bash
# Check a deployed site from the outside:  bash deploy/verify.sh https://34-1-2-3.sslip.io
set -uo pipefail
URL=${1:?usage: verify.sh https://your-site}
URL=${URL%/}
fails=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fails=$((fails+1)); }
check() { if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }

echo "Checking $URL"
headers=$(curl -sS -D - -o /dev/null --max-time 15 "$URL/" 2>/dev/null || true)
check "HTTPS responds with a valid certificate" "curl -fsS --max-time 15 -o /dev/null '$URL/'"
check "Booking page (HTML) is served" "curl -fsS --max-time 15 '$URL/' | grep -q '<div id=\"root\">'"
check "API is up (/api/public/info)" "curl -fsS --max-time 15 '$URL/api/public/info' | grep -q tutor_name"
check "Admin page loads" "curl -fsS --max-time 15 -o /dev/null '$URL/admin'"
check "Admin API is locked (401 without login)" "[ \"\$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 '$URL/api/admin/dashboard')\" = 401 ]"
check "Content-Security-Policy header" "grep -qi '^content-security-policy:' <<< \"\$headers\""
check "HSTS header (HTTPS enforced)" "grep -qi '^strict-transport-security:' <<< \"\$headers\""
check "Referrer-Policy: no-referrer (protects family links)" "grep -qi '^referrer-policy: no-referrer' <<< \"\$headers\""
if [[ $URL == https://* ]]; then
  http=${URL/https:/http:}
  check "Plain HTTP redirects to HTTPS" "curl -s -o /dev/null -w '%{redirect_url}' --max-time 15 '$http/' | grep -q '^https://'"
fi

if (( fails )); then echo "$fails check(s) failed."; exit 1; fi
echo "All good: the site is live."
