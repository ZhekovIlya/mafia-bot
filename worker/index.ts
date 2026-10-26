// Cloudflare Workers version of the bot: Telegram pushes updates to this Worker (webhook),
// and all game state lives in a single Durable Object so it survives restarts.
import {
    GAME_STATUS,
    MESSAGES,
    START_HINT,
    HELP_TEXT,
    OWNER_HELP_TEXT,
    ROLES,
    Role,
    Game,
    Keyboard,
    shuffleArray,
    generateRoles,
    checkWinCondition,
    gameTitle,
    cleanTitle,
    newLobbyGame,
    hostedOpenGame,
    renderLobby,
    lobbyKeyboard,
    renderDashboard,
    teammatesText,
    suggestMafia,
    validateSetup,
    playerLabel,
    fullName,
    refreshIdentity,
    parseAdminIds,
    clampTestCount,
    isTestId,
    addTestPlayers,
    clearTestPlayers,
} from '../src/util';

interface Env {
    BOT_TOKEN: string;
    BOT_USERNAME: string;
    WEBHOOK_SECRET: string;
    // Comma-separated Telegram user ids allowed to use /addtest (set with `wrangler secret put ADMIN_IDS`)
    ADMIN_IDS?: string;
    GAMES: DurableObjectNamespace;
}

// Minimal Workers runtime types, so no extra type packages are needed.
declare class DurableObjectNamespace {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(req: Request): Promise<Response> };
}
interface DurableObjectState {
    storage: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> };
}

const IMAGE_BASE = 'https://raw.githubusercontent.com/ZhekovIlya/mafia-bot/main/assets/';
const ROLE_IMAGES: Record<Role, string> = {
    [ROLES.DON]: IMAGE_BASE + 'don.png',
    [ROLES.MAFIA]: IMAGE_BASE + 'mafia.png',
    [ROLES.SHERIFF]: IMAGE_BASE + 'sheriff.png',
    [ROLES.DOCTOR]: IMAGE_BASE + 'doc.png',
    [ROLES.CIVILIAN]: IMAGE_BASE + 'civilian.png',
};

export default {
    async fetch(req: Request, env: Env): Promise<Response> {
        const url = new URL(req.url);
        if (req.method === 'POST' && url.pathname === '/webhook') {
            if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
                return new Response('forbidden', { status: 403 });
            }
            return env.GAMES.get(env.GAMES.idFromName('main')).fetch(req);
        }
        return new Response('🎭 Mafia Bot is running');
    },
};

export class Games {
    private games = new Map<string, Game>();
    private userGames = new Map<number, string>();
    // Users who have DMed the bot, so we know it can message them.
    private users = new Set<number>();
    private loaded = false;

    constructor(private state: DurableObjectState, private env: Env) {}

    async fetch(req: Request): Promise<Response> {
        const update = await req.json() as any;
        if (!this.loaded) {
            this.games = new Map(await this.state.storage.get<[string, Game][]>('games') ?? []);
            this.userGames = new Map(await this.state.storage.get<[number, string][]>('userGames') ?? []);
            this.users = new Set(await this.state.storage.get<number[]>('users') ?? []);
            this.loaded = true;
        }
        try {
            if (update.message?.text) await this.onMessage(update.message);
            else if (update.callback_query) await this.onCallback(update.callback_query);
            else if (update.inline_query) await this.onInlineQuery(update.inline_query);
            else if (update.chosen_inline_result) this.onChosenInlineResult(update.chosen_inline_result);
        } catch (err) {
            console.error('Update failed:', err);
        }
        await this.state.storage.put('games', [...this.games]);
        await this.state.storage.put('userGames', [...this.userGames]);
        await this.state.storage.put('users', [...this.users]);
        // Always 200, otherwise Telegram keeps re-sending the same update.
        return new Response('ok');
    }

    // Failed sends (e.g. a player blocked the bot) are logged and return null instead of throwing.
    private async tg(method: string, body: Record<string, unknown>): Promise<any> {
        try {
            const res = await fetch(`https://api.telegram.org/bot${this.env.BOT_TOKEN}/${method}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json() as any;
            if (!data.ok) {
                console.error(`${method} failed:`, data.description);
                return null;
            }
            return data.result;
        } catch (err) {
            console.error(`${method} error:`, err);
            return null;
        }
    }

    // Fake test players have no Telegram chat: never message them.
    private isTest(id: number) {
        return isTestId(this.games.values(), id);
    }

    private async send(chatId: number, text: string, extra: Record<string, unknown> = {}) {
        if (this.isTest(chatId)) return null;
        return this.tg('sendMessage', { chat_id: chatId, text, ...extra });
    }

    private async sendPhoto(chatId: number, photo: string, caption: string) {
        if (this.isTest(chatId)) return null;
        return this.tg('sendPhoto', { chat_id: chatId, photo, caption });
    }

    private answer(cbId: string, text?: string, extra: Record<string, unknown> = {}) {
        return this.tg('answerCallbackQuery', { callback_query_id: cbId, text, ...extra });
    }

    // Edits the one live dashboard message to the current state. No dashboard stored: nothing to do.
    // Failed edits (including "message is not modified") are logged by tg() and never break the flow.
    private async refreshDashboard(game: Game) {
        const d = game.dashboard;
        if (!d?.messageId) return;
        const view = renderDashboard(game);
        await this.tg('editMessageText', {
            chat_id: d.chatId,
            message_id: d.messageId,
            text: view.text,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: view.keyboard },
        });
    }

    // Re-renders every lobby message of a game (and the live dashboard, whose waiting-phase panel
    // lists the same players); failed edits are logged by tg() and never break the flow.
    private async refreshLobby(game: Game) {
        await this.refreshDashboard(game);
        const base = { text: renderLobby(game), parse_mode: 'HTML' };
        await Promise.all([
            ...(game.lobbyMessages ?? []).map(m => this.tg('editMessageText', {
                ...base,
                chat_id: m.chatId,
                message_id: m.messageId,
                reply_markup: { inline_keyboard: lobbyKeyboard(game, m.share) },
            })),
            ...(game.lobbyInlineIds ?? []).map(id => this.tg('editMessageText', {
                ...base,
                inline_message_id: id,
                reply_markup: { inline_keyboard: lobbyKeyboard(game) },
            })),
        ]);
    }

    private addInlineId(game: Game, inlineId: string | undefined) {
        if (!inlineId) return;
        game.lobbyInlineIds ??= [];
        if (!game.lobbyInlineIds.includes(inlineId)) game.lobbyInlineIds.push(inlineId);
    }

    private randomizeGame(game: Game) {
        const roles = generateRoles(game.maxPlayers, game.maxMafia);
        game.players = shuffleArray(game.players).map((player, index) => ({
            ...player,
            role: roles[index],
            order: index + 1,
            revealed: false,
        }));
    }

    private async endGame(game: Game, winner: string) {
        game.status = GAME_STATUS.ENDED;
        game.winner = winner;
        const activeNonCivilians = game.players
            .filter(p => p.role !== ROLES.CIVILIAN)
            .map(p => `${playerLabel(p)}: ${p.role}`)
            .join('\n');
        const message = `🏆 ${winner} win!\n\n📜 Active Roles:\n${activeNonCivilians}`;
        await Promise.all([game.ownerId, ...game.players.map(p => p.id)].map(id => this.send(id, message)));
        await this.refreshLobby(game);
    }

    private async onMessage(msg: any) {
        const text: string = msg.text;
        const chatId: number = msg.chat.id;
        const userId: number | undefined = msg.from?.id;
        let match: RegExpExecArray | null;

        // Only a private message proves the bot can DM this user.
        if (userId && msg.chat.type === 'private') this.users.add(userId);
        // Keep the stored name/username of the host and listed players fresh.
        if (userId) {
            const mine = this.games.get(this.userGames.get(userId) ?? '');
            if (mine && refreshIdentity(mine, msg.from)) await this.refreshLobby(mine);
        }

        if (/\/start$/.test(text)) {
            await this.send(chatId, START_HINT);
        } else if (/\/help$/.test(text)) {
            await this.send(chatId, HELP_TEXT);
            const gameId = userId && this.userGames.get(userId);
            if (gameId && this.games.get(gameId)?.ownerId === userId) {
                await this.send(chatId, OWNER_HELP_TEXT);
            }
        } else if (/\/abortgame$/.test(text)) {
            await this.abortGame(chatId, userId);
        } else if ((match = /\/creategame(?:\s+([\s\S]+))?$/.exec(text))) {
            await this.createGame(msg, match[1]);
        } else if ((match = /\/start (?:in|join)_(.+)/.exec(text)) || (match = /\/joingame (.+)/.exec(text))) {
            await this.handleJoin(msg, match[1].trim());
        } else if (/\/leave$/.test(text)) {
            await this.handleLeave(msg);
        } else if (/\/startgame$/.test(text)) {
            const game = this.games.get(this.userGames.get(userId!) ?? '');
            if (!game) return this.send(chatId, '❌ No game found!');
            if (game.ownerId !== userId) return this.send(chatId, MESSAGES.NOT_AUTHORIZED_CHAT);
            if (game.status !== GAME_STATUS.WAITING) return this.send(chatId, '❌ Roles are already assigned.');
            const err = validateSetup(game.players.length, suggestMafia(game.players.length));
            if (err) return this.send(chatId, `❌ ${err}`);
            await this.sendDashboard(game, chatId, suggestMafia(game.players.length));
        } else if (/\/dashboard$/.test(text)) {
            await this.dashboard(chatId, userId);
        } else if ((match = /\/addtest(?:\s+(\S+))?$/.exec(text))) {
            await this.testPlayers(msg, 'add', match[1]);
        } else if (/\/cleartest$/.test(text)) {
            await this.testPlayers(msg, 'clear');
        }
    }

    // Admin-only: add or remove fake players in the host's waiting lobby.
    private async testPlayers(msg: any, action: 'add' | 'clear', countText?: string) {
        const userId: number | undefined = msg.from?.id;
        const chatId: number = msg.chat.id;
        if (!userId) return;
        if (msg.chat.type !== 'private') return this.send(chatId, '❌ Use this command in a private chat with the bot.');
        if (!parseAdminIds(this.env.ADMIN_IDS).has(userId)) {
            return this.send(chatId, `❌ Test mode is for admins. Your Telegram id is ${userId} — add it to ADMIN_IDS to enable.`);
        }
        const game = this.games.get(this.userGames.get(userId) ?? '');
        if (!game || game.ownerId !== userId || game.status === GAME_STATUS.ENDED) {
            return this.send(chatId, '❌ Create a game first with /creategame.');
        }
        if (game.status !== GAME_STATUS.WAITING) return this.send(chatId, '❌ Test players can only be changed while the lobby is open.');
        if (action === 'add') {
            const n = clampTestCount(countText);
            addTestPlayers(game, n, this.games.values());
            await this.refreshLobby(game);
            await this.send(chatId, `🤖 Added ${n} test players (${game.players.length} interested)`);
        } else {
            const removed = clearTestPlayers(game);
            await this.refreshLobby(game);
            await this.send(chatId, `🤖 Removed ${removed} test players (${game.players.length} interested)`);
        }
    }

    private async abortGame(chatId: number, userId: number | undefined) {
        if (!userId || !this.userGames.has(userId)) return;
        const gameId = this.userGames.get(userId)!;
        const game = this.games.get(gameId);
        if (!game) {
            this.userGames.delete(userId);
            return;
        }
        if (game.ownerId !== userId) return this.send(chatId, MESSAGES.NOT_AUTHORIZED_CHAT);
        game.cancelled = true;
        await this.refreshLobby(game);
        game.players.forEach(p => {
            if (this.userGames.get(p.id) === gameId) this.userGames.delete(p.id);
        });
        this.games.delete(gameId);
        this.userGames.delete(userId);
        await this.send(chatId, 'Game was aborted!');
    }

    private async createGame(msg: any, titleText: string | undefined) {
        const userId: number | undefined = msg.from?.id;
        const chatId: number = msg.chat.id;
        if (!userId) return;
        if (this.userGames.has(userId)) {
            const existingGame = this.games.get(this.userGames.get(userId)!);
            if (existingGame && existingGame.status !== GAME_STATUS.ENDED) {
                return this.send(chatId, '❌ You are already in an active game!');
            }
            this.userGames.delete(userId);
        }
        // Old "[players] [mafia]" numbers just become part of the title.
        const game = newLobbyGame(userId, msg.from ? fullName(msg.from, 'admin') : 'admin', titleText, msg.from?.username);
        this.games.set(game.id, game);
        this.userGames.set(userId, game.id);
        const sent = await this.send(chatId, renderLobby(game), {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: lobbyKeyboard(game, true) },
        });
        if (sent) game.lobbyMessages!.push({ chatId: sent.chat.id, messageId: sent.message_id, share: true });
        await this.send(chatId, OWNER_HELP_TEXT, { parse_mode: 'HTML' });
    }

    // Adds a user to a waiting lobby. ok=false carries the reason to show the user.
    private async addInterested(game: Game, from: any): Promise<{ ok: boolean; text: string }> {
        const id: number = from.id;
        if (game.status !== GAME_STATUS.WAITING) return { ok: false, text: 'This game is closed.' };
        if (game.ownerId === id) return { ok: false, text: 'You\'re the host 🙂' };
        if (game.players.some(p => p.id === id)) {
            if (refreshIdentity(game, from)) await this.refreshLobby(game);
            return { ok: false, text: 'You\'re already in ✅' };
        }
        // One waiting lobby at a time; a running game blocks joining another.
        const otherId = this.userGames.get(id);
        const other = otherId && otherId !== game.id ? this.games.get(otherId) : undefined;
        if (other && other.status !== GAME_STATUS.ENDED) {
            if (other.ownerId === id) return { ok: false, text: 'You\'re hosting another game.' };
            if (other.status === GAME_STATUS.ACTIVE) return { ok: false, text: 'You\'re already in a running game.' };
            other.players = other.players.filter(p => p.id !== id);
            await this.refreshLobby(other);
        }
        const player = {
            id,
            name: fullName(from),
            username: from.username,
            role: null,
            isAlive: true,
            order: game.players.length,
            revealed: false,
        };
        game.players.push(player);
        this.userGames.set(id, game.id);
        await this.refreshLobby(game);
        await this.send(game.ownerId, `🙋 ${playerLabel(player)} is in (${game.players.length} interested)`);
        return { ok: true, text: 'You\'re in! ✅' };
    }

    // Removes a user from their own choice of lobby; returns the text to show them.
    private async removeInterested(game: Game, from: any): Promise<string> {
        const inList = game.players.some(p => p.id === from.id);
        if (game.status !== GAME_STATUS.WAITING) {
            return inList && !game.cancelled && game.status === GAME_STATUS.ACTIVE
                ? 'Roster is locked — ask the host.'
                : 'This game is closed.';
        }
        if (!inList) return 'You weren\'t on the list.';
        const leaver = playerLabel({ name: fullName(from), username: from.username });
        game.players = game.players.filter(p => p.id !== from.id);
        if (this.userGames.get(from.id) === game.id) this.userGames.delete(from.id);
        await this.refreshLobby(game);
        await this.send(game.ownerId, `🙅 ${leaver} dropped out (${game.players.length} interested)`);
        return 'Got it, you\'re out.';
    }

    private async handleJoin(msg: any, gameId: string) {
        const userId: number | undefined = msg.from?.id;
        const chatId: number = msg.chat.id;
        if (!userId) return;
        const game = this.games.get(gameId);
        if (!game) return this.send(chatId, '❌ Game not found!');
        if (!this.users.has(userId)) {
            return this.send(chatId, `Open https://t.me/${this.env.BOT_USERNAME}?start=in_${gameId} and press Start to join.`);
        }
        const res = await this.addInterested(game, msg.from);
        if (!res.ok) return this.send(chatId, `❌ ${res.text}`);
        await this.send(chatId, `✅ You're on the list for ${gameTitle(game)}. I'll send your role here when the host deals.`);
    }

    private async handleLeave(msg: any) {
        const userId: number | undefined = msg.from?.id;
        if (!userId) return;
        const game = this.games.get(this.userGames.get(userId) ?? '');
        if (!game) return this.send(msg.chat.id, 'You\'re not on any lobby.');
        await this.send(msg.chat.id, await this.removeInterested(game, msg.from));
    }

    private async dashboard(chatId: number, userId: number | undefined) {
        const gameId = this.userGames.get(userId!);
        if (!gameId) return this.send(chatId, '❌ No game found!');
        const game = this.games.get(gameId)!;
        if (game.ownerId !== userId) return this.send(chatId, MESSAGES.NOT_AUTHORIZED_CHAT);
        if (game.status === GAME_STATUS.ENDED) return this.send(chatId, '⚠️ Game has ended.');
        if (game.status === GAME_STATUS.ACTIVE) await this.deleteLastReveal(game);
        await this.sendDashboard(game, chatId);
    }

    // Sends a fresh live dashboard (deleting the previous one) and remembers its message ids.
    // mafia: open the lock/setup confirmation instead of the panel.
    private async sendDashboard(game: Game, chatId: number, mafia?: number) {
        const old = game.dashboard;
        if (old?.messageId) await this.tg('deleteMessage', { chat_id: old.chatId, message_id: old.messageId });
        game.dashboard = { chatId, messageId: 0, mafia };
        const view = renderDashboard(game);
        const sent = await this.send(chatId, view.text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: view.keyboard } });
        if (sent) game.dashboard.messageId = sent.message_id;
        else delete game.dashboard;
    }

    private async deleteLastReveal(game: Game) {
        if (game.lastRevealChatId && game.lastRevealMessageId) {
            await this.tg('deleteMessage', { chat_id: game.lastRevealChatId, message_id: game.lastRevealMessageId });
        }
    }

    // Inline mode: `@bot <title or gameId>` offers the host's lobby to post anywhere.
    private async onInlineQuery(q: any) {
        const from = q.from;
        const text = String(q.query ?? '').trim();
        let game = hostedOpenGame(this.games, this.userGames, from.id);
        let results: unknown[] = [];
        if (game && game.status !== GAME_STATUS.WAITING) {
            game = undefined; // roster already locked, nothing to post
        } else if (!game) {
            const existing = this.games.get(this.userGames.get(from.id) ?? '');
            if (!existing || existing.status === GAME_STATUS.ENDED) {
                game = newLobbyGame(from.id, fullName(from, 'admin'), text, from.username);
                this.games.set(game.id, game);
                this.userGames.set(from.id, game.id);
            }
        } else if (text && text !== game.id && !game.lobbyMessages?.length && !game.lobbyInlineIds?.length) {
            // Nothing posted yet: keep the title in sync while the host is still typing.
            game.title = cleanTitle(text);
        }
        if (game) {
            results = [{
                type: 'article',
                id: game.id,
                title: `🎭 Post Mafia lobby: ${gameTitle(game)}`,
                description: `${game.players.length} interested`,
                input_message_content: { message_text: renderLobby(game), parse_mode: 'HTML' },
                reply_markup: { inline_keyboard: lobbyKeyboard(game) },
            }];
        }
        await this.tg('answerInlineQuery', {
            inline_query_id: q.id,
            results,
            cache_time: 0,
            is_personal: true,
        });
    }

    private onChosenInlineResult(r: any) {
        const game = this.games.get(r.result_id);
        if (game) this.addInlineId(game, r.inline_message_id);
    }

    private async lockAndDeal(game: Game, mafia: number) {
        game.maxPlayers = game.players.length;
        game.maxMafia = mafia;
        this.randomizeGame(game);
        game.status = GAME_STATUS.ACTIVE;
        if (game.dashboard) delete game.dashboard.mafia;
        // Also turns the dashboard message into the active dashboard.
        await this.refreshLobby(game);
        await Promise.all(game.players.map(p => this.send(p.id,
            `🔒 Roster locked — you're playing in ${gameTitle(game)}! Your role is coming soon.`)));
    }

    // Callbacks that drive the owner dashboard (all owner-only).
    private static readonly DASHBOARD_ACTIONS = new Set([
        'lkick', 'llock', 'lmafia', 'lback', 'ldeal',
        'reveal', 'revealall', 'eliminateconfirm', 'eliminate', 'elimno', 'cancel',
    ]);

    private async onCallback(cb: any) {
        const [action, gameId, userIdStr] = (cb.data || '').split('_');
        const game = this.games.get(gameId);
        if (!game) {
            // Old clutter (e.g. a stale confirm message of a finished game): answer and tidy up.
            if (action === 'cancel' || action === 'elimno') await this.deleteTapped(cb);
            return this.answer(cb.id, action.startsWith('l') ? 'This game is closed.' : undefined);
        }
        // Fallback capture of an inline-posted lobby in case chosen_inline_result is not enabled.
        if (cb.inline_message_id) this.addInlineId(game, cb.inline_message_id);
        const chatId: number | undefined = cb.message?.chat.id;
        if (refreshIdentity(game, cb.from)) await this.refreshLobby(game);
        const isOwner = game.ownerId === cb.from.id;
        const waiting = game.status === GAME_STATUS.WAITING;
        const active = game.status === GAME_STATUS.ACTIVE;
        let toast: string | undefined;

        if (Games.DASHBOARD_ACTIONS.has(action)) {
            if (!isOwner) return this.answer(cb.id, MESSAGES.NOT_AUTHORIZED);
            // Old two-message elimination flow: just tidy up, never act.
            if (action === 'cancel') {
                await this.deleteTapped(cb);
                return this.answer(cb.id);
            }
            if (!chatId) return this.answer(cb.id);
            const tappedId: number = cb.message.message_id;
            if (!game.dashboard?.messageId) {
                // No live dashboard yet (e.g. /startgame confirm or pre-upgrade message): adopt this one.
                game.dashboard = { chatId, messageId: tappedId };
            } else if (game.dashboard.chatId !== chatId || game.dashboard.messageId !== tappedId) {
                // Button of an outdated dashboard: act on the game, show the result on the current one.
                await this.deleteTapped(cb);
            }
        }

        switch (action) {
            case 'lin': {
                if (!waiting) return this.answer(cb.id, 'This game is closed.');
                if (isOwner) return this.answer(cb.id, 'You\'re the host 🙂');
                if (!this.users.has(cb.from.id)) {
                    // Bot can't DM them yet: send them to the bot to press Start.
                    return this.answer(cb.id, undefined, { url: `https://t.me/${this.env.BOT_USERNAME}?start=in_${gameId}` });
                }
                const res = await this.addInterested(game, cb.from);
                return this.answer(cb.id, res.text);
            }
            case 'lout':
                return this.answer(cb.id, await this.removeInterested(game, cb.from));
            case 'lkick': {
                if (!waiting) return this.answer(cb.id, 'This game is closed.');
                const targetId = Number(userIdStr);
                if (game.players.some(p => p.id === targetId)) {
                    game.players = game.players.filter(p => p.id !== targetId);
                    if (this.userGames.get(targetId) === game.id) this.userGames.delete(targetId);
                    await this.refreshLobby(game);
                    await this.send(targetId, `ℹ️ The host removed you from ${gameTitle(game)}. Tap I'm in again if you can make it.`);
                } else {
                    await this.refreshDashboard(game);
                }
                break;
            }
            case 'llock':
            case 'lmafia':
            case 'lback':
            case 'ldeal': {
                if (!waiting) return this.answer(cb.id, 'This game is closed.');
                const n = game.players.length;
                if (action === 'lback') {
                    delete game.dashboard!.mafia;
                    await this.refreshDashboard(game);
                    break;
                }
                const mafia = action === 'llock' ? suggestMafia(n) : Number(userIdStr);
                const err = validateSetup(n, mafia);
                if (err) return this.answer(cb.id, err);
                if (action === 'ldeal') {
                    await this.lockAndDeal(game, mafia);
                    toast = '🎲 Roles assigned — reveal them below.';
                } else {
                    game.dashboard!.mafia = mafia;
                    await this.refreshDashboard(game);
                }
                break;
            }
            case 'reveal': {
                const player = game.players.find(p => p.id === Number(userIdStr));
                if (!active || !player || !player.role) break;
                player.revealed = true;
                await this.deleteLastReveal(game);
                const sentMsg = await this.sendPhoto(chatId!, ROLE_IMAGES[player.role], `🎭 ${playerLabel(player)} is ${player.role}`);
                if (sentMsg) {
                    game.lastRevealChatId = sentMsg.chat.id;
                    game.lastRevealMessageId = sentMsg.message_id;
                }
                await this.sendPhoto(player.id, ROLE_IMAGES[player.role], `🎭 Your role is ${player.role}`);
                const mates = teammatesText(game, player);
                if (mates) await this.send(player.id, mates);
                await this.refreshDashboard(game);
                break;
            }
            case 'revealall': {
                const unrevealed = game.players.filter(p => !p.revealed);
                if (!active || unrevealed.length === 0) break;
                await this.deleteLastReveal(game);
                unrevealed.forEach(p => { p.revealed = true; });
                await Promise.all(unrevealed.map(p =>
                    p.role ? this.sendPhoto(p.id, ROLE_IMAGES[p.role], `🎭 Your role is ${p.role}`) : null));
                await Promise.all(game.players.map(p => {
                    const mates = teammatesText(game, p);
                    return mates ? this.send(p.id, mates) : null;
                }));
                await this.send(chatId!, '🎭 All roles have been revealed.');
                await this.refreshDashboard(game);
                break;
            }
            case 'eliminateconfirm': {
                const target = game.players.find(p => p.id === Number(userIdStr));
                if (active && target?.isAlive) game.dashboard!.eliminate = target.id;
                await this.refreshDashboard(game);
                break;
            }
            case 'elimno': {
                delete game.dashboard!.eliminate;
                await this.refreshDashboard(game);
                toast = 'Cancelled';
                break;
            }
            case 'eliminate': {
                delete game.dashboard!.eliminate;
                const player = game.players.find(p => p.id === Number(userIdStr));
                if (!active || !player || !player.isAlive) {
                    await this.refreshDashboard(game);
                    break;
                }
                player.isAlive = false;
                await this.send(chatId!, `☠️ ${playerLabel(player)} has been eliminated.`);
                const winner = checkWinCondition(game);
                // endGame refreshes the dashboard into the final summary.
                if (winner) await this.endGame(game, winner);
                else await this.refreshDashboard(game);
                break;
            }
        }
        await this.answer(cb.id, toast);
    }

    // Deletes the message a callback button was on (errors ignored).
    private async deleteTapped(cb: any) {
        if (cb.message) await this.tg('deleteMessage', { chat_id: cb.message.chat.id, message_id: cb.message.message_id });
    }
}
