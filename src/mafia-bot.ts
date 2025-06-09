import TelegramBot from 'node-telegram-bot-api';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME;

if (!BOT_TOKEN) {
    throw new Error('BOT_TOKEN is required.');
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

interface Player {
    id: number;
    name: string;
    role: string | null;
    isAlive: boolean;
    order: number;
    revealed: boolean;
}

interface Game {
    id: string;
    ownerId: number;
    ownerName: string;
    players: Player[];
    maxPlayers: number;
    maxMafia: number;
    status: 'waiting' | 'active' | 'ended';
    lastRevealChatId?: number;
    lastRevealMessageId?: number;
}

export const ROLE_IMAGES: Record<string, string> = {
    'Mafia Don': path.join(__dirname, '../assets/don.png'),
    'Mafia': path.join(__dirname, '../assets/mafia.png'),
    'Sheriff': path.join(__dirname, '../assets/sheriff.png'),
    'Doctor': path.join(__dirname, '../assets/doc.png'),
    'Civilian': path.join(__dirname, '../assets/civilian.png'),
};

const DEFAULT_PLAYERS_COUNT = 11;
const DEFAULT_MAFIA_COUNT = 3;

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

const shuffleArray = <T>(array: T[]) => {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
};

const generateRoles = (playersTotal: number, mafiaTotal: number) => {
    const roles: string[] = ['Mafia Don'];
    for (let i = 1; i < mafiaTotal; i++) {
        roles.push('Mafia');
    }
    roles.push('Sheriff', 'Doctor');
    while (roles.length < playersTotal) {
        roles.push('Civilian');
    }
    return shuffleArray(roles);
};

const checkWinCondition = (game: Game) => {
    const alivePlayers = game.players.filter(p => p.isAlive);
    const aliveMafia = alivePlayers.filter(p => p.role === 'Mafia' || p.role === 'Mafia Don');
    const aliveCivilians = alivePlayers.filter(p => p.role !== 'Mafia' && p.role !== 'Mafia Don');
    if (aliveMafia.length === 0) return 'Civilians';
    if (aliveMafia.length >= aliveCivilians.length) return 'Mafia';
    return null;
};

const endGame = (game: Game, winner: string) => {
    game.status = 'ended';
    const activeNonCivilians = game.players
        .filter(p => p.role !== 'Civilian')
        .map(p => `${p.name}: ${p.role}`)
        .join('\n');
    const message = `🏆 ${winner} win!\n\n📜 Active Roles:\n${activeNonCivilians}`;
    bot.sendMessage(game.ownerId, message);
    game.players.forEach(p => {
        bot.sendMessage(p.id, message);
    });
};

bot.onText(/\/start$/, msg => {
    bot.sendMessage(msg.chat.id, `🎭 Welcome to Mafia Game Bot!\n\nCommands:\n/creategame [numPlayers] - Create a game with optional player count\n/joingame [gameId] - Join a game\n/startgame - Assign roles and start (owner only)\n/dashboard - Reveal roles & manage game (owner only)`);
});

bot.onText(/\/abortgame$/, (msg) => {
    const userId = msg.from?.id;
    if (!userId) return;
    if (userGames.has(userId)) {
        const existingGameId = userGames.get(userId)!;
        if (games.get(existingGameId)?.ownerId !== userId) return bot.sendMessage(msg.chat.id, '❌ Not authorized!');
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
        if (existingGame && existingGame.status !== 'ended') {
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
        status: 'waiting',
    };
    games.set(gameId, newGame);
    userGames.set(userId, gameId);
    const joinLink = `https://t.me/${BOT_USERNAME}?start=join_${gameId}`;
    bot.sendMessage(msg.chat.id, `🎮 Game created! Game ID: ${gameId}\nMax Players: ${maxPlayers}\nMax Mafia: ${maxMafia}\nJoin link: ${joinLink}`, {
        reply_markup: { inline_keyboard: [[{ text: 'Join Game', url: joinLink }]] }
    });
});

const handleJoin = (msg: TelegramBot.Message, match:RegExpExecArray | null) => {
    const userId = msg.from?.id;
    const userName = msg.from?.first_name || 'Player';
    const chatId = msg.chat.id;
    if (!userId) return;

    const gameId = match![1];
    const game = games.get(gameId);
    if (!game) return bot.sendMessage(chatId, '❌ Game not found!');

    if (game.ownerId === userId) return bot.sendMessage(chatId, '❌ Game owner cannot join their own game!');
    if (game.status === 'ended') return bot.sendMessage(chatId, '❌ Cannot join an ended game!');
    if (game.players.length >= game.maxPlayers) return bot.sendMessage(chatId, '❌ Game full!');
    if (game.players.some(p => p.id === userId)) {
        return bot.sendMessage(chatId, '❌ Already joined!');
    }
    game.players.push({ id: userId, name: userName, role: null, isAlive: true, order: game.players.length, revealed: false });
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
    game.status = 'active';
    bot.sendMessage(msg.chat.id, '🎲 Roles assigned. Use /dashboard to reveal roles and manage the game.');
});

bot.onText(/\/dashboard$/, msg => {
    const userId = msg.from?.id;
    const gameId = userGames.get(userId!);
    if (!gameId) return bot.sendMessage(msg.chat.id, '❌ No game found!');
    const game = games.get(gameId)!;
    if (game.ownerId !== userId) return bot.sendMessage(msg.chat.id, '❌ Not authorized!');
    if (game.status === 'ended') return bot.sendMessage(msg.chat.id, '⚠️ Game has ended.');
    const anyUnrevealed = game.players.some(p => !p.revealed);
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    if (game.status === 'waiting') {
        keyboard.push([{ text: '🚀 Start Game', callback_data: `startgame_${gameId}` }]);
    } else if (anyUnrevealed) {
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
    if (!anyUnrevealed && game.status === 'active') {
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
            if (game.ownerId !== cb.from.id) return bot.answerCallbackQuery(cb.id, { text: 'Not authorized!' });
            if (game.players.length !== game.maxPlayers) return bot.answerCallbackQuery(cb.id, { text: `Need ${game.maxPlayers} players to start!` });
            randomizeGame(game);
            game.status = 'active';
            bot.sendMessage(cb.message!.chat.id, '🎲 Roles assigned. Refresh dashboard to proceed.');
            bot.answerCallbackQuery(cb.id);
            break;
        }
        case 'reveal': {
            const targetId = Number(userIdStr);
            if (game.ownerId !== cb.from.id) return bot.answerCallbackQuery(cb.id, { text: 'Not authorized!' });
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
            bot.answerCallbackQuery(cb.id);
            break;
        }
        case 'eliminateconfirm': {
            const targetId = Number(userIdStr);
            if (game.ownerId !== cb.from.id) return bot.answerCallbackQuery(cb.id, { text: 'Not authorized!' });
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
            if (game.ownerId !== cb.from.id) return bot.answerCallbackQuery(cb.id, { text: 'Not authorized!' });
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

console.log('🎭 Mafia Bot Running');
