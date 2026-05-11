import type { Card } from './types';
import { makeDeck, shuffle, cv } from './deck';
import { bestHand, cmp, HAND_NAMES } from './handEval';
import { analyzeDraws, exactOutsEq } from './equity';

export interface Lesson {
  id: string;
  level: number;
  title: string;
  tagline: string;
  formula: string;
  plug: string;
  result: string;
  example: string[];
}

export interface Scenario {
  key: string;
  improved: boolean;
  count: number;
  pct: number;
  examples: Card[];
  handName: string;
}

export interface HandDistEntry {
  name: string;
  winCount: number;
  lossCount: number;
  winPct: number;
  lossPct: number;
}

export interface RunnerRunner {
  flushPct: number;
  straightPct: number;
  hasFlushBackdoor: boolean;
  suit?: string;
}

export interface ExplainerResult {
  equity: number;
  winPct: number;
  tiePct: number;
  lossPct: number;
  wins: number;
  ties: number;
  losses: number;
  scenarios: Scenario[];
  handDist: HandDistEntry[];
  sims: number;
  currentHandName: string | null;
  cardsToCome: number;
  po: number;
  spr: number;
  toCall: number;
  pot: number;
  nOpp: number;
  totalOuts: number;
  rule2or4: number;
  exactOutsEquity: number;
  unseenCount: number;
  runnerRunner: RunnerRunner | null;
  evCall: number;
  lessons: Lesson[];
}

export function buildExplainer(
  hole: Card[], board: Card[], nOpp: number,
  pot: number, toCall: number, stack: number, street: string
): ExplainerResult | null {
  if (!hole || hole.length < 2 || nOpp < 1) return null;

  const SIMS = 600;
  const known = new Set([...hole, ...board].map(c => c.id));
  const deck = makeDeck().filter(c => !known.has(c.id));
  let wins = 0, ties = 0, losses = 0;
  const winsByHand = Array(9).fill(0);
  const lossesByHand = Array(9).fill(0);

  for (let s = 0; s < SIMS; s++) {
    const d = shuffle(deck);
    const fill = 5 - board.length;
    const fb = [...board, ...d.slice(0, fill)];
    const my = bestHand(hole, fb);
    let bestOpp: number[] | null = null;
    for (let o = 0; o < nOpp; o++) {
      const oh = [d[fill + o * 2], d[fill + o * 2 + 1]];
      if (!oh[0] || !oh[1]) continue;
      const os = bestHand(oh, fb);
      if (!bestOpp || cmp(os, bestOpp) > 0) bestOpp = os;
    }
    if (!bestOpp) { wins++; winsByHand[my[0]]++; continue; }
    const r = cmp(my, bestOpp);
    if (r > 0) { wins++; winsByHand[my[0]]++; }
    else if (r < 0) { losses++; lossesByHand[bestOpp[0]]++; }
    else { ties++; }
  }

  const equity = Math.round(((wins + ties * 0.5) / SIMS) * 100);
  const winPct = Math.round(wins / SIMS * 100);
  const tiePct = Math.round(ties / SIMS * 100);
  const lossPct = Math.round(losses / SIMS * 100);

  const drawInfo = analyzeDraws(hole, board);
  const totalOuts = drawInfo.outs;
  const cardsToCome = street === 'flop' ? 2 : street === 'turn' ? 1 : 0;
  const rule2or4 = cardsToCome === 2 ? totalOuts * 4 : totalOuts * 2;
  const unseenCount = deck.length;
  const exactOutsEquity = cardsToCome > 0 ? exactOutsEq(totalOuts, unseenCount, cardsToCome) : 0;

  const currentScore = board.length >= 3 ? bestHand(hole, board) : null;
  const currentHandName = currentScore ? HAND_NAMES[currentScore[0]] : null;
  const scenarios: Scenario[] = [];
  if (cardsToCome > 0 && board.length >= 3) {
    const groups: Record<string, Scenario> = {};
    for (const c of deck) {
      const newBoard = [...board, c];
      const newScore = bestHand(hole, newBoard);
      const improved = currentScore ? cmp(newScore, currentScore) > 0 : false;
      const handName = HAND_NAMES[newScore[0]];
      const key = improved ? `Improves to ${handName}` : `Stays ${currentHandName}`;
      if (!groups[key]) groups[key] = { key, improved, count: 0, examples: [], handName, pct: 0 };
      groups[key].count++;
      if (groups[key].examples.length < 6) groups[key].examples.push(c);
    }
    Object.values(groups).forEach(g => {
      g.pct = Math.round(g.count / deck.length * 100);
      scenarios.push(g);
    });
    scenarios.sort((a, b) => b.count - a.count);
  }

  let runnerRunner: RunnerRunner | null = null;
  if (street === 'flop') {
    const TRIALS = 300;
    let backdoorFlush = 0, backdoorStraight = 0;
    const suitCounts: Record<string, number> = {};
    [...hole, ...board].forEach(c => suitCounts[c.s] = (suitCounts[c.s] || 0) + 1);
    const flushEntry = Object.entries(suitCounts).find(([, c]) => c === 3);
    const flushSuit = flushEntry?.[0];
    for (let t = 0; t < TRIALS; t++) {
      const d = shuffle(deck);
      const turn = d[0], river = d[1];
      if (flushSuit && turn.s === flushSuit && river.s === flushSuit) backdoorFlush++;
      const allCards = [...hole, ...board, turn, river];
      const vals = [...new Set(allCards.map(cv))].sort((a, b) => a - b);
      let hasStraight = false;
      for (let top = 14; top >= 5; top--) {
        const need = [top, top - 1, top - 2, top - 3, top - 4];
        if (need.every(v => vals.includes(v))) { hasStraight = true; break; }
      }
      if (!hasStraight && [14, 2, 3, 4, 5].every(v => vals.includes(v))) hasStraight = true;
      const flopVals = [...new Set([...hole, ...board].map(cv))].sort((a, b) => a - b);
      let alreadyStraight = false;
      for (let top = 14; top >= 5; top--) {
        const need = [top, top - 1, top - 2, top - 3, top - 4];
        if (need.filter(v => flopVals.includes(v)).length >= 4) { alreadyStraight = true; break; }
      }
      if (hasStraight && !alreadyStraight) backdoorStraight++;
    }
    const bdFlushPct = Math.round(backdoorFlush / TRIALS * 100);
    const bdStraightPct = Math.round(backdoorStraight / TRIALS * 100);
    if (bdFlushPct >= 2 || bdStraightPct >= 2) {
      runnerRunner = { flushPct: bdFlushPct, straightPct: bdStraightPct, hasFlushBackdoor: !!flushSuit, suit: flushSuit };
    }
  }

  const handDist: HandDistEntry[] = winsByHand.map((w: number, i: number) => ({
    name: HAND_NAMES[i],
    winCount: w,
    lossCount: lossesByHand[i],
    winPct: Math.round(w / SIMS * 100),
    lossPct: Math.round(lossesByHand[i] / SIMS * 100),
  })).filter(h => h.winCount > 0 || h.lossCount > 0).sort((a, b) => (b.winCount + b.lossCount) - (a.winCount + a.lossCount));

  const po = toCall > 0 ? Math.round(toCall / (pot + toCall) * 100) : 0;
  const spr = pot > 0 ? Math.round((stack / pot) * 10) / 10 : 99;
  const evCall = toCall > 0 ? Math.round((equity / 100) * (pot + toCall) - (1 - equity / 100) * toCall) : 0;

  const cnk = (n: number, k: number) => { if (k < 0 || k > n) return 0; let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return Math.round(r); };

  const lessons: Lesson[] = [];

  if (toCall > 0) {
    lessons.push({
      id: 'pot-odds', level: 1, title: 'Pot Odds',
      tagline: 'How often you need to win to make a call break even',
      formula: 'Pot Odds % = call ÷ (pot + call) × 100',
      plug: `${toCall} ÷ (${pot} + ${toCall}) × 100 = ${toCall} ÷ ${pot + toCall} × 100`,
      result: `${po}%`,
      example: [
        `The pot is $${pot}. Someone bet $${toCall} into it.`,
        `If you call, the pot becomes $${pot + toCall} (their bet + the existing pot).`,
        `You're risking $${toCall} to win that whole pot. Your share of the new pot is ${toCall}/${pot + toCall} = ${po}%.`,
        `Translation: if your hand wins more than ${po}% of the time, calling makes money in the long run. If less, calling loses money.`,
      ],
    });
  }

  const cardsLeft = unseenCount;
  const totalRunouts = cardsToCome === 2
    ? `C(${cardsLeft},2) × C(${cardsLeft - 2},${nOpp * 2})`
    : cardsToCome === 1
    ? `${cardsLeft} × C(${cardsLeft - 1},${nOpp * 2})`
    : `C(${cardsLeft},${nOpp * 2})`;
  const totalRunoutsExact = cardsToCome === 2
    ? cnk(cardsLeft, 2) * cnk(cardsLeft - 2, nOpp * 2)
    : cardsToCome === 1
    ? cardsLeft * cnk(cardsLeft - 1, nOpp * 2)
    : cnk(cardsLeft, nOpp * 2);

  lessons.push({
    id: 'equity', level: 1, title: 'Equity (from first principles)',
    tagline: "Your share of the pot — derived from probability, not magic",
    formula: 'Equity = Σ P(scenario) × outcome, where outcomes ∈ {win=1, tie=½, lose=0}',
    plug: `Total possible runouts = ${totalRunouts} ≈ ${totalRunoutsExact.toLocaleString()}. We sample ${SIMS} of them randomly.`,
    result: `${equity}%`,
    example: [
      `STEP 1 — Count what's UNKNOWN. The deck has 52 cards. You see ${[...hole, ...board].length} (your 2 hole cards + ${board.length} board card${board.length === 1 ? '' : 's'}). Unknown cards = 52 − ${[...hole, ...board].length} = ${cardsLeft}.`,
      cardsToCome > 0
        ? `STEP 2 — Count possible runouts. We need to deal ${cardsToCome} more board card${cardsToCome > 1 ? 's' : ''} AND ${nOpp * 2} opponent hole card${nOpp * 2 > 1 ? 's' : ''}. Using combinations: ${totalRunouts} = ${totalRunoutsExact.toLocaleString()} possible runouts.`
        : `STEP 2 — On the river, only opponents' hole cards are unknown. Possible opponent hands: C(${cardsLeft},${nOpp * 2}) = ${totalRunoutsExact.toLocaleString()} combinations.`,
      `STEP 3 — Why C(n,k)? "Choose k of n" = n! / (k!(n−k)!). It counts how many ways to pick k items when order doesn't matter.`,
      `STEP 4 — Brute-forcing all ${totalRunoutsExact.toLocaleString()} runouts is too slow. Instead, we sample ${SIMS} random runouts (Monte Carlo).`,
      `STEP 5 — The result of ${SIMS} sims: won ${wins} (${winPct}%), tied ${ties} (${tiePct}%), lost ${losses} (${lossPct}%). Equity = (${wins} + ½·${ties}) ÷ ${SIMS} = ${equity}%.`,
      `STEP 6 — Why ties × ½? At showdown, a tie splits the pot. If you tie 10% of the time, you win half the pot 10% of the time — equivalent to winning the whole pot 5% of the time.`,
      `STEP 7 — Margin of error. With ${SIMS} samples, equity is accurate to roughly ±${Math.round(100 / Math.sqrt(SIMS))}%.`,
    ],
  });

  if (handDist.length > 0) {
    lessons.push({
      id: 'distribution', level: 2, title: 'How Often You Make Each Hand',
      tagline: 'Equity comes from the distribution of made hands at showdown',
      formula: 'Total equity = Σ (P(make hand X) × P(hand X wins | hand X))',
      plug: `Out of ${SIMS} runouts, you ended up with each hand a different number of times.`,
      result: 'Hand-by-hand contribution',
      example: [
        "Equity isn't one number — it's the sum of many smaller probabilities.",
        ...handDist.slice(0, 4).map(h => `${h.name}: won ${h.winCount}/${SIMS} runouts (${h.winPct}%), lost ${h.lossCount}/${SIMS} (${h.lossPct}%).`),
        `Add up all the wins (${wins}) and ties (${ties}) and divide by ${SIMS} to get equity.`,
      ],
    });
  }

  if (toCall > 0) {
    const margin = equity - po;
    lessons.push({
      id: 'compare', level: 1, title: 'The Decision Rule',
      tagline: "Compare your equity to the pot odds — that's your call",
      formula: 'If Equity > Pot Odds → call is profitable',
      plug: `Equity ${equity}% vs Pot Odds ${po}%`,
      result: margin >= 0 ? `Call wins +${margin} pts` : `Call loses ${margin} pts`,
      example: margin >= 0 ? [
        `Your equity (${equity}%) beats the pot odds (${po}%) by ${margin} percentage points.`,
        `That means: every time you face this exact spot, calling makes money on average.`,
        `Doesn't guarantee you win this hand — it guarantees that over many hands like this, you profit.`,
      ] : [
        `Your equity (${equity}%) is below the pot odds (${po}%) by ${Math.abs(margin)} points.`,
        `Calling loses money on average in this exact spot.`,
        `Exception: if you can win extra chips later when you hit (implied odds), the math can flip in your favour.`,
      ],
    });
  }

  if (totalOuts > 0 && cardsToCome > 0) {
    lessons.push({
      id: 'rule24', level: 1, title: `Rule of ${cardsToCome === 2 ? '4' : '2'}`,
      tagline: 'Quick mental math for your equity from a draw',
      formula: cardsToCome === 2
        ? 'Equity ≈ outs × 4 (when 2 cards still to come — flop)'
        : 'Equity ≈ outs × 2 (when 1 card still to come — turn)',
      plug: `${totalOuts} outs × ${cardsToCome === 2 ? 4 : 2} = ${rule2or4}%`,
      result: `≈ ${rule2or4}% (exact: ${exactOutsEquity}%)`,
      example: [
        `You have ${totalOuts} outs — cards in the deck that improve your hand to a likely winner.`,
        `On the ${street}, you'll see ${cardsToCome} more card${cardsToCome > 1 ? 's' : ''} before showdown.`,
        cardsToCome === 2
          ? `Quick estimate: each out is worth roughly 2% per card. With 2 cards to come, multiply by 4. So ${totalOuts} × 4 = ${rule2or4}%.`
          : `Quick estimate: each out is worth roughly 2%. So ${totalOuts} × 2 = ${rule2or4}%.`,
        `The exact math: ${cardsToCome === 2
          ? `1 − [(${unseenCount - totalOuts}/${unseenCount}) × (${unseenCount - 1 - totalOuts}/${unseenCount - 1})] = ${exactOutsEquity}%`
          : `${totalOuts}/${unseenCount} = ${exactOutsEquity}%`}.`,
        `The Rule of ${cardsToCome === 2 ? 4 : 2} is ${Math.abs(rule2or4 - exactOutsEquity) <= 3 ? 'close enough' : 'a bit optimistic'} (off by ${Math.abs(rule2or4 - exactOutsEquity)} pts here).`,
      ],
    });
  }

  if (toCall > 0 && totalOuts >= 4) {
    const minImpliedNeeded = Math.max(0, Math.round((toCall * 100 / Math.max(exactOutsEquity, 1)) - pot - toCall));
    lessons.push({
      id: 'implied', level: 2, title: 'Implied Odds',
      tagline: 'Extra chips you can expect to win on later streets if you hit',
      formula: 'Effective Pot Odds = call ÷ (pot + call + future winnings)',
      plug: `${toCall} ÷ (${pot + toCall} + future) ≤ ${exactOutsEquity}% (your draw equity)`,
      result: `Need ~$${minImpliedNeeded} more on later streets`,
      example: [
        `Your draw is worth ~${exactOutsEquity}% but you only get ${po}% pot odds — direct call is ${exactOutsEquity > po ? 'profitable' : 'unprofitable'}.`,
        `Implied odds = the chips you expect to win on later streets WHEN you hit your draw.`,
        exactOutsEquity >= po
          ? "You don't need implied odds here — the call already pays for itself."
          : `If hitting your draw will reliably win you another ~$${minImpliedNeeded}+ from your opponent, calling becomes break-even or better.`,
        `Implied odds are biggest against opponents who pay off when you hit (loose, sticky players) and smallest against opponents who fold when scary cards land.`,
      ],
    });
  }

  if (runnerRunner && (runnerRunner.flushPct >= 3 || runnerRunner.straightPct >= 3)) {
    lessons.push({
      id: 'runner', level: 2, title: 'Runner-Runner (Backdoor) Equity',
      tagline: 'Hidden equity from drawing both the turn AND river to a draw',
      formula: 'Backdoor equity ≈ 4% per backdoor flush, 1.5% per backdoor straight',
      plug: `Flush: ${runnerRunner.flushPct}% Straight: ${runnerRunner.straightPct}%`,
      result: `≈ +${runnerRunner.flushPct + runnerRunner.straightPct}% hidden equity`,
      example: [
        'A "backdoor" or "runner-runner" draw needs BOTH the turn and the river to be specific cards.',
        runnerRunner.hasFlushBackdoor
          ? `You have 3 ${runnerRunner.suit}s right now. If turn AND river are both ${runnerRunner.suit}s, you make a flush. Probability: ${runnerRunner.flushPct}%.`
          : '',
        runnerRunner.straightPct >= 2
          ? `You also have a backdoor straight: certain turn+river combos give you a 5-straight. Probability: ${runnerRunner.straightPct}%.`
          : '',
        "Each backdoor draw isn't worth much alone, but they stack up.",
      ].filter(Boolean),
    });
  }

  if (toCall > 0) {
    lessons.push({
      id: 'ev', level: 2, title: 'Expected Value (EV) of Calling',
      tagline: 'Average chips you win per call decision in this exact spot',
      formula: 'EV(call) = (equity × pot_after) − ((1 − equity) × call)',
      plug: `(${equity / 100} × ${pot + toCall}) − (${(1 - equity / 100).toFixed(2)} × ${toCall})`,
      result: `${evCall >= 0 ? '+' : ''}$${evCall} per call`,
      example: [
        `Imagine playing this exact situation 100 times.`,
        `You'd win the $${pot + toCall} pot ~${equity} times.`,
        `You'd lose the $${toCall} call ~${100 - equity} times.`,
        `Net per hand: (${equity}% × $${pot + toCall}) − (${100 - equity}% × $${toCall}) = ${evCall >= 0 ? '+' : ''}$${evCall}.`,
        evCall > 0
          ? `Positive EV — over many hands, you make $${evCall} per call on average.`
          : `Negative EV — calling loses $${Math.abs(evCall)} per hand on average. Folding ($0 EV) is better.`,
      ],
    });
  }

  if (pot > 0) {
    lessons.push({
      id: 'spr', level: 3, title: 'Stack-to-Pot Ratio (SPR)',
      tagline: 'Decides how committed you are and which hand strengths play well',
      formula: 'SPR = effective stack ÷ pot',
      plug: `$${stack} ÷ $${pot} = ${spr}`,
      result: `SPR ${spr}`,
      example: [
        `SPR tells you how much room there is for postflop play.`,
        `Low SPR (under 3): you're effectively committed. Top pair is enough to get all-in.`,
        `Medium SPR (3–10): standard play — top pair plays cautiously, two pair+ goes for stacks.`,
        `High SPR (over 10): big implied odds. Sets, straights, flushes win huge pots.`,
        `Yours is ${spr} → ${spr < 3 ? 'committed' : spr > 10 ? 'deep, look for monsters' : 'medium, standard play'}.`,
      ],
    });
  }

  lessons.push({
    id: 'position', level: 3, title: 'Position',
    tagline: 'Acting last is worth ~2-3% equity on its own',
    formula: 'Position bonus = ability to see opponents act before you decide',
    plug: `On the ${street}, ${cardsToCome > 0 ? "you'll have to act before seeing how others react to the next card" : 'you act now'}`,
    result: '+5% to call thresholds when in position',
    example: [
      'In position (acting last), you see what everyone does before you decide. That\'s huge.',
      'Out of position, you have to commit chips not knowing if someone behind will raise.',
      'Practical effect: in position you can call wider with marginal hands and draws. Out of position, tighten up.',
      'Rule of thumb: subtract ~5% from your equity needed to call when you\'re in position; add ~5% when out of position.',
    ],
  });

  if (equity < 55) {
    lessons.push({
      id: 'foldeq', level: 3, title: 'Fold Equity',
      tagline: 'Equity you gain when opponents fold to your bet/raise',
      formula: 'Total equity = showdown equity + (fold% × pot already in)',
      plug: `If raising made opponent fold 30% of the time: ${equity}% + (30% × pot) value`,
      result: 'Bluff/semi-bluff math',
      example: [
        `You don't need to win at showdown — making opponents fold also wins the pot.`,
        `If your hand wins ${equity}% at showdown but a bet/raise makes the opponent fold 30% of the time, your real win rate is ~${Math.min(equity + 30, 100)}%.`,
        `Best fold equity comes from credible aggression: when your bet pattern matches a strong made hand, opponents fold their marginal stuff.`,
        `Semi-bluffs (hands with outs + fold equity) are powerful — even if called, you have a backup plan.`,
      ],
    });
  }

  return {
    equity, winPct, tiePct, lossPct, wins, ties, losses,
    scenarios, handDist, sims: SIMS, currentHandName, cardsToCome,
    po, spr, toCall, pot, nOpp, totalOuts, rule2or4,
    exactOutsEquity, unseenCount, runnerRunner, evCall, lessons,
  };
}
