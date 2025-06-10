import path from 'path';

export const DEFAULT_PLAYERS_COUNT = 11;
export const DEFAULT_MAFIA_COUNT = 3;

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
  '/creategame [players] [mafia] - create a new game (defaults 11 players, 3 mafia). You become the owner.\n' +
  '/joingame <gameId> - join an existing game or use a join link.\n' +
  '\nWhen enough players join, open /dashboard to begin. Roles are sent when the game starts.\n' +
  'Mafia eliminate others while civilians try to expose them.';

export const OWNER_HELP_TEXT =
  '\n<b>Owner Tips</b>\n' +
  'Single command to manage whole game:\n/dashboard\n' +
  '\nAdvanced commands:\n' +
  '/startgame - start the game manually\n' +
  '/abortgame - cancel your current game';


export interface Player {
  id: number;
  name: string;
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
}

export const ROLE_IMAGES: Record<Role, string> = {
  [ROLES.DON]: path.join(__dirname, '../assets/don.png'),
  [ROLES.MAFIA]: path.join(__dirname, '../assets/mafia.png'),
  [ROLES.SHERIFF]: path.join(__dirname, '../assets/sheriff.png'),
  [ROLES.DOCTOR]: path.join(__dirname, '../assets/doc.png'),
  [ROLES.CIVILIAN]: path.join(__dirname, '../assets/civilian.png'),
};

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
