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

To run it hidden in the background every time you log in, double-click `install-autostart.bat` (after the first run above).
Stop it with `stop-bot.bat`, remove autostart with `uninstall-autostart.bat`. Output goes to `bot.log`.

**24/7 on a free cloud VM** (Oracle Cloud Always Free or Google Cloud e2-micro, Ubuntu):

```bash
curl -fsSL https://raw.githubusercontent.com/ZhekovIlya/mafia-bot/main/deploy/setup-vm.sh | bash
```

It installs Node, builds the bot and runs it as a systemd service (restarts on crash and on reboot).
Logs: `journalctl -u mafia-bot -f`. Update: `cd ~/mafia-bot && git pull && npm ci && npm run build && sudo systemctl restart mafia-bot`.

The GitHub Actions workflow in `.github/workflows/node.yml` only checks that the project builds; GitHub does not allow Actions to be used as bot hosting.

## Interest lobby ("who's in?")

The host announces a game days ahead; anyone can tap **I'm in** (no cap) and the message updates live. On game day the host removes no-shows, locks the roster and the bot suggests a mafia count from the real headcount. Full spec: `docs/LOBBY_SPEC.md`.

- `/creategame [title]` (private chat), e.g. `/creategame Friday 20:00`. The bot replies with the lobby plus a **Share to a chat** button.
- Or type `@your_bot Friday 20:00` in any chat (the bot does not need to be a member) and pick the result to post the lobby there.
- Players tap **I'm in** / **Can't make it** (or send `/leave`). A player who never started the bot is sent to the bot first so it can DM their role.
- `/dashboard` while waiting: remove players, **Lock & deal** (pick the mafia count, then deal). After that the usual reveal / eliminate flow applies.

### One-time BotFather setup (required for the lobby)

1. `/setinline` - choose your bot, enable inline mode, placeholder e.g. `game title, e.g. Friday 20:00`.
2. `/setinlinefeedback` - choose your bot, set it to **Enabled** (lets the bot edit inline-posted lobbies right away; without it the bot only learns the message on the first button tap).

### Cloudflare Worker webhook

The webhook must receive `message`, `callback_query`, `inline_query` and `chosen_inline_result`. When (re)setting it, pass `allowed_updates` explicitly:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://<your-worker>.workers.dev/webhook" \
  -d "secret_token=<WEBHOOK_SECRET>" \
  -d 'allowed_updates=["message","callback_query","inline_query","chosen_inline_result"]'
```


## Testing with few accounts

You can play a full game with just two Telegram accounts by adding fake test players (admins only):

1. Find your Telegram id: send `/addtest` to the bot once, it replies with your id. Then set it: Worker `npx wrangler secret put ADMIN_IDS` (comma-separated ids), Node: `ADMIN_IDS=123456789` in `.env`.
2. `/creategame Test night` (host account), then have the other phone tap **I'm in**.
3. `/addtest 3` adds `🤖 Test 1..3` (`/cleartest` removes them). Test players count like normal players but are never messaged.
4. `/dashboard` → **Lock & deal** → `/dashboard` → **Reveal All**, then play. Test players' roles are shown to the host in the dashboard and on single **Reveal**.

`npm run simulate` runs the whole flow against the Worker code with a mocked Telegram API (no network, no tokens) and exits non-zero on failure.
