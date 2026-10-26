# Interest lobby ("who's in?") — spec

## Goal
The host announces a game days ahead. Anyone can tap "I'm in" with no cap; a live-updating message shows who's interested. On game day the host removes no-shows, the bot suggests a mafia count from the real headcount, the host locks the roster and roles are dealt. Nothing else about the game changes (dashboard reveal / eliminate / win flow stays as-is).

## Terms
- **Owner / host** — creates the game, moderates, never plays (existing rule: owner cannot join own game).
- **Interested list** — `game.players` while status is `waiting`. No maximum.
- **Lobby message(s)** — the announcement message(s) with the buttons; the bot edits them on every change.

## 1. Creating an announcement
### 1a. `/creategame [title]` (in private chat with the bot)
- Title is optional free text, e.g. `/creategame Friday 20:00`. Default title: `Mafia game`.
- Drop the old `[players] [mafia]` numeric arguments: game size is no longer chosen up front. If someone passes the old numeric form, just treat the text as the title (don't crash).
- An owner can have only one non-ended game (existing rule, keep it).
- Bot replies in the DM with the lobby message (section 2) PLUS an extra row with a `📣 Share to a chat` button using `switch_inline_query: <gameId>` so the owner can post the same lobby into any group in two taps. Also send `OWNER_HELP_TEXT` as today.
- Record this DM lobby message (chat_id + message_id) in the game so it's edited live too.

### 1b. Inline mode (main "handy" path)
- Owner types `@<bot> <title or gameId>` in any chat (bot does NOT need to be a group member).
- Handle `inline_query`:
  - If the query text equals the owner's existing open game id, OR the owner already has an open (waiting) game → return one article result showing THAT game's lobby.
  - Else → create a new game for the owner with the query text as title (empty → default title) and return its lobby.
  - Result: `type: 'article'`, title `🎭 Post Mafia lobby: <title>`, description `<N> interested`, `input_message_content` = rendered lobby text (HTML parse mode), `reply_markup` = lobby buttons. Use `cache_time: 0` and `is_personal: true`.
  - Only lobby creation is offered via inline; the inline query from a non-owner of a game just creates their own game (they become owner) — that's fine.
- Inline-posted messages are identified by `inline_message_id`. Capture it from `chosen_inline_result` (requires inline feedback enabled in BotFather — document it) AND, as a fallback, from `callback_query.inline_message_id` on the first button tap. Store unique ids in the game.

## 2. Lobby message
Rendered by a pure function in `src/util.ts` (shared by both runtimes), HTML-escaped names:
```
🎭 <b>{title}</b>
Host: {ownerName}

🙋 Interested: {N}
1. Anna (@anna)
2. Max
...
(empty list → "Nobody yet — be the first!")
```
Buttons (status `waiting`): one row `[🙋 I'm in] [🙅 Can't make it]` with callback_data `lin_<gameId>` / `lout_<gameId>`.
- After lock: text gets a footer `🔒 Roster locked — {N} playing. Good luck!`, no buttons.
- After abort: footer `❌ Game cancelled by host.`, no buttons.
- After game end: footer `🏆 {winner} won!`, no buttons.
- Keep callback_data ≤ 64 bytes. Existing callback parsing splits on `_` — keep that scheme.

## 3. Joining / leaving
- Persist a set of **known users** (every user id that ever sent the bot a message or `/start`). Worker: new storage key `users`. Node: in-memory Set. Record on every incoming message and callback where the bot can DM them (i.e. any private-chat message; callbacks don't prove the user started the bot, so only private messages / `/start` add to the set).
- `lin_<gameId>` tap:
  - Game missing or not `waiting` → toast "This game is closed."
  - Tapper is the owner → toast "You're the host 🙂".
  - Tapper NOT in known users → `answerCallbackQuery` with `url: https://t.me/<BOT_USERNAME>?start=in_<gameId>` (opens the bot; they press Start). Do NOT add them yet — the bot couldn't DM their role.
  - Already interested → toast "You're already in ✅".
  - Else add to `game.players`, map `userGames`, toast "You're in! ✅", re-render all lobby messages, DM the owner `🙋 {name} is in ({N} interested)`.
- `/start in_<gameId>` (and keep supporting the existing `/start join_<gameId>` and `/joingame <id>` as aliases): add user to known users, then same add logic as above; reply in DM "✅ You're on the list for <title>. I'll send your role here when the host deals."
- `lout_<gameId>` tap (or the user sending `/leave` in DM): if in the list and game is `waiting` → remove, clear `userGames`, toast "Got it, you're out.", re-render, DM owner `🙅 {name} dropped out ({N} interested)`. If not in list → toast "You weren't on the list." After lock, players cannot leave themselves (toast "Roster is locked — ask the host.").
- A user can be on only one waiting lobby at a time: joining a new one removes them from the old one (and re-renders the old one). Don't let anyone who is in an ACTIVE game join another.
- Removing the old "Game full" / exact-count rules for the waiting phase.

## 4. Owner panel (`/dashboard` while status is `waiting`)
- Text:
```
📋 Lobby: {title} — {N} interested
Suggested setup: {N} players, {M} mafia (Don + {M-1})
```
  (If N < 4: `Need at least 4 players to deal.` instead of the suggestion.)
- Keyboard: one row per interested player `❌ Remove {i}. {name}` → callback `lkick_<gameId>_<userId>` (no confirmation needed; it's reversible by them re-joining). Last row `🔒 Lock & deal` → `llock_<gameId>`.
- `lkick`: owner-only. Remove the player, clear their `userGames`, re-render lobby messages, DM the removed player `ℹ️ The host removed you from <title>. Tap I'm in again if you can make it.` (ignore send failures), then send a refreshed panel (or edit the panel message in place — preferred: editMessageText on the panel message).
- Re-sending `/dashboard` is always allowed and shows the current state.

## 5. Lock & deal
- `llock_<gameId>` (owner-only) → edit panel into a setup confirmation:
```
🔒 Lock roster with {N} players?
Mafia: {M} (Don + {M-1}) · Sheriff · Doctor · Civilians: {N-M-2}
```
  Keyboard: `[➖ Mafia] [➕ Mafia]` (`lmafia_<gameId>_<M-1>` / `lmafia_<gameId>_<M+1>`, re-render confirmation), `[✅ Deal roles]` (`ldeal_<gameId>_<M>`), `[↩️ Back]` (back to panel).
- Suggested mafia (pure function in util.ts): 4–6 players → 1, 7–9 → 2, 10–13 → 3, 14+ → 4. 
- Validation (pure function in util.ts, used for ± bounds and on deal): players ≥ 4; 1 ≤ mafia; mafia + 2 ≤ players (roles fit); mafia < players − mafia (mafia must start as a minority). Clamp ± buttons to valid range; on invalid `ldeal` toast the reason.
- `ldeal`: set `maxPlayers = players.length`, `maxMafia = M`, call existing `randomizeGame`, status `active`, re-render lobby messages with the locked footer, DM every player `🔒 Roster locked — you're playing in <title>! Your role is coming soon.`, and tell the owner `🎲 Roles assigned. Use /dashboard to reveal roles and manage the game.` (same as today). From here the existing ACTIVE dashboard flow is unchanged.
- `/startgame` command → behaves like tapping `🔒 Lock & deal` (sends the confirmation).
- Replace the old `startgame_` dashboard button / exact-player-count checks with this flow (you can delete the old `startgame` callback case).

## 6. Abort / end
- `/abortgame` (owner): also re-render lobby messages with the cancelled footer and clear `userGames` for all players of that game (currently it only clears the owner — fix that).
- `endGame`: additionally re-render lobby messages with the winner footer. Keep the existing DMs.

## 7. Editing lobby messages
- Keep in the game: `lobbyMessages: { chatId: number; messageId: number }[]` and `lobbyInlineIds: string[]`.
- One helper `refreshLobby(game)` edits all of them (`editMessageText` with `chat_id`+`message_id`, or with `inline_message_id`), `parse_mode: 'HTML'`, with the right `reply_markup` (omit / empty keyboard when closed). Ignore "message is not modified" and any other edit errors (log them) — a failed edit must never break the flow.

## 8. Help texts
Update `HELP_TEXT` / `OWNER_HELP_TEXT` / `START_HINT` in util.ts to describe: `/creategame [title]`, inline `@bot` sharing, I'm in / Can't make it, `/leave`, `/dashboard` (remove players, lock & deal), `/abortgame`. Keep them short.

## 9. Setup the human must do (document in README)
In @BotFather: `/setinline` (enable, placeholder e.g. `game title, e.g. Friday 20:00`) and `/setinlinefeedback` (Enabled). Worker: the webhook must receive `inline_query`, `chosen_inline_result`, `callback_query`, `message` — if the README/worker sets webhook `allowed_updates`, include those.

## Out of scope
Broadcast, night actions, undo elimination, teammate-message fix, anything else.

## Addendum: names and test players

### Names
- Display name is `first_name` + ` last_name` (when present); `username` is stored separately. Every user-facing mention uses `playerLabel`: `Name (@username)`, or `Name` without a username (lobby list and host line, panel buttons, owner DMs, dashboard roster and buttons, reveal caption, elimination messages, end-game roles, mafia teammates).
- `Game.ownerUsername` (optional) is set on create. Stored name/username of the host and listed players are refreshed from the latest `from` on any message or callback.
- Inline button text is capped at ~40 chars: the name is truncated with `…`, the `(@username)` stays intact. HTML messages escape the label.

### Test players (admin-only)
- `ADMIN_IDS` env var (comma-separated Telegram ids; Worker secret, Node `.env`).
- `/addtest [n]` (private chat, host of a `waiting` game, id in `ADMIN_IDS`; n defaults to 1, clamped 1..12) adds `🤖 Test N` players with unique negative ids and `isTest: true`. `/cleartest` removes them. Non-admins get `❌ Test mode is for admins. Your Telegram id is <id> — add it to ADMIN_IDS to enable.`; admins without a waiting game get `❌ Create a game first with /creategame.`
- Test players are not in `userGames` or known users, otherwise behave like real players (lobby count, remove, deal, reveal, eliminate, win check, summaries). Nothing is ever sent to them (single guard in `send`/`sendPhoto`); the host still gets reveal captions.
- `npm run simulate` (`scripts/simulate.ts`) drives the Durable Object end to end with a mocked Telegram API.

## Addendum: live dashboard
- One live owner message per game: `game.dashboard = { chatId, messageId, mafia?, eliminate? }` (optional, old state loads). `mafia` = the waiting panel shows the lock/setup confirmation with that count; `eliminate` = the active dashboard asks "Eliminate N. Name?" for that player.
- Rendering is the pure `renderDashboard(game)` in `src/util.ts` (HTML): waiting panel, setup confirm, active-unrevealed, active-revealed (roster with roles and 💚/💀), ended (winner and full roster, no buttons), cancelled ("❌ Game cancelled.", no buttons).
- `/dashboard` deletes the old dashboard message (errors ignored), sends a fresh one and stores its ids. `/startgame` does the same but opens the setup confirm. A callback with no stored dashboard adopts the tapped message.
- `refreshDashboard(game)` edits the stored message (`editMessageText`, HTML, current keyboard); errors incl. "message is not modified" are logged and ignored. It runs after every state change: `refreshLobby` calls it (join, leave, kick, addtest, cleartest, name refresh, ldeal, game end, abort) and callbacks call it directly (setup steps, reveal, reveal all, eliminate confirm / yes / no).
- `ldeal` turns the same message into the active dashboard; the host gets a toast ("Roles assigned") instead of a chat message. End of game edits it to the final summary; abort to "Game cancelled."; end-game DMs stay.
- Elimination: `❌ Eliminate` edits the dashboard into `⚠️ Eliminate N. Name (@nick)?` with `eliminate_` (Yes) / `elimno_` (No). Yes sends "☠️ … has been eliminated." and refreshes; No toasts "Cancelled" and refreshes. No confirm/cancelled messages are sent. A stale `cancel_` button (old flow) only deletes its own message.
- A button on a message that is not the current dashboard still acts on the game, the tapped message is deleted, and the current dashboard is refreshed.
- Single 🎭 Reveal of a Mafia/Don also DMs their teammates list (same text as Reveal All; skipped when they have none).
