import type { Card, DrawInfo, Draw } from './types';
import { makeDeck, shuffle, cv, unseenCards } from './deck';
import { bestHand, cmp, HAND_NAMES } from './handEval';

const VAL_TO_RANK: Record<number, string> = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: '10', 9: '9', 8: '8', 7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2' };

export function calcEquity(hole: Card[], board: Card[], nOpp: number, sims = 250): number {
  if (!hole || hole.length < 2 || nOpp < 1) return 50;
  const known = new Set([...hole, ...board].map(c => c.id));
  const deck = makeDeck().filter(c => !known.has(c.id));
  let w = 0, t = 0;
  for (let s = 0; s < sims; s++) {
    const d = shuffle(deck);
    const fill = 5 - board.length;
    const fb = [...board, ...d.slice(0, fill)];
    const my = bestHand(hole, fb);
    let win = true, tie = false;
    for (let o = 0; o < nOpp; o++) {
      const oh = [d[fill + o * 2], d[fill + o * 2 + 1]];
      if (!oh[0] || !oh[1]) continue;
      const os = bestHand(oh, fb);
      const r = cmp(my, os);
      if (r < 0) { win = false; break; }
      if (r === 0) tie = true;
    }
    if (win && !tie) w++;
    else if (tie && win) t += 0.5;
  }
  return Math.round(((w + t) / sims) * 100);
}

export function analyzeDraws(hole: Card[], board: Card[]): DrawInfo {
  if (!hole || hole.length < 2 || board.length < 3) return { draws: [], outs: 0, made: null, unseenCount: 0 };
  const all = [...hole, ...board];
  const vals = all.map(cv);
  const suits = all.map(c => c.s);
  const score = bestHand(hole, board);
  const made = HAND_NAMES[score[0]];
  const draws: Draw[] = [];
  const unseen = unseenCards(hole, board);
  const allOutCards = new Set<string>();

  // Flush draw
  const sc: Record<string, number> = {};
  suits.forEach(s => sc[s] = (sc[s] || 0) + 1);
  const fd = Object.entries(sc).find(([, c]) => c === 4);
  if (fd && score[0] < 5) {
    const suit = fd[0];
    const outCards = unseen.filter(c => c.s === suit);
    draws.push({
      name: 'Flush Draw', outs: outCards.length, color: '#818cf8', cards: outCards,
      explain: `Any ${suit} completes your flush. There are 13 ${suit}s total — you can see 4 of them, so ${outCards.length} are still in the deck.`,
    });
    outCards.forEach(c => allOutCards.add(c.id));
  }

  // Straight draws
  const uv = [...new Set(vals)].sort((a, b) => a - b);
  const straightOuts = new Set<number>();
  let oesd = false, gut = false;
  for (let top = 14; top >= 6; top--) {
    const need = [top, top - 1, top - 2, top - 3, top - 4];
    const have = need.filter(v => uv.includes(v)).length;
    if (have === 4) {
      const miss = need.find(v => !uv.includes(v))!;
      if (miss === top || miss === top - 4) {
        oesd = true;
        if (miss === top) { straightOuts.add(top); straightOuts.add(top - 5); }
        else { straightOuts.add(miss); straightOuts.add(top + 1); }
      } else {
        gut = true;
        straightOuts.add(miss);
      }
    }
  }
  if ([14, 2, 3, 4, 5].filter(v => uv.includes(v)).length === 4) {
    const missVal = [14, 2, 3, 4, 5].find(v => !uv.includes(v));
    if (missVal != null && !straightOuts.has(missVal)) {
      if (!oesd) gut = true;
      straightOuts.add(missVal);
    }
  }
  const validStraightVals = [...straightOuts].filter(v => v >= 2 && v <= 14);
  const isOpen = validStraightVals.length >= 2;
  if ((isOpen || gut) && score[0] < 4 && validStraightVals.length > 0) {
    const outCards = unseen.filter(c => validStraightVals.includes(cv(c)));
    const ranks = validStraightVals.map(v => VAL_TO_RANK[v]).filter(Boolean);
    if (isOpen) {
      draws.push({
        name: 'Open-Ended Straight Draw', outs: outCards.length, color: '#f59e0b', cards: outCards,
        explain: `You need a ${ranks.join(' or a ')} to make your straight — ${outCards.length} cards still live.`,
      });
    } else {
      draws.push({
        name: 'Gutshot Straight Draw', outs: outCards.length, color: '#fb923c', cards: outCards,
        explain: `You need exactly a ${ranks.join(' or ')} to fill the inside of your straight — ${outCards.length} still live.`,
      });
    }
    outCards.forEach(c => allOutCards.add(c.id));
  }

  // Overcards
  if (board.length >= 3 && score[0] === 0) {
    const bmax = Math.max(...board.map(cv));
    const ocHole = hole.filter(c => cv(c) > bmax);
    if (ocHole.length >= 1) {
      const ocVals = ocHole.map(cv);
      const outCards = unseen.filter(c => ocVals.includes(cv(c)));
      const ranks = ocHole.map(c => c.r).join(' or ');
      draws.push({
        name: ocHole.length === 2 ? 'Two Overcards' : 'Overcard',
        outs: outCards.length, color: ocHole.length === 2 ? '#ec4899' : '#a78bfa', cards: outCards,
        explain: ocHole.length === 2
          ? `Either of your overcards (${ranks}) likely makes top pair. ${outCards.length} outs.`
          : `Pairing your ${ranks} likely makes top pair. ${outCards.length} outs.`,
      });
      outCards.forEach(c => allOutCards.add(c.id));
    }
  }

  return { draws, outs: allOutCards.size, made, unseenCount: unseen.length };
}

export const outsEq = (outs: number, cardsToCome: number): number => Math.min(cardsToCome === 2 ? outs * 4 : outs * 2, 100);
export const exactOutsEq = (outs: number, unseenLeft: number, cardsToCome: number): number => {
  if (!unseenLeft || cardsToCome <= 0) return 0;
  if (cardsToCome === 1) return Math.round(outs / unseenLeft * 100);
  const missOne = (unseenLeft - outs) / unseenLeft;
  const missTwo = missOne * ((unseenLeft - 1 - outs) / (unseenLeft - 1));
  return Math.round((1 - missTwo) * 100);
};
