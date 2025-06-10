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

The repository also includes a GitHub Actions workflow in `.github/workflows/node.yml` that installs dependencies and builds the project on each push to `main`.

