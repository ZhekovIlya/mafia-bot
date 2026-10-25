# Mafia Bot

This project is a small Telegram bot implemented in TypeScript.

The bot requires two environment variables:

- `BOT_TOKEN` – the bot API token from BotFather.
- `BOT_USERNAME` – the bot's username without the `@` sign.

## Setup

1. Install dependencies:

```bash
npm ci
```

2. Create a `.env` file in the project root:

```bash
BOT_TOKEN=your-telegram-token
BOT_USERNAME=your-bot-username
```

## Development

Run the bot with `ts-node`:

```bash
npm run dev
```

## Building

Compile the sources and start the bot:

```bash
npm run build
npm start
```

## Hosting (free)

**On your Windows PC:** install [Node.js](https://nodejs.org), then double-click `start-bot.bat`.
The first run asks for the token and username and saves them to `.env`. The bot runs (and auto-restarts) while the window is open.

**24/7 on a free cloud VM** (Oracle Cloud Always Free or Google Cloud e2-micro, Ubuntu):

```bash
curl -fsSL https://raw.githubusercontent.com/ZhekovIlya/mafia-bot/main/deploy/setup-vm.sh | bash
```

It installs Node, builds the bot and runs it as a systemd service (restarts on crash and on reboot).
Logs: `journalctl -u mafia-bot -f`. Update: `cd ~/mafia-bot && git pull && npm ci && npm run build && sudo systemctl restart mafia-bot`.

The GitHub Actions workflow in `.github/workflows/node.yml` only checks that the project builds; GitHub does not allow Actions to be used as bot hosting.

