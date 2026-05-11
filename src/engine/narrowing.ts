import type { Card, BettingAction } from './types';
import { SUITS, cv } from './deck';
import { bestHand } from './handEval';
import { analyzeDraws } from './equity';
import { RANGE_DATA } from '../data/ranges';

export interface NarrowedHand {
  hand: string;
  cat: string;
  combos: Card[][];
  count: number;
  weight: number;
  boardCat?: string;
}

export interface NarrowingStep {
  step: string;
  detail: string;
  keptHands: string[];
  survivors: number;
  before?: number;
}

export interface NarrowResult {
  hands: NarrowedHand[];
  totalCombos: number;
  reasoning: NarrowingStep[];
}

export function comboCount(hand: string): number {
  if (hand.length === 2 && hand[0] === hand[1]) return 6;
  if (hand.endsWith('s')) return 4;
  if (hand.endsWith('o')) return 12;
  return 0;
}

function expandHand(hand: string): Card[][] {
  const r1 = hand[0], r2 = hand[1];
  const combos: Card[][] = [];
  const toRank = (c: string) => c === 'T' ? '10' : c;
  if (hand.length === 2) {
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
      combos.push([
        { r: toRank(r1) as Card['r'], s: SUITS[i], id: toRank(r1) + SUITS[i] },
        { r: toRank(r2) as Card['r'], s: SUITS[j], id: toRank(r2) + SUITS[j] }
      ]);
    }
  } else if (hand.endsWith('s')) {
    for (let i = 0; i < 4; i++) {
      combos.push([
        { r: toRank(r1) as Card['r'], s: SUITS[i], id: toRank(r1) + SUITS[i] },
        { r: toRank(r2) as Card['r'], s: SUITS[i], id: toRank(r2) + SUITS[i] }
      ]);
    }
  } else {
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (i !== j) {
      combos.push([
        { r: toRank(r1) as Card['r'], s: SUITS[i], id: toRank(r1) + SUITS[i] },
        { r: toRank(r2) as Card['r'], s: SUITS[j], id: toRank(r2) + SUITS[j] }
      ]);
    }
  }
  return combos;
}

function removeCardConflicts(combos: Card[][], knownIds: Set<string>): Card[][] {
  return combos.filter(([c1, c2]) => !knownIds.has(c1.id) && !knownIds.has(c2.id));
}

function categorizeOnBoard(combo: Card[], board: Card[]): string {
  if (board.length < 3) return 'premium-preflop';
  const score = bestHand(combo, board);
  const cat = score[0];
  const boardVals = board.map(cv);
  const topBoardVal = Math.max(...boardVals);
  const myHoleVals = combo.map(cv);
  if (cat >= 3) return 'strong';
  if (cat === 2) return myHoleVals.some(v => boardVals.includes(v)) ? 'two-pair' : 'strong';
  if (cat === 1) {
    if (myHoleVals[0] === myHoleVals[1]) return myHoleVals[0] > topBoardVal ? 'overpair' : 'underpair';
    const pairedRank = myHoleVals.find(v => boardVals.includes(v));
    if (pairedRank === topBoardVal) {
      const kicker = myHoleVals.find(v => v !== pairedRank);
      return kicker && kicker >= 12 ? 'top-pair-good-kicker' : 'top-pair-weak-kicker';
    }
    return 'weak-pair';
  }
  const di = analyzeDraws(combo, board);
  if (di.outs >= 8) return 'strong-draw';
  if (di.outs >= 4) return 'weak-draw';
  if (myHoleVals.every(v => v > topBoardVal)) return 'overcards';
  return 'air';
}

function startingRange(position: string, knownIds: Set<string>) {
  const rm = RANGE_DATA[position as keyof typeof RANGE_DATA] || {};
  const hands: NarrowedHand[] = [];
  let totalCombos = 0;
  for (const [hand, cat] of Object.entries(rm)) {
    const allCombos = expandHand(hand);
    const liveCombos = removeCardConflicts(allCombos, knownIds);
    if (liveCombos.length === 0) continue;
    hands.push({ hand, cat, combos: liveCombos, count: liveCombos.length, weight: 1 });
    totalCombos += liveCombos.length;
  }
  return { hands, totalCombos };
}

export function narrowRange(position: string, board: Card[], actions: BettingAction[], knownIds: Set<string>): NarrowResult {
  let { hands, totalCombos } = startingRange(position, knownIds);
  const reasoning: NarrowingStep[] = [];
  reasoning.push({
    step: 'Starting Range',
    detail: `${position} opens with ${totalCombos} combos of starting hands (premium + value + speculative).`,
    keptHands: hands.map(h => h.hand),
    survivors: totalCombos,
  });

  for (const a of actions) {
    const beforeCombos = hands.reduce((s, h) => s + h.count, 0);
    if (a.action === 'raise' && a.street === 'preflop') {
      hands = hands.filter(h => h.cat === 'p' || ['JJ', 'QQ', 'KK', 'AA', 'AKs', 'AKo', 'AQs'].includes(h.hand));
      reasoning.push({
        step: 'Pre-flop 3-bet',
        detail: 'A 3-bet narrows the range dramatically. Most opponents 3-bet only premium pairs (JJ+) and AK/AQs.',
        before: beforeCombos,
        survivors: hands.reduce((s, h) => s + h.count, 0),
        keptHands: hands.map(h => h.hand),
      });
    } else if (a.action === 'call' && a.street === 'preflop') {
      hands = hands.filter(h => h.cat !== 'p' || h.hand === 'AA' || h.hand === 'KK');
      reasoning.push({
        step: 'Pre-flop call',
        detail: 'A call removes ~the bottom 20% (folds) and the very top (would re-raise). The middle stays.',
        before: beforeCombos,
        survivors: hands.reduce((s, h) => s + h.count, 0),
        keptHands: hands.map(h => h.hand),
      });
    } else if (a.action === 'bet' || a.action === 'raise') {
      hands = hands.map(h => {
        const sample = h.combos[0];
        const boardCat = categorizeOnBoard(sample, board);
        let weight = 1;
        if (['strong', 'two-pair', 'top-pair-good-kicker', 'overpair'].includes(boardCat)) weight = 1;
        else if (boardCat === 'strong-draw') weight = 0.7;
        else if (['top-pair-weak-kicker', 'weak-pair', 'underpair'].includes(boardCat)) weight = 0.4;
        else if (boardCat === 'weak-draw') weight = 0.3;
        else if (boardCat === 'overcards') weight = 0.25;
        else weight = 0.15;
        return { ...h, weight, boardCat };
      }).filter(h => h.weight > 0.1);
      reasoning.push({
        step: `${a.street} bet (${Math.round((a.sizeRel || 0.66) * 100)}% pot)`,
        detail: `A bet polarizes the range: strong made hands and credible draws bet. Weak hands mostly check.`,
        before: beforeCombos,
        survivors: Math.round(hands.reduce((s, h) => s + h.count * h.weight, 0)),
        keptHands: hands.map(h => h.hand),
      });
    } else if (a.action === 'check') {
      hands = hands.map(h => {
        const sample = h.combos[0];
        const boardCat = categorizeOnBoard(sample, board);
        let weight = h.weight || 1;
        if (['strong', 'two-pair', 'overpair'].includes(boardCat)) weight *= 0.4;
        else if (['top-pair-good-kicker'].includes(boardCat)) weight *= 0.6;
        else weight *= 1.1;
        return { ...h, weight: Math.min(weight, 1), boardCat };
      });
      reasoning.push({
        step: `${a.street} check`,
        detail: 'A check removes most value bets. Weak hands and draws are over-represented.',
        before: beforeCombos,
        survivors: Math.round(hands.reduce((s, h) => s + h.count * h.weight, 0)),
        keptHands: hands.map(h => h.hand),
      });
    } else if (a.action === 'call' && a.street !== 'preflop') {
      hands = hands.map(h => {
        const sample = h.combos[0];
        const boardCat = categorizeOnBoard(sample, board);
        let weight = h.weight || 1;
        if (boardCat === 'strong') weight *= 0.5;
        else if (boardCat === 'air') weight *= 0.05;
        else if (boardCat === 'overcards') weight *= 0.5;
        return { ...h, weight, boardCat };
      }).filter(h => h.weight > 0.05);
      reasoning.push({
        step: `${a.street} call`,
        detail: 'A call suggests medium-strength or a draw — strong enough to continue, not strong enough to raise.',
        before: beforeCombos,
        survivors: Math.round(hands.reduce((s, h) => s + h.count * h.weight, 0)),
        keptHands: hands.map(h => h.hand),
      });
    }
  }

  return { hands, totalCombos: hands.reduce((s, h) => s + h.count * h.weight, 0), reasoning };
}
