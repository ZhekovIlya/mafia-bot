// Cloudflare Workers version of the bot: Telegram pushes updates to this Worker (webhook),
// and all game state lives in a single Durable Object so it survives restarts.
import {
    DEFAULT_PLAYERS_COUNT,
    DEFAULT_MAFIA_COUNT,
    GAME_STATUS,
    MESSAGES,
    START_HINT,
    HELP_TEXT,
    OWNER_HELP_TEXT,
    ROLES,
    Role,
    Game,
    shuffleArray,
    generateRoles,
    checkWinCondition,
} from '../src/util';

interface Env {
    BOT_TOKEN: string;
    BOT_USERNAME: string;
    WEBHOOK_SECRET: string;
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

type Keyboard = Array<Array<{ text: string; callback_data?: string; url?: string }>>;

export class Games {
    private games = new Map<string, Game>();
    private userGames = new Map<number, string>();
    private loaded = false;

    constructor(private state: DurableObjectState, private env: Env) {}

    async fetch(req: Request): Promise<Response> {
        const update = await req.json() as any;
        if (!this.loaded) {
            this.games = new Map(await this.state.storage.get<[string, Game][]>('games') ?? []);
            this.userGames = new Map(await this.state.storage.get<[number, string][]>('userGames') ?? []);
            this.loaded = true;
        }
        try {
            if (update.message?.text) await this.onMessage(update.message);
            else if (update.callback_query) await this.onCallback(update.callback_query);
        } catch (err) {
            console.error('Update failed:', err);
        }
        await this.state.storage.put('games', [...this.games]);
        await this.state.storage.put('userGames', [...this.userGames]);
        // Always 200, otherwise Telegram keeps re-sending the same update.
        return new Response('ok');
    }

    // Failed sends (e.g. a player blocked the bot) are logged and return null instead of throwing.
    private async tg(method: string, body: Record<string, unknown>): Promise<any> {
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
    }

    private send(chatId: number, text: string, extra: Record<string, unknown> = {}) {
        return this.tg('sendMessage', { chat_id: chatId, text, ...extra });
    }

    private sendPhoto(chatId: number, photo: string, caption: string) {
        return this.tg('sendPhoto', { chat_id: chatId, photo, caption });
    }

    private answer(cbId: string, text?: string) {
        return this.tg('answerCallbackQuery', { callback_query_id: cbId, text });
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
        const activeNonCivilians = game.players
            .filter(p => p.role !== ROLES.CIVILIAN)
            .map(p => `${p.name}: ${p.role}`)
            .join('\n');
        const message = `🏆 ${winner} win!\n\n📜 Active Roles:\n${activeNonCivilians}`;
        await Promise.all([game.ownerId, ...game.players.map(p => p.id)].map(id => this.send(id, message)));
    }

    private async onMessage(msg: any) {
        const text: string = msg.text;
        const chatId: number = msg.chat.id;
        const userId: number | undefined = msg.from?.id;
        let match: RegExpExecArray | null;

        if (/\/start$/.test(text)) {
            await this.send(chatId, START_HINT);
        } else if (/\/help$/.test(text)) {
            await this.send(chatId, HELP_TEXT);
            const gameId = userId && this.userGames.get(userId);
            if (gameId && this.games.get(gameId)?.ownerId === userId) {
                await this.send(chatId, OWNER_HELP_TEXT);
            }
        } else if (/\/abortgame$/.test(text)) {
            if (!userId || !this.userGames.has(userId)) return;
            const gameId = this.userGames.get(userId)!;
            if (this.games.get(gameId)?.ownerId !== userId) return this.send(chatId, MESSAGES.NOT_AUTHORIZED_CHAT);
            this.games.delete(gameId);
            this.userGames.delete(userId);
            await this.send(chatId, 'Game was aborted!');
        } else if ((match = /\/creategame(?:\s+(\d+)\s+(\d+))?$/.exec(text))) {
            await this.createGame(msg, match);
        } else if ((match = /\/start join_(.+)/.exec(text)) || (match = /\/joingame (.+)/.exec(text))) {
            await this.handleJoin(msg, match[1]);
        } else if (/\/startgame$/.test(text)) {
            const gameId = this.userGames.get(userId!);
            if (!gameId) return this.send(chatId, '❌ No game found!');
            const game = this.games.get(gameId)!;
            if (game.ownerId !== userId || game.players.length !== game.maxPlayers) {
                return this.send(chatId, `❌ Need ${game.maxPlayers} players (excluding owner) to start!`);
            }
            this.randomizeGame(game);
            game.status = GAME_STATUS.ACTIVE;
            await this.send(chatId, '🎲 Roles assigned. Use /dashboard to reveal roles and manage the game.');
        } else if (/\/dashboard$/.test(text)) {
            await this.dashboard(chatId, userId);
        }
    }

    private async createGame(msg: any, match: RegExpExecArray) {
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
        const maxPlayers = match[1] ? parseInt(match[1], 10) : DEFAULT_PLAYERS_COUNT;
        const maxMafia = match[2] ? parseInt(match[2], 10) : DEFAULT_MAFIA_COUNT;
        const gameId = Date.now().toString();
        this.games.set(gameId, {
            id: gameId,
            ownerId: userId,
            ownerName: msg.from?.first_name ?? 'admin',
            players: [],
            maxPlayers,
            maxMafia,
            status: GAME_STATUS.WAITING,
        });
        this.userGames.set(userId, gameId);
        const joinLink = `https://t.me/${this.env.BOT_USERNAME}?start=join_${gameId}`;
        await this.send(chatId, `🎮 Game created! Game ID: ${gameId}\nMax Players: ${maxPlayers}\nMax Mafia: ${maxMafia}\nJoin link: ${joinLink}`, {
            reply_markup: { inline_keyboard: [[{ text: 'Join Game', url: joinLink }]] },
        });
        await this.send(chatId, OWNER_HELP_TEXT);
    }

    private async handleJoin(msg: any, gameId: string) {
        const userId: number | undefined = msg.from?.id;
        const userName: string = msg.from?.first_name || 'Player';
        const chatId: number = msg.chat.id;
        if (!userId) return;
        const game = this.games.get(gameId);
        if (!game) return this.send(chatId, '❌ Game not found!');
        if (game.ownerId === userId) return this.send(chatId, '❌ Game owner cannot join their own game!');
        if (game.status === GAME_STATUS.ENDED) return this.send(chatId, '❌ Cannot join an ended game!');
        if (game.players.length >= game.maxPlayers) return this.send(chatId, '❌ Game full!');
        if (game.players.some(p => p.id === userId)) return this.send(chatId, '❌ Already joined!');
        game.players.push({ id: userId, name: userName, username: msg.from?.username, role: null, isAlive: true, order: game.players.length, revealed: false });
        this.userGames.set(userId, gameId);
        await this.send(chatId, '✅ Joined successfully!');
        await this.send(game.ownerId, `🎯 ${userName} joined! (${game.players.length}/${game.maxPlayers})`);
    }

    private async dashboard(chatId: number, userId: number | undefined) {
        const gameId = this.userGames.get(userId!);
        if (!gameId) return this.send(chatId, '❌ No game found!');
        const game = this.games.get(gameId)!;
        if (game.ownerId !== userId) return this.send(chatId, MESSAGES.NOT_AUTHORIZED_CHAT);
        if (game.status === GAME_STATUS.ENDED) return this.send(chatId, '⚠️ Game has ended.');
        const anyUnrevealed = game.players.some(p => !p.revealed);
        const keyboard: Keyboard = [];
        if (game.status === GAME_STATUS.WAITING) {
            keyboard.push([{ text: '🚀 Start Game', callback_data: `startgame_${gameId}` }]);
        } else if (anyUnrevealed) {
            keyboard.push([{ text: '🔓 Reveal All', callback_data: `revealall_${gameId}` }]);
            game.players.forEach(p => {
                keyboard.push([{ text: `🎭 Reveal ${p.order}. ${p.name}`, callback_data: `reveal_${gameId}_${p.id}` }]);
            });
        } else {
            game.players.forEach(p => {
                if (p.isAlive) {
                    keyboard.push([{ text: `❌ Eliminate ${p.order}. ${p.name}`, callback_data: `eliminateconfirm_${gameId}_${p.id}` }]);
                }
            });
        }
        let dashboardText = `📋 Game Dashboard (Status: ${game.status})`;
        await this.deleteLastReveal(game);
        if (!anyUnrevealed && game.status === GAME_STATUS.ACTIVE) {
            dashboardText += '\n\n<b>Players with Roles:</b>';
            game.players.forEach(p => {
                dashboardText += `\n${p.order}. ${p.name} - ${p.role} ${p.isAlive ? '💚' : '💀'}`;
            });
        }
        await this.send(chatId, dashboardText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
    }

    private async deleteLastReveal(game: Game) {
        if (game.lastRevealChatId && game.lastRevealMessageId) {
            await this.tg('deleteMessage', { chat_id: game.lastRevealChatId, message_id: game.lastRevealMessageId });
        }
    }

    private async onCallback(cb: any) {
        const [action, gameId, userIdStr] = (cb.data || '').split('_');
        const game = this.games.get(gameId);
        if (!game) return;
        const chatId: number = cb.message.chat.id;
        const isOwner = game.ownerId === cb.from.id;
        switch (action) {
            case 'startgame': {
                if (!isOwner) return this.answer(cb.id, MESSAGES.NOT_AUTHORIZED);
                if (game.players.length !== game.maxPlayers) return this.answer(cb.id, `Need ${game.maxPlayers} players to start!`);
                this.randomizeGame(game);
                game.status = GAME_STATUS.ACTIVE;
                await this.send(chatId, '🎲 Roles assigned. Refresh dashboard to proceed.');
                break;
            }
            case 'reveal': {
                if (!isOwner) return this.answer(cb.id, MESSAGES.NOT_AUTHORIZED);
                const player = game.players.find(p => p.id === Number(userIdStr));
                if (!player || !player.role) return;
                player.revealed = true;
                await this.deleteLastReveal(game);
                const sentMsg = await this.sendPhoto(chatId, ROLE_IMAGES[player.role], `🎭 ${player.name} is ${player.role}`);
                if (sentMsg) {
                    game.lastRevealChatId = sentMsg.chat.id;
                    game.lastRevealMessageId = sentMsg.message_id;
                }
                await this.sendPhoto(player.id, ROLE_IMAGES[player.role], `🎭 Your role is ${player.role}`);
                break;
            }
            case 'revealall': {
                if (!isOwner) return this.answer(cb.id, MESSAGES.NOT_AUTHORIZED);
                const unrevealed = game.players.filter(p => !p.revealed);
                if (unrevealed.length === 0) break;
                await this.deleteLastReveal(game);
                unrevealed.forEach(p => { p.revealed = true; });
                await Promise.all(unrevealed.map(p =>
                    p.role ? this.sendPhoto(p.id, ROLE_IMAGES[p.role], `🎭 Your role is ${p.role}`) : null));
                const mafiaPlayers = game.players.filter(p => p.role === ROLES.MAFIA || p.role === ROLES.DON);
                await Promise.all(mafiaPlayers.map(player => {
                    const teammates = mafiaPlayers
                        .filter(p => p.id !== player.id)
                        .map(p => `${p.name}${p.username ? ` (@${p.username})` : ''} - ${p.role}`)
                        .join(', ');
                    return this.send(player.id, `🤝 Mafia teammates: ${teammates}`);
                }));
                await this.send(chatId, '🎭 All roles have been revealed.');
                break;
            }
            case 'eliminateconfirm': {
                if (!isOwner) return this.answer(cb.id, MESSAGES.NOT_AUTHORIZED);
                const targetId = Number(userIdStr);
                const playerName = game.players.find(p => p.id === targetId)?.name;
                await this.send(chatId, `⚠️ Confirm elimination of <b>${playerName}</b>?`, {
                    parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[
                        { text: '✅ Yes', callback_data: `eliminate_${gameId}_${targetId}` },
                        { text: '❌ No', callback_data: `cancel_${gameId}` },
                    ]] },
                });
                break;
            }
            case 'eliminate': {
                if (!isOwner) return this.answer(cb.id, MESSAGES.NOT_AUTHORIZED);
                const player = game.players.find(p => p.id === Number(userIdStr));
                if (!player || !player.isAlive) return;
                player.isAlive = false;
                await this.send(chatId, `☠️ ${player.name} has been eliminated.`);
                await this.answer(cb.id);
                const winner = checkWinCondition(game);
                if (winner) await this.endGame(game, winner);
                return;
            }
            case 'cancel': {
                await this.send(chatId, '❎ Elimination cancelled.');
                break;
            }
        }
        await this.answer(cb.id);
    }
}
