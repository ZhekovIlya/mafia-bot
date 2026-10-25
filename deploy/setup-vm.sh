#!/usr/bin/env bash
# 24/7 hosting on a free Linux VM (Oracle Cloud Always Free / Google Cloud e2-micro).
# Usage on the VM:  curl -fsSL https://raw.githubusercontent.com/ZhekovIlya/mafia-bot/main/deploy/setup-vm.sh | bash
set -euo pipefail

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs git
fi

cd ~
[ -d mafia-bot ] || git clone https://github.com/ZhekovIlya/mafia-bot.git
cd mafia-bot && git pull

if [ ! -f .env ]; then
    read -rp "Paste BOT_TOKEN: " TOKEN </dev/tty
    read -rp "Bot username without @: " UNAME </dev/tty
    printf 'BOT_TOKEN=%s\nBOT_USERNAME=%s\n' "$TOKEN" "$UNAME" > .env
    chmod 600 .env
fi

npm ci && npm run build

# systemd keeps the bot running, restarts it on crash and starts it on boot.
sudo tee /etc/systemd/system/mafia-bot.service >/dev/null <<EOF
[Unit]
Description=Mafia Telegram bot
After=network-online.target

[Service]
WorkingDirectory=$HOME/mafia-bot
ExecStart=$(command -v node) dist/mafia-bot.js
Restart=always
RestartSec=5
User=$USER

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now mafia-bot
sudo systemctl status mafia-bot --no-pager
echo "Done. Logs: journalctl -u mafia-bot -f"
