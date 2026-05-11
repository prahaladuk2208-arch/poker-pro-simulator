import type { DrawInfo } from './types';

export interface Advice {
  action: string;
  reason: string;
  po: number;
  showBetSizing: boolean;
}

export function getAdvice(equity: number, toCall: number, pot: number, stack: number, _street: string, drawInfo: DrawInfo | null): Advice {
  const po = toCall > 0 ? Math.round(toCall / (pot + toCall) * 100) : 0;
  const spr = pot > 0 ? stack / pot : 99;
  let action: string, reason: string, showBetSizing = false;
  if (toCall === 0) {
    if (equity >= 65) { action = 'BET FOR VALUE'; reason = `${equity}% equity. Bet to build the pot.`; showBetSizing = true; }
    else if (drawInfo && drawInfo.outs >= 8) { action = 'SEMI-BLUFF / CHECK'; reason = `${drawInfo.outs} outs. Semi-bluff or check for a free card.`; }
    else if (equity >= 45) { action = 'CHECK'; reason = `${equity}% equity. Check and see the next card for free.`; }
    else { action = 'CHECK / FOLD'; reason = `Weak equity (${equity}%). Check and fold to aggression.`; }
  } else {
    const impl = drawInfo && drawInfo.outs >= 8 && spr > 4 ? 8 : 0;
    const adj = equity + impl;
    if (adj > po + 18) { action = 'RAISE'; reason = `Your equity (${equity}%) far exceeds pot odds (${po}%). Raise for value.`; showBetSizing = true; }
    else if (adj > po + 4) { action = 'CALL'; reason = `Equity (${equity}%) beats pot odds needed (${po}%). Profitable call.`; }
    else if (adj >= po - 4) { action = 'CALL / FOLD'; reason = `Close spot — equity (${equity}%) near break-even (${po}%). Fold without implied odds.`; }
    else { action = 'FOLD'; reason = `Need ${po}% equity to call. You have ${equity}%. Fold.`; }
  }
  let sprNote = '';
  if (spr < 3) sprNote = ' Low SPR — commit or fold.';
  else if (spr > 10) sprNote = ' Deep stack — implied odds matter.';
  return { action, reason: reason + sprNote, po, showBetSizing };
}
