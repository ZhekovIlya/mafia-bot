export const DEFAULT_TITLE = 'Mafia game';
export const MIN_PLAYERS = 4;

export const ROLES = {
  DON: 'Mafia Don',
  MAFIA: 'Mafia',
  SHERIFF: 'Sheriff',
  DOCTOR: 'Doctor',
  CIVILIAN: 'Civilian',
} as const;

export type Role = typeof ROLES[keyof typeof ROLES];

export const GAME_STATUS = {
  WAITING: 'waiting',
  ACTIVE: 'active',
  ENDED: 'ended',
} as const;

export type GameStatus = typeof GAME_STATUS[keyof typeof GAME_STATUS];

export const MESSAGES = {
  NOT_AUTHORIZED: 'Not authorized!',
  NOT_AUTHORIZED_CHAT: '❌ Not authorized!',
};

export const START_HINT =
  'Welcome to Mafia Game Bot! Send /help for commands and game rules.';

export const HELP_TEXT =
  '📖 Commands:\n' +
  '/creategame [title] - announce a game, e.g. /creategame Friday 20:00. You become the host.\n' +
  'Or type @bot <title> in any chat to post the lobby there.\n' +
  'Tap 🙋 I\'m in / 🙅 Can\'t make it on the lobby message. /leave - drop out of your lobby.\n' +
  '/joingame <gameId> - join by id.\n' +
  '\nThe host removes no-shows, locks the roster and roles are dealt. Roles are sent here in DM.\n' +
  'Mafia eliminate others while civilians try to expose them.';

export const OWNER_HELP_TEXT =
  '\n<b>Owner Tips</b>\n' +
  'Single command to manage whole game (remove players, lock & deal, reveal roles):\n/dashboard\n' +
  '\nAdvanced commands:\n' +
  '/startgame - lock the roster and deal roles\n' +
  '/abortgame - cancel your current game';


export interface Player {
  id: number;
  name: string;
  username?: string;
  role: Role | null;
  isAlive: boolean;
  order: number;
  revealed: boolean;
}

export interface Game {
  id: string;
  ownerId: number;
  ownerName: string;
  players: Player[];
  maxPlayers: number;
  maxMafia: number;
  status: GameStatus;
  lastRevealChatId?: number;
  lastRevealMessageId?: number;
  // Interest lobby (optional so older persisted state still loads)
  title?: string;
  // share: the DM copy, which also carries the 'Share to a chat' button
  lobbyMessages?: { chatId: number; messageId: number; share?: boolean }[];
  lobbyInlineIds?: string[];
  winner?: string;
  cancelled?: boolean;
}


export const shuffleArray = <T>(array: T[]): T[] => {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};

export const generateRoles = (
  playersTotal: number,
  mafiaTotal: number,
): Role[] => {
  const roles: Role[] = [ROLES.DON];
  for (let i = 1; i < mafiaTotal; i++) {
    roles.push(ROLES.MAFIA);
  }
  roles.push(ROLES.SHERIFF, ROLES.DOCTOR);
  while (roles.length < playersTotal) {
    roles.push(ROLES.CIVILIAN);
  }
  return shuffleArray(roles);
};

export const checkWinCondition = (game: Game): string | null => {
  const alivePlayers = game.players.filter(p => p.isAlive);
  const aliveMafia = alivePlayers.filter(
    p => p.role === ROLES.MAFIA || p.role === ROLES.DON,
  );
  const aliveCivilians = alivePlayers.filter(
    p => p.role !== ROLES.MAFIA && p.role !== ROLES.DON,
  );
  if (aliveMafia.length === 0) return 'Civilians';
  if (aliveMafia.length >= aliveCivilians.length) return 'Mafia';
  return null;
};

// ---------- Interest lobby (shared by the Node and Worker runtimes) ----------

export type Keyboard = Array<Array<{
  text: string;
  callback_data?: string;
  url?: string;
  switch_inline_query?: string;
}>>;

export const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const gameTitle = (game: Game): string => game.title || DEFAULT_TITLE;

export const cleanTitle = (text: string | undefined | null): string =>
  (text ?? '').trim().slice(0, 100) || DEFAULT_TITLE;

export const playerLabel = (p: { name: string; username?: string }): string =>
  p.username ? `${p.name} (@${p.username})` : p.name;

// Mafia count suggested for a headcount.
export const suggestMafia = (players: number): number => {
  if (players >= 14) return 4;
  if (players >= 10) return 3;
  if (players >= 7) return 2;
  return 1;
};

// Returns an error message, or null when the setup is valid.
export const validateSetup = (players: number, mafia: number): string | null => {
  if (players < MIN_PLAYERS) return `Need at least ${MIN_PLAYERS} players to deal.`;
  if (mafia < 1) return 'Need at least 1 mafia.';
  if (mafia + 2 > players) return 'Not enough players for Sheriff and Doctor.';
  if (mafia >= players - mafia) return 'Mafia must be a minority.';
  return null;
};

// Valid mafia range for a headcount (only meaningful when players >= MIN_PLAYERS).
export const mafiaRange = (players: number): { min: number; max: number } => {
  let max = 1;
  while (validateSetup(players, max + 1) === null) max++;
  return { min: 1, max };
};

export const clampMafia = (players: number, mafia: number): number => {
  const { min, max } = mafiaRange(players);
  return Math.min(max, Math.max(min, mafia));
};

export const lobbyFooter = (game: Game): string => {
  if (game.cancelled) return '❌ Game cancelled by host.';
  if (game.status === GAME_STATUS.ACTIVE) return `🔒 Roster locked — ${game.players.length} playing. Good luck!`;
  if (game.status === GAME_STATUS.ENDED) return `🏆 ${escapeHtml(game.winner ?? 'Nobody')} won!`;
  return '';
};

export const renderLobby = (game: Game): string => {
  const list = game.players.length
    ? game.players.map((p, i) => `${i + 1}. ${escapeHtml(playerLabel(p))}`).join('\n')
    : 'Nobody yet — be the first!';
  let text = `🎭 <b>${escapeHtml(gameTitle(game))}</b>\nHost: ${escapeHtml(game.ownerName)}\n\n` +
    `🙋 Interested: ${game.players.length}\n${list}`;
  const footer = lobbyFooter(game);
  if (footer) text += `\n\n${footer}`;
  return text;
};

export const lobbyKeyboard = (game: Game, share = false): Keyboard => {
  if (game.status !== GAME_STATUS.WAITING || game.cancelled) return [];
  const keyboard: Keyboard = [[
    { text: '🙋 I\'m in', callback_data: `lin_${game.id}` },
    { text: '🙅 Can\'t make it', callback_data: `lout_${game.id}` },
  ]];
  if (share) keyboard.push([{ text: '📣 Share to a chat', switch_inline_query: game.id }]);
  return keyboard;
};

export const newLobbyGame = (ownerId: number, ownerName: string, title?: string | null): Game => ({
  id: Date.now().toString(),
  ownerId,
  ownerName,
  players: [],
  maxPlayers: 0,
  maxMafia: 0,
  status: GAME_STATUS.WAITING,
  title: cleanTitle(title),
  lobbyMessages: [],
  lobbyInlineIds: [],
});

// Game the user hosts that is not finished yet, if any.
export const hostedOpenGame = (
  games: Map<string, Game>,
  userGames: Map<number, string>,
  userId: number,
): Game | undefined => {
  const game = games.get(userGames.get(userId) ?? '');
  return game && game.ownerId === userId && game.status !== GAME_STATUS.ENDED ? game : undefined;
};

// Owner panel while the game is waiting (plain text, no parse mode).
export const renderPanel = (game: Game): { text: string; keyboard: Keyboard } => {
  const n = game.players.length;
  const setup = n < MIN_PLAYERS
    ? `Need at least ${MIN_PLAYERS} players to deal.`
    : `Suggested setup: ${n} players, ${suggestMafia(n)} mafia (Don + ${suggestMafia(n) - 1})`;
  // Telegram allows at most 100 buttons per message.
  const keyboard: Keyboard = game.players.slice(0, 90).map((p, i) => [
    { text: `❌ Remove ${i + 1}. ${p.name}`, callback_data: `lkick_${game.id}_${p.id}` },
  ]);
  keyboard.push([{ text: '🔒 Lock & deal', callback_data: `llock_${game.id}` }]);
  return { text: `📋 Lobby: ${gameTitle(game)} — ${n} interested\n${setup}`, keyboard };
};

// Lock confirmation with the mafia count picker (plain text, no parse mode).
export const renderConfirm = (game: Game, mafia: number): { text: string; keyboard: Keyboard } => {
  const n = game.players.length;
  const m = clampMafia(n, mafia);
  return {
    text: `🔒 Lock roster with ${n} players?\n` +
      `Mafia: ${m} (Don + ${m - 1}) · Sheriff · Doctor · Civilians: ${n - m - 2}`,
    keyboard: [
      [
        { text: '➖ Mafia', callback_data: `lmafia_${game.id}_${clampMafia(n, m - 1)}` },
        { text: '➕ Mafia', callback_data: `lmafia_${game.id}_${clampMafia(n, m + 1)}` },
      ],
      [{ text: '✅ Deal roles', callback_data: `ldeal_${game.id}_${m}` }],
      [{ text: '↩️ Back', callback_data: `lback_${game.id}` }],
    ],
  };
};
