import type { Personality } from './types';

export function aiDecide(equity: number, toCall: number, pot: number, stack: number, pos: string, pers: Personality): { action: string; amount: number } {
  const posBonus = pos === 'BTN' || pos === 'CO' ? 6 : pos === 'SB' || pos === 'BB' ? -3 : 0;
  const adj = equity + posBonus;
  const po = toCall > 0 ? toCall / (pot + toCall) : 0;
  const r = Math.random();
  if (toCall === 0) {
    if (adj > 52 && r < 0.45 * pers.agg) return { action: 'raise', amount: Math.round(pot * (0.45 + r * 0.35)) };
    if (r < pers.bluff * 0.4) return { action: 'raise', amount: Math.round(pot * 0.5) };
    return { action: 'check', amount: 0 };
  }
  if (r < pers.bluff && toCall < stack * 0.12) return { action: 'raise', amount: Math.round(toCall * 2.5 + pot * 0.2) };
  if (pers.type === 'CS') return adj > 12 || r < 0.55 ? { action: 'call', amount: toCall } : { action: 'fold', amount: 0 };
  if (pers.type === 'NIT') return adj > 62 ? { action: r < 0.25 * pers.agg ? 'raise' : 'call', amount: r < 0.25 ? Math.round(toCall * 2.5) : toCall } : adj > po * 100 + 12 ? { action: 'call', amount: toCall } : { action: 'fold', amount: 0 };
  const thresh = po * 100 - (pers.vpip / 4);
  if (adj < thresh - 6) return { action: 'fold', amount: 0 };
  if (adj > thresh + 18 && r < 0.38 * pers.agg) return { action: 'raise', amount: Math.round(toCall * 2.2 + pot * 0.25) };
  return { action: 'call', amount: toCall };
}
