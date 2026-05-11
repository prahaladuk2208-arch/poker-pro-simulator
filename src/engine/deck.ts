import type { Card, Suit, Rank } from './types';

export const SUITS: Suit[] = ['♠', '♥', '♦', '♣'];
export const RANKS: Rank[] = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const RANK_VAL: Record<string, number> = Object.fromEntries(RANKS.map((r, i) => [r, i + 2]));
export const RED = new Set<Suit>(['♥', '♦']);

export function makeDeck(): Card[] {
  return SUITS.flatMap(s => RANKS.map(r => ({ r, s, id: `${r}${s}` })));
}

export function shuffle(a: Card[]): Card[] {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

export function cv(c: Card): number {
  return RANK_VAL[c.r];
}

export function unseenCards(hole: Card[], board: Card[]): Card[] {
  const known = new Set([...hole, ...board].map(c => c.id));
  return makeDeck().filter(c => !known.has(c.id));
}
