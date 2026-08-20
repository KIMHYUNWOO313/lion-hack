#!/bin/bash
# Enable HTTPS on EC2 (required for camera/microphone in browsers)
set -e

IP="3.34.197.18"
CERT_DIR="/etc/ssl/lion-meet"

echo "=== Setting up HTTPS for Lion Meet ==="

sudo mkdir -p "$CERT_DIR"

if [ ! -f "$CERT_DIR/lion-meet.crt" ]; then
  sudo openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout "$CERT_DIR/lion-meet.key" \
    -out "$CERT_DIR/lion-meet.crt" \
    -subj "/CN=$IP/O=LionMeet/C=KR"
  echo "Self-signed certificate created."
fi

sudo tee /etc/nginx/sites-available/lion-meet > /dev/null << NGXEOF
# HTTP -> HTTPS redirect
server {
    listen 80;
    server_name $IP;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    server_name $IP;

    ssl_certificate $CERT_DIR/lion-meet.crt;
    ssl_certificate_key $CERT_DIR/lion-meet.key;
    ssl_protocols TLSv1.2 TLSv1.3;

    client_max_body_size 10M;

    add_header Permissions-Policy "camera=*, microphone=*" always;

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
sudo nginx -t
sudo systemctl restart nginx

echo ""
echo "=== HTTPS enabled ==="
echo "Visit: https://$IP"
echo "(Self-signed cert — browser will show a warning; click Advanced -> Proceed)"
