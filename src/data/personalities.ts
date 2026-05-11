import type { Personality } from '../engine/types';

export const PERSONALITIES: Personality[] = [
  { type: 'TAG', label: 'TAG', full: 'Tight-Aggressive', color: '#f59e0b', vpip: 22, pfr: 18, agg: 1.4, bluff: 0.12 },
  { type: 'LAG', label: 'LAG', full: 'Loose-Aggressive', color: '#ef4444', vpip: 36, pfr: 28, agg: 1.8, bluff: 0.28 },
  { type: 'NIT', label: 'NIT', full: 'Nit', color: '#818cf8', vpip: 12, pfr: 10, agg: 0.5, bluff: 0.03 },
  { type: 'CS', label: 'CS', full: 'Calling Station', color: '#10b981', vpip: 48, pfr: 7, agg: 0.3, bluff: 0.04 },
];

export const POS6 = ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'] as const;
export const SB_AMOUNT = 10;
export const BB_AMOUNT = 20;
export const START_STACK = 1000;
