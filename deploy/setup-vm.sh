#!/usr/bin/env bash
# Install or update the tutoring app on a Debian 12 VM. Run as root (gcp-create.sh does this).
# Re-run any time to pull the latest code and restart.
set -euo pipefail

BRANCH=${BRANCH:-main}
REPO=${REPO:-https://github.com/javongithub/tutoring-web}
APP_USER=tutor
APP_DIR=/home/$APP_USER/tutoring-web
export DEBIAN_FRONTEND=noninteractive

echo "==> Swap (e2-micro has 1 GB RAM; the build needs headroom)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Packages"
apt-get update -qq
apt-get install -y -qq curl git ca-certificates caddy >/dev/null
if ! node -v 2>/dev/null | grep -qE '^v2[2-9]'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "    node $(node -v), caddy $(caddy version | cut -d' ' -f1)"

echo "==> App user and code ($BRANCH)"
id "$APP_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$APP_USER"
if [[ -d "$APP_DIR/.git" ]]; then
  sudo -u "$APP_USER" git -C "$APP_DIR" fetch -q origin "$BRANCH"
  sudo -u "$APP_USER" git -C "$APP_DIR" checkout -q "$BRANCH"
  sudo -u "$APP_USER" git -C "$APP_DIR" reset -q --hard "origin/$BRANCH"
else
  sudo -u "$APP_USER" git clone -q -b "$BRANCH" "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
sudo -u "$APP_USER" npm ci --no-audit --no-fund --loglevel=error
sudo -u "$APP_USER" npm run build --silent

echo "==> Address"
IP=$(curl -fsS -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip 2>/dev/null \
  || curl -fsS https://api.ipify.org)
# sslip.io turns 34.1.2.3 into a real hostname (34-1-2-3.sslip.io) so HTTPS works with no domain purchase.
DOMAIN=${DOMAIN:-${IP//./-}.sslip.io}
echo "    https://$DOMAIN"

NEW_PASSWORD=""
if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "==> Creating .env with fresh secrets"
  NEW_PASSWORD=$(head -c 12 /dev/urandom | base64 | tr -d '/+=' | cut -c1-16)
  cat > "$APP_DIR/.env" <<ENV
NODE_ENV=production
PORT=3001
ADMIN_PASSWORD=$NEW_PASSWORD
SESSION_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
DB_PATH=data/tutoring.db
TZ_NAME=America/Los_Angeles
TRUST_PROXY=loopback
PUBLIC_URL=https://$DOMAIN
# Email (optional): Gmail + app password — see README
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=
SMTP_PASS=
# Google Calendar push (optional): path to the service account JSON key
GOOGLE_SERVICE_ACCOUNT_JSON=
ENV
  chown "$APP_USER:" "$APP_DIR/.env" && chmod 600 "$APP_DIR/.env"
else
  sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=https://$DOMAIN|" "$APP_DIR/.env"
fi

echo "==> Service"
cp deploy/tutoring.service /etc/systemd/system/tutoring.service
systemctl daemon-reload
systemctl enable -q tutoring
systemctl restart tutoring

echo "==> HTTPS (Caddy)"
printf '%s {\n\treverse_proxy localhost:3001\n}\n' "$DOMAIN" > /etc/caddy/Caddyfile
systemctl enable -q caddy
systemctl reload caddy || systemctl restart caddy

echo "==> Nightly database backup (keeps 14 days in $APP_DIR/data/backups)"
echo "15 3 * * * $APP_USER cd $APP_DIR && /usr/bin/node --disable-warning=ExperimentalWarning server/backup.js >/dev/null 2>&1" > /etc/cron.d/tutoring-backup

sleep 3
if curl -fsS localhost:3001/api/public/info >/dev/null; then STATUS="running ✓"; else STATUS="NOT responding — check: sudo journalctl -u tutoring -n 50"; fi

cat <<DONE

============================================================
 Tutoring app: $STATUS
 Public booking page:  https://$DOMAIN
 Your admin:           https://$DOMAIN/admin
DONE
if [[ -n "$NEW_PASSWORD" ]]; then
  echo " Admin password:      $NEW_PASSWORD   <-- save this now (it's also in $APP_DIR/.env)"
fi
cat <<DONE
 (HTTPS can take a minute to activate the first time.)

 Next steps:
  • Admin → Settings → Notifications: phone alerts via the ntfy app
  • Admin → Settings → Google Calendar: paste your secret iCal address, import students
  • Email: sudo nano $APP_DIR/.env  (SMTP_USER / SMTP_PASS), then: sudo systemctl restart tutoring
  • Update later: re-run the same command in Cloud Shell
============================================================
DONE
