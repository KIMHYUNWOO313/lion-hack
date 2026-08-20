#!/bin/bash
# Get a trusted HTTPS certificate via sslip.io + Let's Encrypt (no domain purchase needed)
set -e

IP="3.34.197.18"
# sslip.io: dashes instead of dots → resolves to the IP
HOST="${IP//./-}.sslip.io"

echo "=== Trusted HTTPS setup ==="
echo "Hostname: $HOST → $IP"

sudo apt-get update -qq
sudo apt-get install -y certbot python3-certbot-nginx

# Temporary HTTP-only config for ACME challenge
sudo tee /etc/nginx/sites-available/lion-meet > /dev/null << NGXEOF
server {
    listen 80;
    server_name $HOST $IP;

    client_max_body_size 10M;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location /static/ {
        alias /opt/lion_meet/staticfiles/;
    }

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
    }
}
NGXEOF

sudo ln -sf /etc/nginx/sites-available/lion-meet /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# Obtain certificate (non-interactive)
sudo certbot --nginx \
  -d "$HOST" \
  --non-interactive \
  --agree-tos \
  --register-unsafely-without-email \
  --redirect

# Permissions-Policy for camera/mic
sudo sed -i '/ssl_certificate/a \    add_header Permissions-Policy "camera=*, microphone=*" always;' /etc/nginx/sites-available/lion-meet 2>/dev/null || true

# Update .env ALLOWED_HOSTS
ENV_FILE="/opt/lion_meet/.env"
if [ -f "$ENV_FILE" ]; then
  if grep -q "^ALLOWED_HOSTS=" "$ENV_FILE"; then
    sudo sed -i "s|^ALLOWED_HOSTS=.*|ALLOWED_HOSTS=$IP,$HOST,localhost,127.0.0.1|" "$ENV_FILE"
  else
    echo "ALLOWED_HOSTS=$IP,$HOST,localhost,127.0.0.1" | sudo tee -a "$ENV_FILE"
  fi
fi

sudo nginx -t && sudo systemctl reload nginx
sudo systemctl restart lion-meet

echo ""
echo "=========================================="
echo "  Trusted HTTPS ready!"
echo "  https://$HOST"
echo "=========================================="
echo ""
echo "Security group: open ports 80 and 443"
