import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
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
    GameStatus,
    Player,
    Game,
    shuffleArray,
    generateRoles,
    checkWinCondition,
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

const randomizeGame = (game: Game) => {
    const roles = generateRoles(game.maxPlayers, game.maxMafia);
    game.players = shuffleArray(game.players).map((player, index) => ({
        ...player,
        role: roles[index],
        order: index + 1,
        revealed: false,
    }));
};


const endGame = (game: Game, winner: string) => {
    game.status = GAME_STATUS.ENDED;
    const activeNonCivilians = game.players
        .filter(p => p.role !== ROLES.CIVILIAN)
        .map(p => `${p.name}: ${p.role}`)
        .join('\n');
    const message = `🏆 ${winner} win!\n\n📜 Active Roles:\n${activeNonCivilians}`;
    bot.sendMessage(game.ownerId, message);
    game.players.forEach(p => {
        bot.sendMessage(p.id, message);
    });
};

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

bot.onText(/\/abortgame$/, (msg) => {
    const userId = msg.from?.id;
    if (!userId) return;
    if (userGames.has(userId)) {
        const existingGameId = userGames.get(userId)!;
        if (games.get(existingGameId)?.ownerId !== userId) return bot.sendMessage(msg.chat.id, `${MESSAGES.NOT_AUTHORIZED_CHAT}`);
        games.delete(existingGameId);
        userGames.delete(userId);
        return bot.sendMessage(msg.chat.id, 'Game was aborted!');
    }
});

bot.onText(/\/creategame(?:\s+(\d+)\s+(\d+))?$/, (msg, match) => {
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
    const maxPlayers = match && match[1] ? parseInt(match[1], 10) : DEFAULT_PLAYERS_COUNT;
    const maxMafia = match && match[2] ? parseInt(match[2], 10) : DEFAULT_MAFIA_COUNT;
    const gameId = Date.now().toString();
    const newGame: Game = {
        id: gameId,
        ownerId: userId,
        ownerName: name,
        players: [],
        maxPlayers,
        maxMafia,
        status: GAME_STATUS.WAITING,
    };
    games.set(gameId, newGame);
    userGames.set(userId, gameId);
    const joinLink = `https://t.me/${BOT_USERNAME}?start=join_${gameId}`;
    bot.sendMessage(msg.chat.id, `🎮 Game created! Game ID: ${gameId}\nMax Players: ${maxPlayers}\nMax Mafia: ${maxMafia}\nJoin link: ${joinLink}`, {
        reply_markup: { inline_keyboard: [[{ text: 'Join Game', url: joinLink }]] }
    });
    bot.sendMessage(msg.chat.id, OWNER_HELP_TEXT);
});

const handleJoin = (msg: TelegramBot.Message, match:RegExpExecArray | null) => {
    const userId = msg.from?.id;
    const userName = msg.from?.first_name || 'Player';
    const userUsername = msg.from?.username;
    const chatId = msg.chat.id;
    if (!userId) return;

    const gameId = match![1];
    const game = games.get(gameId);
    if (!game) return bot.sendMessage(chatId, '❌ Game not found!');

    if (game.ownerId === userId) return bot.sendMessage(chatId, '❌ Game owner cannot join their own game!');
    if (game.status === GAME_STATUS.ENDED) return bot.sendMessage(chatId, '❌ Cannot join an ended game!');
    if (game.players.length >= game.maxPlayers) return bot.sendMessage(chatId, '❌ Game full!');
    if (game.players.some(p => p.id === userId)) {
        return bot.sendMessage(chatId, '❌ Already joined!');
    }
    game.players.push({ id: userId, name: userName, username: userUsername, role: null, isAlive: true, order: game.players.length, revealed: false });
    userGames.set(userId, gameId);
    bot.sendMessage(chatId, '✅ Joined successfully!');
    bot.sendMessage(game.ownerId, `🎯 ${userName} joined! (${game.players.length}/${game.maxPlayers})`);
};

bot.onText(/\/start join_(.+)/, (msg, match) => {
    handleJoin(msg, match);
});

bot.onText(/\/joingame (.+)/, (msg, match) => {
    handleJoin(msg, match);
});

bot.onText(/\/startgame$/, msg => {
    const userId = msg.from?.id;
    const existingGameId = userGames.get(userId!);
    if (!existingGameId) return bot.sendMessage(msg.chat.id, '❌ No game found!');
    const game = games.get(existingGameId)!;
    if (game.ownerId !== userId || game.players.length !== game.maxPlayers) {
        return bot.sendMessage(msg.chat.id, `❌ Need ${game.maxPlayers} players (excluding owner) to start!`);
    }
    randomizeGame(game);
    game.status = GAME_STATUS.ACTIVE;
    bot.sendMessage(msg.chat.id, '🎲 Roles assigned. Use /dashboard to reveal roles and manage the game.');
});

bot.onText(/\/dashboard$/, msg => {
    const userId = msg.from?.id;
    const gameId = userGames.get(userId!);
    if (!gameId) return bot.sendMessage(msg.chat.id, '❌ No game found!');
    const game = games.get(gameId)!;
    if (game.ownerId !== userId) return bot.sendMessage(msg.chat.id, `${MESSAGES.NOT_AUTHORIZED_CHAT}`);
    if (game.status === GAME_STATUS.ENDED) return bot.sendMessage(msg.chat.id, '⚠️ Game has ended.');
    const anyUnrevealed = game.players.some(p => !p.revealed);
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    if (game.status === GAME_STATUS.WAITING) {
        keyboard.push([{ text: '🚀 Start Game', callback_data: `startgame_${gameId}` }]);
    } else if (anyUnrevealed) {
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

bot.on('callback_query', async cb => {
    const data = cb.data || '';
    const parts = data.split('_');
    const action = parts[0];
    const gameId = parts[1];
    const userIdStr = parts[2];
    const game = games.get(gameId);
    if (!game) return;
    switch (action) {
        case 'startgame': {
            if (game.ownerId !== cb.from.id) return bot.answerCallbackQuery(cb.id, { text: MESSAGES.NOT_AUTHORIZED });
            if (game.players.length !== game.maxPlayers) return bot.answerCallbackQuery(cb.id, { text: `Need ${game.maxPlayers} players to start!` });
            randomizeGame(game);
            game.status = GAME_STATUS.ACTIVE;
            bot.sendMessage(cb.message!.chat.id, '🎲 Roles assigned. Refresh dashboard to proceed.');
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
