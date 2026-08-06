#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/xundao}"
DOMAIN="${DOMAIN:-example.com}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-}"

if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "Missing $APP_DIR/.env. Copy .env.example to .env and set POSTGRES_PASSWORD first." >&2
  exit 1
fi

env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$APP_DIR/.env" | tail -n 1 | tr -d '\r'
}

if [[ -z "$LETSENCRYPT_EMAIL" ]]; then
  LETSENCRYPT_EMAIL="$(env_value LETSENCRYPT_EMAIL)"
fi
COOKIE_SECURE_VALUE="$(env_value COOKIE_SECURE)"

if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "Invalid DOMAIN. Use a hostname such as xundao.example.com." >&2
  exit 1
fi

TLS_ENABLED=false
if [[ "$DOMAIN" != "example.com" && "$DOMAIN" != "_" && -n "$LETSENCRYPT_EMAIL" ]]; then
  TLS_ENABLED=true
fi

if [[ "$TLS_ENABLED" != "true" && "$COOKIE_SECURE_VALUE" != "false" ]]; then
  echo "COOKIE_SECURE=true requires HTTPS. Set DOMAIN and LETSENCRYPT_EMAIL, or use COOKIE_SECURE=false only for temporary IP/HTTP testing." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin is required. Install docker-compose-plugin and rerun." >&2
  exit 1
fi

if ! command -v nginx >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y nginx
  elif command -v yum >/dev/null 2>&1; then
    yum install -y nginx
  else
    echo "Install nginx manually, then rerun." >&2
    exit 1
  fi
fi

install -m 0644 "$APP_DIR/deploy/systemd/xundao.service" /etc/systemd/system/xundao.service
sed "s/server_name example.com;/server_name ${DOMAIN};/" "$APP_DIR/deploy/nginx/xundao.conf" > /etc/nginx/conf.d/xundao.conf

systemctl daemon-reload
systemctl enable --now xundao
nginx -t
systemctl enable --now nginx
systemctl reload nginx

if [[ "$TLS_ENABLED" == "true" ]]; then
  if ! command -v certbot >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      apt-get update
      apt-get install -y certbot python3-certbot-nginx
    elif command -v yum >/dev/null 2>&1; then
      yum install -y certbot python3-certbot-nginx
    else
      echo "Install Certbot and its Nginx plugin manually, then rerun." >&2
      exit 1
    fi
  fi
  certbot --nginx --non-interactive --agree-tos --redirect \
    --email "$LETSENCRYPT_EMAIL" \
    -d "$DOMAIN"
  echo "Xundao started at https://$DOMAIN"
else
  echo "Xundao started in temporary HTTP mode. Do not use this mode for production accounts."
fi

echo "Check: docker compose -f $APP_DIR/docker-compose.yml ps"
