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
    renderPanel,
    renderConfirm,
    suggestMafia,
    validateSetup,
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

// DM that must never throw (e.g. the user blocked the bot).
const dm = (chatId: number, text: string, options?: TelegramBot.SendMessageOptions) =>
    bot.sendMessage(chatId, text, options).catch(err => console.error('sendMessage failed:', err?.message ?? err));

// Re-renders every lobby message of a game; failed edits are logged and never break the flow.
const refreshLobby = async (game: Game) => {
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

// Edits a plain-text owner panel message in place.
const editPanel = (cb: TelegramBot.CallbackQuery, view: { text: string; keyboard: Keyboard }) =>
    bot.editMessageText(view.text, {
        chat_id: cb.message!.chat.id,
        message_id: cb.message!.message_id,
        reply_markup: { inline_keyboard: view.keyboard } as TelegramBot.InlineKeyboardMarkup,
    }).catch(err => console.error('editMessageText failed:', err?.message ?? err));

const endGame = (game: Game, winner: string) => {
    game.status = GAME_STATUS.ENDED;
    game.winner = winner;
    const activeNonCivilians = game.players
        .filter(p => p.role !== ROLES.CIVILIAN)
        .map(p => `${p.name}: ${p.role}`)
        .join('\n');
    const message = `🏆 ${winner} win!\n\n📜 Active Roles:\n${activeNonCivilians}`;
    bot.sendMessage(game.ownerId, message);
    game.players.forEach(p => {
        bot.sendMessage(p.id, message);
    });
    refreshLobby(game);
};

// Adds a user to a waiting lobby. ok=false carries the reason to show the user.
const addInterested = async (game: Game, from: TelegramBot.User): Promise<{ ok: boolean; text: string }> => {
    const id = from.id;
    if (game.status !== GAME_STATUS.WAITING) return { ok: false, text: 'This game is closed.' };
    if (game.ownerId === id) return { ok: false, text: 'You\'re the host 🙂' };
    if (game.players.some(p => p.id === id)) return { ok: false, text: 'You\'re already in ✅' };
    // One waiting lobby at a time; a running game blocks joining another.
    const otherId = userGames.get(id);
    const other = otherId && otherId !== game.id ? games.get(otherId) : undefined;
    if (other && other.status !== GAME_STATUS.ENDED) {
        if (other.ownerId === id) return { ok: false, text: 'You\'re hosting another game.' };
        if (other.status === GAME_STATUS.ACTIVE) return { ok: false, text: 'You\'re already in a running game.' };
        other.players = other.players.filter(p => p.id !== id);
        await refreshLobby(other);
    }
    const name = from.first_name || 'Player';
    game.players.push({ id, name, username: from.username, role: null, isAlive: true, order: game.players.length, revealed: false });
    userGames.set(id, game.id);
    await refreshLobby(game);
    dm(game.ownerId, `🙋 ${name} is in (${game.players.length} interested)`);
    return { ok: true, text: 'You\'re in! ✅' };
};

// Removes a user from a lobby by their own choice; returns the text to show them.
const removeInterested = async (game: Game, from: TelegramBot.User): Promise<string> => {
    const inList = game.players.some(p => p.id === from.id);
    if (game.status !== GAME_STATUS.WAITING) {
        return inList && game.status === GAME_STATUS.ACTIVE ? 'Roster is locked — ask the host.' : 'This game is closed.';
    }
    if (!inList) return 'You weren\'t on the list.';
    game.players = game.players.filter(p => p.id !== from.id);
    if (userGames.get(from.id) === game.id) userGames.delete(from.id);
    await refreshLobby(game);
    dm(game.ownerId, `🙅 ${from.first_name || 'Player'} dropped out (${game.players.length} interested)`);
    return 'Got it, you\'re out.';
};

bot.on('message', msg => {
    // Only a private message proves the bot can DM this user.
    if (msg.from && msg.chat.type === 'private') knownUsers.add(msg.from.id);
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
    const name = msg.from?.first_name ?? 'admin';
    // Old "[players] [mafia]" numbers just become part of the title.
    const game = newLobbyGame(userId, name, match?.[1]);
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
    const view = renderConfirm(game, suggestMafia(game.players.length));
    bot.sendMessage(msg.chat.id, view.text, { reply_markup: { inline_keyboard: view.keyboard } as TelegramBot.InlineKeyboardMarkup });
});

bot.onText(/\/dashboard$/, msg => {
    const userId = msg.from?.id;
    const gameId = userGames.get(userId!);
    if (!gameId) return bot.sendMessage(msg.chat.id, '❌ No game found!');
    const game = games.get(gameId)!;
    if (game.ownerId !== userId) return bot.sendMessage(msg.chat.id, `${MESSAGES.NOT_AUTHORIZED_CHAT}`);
    if (game.status === GAME_STATUS.ENDED) return bot.sendMessage(msg.chat.id, '⚠️ Game has ended.');
    if (game.status === GAME_STATUS.WAITING) {
        const view = renderPanel(game);
        return bot.sendMessage(msg.chat.id, view.text, { reply_markup: { inline_keyboard: view.keyboard } as TelegramBot.InlineKeyboardMarkup });
    }
    const anyUnrevealed = game.players.some(p => !p.revealed);
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    if (anyUnrevealed) {
        keyboard.push([{ text: '🔓 Reveal All', callback_data: `revealall_${gameId}` }]);
        game.players.forEach(p => {
            const revealData = `reveal_${gameId}_${p.id}`;
            keyboard.push([{ text: `🎭 Reveal ${p.order}. ${p.name}`, callback_data: revealData }]);
        });
    } else {
        game.players.forEach(p => {
            if (p.isAlive) {
                const eliminateConfirmData = `eliminateconfirm_${gameId}_${p.id}`;
                keyboard.push([{ text: `❌ Eliminate ${p.order}. ${p.name}`, callback_data: eliminateConfirmData }]);
            }
        });
    }
    let dashboardText = `📋 Game Dashboard (Status: ${game.status})`;
    if (game.lastRevealChatId && game.lastRevealMessageId) {
        bot.deleteMessage(game.lastRevealChatId, game.lastRevealMessageId);
    }
    if (!anyUnrevealed && game.status === GAME_STATUS.ACTIVE) {
        dashboardText += '\n\n<b>Players with Roles:</b>';
        game.players.forEach(p => {
            dashboardText += `\n${p.order}. ${p.name} - ${p.role} ${p.isAlive ? '💚' : '💀'}`;
        });
    }
    bot.sendMessage(msg.chat.id, dashboardText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
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
            game = newLobbyGame(from.id, from.first_name ?? 'admin', text);
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

const lockAndDeal = async (game: Game, mafia: number, cb: TelegramBot.CallbackQuery) => {
    game.maxPlayers = game.players.length;
    game.maxMafia = mafia;
    randomizeGame(game);
    game.status = GAME_STATUS.ACTIVE;
    await refreshLobby(game);
    await editPanel(cb, { text: '🔒 Roster locked.', keyboard: [] });
    game.players.forEach(p => {
        dm(p.id, `🔒 Roster locked — you're playing in ${gameTitle(game)}! Your role is coming soon.`);
    });
    dm(game.ownerId, '🎲 Roles assigned. Use /dashboard to reveal roles and manage the game.');
};

bot.on('callback_query', async cb => {
    const data = cb.data || '';
    const parts = data.split('_');
    const action = parts[0];
    const gameId = parts[1];
    const userIdStr = parts[2];
    const game = games.get(gameId);
    if (!game) return bot.answerCallbackQuery(cb.id, action.startsWith('l') ? { text: 'This game is closed.' } : undefined);
    // Fallback capture of an inline-posted lobby in case chosen_inline_result is not enabled.
    addInlineId(game, cb.inline_message_id);
    const isOwner = game.ownerId === cb.from.id;
    const waiting = game.status === GAME_STATUS.WAITING;
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
            if (!isOwner) return bot.answerCallbackQuery(cb.id, { text: MESSAGES.NOT_AUTHORIZED });
            if (!waiting) return bot.answerCallbackQuery(cb.id, { text: 'This game is closed.' });
            const targetId = Number(userIdStr);
            if (game.players.some(p => p.id === targetId)) {
                game.players = game.players.filter(p => p.id !== targetId);
                if (userGames.get(targetId) === game.id) userGames.delete(targetId);
                await refreshLobby(game);
                dm(targetId, `ℹ️ The host removed you from ${gameTitle(game)}. Tap I'm in again if you can make it.`);
            }
            await editPanel(cb, renderPanel(game));
            bot.answerCallbackQuery(cb.id);
            break;
        }
        case 'llock':
        case 'lmafia':
        case 'lback':
        case 'ldeal': {
            if (!isOwner) return bot.answerCallbackQuery(cb.id, { text: MESSAGES.NOT_AUTHORIZED });
            if (!waiting) return bot.answerCallbackQuery(cb.id, { text: 'This game is closed.' });
            const n = game.players.length;
            if (action === 'lback') {
                await editPanel(cb, renderPanel(game));
                bot.answerCallbackQuery(cb.id);
                break;
            }
            const mafia = action === 'llock' ? suggestMafia(n) : Number(userIdStr);
            const err = validateSetup(n, mafia);
            if (err) return bot.answerCallbackQuery(cb.id, { text: err });
            if (action === 'ldeal') {
                await lockAndDeal(game, mafia, cb);
            } else {
                await editPanel(cb, renderConfirm(game, mafia));
            }
            bot.answerCallbackQuery(cb.id);
            break;
        }
        case 'reveal': {
            const targetId = Number(userIdStr);
            if (game.ownerId !== cb.from.id) return bot.answerCallbackQuery(cb.id, { text: MESSAGES.NOT_AUTHORIZED });
            const player = game.players.find(p => p.id === targetId);
            if (!player || !player.role) return;
            player.revealed = true;
            const roleImage = ROLE_IMAGES[player.role];
            if (game.lastRevealChatId && game.lastRevealMessageId) {
                try {
                    await bot.deleteMessage(game.lastRevealChatId, game.lastRevealMessageId);
                } catch {
                }
            }
            const sentMsg = await bot.sendPhoto(cb.message!.chat.id, roleImage, { caption: `🎭 ${player.name} is ${player.role}` });
            game.lastRevealChatId = sentMsg.chat.id;
            game.lastRevealMessageId = sentMsg.message_id;
            await bot.sendPhoto(player.id, roleImage, { caption: `🎭 Your role is ${player.role}` });
            bot.answerCallbackQuery(cb.id);
            break;
        }
        case 'revealall': {
            if (game.ownerId !== cb.from.id) return bot.answerCallbackQuery(cb.id, { text: MESSAGES.NOT_AUTHORIZED });
            const unrevealed = game.players.filter(p => !p.revealed);
            if (unrevealed.length === 0) {
                bot.answerCallbackQuery(cb.id);
                break;
            }
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
                    return bot.sendPhoto(p.id, ROLE_IMAGES[p.role], { caption: `🎭 Your role is ${p.role}` });
                })
            );

            const mafiaPlayers = game.players.filter(
                p => p.role === ROLES.MAFIA || p.role === ROLES.DON,
            );
            await Promise.all(
                mafiaPlayers.map(player => {
                    const teammates = mafiaPlayers
                        .filter(p => p.id !== player.id)
                        .map(
                            p =>
                                `${p.name}${p.username ? ` (@${p.username})` : ''} - ${p.role}`,
                        )
                        .join(', ');
                    return bot.sendMessage(
                        player.id,
                        `🤝 Mafia teammates: ${teammates}`,
                    );
                }),
            );

            await bot.sendMessage(cb.message!.chat.id, '🎭 All roles have been revealed.');
            bot.answerCallbackQuery(cb.id);
            break;
        }
        case 'eliminateconfirm': {
            const targetId = Number(userIdStr);
            if (game.ownerId !== cb.from.id) return bot.answerCallbackQuery(cb.id, { text: MESSAGES.NOT_AUTHORIZED });
            const confirmKeyboard = {
                inline_keyboard: [[
                    { text: '✅ Yes', callback_data: `eliminate_${gameId}_${targetId}` },
                    { text: '❌ No', callback_data: `cancel_${gameId}` }
                ]]
            };
            const playerName = game.players.find(p => p.id === targetId)?.name;
            bot.sendMessage(cb.message!.chat.id, `⚠️ Confirm elimination of <b>${playerName}</b>?`, { parse_mode: 'HTML', reply_markup: confirmKeyboard });
            bot.answerCallbackQuery(cb.id);
            break;
        }
        case 'eliminate': {
            const targetId = Number(userIdStr);
            if (game.ownerId !== cb.from.id) return bot.answerCallbackQuery(cb.id, { text: MESSAGES.NOT_AUTHORIZED });
            const player = game.players.find(p => p.id === targetId);
            if (!player || !player.isAlive) return;
            player.isAlive = false;
            bot.sendMessage(cb.message!.chat.id, `☠️ ${player.name} has been eliminated.`);
            bot.answerCallbackQuery(cb.id);
            const winner = checkWinCondition(game);
            if (winner) endGame(game, winner);
            break;
        }
        case 'cancel': {
            bot.sendMessage(cb.message!.chat.id, '❎ Elimination cancelled.');
            bot.answerCallbackQuery(cb.id);
            break;
        }
        default:
            bot.answerCallbackQuery(cb.id);
    }
});

bot.on('polling_error', console.error);

// A failed send (e.g. a player blocked the bot) must not crash the whole bot.
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));
process.on('uncaughtException', err => console.error('Uncaught exception:', err));

console.log('🎭 Mafia Bot Running');
