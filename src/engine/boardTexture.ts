import type { Card, BoardTexture } from './types';
import { cv } from './deck';

export function analyzeBoardTexture(board: Card[], prevBoard: Card[] | null): BoardTexture | null {
  if (!board || board.length < 3) return null;

  const flop = board.slice(0, 3);
  const vals = board.map(cv);
  const flopSuits = flop.map(c => c.s);
  const suits = board.map(c => c.s);

  const suitCnt: Record<string, number> = {};
  suits.forEach(s => suitCnt[s] = (suitCnt[s] || 0) + 1);
  const maxSuit = Math.max(...Object.values(suitCnt));
  const flushSuitCnt: Record<string, number> = {};
  flopSuits.forEach(s => flushSuitCnt[s] = (flushSuitCnt[s] || 0) + 1);
  const flopMaxSuit = Math.max(...Object.values(flushSuitCnt));
  const monotone = flopMaxSuit === 3;
  const flushDraw = maxSuit >= 4;
  const flushComplete = maxSuit >= 5;
  const twoToneFlop = flopMaxSuit === 2 && !monotone;

  const uv = [...new Set(vals)].sort((a, b) => a - b);
  let straightPossible = false, straightComplete = false, OESD_board = false;
  for (let top = 14; top >= 5; top--) {
    const window = [top, top - 1, top - 2, top - 3, top - 4];
    const have = window.filter(v => uv.includes(v)).length;
    if (have >= 5) { straightComplete = true; break; }
    if (have >= 4) OESD_board = true;
    if (have >= 3) straightPossible = true;
  }

  const valCnt: Record<number, number> = {};
  vals.forEach(v => valCnt[v] = (valCnt[v] || 0) + 1);
  const pairs = Object.values(valCnt).filter(c => c >= 2).length;
  const trips = Object.values(valCnt).filter(c => c >= 3).length;
  const pairedBoard = pairs > 0;
  const tripsBoard = trips > 0;

  const highCards = vals.filter(v => v >= 10).length;
  const hasAce = vals.includes(14);
  const hasKing = vals.includes(13);

  let label: string, color: string, danger: 'high' | 'medium' | 'low';
  if (monotone) { label = 'MONOTONE'; color = '#818cf8'; danger = 'high'; }
  else if (straightComplete) { label = 'STRAIGHT ON BOARD'; color = '#ef4444'; danger = 'high'; }
  else if (flushComplete) { label = 'FLUSH ON BOARD'; color = '#818cf8'; danger = 'high'; }
  else if (tripsBoard) { label = 'TRIPS ON BOARD'; color = '#f59e0b'; danger = 'high'; }
  else if (OESD_board && twoToneFlop) { label = 'VERY WET'; color = '#ef4444'; danger = 'high'; }
  else if (OESD_board || twoToneFlop) { label = 'WET'; color = '#fb923c'; danger = 'medium'; }
  else if (pairedBoard && straightPossible) { label = 'SEMI-WET'; color = '#fcd34d'; danger = 'medium'; }
  else if (pairedBoard) { label = 'PAIRED & DRY'; color = '#6ee7b7'; danger = 'low'; }
  else if (straightPossible && highCards >= 2) { label = 'SEMI-WET'; color = '#fcd34d'; danger = 'medium'; }
  else if (highCards >= 3) { label = 'HIGH / DRY'; color = '#6ee7b7'; danger = 'low'; }
  else { label = 'DRY'; color = '#22c55e'; danger = 'low'; }

  let cbetSize: string, cbetReason: string;
  if (danger === 'high') { cbetSize = '⅔–FULL POT'; cbetReason = 'Wet board — bet large to charge draws and protect your hand.'; }
  else if (danger === 'medium') { cbetSize = '½–⅔ POT'; cbetReason = 'Semi-wet board — medium sizing balances value and protection.'; }
  else { cbetSize = '⅓–½ POT'; cbetReason = "Dry board — small bets work well. Opponents can't have many draws."; }

  let favours: string;
  if (highCards >= 2 && !pairedBoard) favours = 'Preflop aggressor — high boards hit tight opening ranges.';
  else if (vals.some(v => v <= 6) && !straightPossible) favours = 'Neither player — low dry boards miss most ranges equally.';
  else if (monotone || OESD_board) favours = 'Caller — connected/suited boards hit wide calling ranges.';
  else if (pairedBoard) favours = 'Neither — paired boards often miss both players. Check is common.';
  else favours = 'Preflop aggressor — bet to take advantage of range advantage.';

  let scareCard: BoardTexture['scareCard'] = null;
  if (prevBoard && board.length > prevBoard.length) {
    const newCard = board[board.length - 1];
    const newVal = cv(newCard);
    const newSuit = newCard.s;
    const prevSuitCnt: Record<string, number> = {};
    prevBoard.map(c => c.s).forEach(s => prevSuitCnt[s] = (prevSuitCnt[s] || 0) + 1);

    if ((prevSuitCnt[newSuit] || 0) >= 3) {
      scareCard = { card: newCard, type: 'FLUSH COMPLETED', msg: `${newSuit} flush is now possible. Reassess any hand without the nut flush.`, color: '#818cf8' };
    } else if (newVal === 14 && !prevBoard.map(cv).includes(14)) {
      scareCard = { card: newCard, type: 'ACE ARRIVED', msg: 'Ace on board changes everything — strong hands may now be second best.', color: '#f59e0b' };
    } else if (OESD_board && straightComplete) {
      scareCard = { card: newCard, type: 'STRAIGHT COMPLETED', msg: 'Straight is now possible on this board. Tread carefully.', color: '#ef4444' };
    } else if (pairedBoard && tripsBoard) {
      scareCard = { card: newCard, type: 'BOARD PAIRED', msg: 'Board paired — full houses and quads are now possible.', color: '#fb923c' };
    } else if (newVal >= 11 && highCards >= 3) {
      scareCard = { card: newCard, type: 'BROADWAY CARD', msg: 'Three broadway cards — top pair is now vulnerable to two pair+.', color: '#fcd34d' };
    }
  }

  return { label, color, danger, cbetSize, cbetReason, favours, scareCard, monotone, flushDraw, pairedBoard, straightPossible, OESD_board, highCards, hasAce, hasKing };
}
