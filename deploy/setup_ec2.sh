#!/bin/bash
# AWS EC2 Ubuntu deployment script for Lion Meet
# Usage: bash deploy/setup_ec2.sh

set -e

APP_DIR="/opt/lion_meet"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== Lion Meet EC2 Setup ==="

# System packages
sudo apt-get update
sudo apt-get install -y python3 python3-pip python3-venv nginx

# App directory
sudo mkdir -p "$APP_DIR"
sudo cp -r "$REPO_DIR"/* "$APP_DIR/"
# dotfiles (e.g. .env) are not matched by glob *
if [ -f "$REPO_DIR/.env" ]; then
  sudo cp "$REPO_DIR/.env" "$APP_DIR/.env"
fi
sudo chown -R "$USER:$USER" "$APP_DIR"

cd "$APP_DIR"

# Virtual environment
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

# Environment
if [ ! -f .env ]; then
  cat > .env << 'ENVEOF'
GPT_API_KEY=your-openai-api-key-here
DJANGO_SECRET_KEY=change-this-to-a-random-secret-key
DEBUG=False
ALLOWED_HOSTS=3.34.197.18,localhost,127.0.0.1
ENVEOF
  echo "Created .env - please edit GPT_API_KEY and DJANGO_SECRET_KEY"
fi

# Django setup
python manage.py migrate
python manage.py collectstatic --noinput

# Systemd service
sudo tee /etc/systemd/system/lion-meet.service > /dev/null << 'SVCEOF'
[Unit]
Description=Lion Meet Django ASGI (Daphne)
After=network.target

[Service]
User=ubuntu
Group=ubuntu
WorkingDirectory=/opt/lion_meet
Environment="PATH=/opt/lion_meet/venv/bin"
ExecStart=/opt/lion_meet/venv/bin/daphne -b 0.0.0.0 -p 8000 config.asgi:application
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
SVCEOF

# Nginx config (HTTPS via Let's Encrypt sslip.io — do not downgrade to HTTP-only)
NGINX_CONF="$REPO_DIR/deploy/nginx-lion-meet.conf"
if [ -f "$NGINX_CONF" ]; then
  sudo cp "$NGINX_CONF" /etc/nginx/sites-available/lion-meet
elif [ -f /etc/letsencrypt/live/3-34-197-18.sslip.io/fullchain.pem ]; then
  echo "Keeping existing nginx HTTPS config (cert present, nginx-lion-meet.conf missing)"
else
  sudo tee /etc/nginx/sites-available/lion-meet > /dev/null << 'NGXEOF'
server {
    listen 80;
    server_name 3.34.197.18;

    client_max_body_size 10M;

    location /static/ {
        alias /opt/lion_meet/staticfiles/;
    }

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
NGXEOF
fi

sudo ln -sf /etc/nginx/sites-available/lion-meet /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable lion-meet
sudo systemctl restart lion-meet
sudo systemctl restart nginx

echo ""
echo "=== Deployment complete ==="
echo "Visit: https://3-34-197-18.sslip.io"
echo "Edit /opt/lion_meet/.env to set GPT_API_KEY"
echo "Logs: sudo journalctl -u lion-meet -f"
