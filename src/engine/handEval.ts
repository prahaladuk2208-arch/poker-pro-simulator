import type { Card, HandRank } from './types';
import { cv } from './deck';

export const HAND_NAMES = ['High Card', 'One Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'];

export function evalFive(cards: Card[]): HandRank {
  const vals = cards.map(cv).sort((a, b) => b - a);
  const suits = cards.map(c => c.s);
  const flush = suits.every(s => s === suits[0]);
  const cnt: Record<number, number> = {};
  vals.forEach(v => cnt[v] = (cnt[v] || 0) + 1);
  const g = Object.entries(cnt).sort((a, b) => (b[1] as number) - (a[1] as number) || Number(b[0]) - Number(a[0]));
  const u = [...new Set(vals)];
  let str = 0;
  if (u.length >= 5) {
    for (let i = 0; i <= u.length - 5; i++) {
      if (u[i] - u[i + 4] === 4) { str = u[i]; break; }
    }
  }
  if (!str && u.includes(14) && u.includes(2) && u.includes(3) && u.includes(4) && u.includes(5)) str = 5;
  if (flush && str) return [8, str];
  if (g[0][1] === 4) return [7, +g[0][0], +g[1][0]];
  if (g[0][1] === 3 && g[1]?.[1] === 2) return [6, +g[0][0], +g[1][0]];
  if (flush) return [5, ...vals];
  if (str) return [4, str];
  if (g[0][1] === 3) return [3, +g[0][0], ...vals.filter(v => v !== +g[0][0]).slice(0, 2)];
  if (g[0][1] === 2 && g[1]?.[1] === 2) return [2, Math.max(+g[0][0], +g[1][0]), Math.min(+g[0][0], +g[1][0]), vals.find(v => v !== +g[0][0] && v !== +g[1][0]) || 0];
  if (g[0][1] === 2) return [1, +g[0][0], ...vals.filter(v => v !== +g[0][0]).slice(0, 3)];
  return [0, ...vals.slice(0, 5)];
}

export function cmp(a: HandRank, b: HandRank): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

export function bestHand(hole: Card[], board: Card[]): HandRank {
  const all = [...hole, ...board];
  if (all.length < 5) {
    const pad: Card[] = Array(5 - all.length).fill({ r: '2' as const, s: '♠' as const, id: '2♠' });
    return evalFive([...all, ...pad]);
  }
  let best: HandRank | null = null;
  for (let i = 0; i < all.length - 1; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const five = all.filter((_, k) => k !== i && k !== j);
      if (five.length !== 5) continue;
      const e = evalFive(five);
      if (!best || cmp(e, best) > 0) best = e;
    }
  }
  return best ?? evalFive(all.slice(0, 5));
}
