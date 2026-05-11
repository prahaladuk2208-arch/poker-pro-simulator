export type Suit = '♠' | '♥' | '♦' | '♣';
export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';
export type Position = 'BTN' | 'SB' | 'BB' | 'UTG' | 'HJ' | 'CO';

export interface Card {
  r: Rank;
  s: Suit;
  id: string;
}

export type HandRank = number[];

export interface Player {
  id: number;
  pos: Position;
  stack: number;
  hole: Card[];
  folded: boolean;
  bet: number;
  allIn: boolean;
  isHuman: boolean;
  personality: Personality | null;
}

export interface Personality {
  type: 'TAG' | 'LAG' | 'NIT' | 'CS';
  label: string;
  full: string;
  color: string;
  vpip: number;
  pfr: number;
  agg: number;
  bluff: number;
}

export interface DrawInfo {
  draws: Draw[];
  outs: number;
  made: string | null;
  unseenCount: number;
}

export interface Draw {
  name: string;
  outs: number;
  color: string;
  cards: Card[];
  explain: string;
}

export interface BoardTexture {
  label: string;
  color: string;
  danger: 'high' | 'medium' | 'low';
  cbetSize: string;
  cbetReason: string;
  favours: string;
  scareCard: ScareCard | null;
  monotone: boolean;
  flushDraw: boolean;
  pairedBoard: boolean;
  straightPossible: boolean;
  OESD_board: boolean;
  highCards: number;
  hasAce: boolean;
  hasKing: boolean;
}

export interface ScareCard {
  card: Card;
  type: string;
  msg: string;
  color: string;
}

export type Street = 'preflop' | 'flop' | 'turn' | 'river';
export type Phase = 'idle' | 'betting' | 'showdown';
export type ActionType = 'fold' | 'check' | 'call' | 'raise';

export interface BettingAction {
  street: Street;
  action: ActionType | 'bet';
  amount?: number;
  sizeRel?: number;
  pot?: number;
}

export interface ShowdownResult {
  winner: string;
  pot: number;
  handName?: string;
  solo: boolean;
  all: ShowdownPlayer[] | null;
}

export interface ShowdownPlayer {
  pos: string;
  handName: string;
  hole: Card[];
  isWinner: boolean;
}

export interface SessionStats {
  hands: number;
  wins: number;
  startChips: number;
  vpip: number;
  pfr: number;
  hist: HandHistory[];
  _preflopVpip?: boolean;
  _preflopPfr?: boolean;
}

export interface HandHistory {
  hole: Card[];
  board: Card[];
  result: 'win' | 'loss';
  pot: number;
  handName: string;
}
