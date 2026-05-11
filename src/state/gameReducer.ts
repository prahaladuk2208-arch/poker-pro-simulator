import type { Card, Player, Position, Street, Phase, ShowdownResult, SessionStats, BettingAction } from '../engine/types';
import { makeDeck, shuffle } from '../engine/deck';
import { bestHand, cmp, HAND_NAMES } from '../engine/handEval';
import { calcEquity } from '../engine/equity';
import { aiDecide } from '../engine/ai';
import { PERSONALITIES, SB_AMOUNT, BB_AMOUNT, START_STACK } from '../data/personalities';

export interface GameState {
  players: Player[];
  board: Card[];
  deck: Card[];
  pot: number;
  currentBet: number;
  street: Street;
  phase: Phase;
  activeIdx: number;
  needsAction: Set<number>;
  lastAggressor: number;
  dealerSeat: number;
  log: LogEntry[];
  showdown: ShowdownResult | null;
  session: SessionStats;
  oppActions: Record<number, BettingAction[]>;
  oppStats: Record<number, OppStat>;
  paused: PauseState | null;
}

export interface LogEntry {
  msg: string;
  type: string;
  id: number;
}

export interface OppStat {
  raises: number;
  calls: number;
  folds: number;
  checks: number;
  totalActions: number;
  lastAction: string | null;
  lastStreet: string | null;
}

export interface PauseState {
  mode: 'prompt' | 'frozen' | 'reveal' | 'analyze';
  snapshot: FoldSnapshot;
}

export interface FoldSnapshot {
  street: Street;
  board: Card[];
  hole: Card[];
  pot: number;
  toCall: number;
  continuedEquity: number;
  opponents: { pos: string; hole: Card[]; personality: Player['personality'] }[];
}

export type GameAction =
  | { type: 'DEAL_HAND' }
  | { type: 'PLAYER_ACTION'; idx: number; action: string; amount: number; label: string }
  | { type: 'AI_ACTION'; idx: number }
  | { type: 'ADVANCE_TO_NEXT'; fromIdx: number }
  | { type: 'NEXT_STREET' }
  | { type: 'RESOLVE_HAND' }
  | { type: 'SET_PAUSE'; mode: PauseState['mode'] | null }
  | { type: 'RESUME_AFTER_FOLD' };

function assignPositions(dealerSeat: number): Position[] {
  const positions: Position[] = ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'];
  const result: Position[] = [];
  for (let i = 0; i < 6; i++) {
    result[(dealerSeat + i) % 6] = positions[i];
  }
  return result;
}

export function createInitialState(): GameState {
  return {
    players: [],
    board: [],
    deck: [],
    pot: 0,
    currentBet: 0,
    street: 'preflop',
    phase: 'idle',
    activeIdx: -1,
    needsAction: new Set(),
    lastAggressor: -1,
    dealerSeat: Math.floor(Math.random() * 6),
    log: [],
    showdown: null,
    session: { hands: 0, wins: 0, startChips: START_STACK, vpip: 0, pfr: 0, hist: [] },
    oppActions: {},
    oppStats: {},
    paused: null,
  };
}

export function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case 'DEAL_HAND': {
      const dealerSeat = (state.dealerSeat + (state.session.hands === 0 ? 0 : 1)) % 6;
      const positions = assignPositions(dealerSeat);
      const d = shuffle(makeDeck());
      const prevPlayers = state.players;
      const players: Player[] = positions.map((pos, i) => {
        const stack = prevPlayers[i]?.stack > 0 ? prevPlayers[i].stack : START_STACK;
        const pers = i === 0 ? null : PERSONALITIES[Math.floor(Math.random() * PERSONALITIES.length)];
        return { id: i, pos, stack, hole: [d[i * 2], d[i * 2 + 1]], folded: stack <= 0 && i !== 0, bet: 0, allIn: false, isHuman: i === 0, personality: pers };
      });

      const sbIdx = players.findIndex(p => p.pos === 'SB');
      const bbIdx = players.findIndex(p => p.pos === 'BB');
      players[sbIdx] = { ...players[sbIdx], bet: SB_AMOUNT, stack: players[sbIdx].stack - SB_AMOUNT };
      players[bbIdx] = { ...players[bbIdx], bet: BB_AMOUNT, stack: players[bbIdx].stack - BB_AMOUNT };

      const needsAction = new Set(players.filter(p => !p.folded && !p.allIn).map(p => p.id));
      // First to act preflop is UTG (3 seats after dealer)
      const utgIdx = players.findIndex(p => p.pos === 'UTG');

      return {
        ...state,
        players,
        board: [],
        deck: d.slice(12),
        pot: SB_AMOUNT + BB_AMOUNT,
        currentBet: BB_AMOUNT,
        street: 'preflop',
        phase: 'betting',
        activeIdx: utgIdx,
        needsAction,
        lastAggressor: bbIdx,
        dealerSeat,
        log: [{ msg: 'New hand dealt. Blinds $10/$20', type: 'deal', id: Math.random() }],
        showdown: null,
        oppActions: {},
        oppStats: {},
        paused: null,
        session: { ...state.session, _preflopVpip: false, _preflopPfr: false },
      };
    }

    case 'PLAYER_ACTION': {
      const { idx, action: act, amount, label } = action;
      const players = [...state.players.map(p => ({ ...p }))];
      const p = players[idx];
      const toCall = Math.max(0, state.currentBet - p.bet);
      const needsAction = new Set(state.needsAction);
      needsAction.delete(idx);
      let pot = state.pot;
      let currentBet = state.currentBet;
      let lastAggressor = state.lastAggressor;
      const log = [...state.log];

      if (act === 'fold') {
        players[idx] = { ...p, folded: true };
        log.unshift({ msg: `${label} folds`, type: 'fold', id: Math.random() });
      } else if (act === 'check') {
        log.unshift({ msg: `${label} checks`, type: 'check', id: Math.random() });
      } else if (act === 'call') {
        const amt = Math.min(toCall, p.stack);
        players[idx] = { ...p, stack: p.stack - amt, bet: p.bet + amt, allIn: p.stack - amt <= 0 };
        pot += amt;
        log.unshift({ msg: `${label} calls $${amt}`, type: 'call', id: Math.random() });
      } else if (act === 'raise') {
        const extra = Math.max(0, Math.min(amount - toCall, p.stack - toCall));
        const total = Math.min(toCall + extra, p.stack);
        const newBet = p.bet + total;
        players[idx] = { ...p, stack: p.stack - total, bet: newBet, allIn: p.stack - total <= 0 };
        pot += total;
        if (newBet > currentBet) {
          currentBet = newBet;
          lastAggressor = idx;
          players.forEach(pl => {
            if (pl.id !== idx && !pl.folded && !pl.allIn) needsAction.add(pl.id);
          });
          log.unshift({ msg: `${label} raises to $${newBet}`, type: 'raise', id: Math.random() });
        } else {
          log.unshift({ msg: `${label} calls $${total}`, type: 'call', id: Math.random() });
        }
      }

      // Track opponent stats
      const oppStats = { ...state.oppStats };
      const oppActions = { ...state.oppActions };
      if (idx !== 0) {
        const s = oppStats[idx] || { raises: 0, calls: 0, folds: 0, checks: 0, totalActions: 0, lastAction: null, lastStreet: null };
        oppStats[idx] = {
          ...s,
          raises: s.raises + (act === 'raise' ? 1 : 0),
          calls: s.calls + (act === 'call' ? 1 : 0),
          folds: s.folds + (act === 'fold' ? 1 : 0),
          checks: s.checks + (act === 'check' ? 1 : 0),
          totalActions: s.totalActions + 1,
          lastAction: act,
          lastStreet: state.street,
        };
        const totalChips = act === 'raise' ? amount : (act === 'call' ? toCall : 0);
        const sizeRel = state.pot > 0 && totalChips > 0 ? totalChips / state.pot : 0;
        oppActions[idx] = [...(oppActions[idx] || []), { street: state.street, action: act as BettingAction['action'], amount: totalChips, sizeRel, pot: state.pot }];
      }

      // Track human VPIP/PFR
      let session = state.session;
      if (idx === 0 && state.street === 'preflop') {
        if (act === 'call' || act === 'raise') session = { ...session, _preflopVpip: true };
        if (act === 'raise') session = { ...session, _preflopPfr: true };
      }

      // Handle fold-and-study pause
      let paused = state.paused;
      if (idx === 0 && act === 'fold') {
        const stillIn = players.filter(p2 => !p2.folded && !p2.isHuman);
        const continuedEquity = calcEquity(players[0].hole, state.board, Math.max(stillIn.length, 1), 400);
        paused = {
          mode: 'prompt',
          snapshot: {
            street: state.street,
            board: [...state.board],
            hole: [...players[0].hole],
            pot,
            toCall,
            continuedEquity,
            opponents: stillIn.map(pp => ({ pos: pp.pos, hole: [...pp.hole], personality: pp.personality })),
          },
        };
      }

      return {
        ...state,
        players,
        pot,
        currentBet,
        lastAggressor,
        needsAction,
        activeIdx: -1,
        log: log.slice(0, 50),
        oppStats,
        oppActions,
        session,
        paused,
      };
    }

    case 'AI_ACTION': {
      const { idx } = action;
      const p = state.players[idx];
      if (!p || p.folded || p.allIn || state.phase !== 'betting') return state;
      const toCall = Math.max(0, state.currentBet - p.bet);
      const nOpp = state.players.filter((_, i) => i !== idx && !state.players[i].folded).length;
      const eq = calcEquity(p.hole, state.board, nOpp, 60);
      const dec = aiDecide(eq, toCall, state.pot, p.stack, p.pos, p.personality!);
      const amount = dec.action === 'raise' ? toCall + (dec.amount || 0) : (dec.amount || 0);
      const label = `${p.pos} (${p.personality?.label})`;
      return gameReducer(state, { type: 'PLAYER_ACTION', idx, action: dec.action, amount, label });
    }

    case 'ADVANCE_TO_NEXT': {
      const { fromIdx } = action;
      const stillIn = state.players.filter(p => !p.folded && !p.allIn);
      if (stillIn.length <= 1) {
        return gameReducer(state, { type: 'NEXT_STREET' });
      }
      const betsSettled = stillIn.every(p => p.bet === state.currentBet);
      const roundOver = state.needsAction.size === 0 && betsSettled;
      if (roundOver) {
        return gameReducer(state, { type: 'NEXT_STREET' });
      }
      let next = -1;
      for (let i = 1; i <= state.players.length; i++) {
        const idx2 = (fromIdx + i) % state.players.length;
        const p2 = state.players[idx2];
        if (p2.folded || p2.allIn) continue;
        if (state.needsAction.has(idx2)) { next = idx2; break; }
      }
      if (next === -1) {
        return gameReducer(state, { type: 'NEXT_STREET' });
      }
      return { ...state, activeIdx: next };
    }

    case 'NEXT_STREET': {
      const stillIn = state.players.filter(p => !p.folded && !p.allIn);
      if (stillIn.length <= 1) {
        return gameReducer(state, { type: 'RESOLVE_HAND' });
      }
      const players = state.players.map(p => ({ ...p, bet: 0 }));
      const needsAction = new Set(players.filter(p => !p.folded && !p.allIn).map(p => p.id));
      let board = state.board;
      let deck = state.deck;
      let street = state.street;
      const log = [...state.log];

      if (street === 'preflop') {
        board = [deck[0], deck[1], deck[2]]; deck = deck.slice(3); street = 'flop';
        log.unshift({ msg: '━━ FLOP ━━', type: 'street', id: Math.random() });
      } else if (street === 'flop') {
        board = [...board, deck[0]]; deck = deck.slice(1); street = 'turn';
        log.unshift({ msg: '━━ TURN ━━', type: 'street', id: Math.random() });
      } else if (street === 'turn') {
        board = [...board, deck[0]]; deck = deck.slice(1); street = 'river';
        log.unshift({ msg: '━━ RIVER ━━', type: 'street', id: Math.random() });
      } else {
        return gameReducer(state, { type: 'RESOLVE_HAND' });
      }

      // First to act postflop: first non-folded clockwise from SB
      const sbIdx = players.findIndex(p => p.pos === 'SB');
      let first = -1;
      for (let i = 0; i < players.length; i++) {
        const idx2 = (sbIdx + i) % players.length;
        if (!players[idx2].folded && !players[idx2].allIn) { first = idx2; break; }
      }
      if (first === -1) first = players.findIndex(p => !p.folded);

      return {
        ...state,
        players,
        board,
        deck,
        street: street as Street,
        currentBet: 0,
        lastAggressor: -1,
        needsAction,
        activeIdx: first >= 0 ? first : 0,
        log: log.slice(0, 50),
      };
    }

    case 'RESOLVE_HAND': {
      const players = [...state.players.map(p => ({ ...p }))];
      const active = players.filter(p => !p.folded);
      let showdown: ShowdownResult;
      let winnerId = -1;
      let winnerPos = '';
      let handName = '';
      const log = [...state.log];

      if (active.length === 1) {
        winnerId = active[0].id;
        winnerPos = active[0].pos;
        showdown = { winner: winnerPos, pot: state.pot, solo: true, all: null };
        log.unshift({ msg: `${winnerPos} wins $${state.pot} (everyone else folded)`, type: 'win', id: Math.random() });
      } else {
        const scored = active.map(p => ({ ...p, score: bestHand(p.hole, state.board) })).sort((a, b) => cmp(b.score, a.score));
        winnerId = scored[0].id;
        winnerPos = scored[0].pos;
        handName = HAND_NAMES[scored[0].score[0]];
        showdown = {
          winner: winnerPos, pot: state.pot, handName, solo: false,
          all: scored.map(p => ({ pos: p.pos, handName: HAND_NAMES[p.score[0]], hole: p.hole, isWinner: p.id === winnerId })),
        };
        log.unshift({ msg: `${winnerPos} wins $${state.pot} with ${handName}!`, type: 'win', id: Math.random() });
      }

      const winnerIdx = players.findIndex(p => p.id === winnerId);
      players[winnerIdx] = { ...players[winnerIdx], stack: players[winnerIdx].stack + state.pot };

      const humanWon = players[0].id === winnerId;
      const hist = { hole: players[0].hole, board: state.board, result: (humanWon ? 'win' : 'loss') as 'win' | 'loss', pot: state.pot, handName };
      const session: SessionStats = {
        ...state.session,
        hands: state.session.hands + 1,
        wins: state.session.wins + (humanWon ? 1 : 0),
        vpip: state.session.vpip + (state.session._preflopVpip ? 1 : 0),
        pfr: state.session.pfr + (state.session._preflopPfr ? 1 : 0),
        hist: [hist, ...state.session.hist].slice(0, 20),
      };

      return {
        ...state,
        players,
        pot: 0,
        phase: 'showdown',
        activeIdx: -1,
        showdown,
        session,
        log: log.slice(0, 50),
      };
    }

    case 'SET_PAUSE': {
      if (action.mode === null) return { ...state, paused: null };
      if (!state.paused) return state;
      return { ...state, paused: { ...state.paused, mode: action.mode } };
    }

    case 'RESUME_AFTER_FOLD': {
      return { ...state, paused: null };
    }

    default:
      return state;
  }
}
