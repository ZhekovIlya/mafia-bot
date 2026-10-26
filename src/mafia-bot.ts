import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import {
    GAME_STATUS,
    MESSAGES,
    START_HINT,
    HELP_TEXT,
    OWNER_HELP_TEXT,
    ROLES,
    Role,
    Game,
    Player,
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
} from './util';
import path from 'path';
dotenv.config();

const ROLE_IMAGES: Record<Role, string> = {
    [ROLES.DON]: path.join(__dirname, '../assets/don.png'),
    [ROLES.MAFIA]: path.join(__dirname, '../assets/mafia.png'),
    [ROLES.SHERIFF]: path.join(__dirname, '../assets/sheriff.png'),
    [ROLES.DOCTOR]: path.join(__dirname, '../assets/doc.png'),
    [ROLES.CIVILIAN]: path.join(__dirname, '../assets/civilian.png'),
};

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME;
// Comma-separated Telegram user ids allowed to use /addtest
const ADMIN_IDS = parseAdminIds(process.env.ADMIN_IDS);

if (!BOT_TOKEN) {
    throw new Error('BOT_TOKEN is required.');
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });



const games = new Map<string, Game>();
const userGames = new Map<number, string>();
// Users who have DMed the bot, so we know it can message them.
const knownUsers = new Set<number>();

const randomizeGame = (game: Game) => {
    const roles = generateRoles(game.maxPlayers, game.maxMafia);
    game.players = shuffleArray(game.players).map((player, index) => ({
        ...player,
        role: roles[index],
        order: index + 1,
        revealed: false,
    }));
};

// Fake test players have no Telegram chat: never message them.
const isTest = (id: number) => isTestId(games.values(), id);

// DM that must never throw (e.g. the user blocked the bot).
const dm = (chatId: number, text: string, options?: TelegramBot.SendMessageOptions) =>
    isTest(chatId)
        ? Promise.resolve(null)
        : bot.sendMessage(chatId, text, options).catch(err => console.error('sendMessage failed:', err?.message ?? err));

const dmPhoto = (chatId: number, photo: string, caption: string) =>
    isTest(chatId)
        ? Promise.resolve(null)
        : bot.sendPhoto(chatId, photo, { caption }).catch(err => console.error('sendPhoto failed:', err?.message ?? err));

// Edits the one live dashboard message to the current state. No dashboard stored: nothing to do.
// Failed edits (including "message is not modified") are logged and never break the flow.
const refreshDashboard = async (game: Game) => {
    const d = game.dashboard;
    if (!d?.messageId) return;
    const view = renderDashboard(game);
    await bot.editMessageText(view.text, {
        chat_id: d.chatId,
        message_id: d.messageId,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: view.keyboard } as TelegramBot.InlineKeyboardMarkup,
    }).catch(err => console.error('editMessageText (dashboard) failed:', err?.message ?? err));
};

// Sends a fresh live dashboard (deleting the previous one) and remembers its message ids.
// mafia: open the lock/setup confirmation instead of the panel.
const sendDashboard = async (game: Game, chatId: number, mafia?: number) => {
    const old = game.dashboard;
    if (old?.messageId) await bot.deleteMessage(old.chatId, old.messageId).catch(err => console.error('deleteMessage failed:', err?.message ?? err));
    game.dashboard = { chatId, messageId: 0, mafia };
    const view = renderDashboard(game);
    try {
        const sent = await bot.sendMessage(chatId, view.text, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: view.keyboard } as TelegramBot.InlineKeyboardMarkup,
        });
        game.dashboard.messageId = sent.message_id;
    } catch (err: any) {
        console.error('sendMessage failed:', err?.message ?? err);
        delete game.dashboard;
    }
};

// Re-renders every lobby message of a game (and the live dashboard, whose waiting-phase panel
// lists the same players); failed edits are logged and never break the flow.
const refreshLobby = async (game: Game) => {
    await refreshDashboard(game);
    const base = { parse_mode: 'HTML' as const };
    const text = renderLobby(game);
    const edits: Promise<unknown>[] = [
        ...(game.lobbyMessages ?? []).map(m => bot.editMessageText(text, {
            ...base,
            chat_id: m.chatId,
            message_id: m.messageId,
            reply_markup: { inline_keyboard: lobbyKeyboard(game, m.share) } as TelegramBot.InlineKeyboardMarkup,
        })),
        ...(game.lobbyInlineIds ?? []).map(id => bot.editMessageText(text, {
            ...base,
            inline_message_id: id,
            reply_markup: { inline_keyboard: lobbyKeyboard(game) } as TelegramBot.InlineKeyboardMarkup,
        })),
    ];
    await Promise.all(edits.map(e => e.catch(err => console.error('editMessageText failed:', err?.message ?? err))));
};

const addInlineId = (game: Game, inlineId: string | undefined) => {
    if (!inlineId) return;
    game.lobbyInlineIds ??= [];
    if (!game.lobbyInlineIds.includes(inlineId)) game.lobbyInlineIds.push(inlineId);
};

const endGame = async (game: Game, winner: string) => {
    game.status = GAME_STATUS.ENDED;
    game.winner = winner;
    const activeNonCivilians = game.players
        .filter(p => p.role !== ROLES.CIVILIAN)
        .map(p => `${playerLabel(p)}: ${p.role}`)
        .join('\n');
    const message = `🏆 ${winner} win!\n\n📜 Active Roles:\n${activeNonCivilians}`;
    dm(game.ownerId, message);
    game.players.forEach(p => {
        dm(p.id, message);
    });
    // Also turns the dashboard into the final summary.
    await refreshLobby(game);
};

// Adds a user to a waiting lobby. ok=false carries the reason to show the user.
const addInterested = async (game: Game, from: TelegramBot.User): Promise<{ ok: boolean; text: string }> => {
    const id = from.id;
    if (game.status !== GAME_STATUS.WAITING) return { ok: false, text: 'This game is closed.' };
    if (game.ownerId === id) return { ok: false, text: 'You\'re the host 🙂' };
    if (game.players.some(p => p.id === id)) {
        if (refreshIdentity(game, from)) await refreshLobby(game);
        return { ok: false, text: 'You\'re already in ✅' };
    }
    // One waiting lobby at a time; a running game blocks joining another.
    const otherId = userGames.get(id);
    const other = otherId && otherId !== game.id ? games.get(otherId) : undefined;
    if (other && other.status !== GAME_STATUS.ENDED) {
        if (other.ownerId === id) return { ok: false, text: 'You\'re hosting another game.' };
        if (other.status === GAME_STATUS.ACTIVE) return { ok: false, text: 'You\'re already in a running game.' };
        other.players = other.players.filter(p => p.id !== id);
        await refreshLobby(other);
    }
    const player: Player = { id, name: fullName(from), username: from.username, role: null, isAlive: true, order: game.players.length, revealed: false };
    game.players.push(player);
    userGames.set(id, game.id);
    await refreshLobby(game);
    dm(game.ownerId, `🙋 ${playerLabel(player)} is in (${game.players.length} interested)`);
    return { ok: true, text: 'You\'re in! ✅' };
};

// Removes a user from a lobby by their own choice; returns the text to show them.
const removeInterested = async (game: Game, from: TelegramBot.User): Promise<string> => {
    const inList = game.players.some(p => p.id === from.id);
    if (game.status !== GAME_STATUS.WAITING) {
        return inList && game.status === GAME_STATUS.ACTIVE ? 'Roster is locked — ask the host.' : 'This game is closed.';
    }
    if (!inList) return 'You weren\'t on the list.';
    const leaver = playerLabel({ name: fullName(from), username: from.username });
    game.players = game.players.filter(p => p.id !== from.id);
    if (userGames.get(from.id) === game.id) userGames.delete(from.id);
    await refreshLobby(game);
    dm(game.ownerId, `🙅 ${leaver} dropped out (${game.players.length} interested)`);
    return 'Got it, you\'re out.';
};

bot.on('message', async msg => {
    // Only a private message proves the bot can DM this user.
    if (msg.from && msg.chat.type === 'private') knownUsers.add(msg.from.id);
    // Keep the stored name/username of the host and listed players fresh.
    if (msg.from) {
        const mine = games.get(userGames.get(msg.from.id) ?? '');
        if (mine && refreshIdentity(mine, msg.from)) await refreshLobby(mine);
    }
});

bot.onText(/\/start$/, msg => {
    bot.sendMessage(msg.chat.id, START_HINT);
});

bot.onText(/\/help$/, msg => {
    const userId = msg.from?.id;
    bot.sendMessage(msg.chat.id, HELP_TEXT);
    if (!userId) return;
    const existingGameId = userGames.get(userId);
    if (!existingGameId) return;
    const game = games.get(existingGameId);
    if (game?.ownerId === userId) {
        bot.sendMessage(msg.chat.id, OWNER_HELP_TEXT);
    }
});

bot.onText(/\/abortgame$/, async (msg) => {
    const userId = msg.from?.id;
    if (!userId) return;
    if (userGames.has(userId)) {
        const existingGameId = userGames.get(userId)!;
        const game = games.get(existingGameId);
        if (!game) {
            userGames.delete(userId);
            return;
        }
        if (game.ownerId !== userId) return bot.sendMessage(msg.chat.id, `${MESSAGES.NOT_AUTHORIZED_CHAT}`);
        game.cancelled = true;
        await refreshLobby(game);
        game.players.forEach(p => {
            if (userGames.get(p.id) === existingGameId) userGames.delete(p.id);
        });
        games.delete(existingGameId);
        userGames.delete(userId);
        return bot.sendMessage(msg.chat.id, 'Game was aborted!');
    }
});

bot.onText(/\/creategame(?:\s+([\s\S]+))?$/, async (msg, match) => {
    const userId = msg.from?.id;
    if (!userId) return;
    if (userGames.has(userId)) {
        const existingGameId = userGames.get(userId)!;
        const existingGame = games.get(existingGameId);
        if (existingGame && existingGame.status !== GAME_STATUS.ENDED) {
            return bot.sendMessage(msg.chat.id, '❌ You are already in an active game!');
        }
        userGames.delete(userId);
    }
    const name = msg.from ? fullName(msg.from, 'admin') : 'admin';
    // Old "[players] [mafia]" numbers just become part of the title.
    const game = newLobbyGame(userId, name, match?.[1], msg.from?.username);
    games.set(game.id, game);
    userGames.set(userId, game.id);
    const sent = await bot.sendMessage(msg.chat.id, renderLobby(game), {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: lobbyKeyboard(game, true) } as TelegramBot.InlineKeyboardMarkup,
    });
    game.lobbyMessages!.push({ chatId: sent.chat.id, messageId: sent.message_id, share: true });
    bot.sendMessage(msg.chat.id, OWNER_HELP_TEXT, { parse_mode: 'HTML' });
});

const handleJoin = async (msg: TelegramBot.Message, match: RegExpExecArray | null) => {
    const userId = msg.from?.id;
    const chatId = msg.chat.id;
    if (!userId) return;

    const gameId = match![1].trim();
    const game = games.get(gameId);
    if (!game) return bot.sendMessage(chatId, '❌ Game not found!');
    // 'text' handlers can run before the generic 'message' listener, so record the user here too.
    if (msg.chat.type === 'private') knownUsers.add(userId);
    if (!knownUsers.has(userId)) {
        return bot.sendMessage(chatId, `Open https://t.me/${BOT_USERNAME}?start=in_${gameId} and press Start to join.`);
    }
    const res = await addInterested(game, msg.from!);
    if (!res.ok) return bot.sendMessage(chatId, `❌ ${res.text}`);
    bot.sendMessage(chatId, `✅ You're on the list for ${gameTitle(game)}. I'll send your role here when the host deals.`);
};

bot.onText(/\/start (?:in|join)_(.+)/, (msg, match) => {
    handleJoin(msg, match);
});

bot.onText(/\/joingame (.+)/, (msg, match) => {
    handleJoin(msg, match);
});

bot.onText(/\/leave$/, async msg => {
    const userId = msg.from?.id;
    if (!userId) return;
    const game = games.get(userGames.get(userId) ?? '');
    if (!game) return bot.sendMessage(msg.chat.id, 'You\'re not on any lobby.');
    bot.sendMessage(msg.chat.id, await removeInterested(game, msg.from!));
});

bot.onText(/\/startgame$/, msg => {
    const userId = msg.from?.id;
    const game = games.get(userGames.get(userId!) ?? '');
    if (!game) return bot.sendMessage(msg.chat.id, '❌ No game found!');
    if (game.ownerId !== userId) return bot.sendMessage(msg.chat.id, `${MESSAGES.NOT_AUTHORIZED_CHAT}`);
    if (game.status !== GAME_STATUS.WAITING) return bot.sendMessage(msg.chat.id, '❌ Roles are already assigned.');
    const err = validateSetup(game.players.length, suggestMafia(game.players.length));
    if (err) return bot.sendMessage(msg.chat.id, `❌ ${err}`);
    sendDashboard(game, msg.chat.id, suggestMafia(game.players.length));
});

bot.onText(/\/dashboard$/, async msg => {
    const userId = msg.from?.id;
    const gameId = userGames.get(userId!);
    if (!gameId) return bot.sendMessage(msg.chat.id, '❌ No game found!');
    const game = games.get(gameId)!;
    if (game.ownerId !== userId) return bot.sendMessage(msg.chat.id, `${MESSAGES.NOT_AUTHORIZED_CHAT}`);
    if (game.status === GAME_STATUS.ENDED) return bot.sendMessage(msg.chat.id, '⚠️ Game has ended.');
    if (game.status === GAME_STATUS.ACTIVE && game.lastRevealChatId && game.lastRevealMessageId) {
        await bot.deleteMessage(game.lastRevealChatId, game.lastRevealMessageId).catch(() => undefined);
    }
    await sendDashboard(game, msg.chat.id);
});

// Admin-only: add or remove fake players in the host's waiting lobby.
const testPlayers = async (msg: TelegramBot.Message, action: 'add' | 'clear', countText?: string) => {
    const userId = msg.from?.id;
    const chatId = msg.chat.id;
    if (!userId) return;
    if (msg.chat.type !== 'private') return bot.sendMessage(chatId, '❌ Use this command in a private chat with the bot.');
    if (!ADMIN_IDS.has(userId)) {
        return bot.sendMessage(chatId, `❌ Test mode is for admins. Your Telegram id is ${userId} — add it to ADMIN_IDS to enable.`);
    }
    const game = games.get(userGames.get(userId) ?? '');
    if (!game || game.ownerId !== userId || game.status === GAME_STATUS.ENDED) {
        return bot.sendMessage(chatId, '❌ Create a game first with /creategame.');
    }
    if (game.status !== GAME_STATUS.WAITING) return bot.sendMessage(chatId, '❌ Test players can only be changed while the lobby is open.');
    if (action === 'add') {
        const n = clampTestCount(countText);
        addTestPlayers(game, n, games.values());
        await refreshLobby(game);
        bot.sendMessage(chatId, `🤖 Added ${n} test players (${game.players.length} interested)`);
    } else {
        const removed = clearTestPlayers(game);
        await refreshLobby(game);
        bot.sendMessage(chatId, `🤖 Removed ${removed} test players (${game.players.length} interested)`);
    }
};

bot.onText(/\/addtest(?:\s+(\S+))?$/, (msg, match) => {
    testPlayers(msg, 'add', match?.[1]);
});

bot.onText(/\/cleartest$/, msg => {
    testPlayers(msg, 'clear');
});

// Inline mode: `@bot <title or gameId>` offers the host's lobby to post anywhere.
bot.on('inline_query', async q => {
    const from = q.from;
    const text = (q.query ?? '').trim();
    let game = hostedOpenGame(games, userGames, from.id);
    if (game && game.status !== GAME_STATUS.WAITING) {
        game = undefined; // roster already locked, nothing to post
    } else if (!game) {
        const existing = games.get(userGames.get(from.id) ?? '');
        if (!existing || existing.status === GAME_STATUS.ENDED) {
            game = newLobbyGame(from.id, fullName(from, 'admin'), text, from.username);
            games.set(game.id, game);
            userGames.set(from.id, game.id);
        }
    } else if (text && text !== game.id && !game.lobbyMessages?.length && !game.lobbyInlineIds?.length) {
        // Nothing posted yet: keep the title in sync while the host is still typing.
        game.title = cleanTitle(text);
    }
    const results: TelegramBot.InlineQueryResult[] = game ? [{
        type: 'article',
        id: game.id,
        title: `🎭 Post Mafia lobby: ${gameTitle(game)}`,
        description: `${game.players.length} interested`,
        input_message_content: { message_text: renderLobby(game), parse_mode: 'HTML' },
        reply_markup: { inline_keyboard: lobbyKeyboard(game) } as TelegramBot.InlineKeyboardMarkup,
    }] : [];
    try {
        await bot.answerInlineQuery(q.id, results, { cache_time: 0, is_personal: true });
    } catch (err: any) {
        console.error('answerInlineQuery failed:', err?.message ?? err);
    }
});

bot.on('chosen_inline_result', r => {
    const game = games.get(r.result_id);
    if (game) addInlineId(game, r.inline_message_id);
});

const lockAndDeal = async (game: Game, mafia: number) => {
    game.maxPlayers = game.players.length;
    game.maxMafia = mafia;
    randomizeGame(game);
    game.status = GAME_STATUS.ACTIVE;
    if (game.dashboard) delete game.dashboard.mafia;
    // Also turns the dashboard message into the active dashboard.
    await refreshLobby(game);
    game.players.forEach(p => {
        dm(p.id, `🔒 Roster locked — you're playing in ${gameTitle(game)}! Your role is coming soon.`);
    });
};

// Callbacks that drive the owner dashboard (all owner-only).
const DASHBOARD_ACTIONS = new Set([
    'lkick', 'llock', 'lmafia', 'lback', 'ldeal',
    'reveal', 'revealall', 'eliminateconfirm', 'eliminate', 'elimno', 'cancel',
]);

// Deletes the message a callback button was on (errors ignored).
const deleteTapped = (cb: TelegramBot.CallbackQuery) =>
    cb.message
        ? bot.deleteMessage(cb.message.chat.id, cb.message.message_id).catch(err => console.error('deleteMessage failed:', err?.message ?? err))
        : Promise.resolve();

bot.on('callback_query', async cb => {
    const data = cb.data || '';
    const parts = data.split('_');
    const action = parts[0];
    const gameId = parts[1];
    const userIdStr = parts[2];
    const game = games.get(gameId);
    if (game && refreshIdentity(game, cb.from)) await refreshLobby(game);
    if (!game) {
        // Old clutter (e.g. a stale confirm message of a finished game): answer and tidy up.
        if (action === 'cancel' || action === 'elimno') await deleteTapped(cb);
        return bot.answerCallbackQuery(cb.id, action.startsWith('l') ? { text: 'This game is closed.' } : undefined);
    }
    // Fallback capture of an inline-posted lobby in case chosen_inline_result is not enabled.
    addInlineId(game, cb.inline_message_id);
    const isOwner = game.ownerId === cb.from.id;
    const waiting = game.status === GAME_STATUS.WAITING;
    const active = game.status === GAME_STATUS.ACTIVE;
    const chatId = cb.message?.chat.id;
    let toast: string | undefined;

    if (DASHBOARD_ACTIONS.has(action)) {
        if (!isOwner) return bot.answerCallbackQuery(cb.id, { text: MESSAGES.NOT_AUTHORIZED });
        // Old two-message elimination flow: just tidy up, never act.
        if (action === 'cancel') {
            await deleteTapped(cb);
            return bot.answerCallbackQuery(cb.id);
        }
        if (!cb.message || chatId === undefined) return bot.answerCallbackQuery(cb.id);
        if (!game.dashboard?.messageId) {
            // No live dashboard yet (e.g. /startgame confirm or pre-upgrade message): adopt this one.
            game.dashboard = { chatId, messageId: cb.message.message_id };
        } else if (game.dashboard.chatId !== chatId || game.dashboard.messageId !== cb.message.message_id) {
            // Button of an outdated dashboard: act on the game, show the result on the current one.
            await deleteTapped(cb);
        }
    }

    switch (action) {
        case 'lin': {
            if (!waiting) return bot.answerCallbackQuery(cb.id, { text: 'This game is closed.' });
            if (isOwner) return bot.answerCallbackQuery(cb.id, { text: 'You\'re the host 🙂' });
            if (!knownUsers.has(cb.from.id)) {
                // Bot can't DM them yet: send them to the bot to press Start.
                return bot.answerCallbackQuery(cb.id, { url: `https://t.me/${BOT_USERNAME}?start=in_${gameId}` });
            }
            const res = await addInterested(game, cb.from);
            return bot.answerCallbackQuery(cb.id, { text: res.text });
        }
        case 'lout': {
            return bot.answerCallbackQuery(cb.id, { text: await removeInterested(game, cb.from) });
        }
        case 'lkick': {
            if (!waiting) return bot.answerCallbackQuery(cb.id, { text: 'This game is closed.' });
            const targetId = Number(userIdStr);
            if (game.players.some(p => p.id === targetId)) {
                game.players = game.players.filter(p => p.id !== targetId);
                if (userGames.get(targetId) === game.id) userGames.delete(targetId);
                await refreshLobby(game);
                dm(targetId, `ℹ️ The host removed you from ${gameTitle(game)}. Tap I'm in again if you can make it.`);
            } else {
                await refreshDashboard(game);
            }
            break;
        }
        case 'llock':
        case 'lmafia':
        case 'lback':
        case 'ldeal': {
            if (!waiting) return bot.answerCallbackQuery(cb.id, { text: 'This game is closed.' });
            const n = game.players.length;
            if (action === 'lback') {
                delete game.dashboard!.mafia;
                await refreshDashboard(game);
                break;
            }
            const mafia = action === 'llock' ? suggestMafia(n) : Number(userIdStr);
            const err = validateSetup(n, mafia);
            if (err) return bot.answerCallbackQuery(cb.id, { text: err });
            if (action === 'ldeal') {
                await lockAndDeal(game, mafia);
                toast = '🎲 Roles assigned — reveal them below.';
            } else {
                game.dashboard!.mafia = mafia;
                await refreshDashboard(game);
            }
            break;
        }
        case 'reveal': {
            const player = game.players.find(p => p.id === Number(userIdStr));
            if (!active || !player || !player.role) break;
            player.revealed = true;
            const roleImage = ROLE_IMAGES[player.role];
            if (game.lastRevealChatId && game.lastRevealMessageId) {
                try {
                    await bot.deleteMessage(game.lastRevealChatId, game.lastRevealMessageId);
                } catch {
                }
            }
            const sentMsg = await bot.sendPhoto(chatId!, roleImage, { caption: `🎭 ${playerLabel(player)} is ${player.role}` });
            game.lastRevealChatId = sentMsg.chat.id;
            game.lastRevealMessageId = sentMsg.message_id;
            await dmPhoto(player.id, roleImage, `🎭 Your role is ${player.role}`);
            const mates = teammatesText(game, player);
            if (mates) await dm(player.id, mates);
            await refreshDashboard(game);
            break;
        }
        case 'revealall': {
            const unrevealed = game.players.filter(p => !p.revealed);
            if (!active || unrevealed.length === 0) break;
            if (game.lastRevealChatId && game.lastRevealMessageId) {
                try {
                    await bot.deleteMessage(game.lastRevealChatId, game.lastRevealMessageId);
                } catch {
                }
            }
            unrevealed.forEach(p => {
                p.revealed = true;
            });
            await Promise.all(
                unrevealed.map(p => {
                    if (!p.role) return Promise.resolve();
                    return dmPhoto(p.id, ROLE_IMAGES[p.role], `🎭 Your role is ${p.role}`);
                })
            );
            await Promise.all(
                game.players.map(p => {
                    const mates = teammatesText(game, p);
                    return mates ? dm(p.id, mates) : null;
                }),
            );
            await bot.sendMessage(chatId!, '🎭 All roles have been revealed.');
            await refreshDashboard(game);
            break;
        }
        case 'eliminateconfirm': {
            const target = game.players.find(p => p.id === Number(userIdStr));
            if (active && target?.isAlive) game.dashboard!.eliminate = target.id;
            await refreshDashboard(game);
            break;
        }
        case 'elimno': {
            delete game.dashboard!.eliminate;
            await refreshDashboard(game);
            toast = 'Cancelled';
            break;
        }
        case 'eliminate': {
            delete game.dashboard!.eliminate;
            const player = game.players.find(p => p.id === Number(userIdStr));
            if (!active || !player || !player.isAlive) {
                await refreshDashboard(game);
                break;
            }
            player.isAlive = false;
            await bot.sendMessage(chatId!, `☠️ ${playerLabel(player)} has been eliminated.`);
            const winner = checkWinCondition(game);
            // endGame refreshes the dashboard into the final summary.
            if (winner) await endGame(game, winner);
            else await refreshDashboard(game);
            break;
        }
    }
    bot.answerCallbackQuery(cb.id, toast ? { text: toast } : undefined);
});

bot.on('polling_error', console.error);

// A failed send (e.g. a player blocked the bot) must not crash the whole bot.
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught exception:', err));

console.log('🎭 Mafia Bot Running');
