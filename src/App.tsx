import { useReducer, useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { gameReducer, createInitialState } from './state/gameReducer';
import type { GameState } from './state/gameReducer';
import type { Card, BoardTexture as BoardTextureType, DrawInfo } from './engine/types';
import type { Advice } from './engine/advice';
import { calcEquity, analyzeDraws, outsEq, exactOutsEq } from './engine/equity';
import { getAdvice } from './engine/advice';
import { analyzeBoardTexture } from './engine/boardTexture';
import { narrowRange } from './engine/narrowing';
import { bestHand, HAND_NAMES } from './engine/handEval';
import { RANGE_DATA, RANGE_COLORS, GRID_RANKS } from './data/ranges';
import { PERSONALITIES, POS6, BB_AMOUNT, START_STACK } from './data/personalities';
import { GLOSSARY } from './data/glossary';
import { buildExplainer } from './engine/explainer';
import type { ExplainerResult } from './engine/explainer';
import { CardComponent } from './ui/shared/CardComponent';

const AI_DELAY = 450;
const STREET_PAUSE = 900;

type TabId = 'game' | 'explain' | 'read' | 'range' | 'glossary' | 'stats';
const TABS: { id: TabId; l: string }[] = [
  { id: 'game', l: 'GAME' }, { id: 'explain', l: 'EXPLAIN' }, { id: 'read', l: 'READ' },
  { id: 'range', l: 'RANGES' }, { id: 'glossary', l: 'GLOSSARY' }, { id: 'stats', l: 'STATS' },
];

export default function App() {
  const [state, dispatch] = useReducer(gameReducer, undefined, createInitialState);
  const [activeTab, setActiveTab] = useState<TabId>(() => (localStorage.getItem('poker_tab') as TabId) || 'game');
  const [rangePos, setRangePos] = useState('BTN');
  const [glossSearch, setGlossSearch] = useState('');
  const [selectedOpp, setSelectedOpp] = useState<number | null>(null);
  const [readMode, setReadMode] = useState<'coach' | 'quiz'>('coach');
  const [readSelectedOpp, setReadSelectedOpp] = useState<number | null>(null);
  const [customBet, setCustomBet] = useState('');
  const [explainer, setExplainer] = useState<ExplainerResult | null>(null);
  const [explainerLevel, setExplainerLevel] = useState(1);
  const aiTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef<GameState>(state);
  stateRef.current = state;

  useEffect(() => { localStorage.setItem('poker_tab', activeTab); }, [activeTab]);

  // Keyboard shortcuts: F=fold, C=call/check, R=raise
  const humanActRef = useRef<(action: string, amount?: number) => void>(() => {});
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const s = stateRef.current;
      if (s.phase !== 'betting' || s.activeIdx !== 0 || s.players[0]?.folded) return;
      const tc = Math.max(0, s.currentBet - s.players[0].bet);
      if (e.key === 'f' || e.key === 'F') { humanActRef.current('fold'); }
      else if (e.key === 'c' || e.key === 'C') { humanActRef.current(tc === 0 ? 'check' : 'call'); }
      else if (e.key === 'r' || e.key === 'R') {
        const mr = Math.max(BB_AMOUNT * 2, s.currentBet * 2);
        humanActRef.current('raise', tc === 0 ? Math.round(s.pot * 0.67) : mr - s.players[0].bet);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const { players, board, pot, currentBet, street, phase, activeIdx, showdown, log, session, oppStats, oppActions, paused } = state;
  const human = players[0];
  const toCall = human ? Math.max(0, currentBet - human.bet) : 0;
  const isMyTurn = phase === 'betting' && activeIdx === 0 && !human?.folded;
  const minRaise = Math.max(BB_AMOUNT * 2, currentBet * 2);

  // Compute equity, advice, draws, texture from current state
  const nOpp = useMemo(() => players.filter(p => !p.folded && !p.isHuman).length, [players]);
  const equity = useMemo(() => {
    if (!human?.hole?.length || phase === 'idle') return null;
    return calcEquity(human.hole, board, Math.max(nOpp, 1));
  }, [human?.hole, board, nOpp, phase, street]);

  const drawInfo = useMemo((): DrawInfo | null => {
    if (!human?.hole?.length || phase === 'idle') return null;
    return analyzeDraws(human.hole, board);
  }, [human?.hole, board, phase, street]);

  const advice = useMemo((): Advice | null => {
    if (equity === null || !human) return null;
    return getAdvice(equity, toCall, pot, human.stack, street, drawInfo);
  }, [equity, toCall, pot, human?.stack, street, drawInfo]);

  const [prevBoard, setPrevBoard] = useState<Card[]>([]);
  const texture = useMemo((): BoardTextureType | null => {
    return analyzeBoardTexture(board, prevBoard.length > 0 ? prevBoard : null);
  }, [board, prevBoard]);

  useEffect(() => {
    if (board.length > prevBoard.length) setPrevBoard([...board]);
  }, [board.length]);

  // AI scheduling
  const scheduleAi = useCallback(() => {
    const s = stateRef.current;
    if (s.phase !== 'betting' || s.paused) return;
    const p = s.players[s.activeIdx];
    if (!p || p.isHuman || p.folded || p.allIn) return;
    if (aiTimer.current) clearTimeout(aiTimer.current);
    aiTimer.current = setTimeout(() => {
      const cur = stateRef.current;
      if (cur.phase !== 'betting' || cur.activeIdx !== p.id) return;
      dispatch({ type: 'AI_ACTION', idx: p.id });
    }, AI_DELAY);
  }, []);

  // After any state change that affects activeIdx, schedule AI or advance
  useEffect(() => {
    if (phase !== 'betting' || activeIdx === -1) return;
    if (paused) return;
    const p = players[activeIdx];
    if (!p) return;
    if (p.isHuman) return;
    if (p.folded || p.allIn) {
      // skip this player
      setTimeout(() => dispatch({ type: 'ADVANCE_TO_NEXT', fromIdx: activeIdx }), 50);
      return;
    }
    scheduleAi();
  }, [activeIdx, phase, paused]);

  // After AI action completes (activeIdx becomes -1), advance
  useEffect(() => {
    if (phase !== 'betting' || activeIdx !== -1) return;
    if (paused) return;
    // Find who just acted — use log to determine
    const lastActionLog = log[0];
    if (!lastActionLog) return;
    // Advance from the last actor
    const timer = setTimeout(() => {
      const s = stateRef.current;
      if (s.activeIdx !== -1 || s.phase !== 'betting') return;
      if (s.paused) return;
      // Determine fromIdx: find last non-human who acted
      const stillIn = s.players.filter(p => !p.folded && !p.allIn);
      if (stillIn.length <= 1) {
        dispatch({ type: 'NEXT_STREET' });
      } else {
        const betsSettled = stillIn.every(p => p.bet === s.currentBet);
        const roundOver = s.needsAction.size === 0 && betsSettled;
        if (roundOver) {
          setTimeout(() => dispatch({ type: 'NEXT_STREET' }), STREET_PAUSE);
        } else {
          // Find next player who needs to act
          let next = -1;
          for (let i = 0; i < s.players.length; i++) {
            if (s.needsAction.has(i) && !s.players[i].folded && !s.players[i].allIn) { next = i; break; }
          }
          if (next >= 0) dispatch({ type: 'ADVANCE_TO_NEXT', fromIdx: next > 0 ? next - 1 : s.players.length - 1 });
          else setTimeout(() => dispatch({ type: 'NEXT_STREET' }), STREET_PAUSE);
        }
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [activeIdx, phase, log.length, paused]);

  useEffect(() => () => { if (aiTimer.current) clearTimeout(aiTimer.current); }, []);

  function humanAct(action: string, amount = 0) {
    if (!isMyTurn) return;
    const label = 'YOU';
    dispatch({ type: 'PLAYER_ACTION', idx: 0, action, amount, label });
    if (action !== 'fold') {
      setTimeout(() => dispatch({ type: 'ADVANCE_TO_NEXT', fromIdx: 0 }), 150);
    }
  }
  humanActRef.current = humanAct;

  function resumeAfterFold() {
    dispatch({ type: 'RESUME_AFTER_FOLD' });
    setTimeout(() => dispatch({ type: 'ADVANCE_TO_NEXT', fromIdx: 0 }), 150);
  }

  const vpipPct = session.hands > 0 ? Math.round(session.vpip / session.hands * 100) : 0;
  const pfrPct = session.hands > 0 ? Math.round(session.pfr / session.hands * 100) : 0;
  const winRate = session.hands > 0 ? Math.round(session.wins / session.hands * 100) : 0;
  const cardsLeft = street === 'flop' ? 2 : street === 'turn' ? 1 : 0;

  const acCol: Record<string, string> = { fold: '#f87171', call: '#6ee7b7', raise: '#fcd34d', check: '#93c5fd', win: '#4ade80', street: '#60a5fa', deal: '#c084fc', info: '#6aa87a' };

  return (
    <div className="min-h-screen bg-[#080e0b] text-[#c8b89a] flex flex-col items-center px-2.5 pt-4 pb-15 md:px-4"
      style={{ backgroundImage: 'radial-gradient(ellipse 100% 55% at 50% -5%, #0b2415 0%, transparent 65%)', fontFamily: 'Georgia, serif' }}>

      {/* Header */}
      <div className="text-center mb-3">
        <div className="text-[8px] tracking-[0.35em] text-[#2a5a3a] mb-1">NO LIMIT HOLD'EM · 6-MAX</div>
        <div className="text-lg md:text-xl tracking-wider text-[#c8b89a]">POKER PRO SIMULATOR</div>
        {human && <div className="text-[9px] text-[#2a5a3a] mt-0.5">Stack: <span className="text-[#4ade80]">${human.stack}</span> · Hand #{session.hands + 1} · Position: <span className="text-[#4ade80]">{human.pos}</span></div>}
      </div>

      {/* Tabs */}
      <div className="flex gap-0.5 mb-3 bg-[#0c1a12] border border-[#1a3a22] rounded-xl p-1 overflow-x-auto max-w-full">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)}
            className={`px-2.5 md:px-3.5 py-1.5 rounded-lg border-none cursor-pointer text-[9px] tracking-[0.18em] font-bold whitespace-nowrap transition-all ${activeTab === t.id ? 'bg-[#1a3a22] text-[#4ade80]' : 'bg-transparent text-[#3a6a4a]'}`}
            style={{ fontFamily: 'Georgia, serif' }}>{t.l}</button>
        ))}
      </div>

      <div className="w-full max-w-[900px]">

        {/* GAME TAB */}
        {activeTab === 'game' && (
          <div className="grid grid-cols-1 md:grid-cols-[1fr_268px] gap-2.5">
            <div>
              {/* Opponents */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-1.5 mb-2">
                {players.filter(p => !p.isHuman).map(p => {
                  const pers = p.personality;
                  const isActive = activeIdx === p.id;
                  const isSelected = selectedOpp === p.id;
                  const stats = oppStats[p.id];
                  return (
                    <div key={p.id} onClick={() => setSelectedOpp(isSelected ? null : p.id)}
                      className={`bg-[#0a1610] rounded-xl p-2 text-center cursor-pointer transition-all relative ${p.folded ? 'opacity-25' : ''} ${isActive ? 'animate-glow' : ''}`}
                      style={{ border: `1px solid ${isSelected ? '#f59e0b' : isActive ? '#22c55e' : p.folded ? '#0d1510' : '#1a3220'}` }}>
                      {isSelected && <div className="absolute top-1 right-1.5 text-[8px] text-amber-500">●</div>}
                      {isActive && !p.folded && <div className="absolute top-1 left-1.5 text-[7px] text-[#4ade80] animate-blink tracking-wider">•••</div>}
                      <div className={`text-[8px] tracking-wider mb-0.5 ${isActive ? 'text-[#4ade80]' : 'text-[#2a5a3a]'}`}>{p.pos}</div>
                      {pers && <div className="text-[7px] font-bold mb-0.5" style={{ color: pers.color }}>{pers.label}</div>}
                      <div className="flex justify-center gap-0.5 mb-0.5">
                        {phase === 'showdown' && !p.folded ? p.hole.map((c, i) => <CardComponent key={i} card={c} small />) : [0, 1].map(i => <CardComponent key={i} hidden small />)}
                      </div>
                      <div className="text-[8px] text-[#3a6a4a]">${p.stack}</div>
                      {p.bet > 0 && <div className="text-[7px] text-[#86efac]">bet ${p.bet}</div>}
                      {stats?.lastAction && !p.folded && <div className="text-[7px] mt-0.5" style={{ color: acCol[stats.lastAction] || '#6aa87a' }}>{stats.lastAction}</div>}
                    </div>
                  );
                })}
              </div>

              {/* Board */}
              <div className="bg-[#091410] border border-[#1a3220] rounded-xl p-3 md:p-4 mb-2">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-[8px] tracking-[0.2em] text-[#2a5a3a]">{street.toUpperCase()}</span>
                  <span className="text-[11px] text-[#4ade80]">POT <b>${pot}</b></span>
                </div>
                <div className="flex justify-center gap-1.5 mb-2">
                  {board.map((c, i) => <div key={i} className="animate-dealIn" style={{ animationDelay: `${i * 0.07}s` }}><CardComponent card={c} /></div>)}
                  {Array(5 - board.length).fill(null).map((_, i) => <div key={i} className="w-13 h-[74px] rounded-lg border border-dashed border-[#1a3220] opacity-20" />)}
                </div>
                {equity != null && phase === 'betting' && (
                  <div className="text-center">
                    <div className="text-[8px] text-[#2a5a3a] tracking-wider mb-1">WIN EQUITY</div>
                    <div className="bg-[#060f09] rounded h-[7px] overflow-hidden max-w-[260px] mx-auto mb-1">
                      <div className="h-full rounded transition-all duration-700" style={{ background: equity > 60 ? '#22c55e' : equity > 40 ? '#f59e0b' : '#ef4444', width: `${equity}%` }} />
                    </div>
                    <div className="text-[15px] font-bold" style={{ color: equity > 60 ? '#22c55e' : equity > 40 ? '#f59e0b' : '#ef4444' }}>{equity}%</div>
                  </div>
                )}
                {/* Board texture */}
                {texture && board.length >= 3 && (
                  <div className="mt-2.5 animate-fadeUp">
                    {texture.scareCard && (
                      <div className="p-2 rounded-lg mb-2 bg-[#2d0a0a] flex gap-2 items-start" style={{ border: `1px solid ${texture.scareCard.color}` }}>
                        <span className="text-sm">⚠️</span>
                        <div>
                          <div className="text-[9px] font-bold tracking-wider mb-0.5" style={{ color: texture.scareCard.color }}>{texture.scareCard.type}</div>
                          <div className="text-[9px] text-[#c8b89a] leading-relaxed">{texture.scareCard.msg}</div>
                        </div>
                      </div>
                    )}
                    <div className="flex items-center gap-2 mb-1.5">
                      <div className="px-2.5 py-1 rounded text-[9px] font-bold tracking-wider" style={{ background: `${texture.color}18`, border: `1px solid ${texture.color}55`, color: texture.color }}>{texture.label}</div>
                      <div className="text-[8px] text-[#3a6a4a]">C-BET: <span className="text-[#c8b89a] font-bold">{texture.cbetSize}</span></div>
                    </div>
                  </div>
                )}
              </div>

              {/* Human seat */}
              <div className={`bg-[#0a1610] rounded-xl p-3 md:p-4 transition-all ${isMyTurn ? 'border-2 border-[#22c55e] animate-glow' : 'border-2 border-[#1a3220]'}`}>
                <div className="flex items-center gap-2.5 mb-2">
                  <div>
                    <div className="text-[8px] text-[#4ade80] tracking-wider mb-1">YOU · {human?.pos} · ${human?.stack}</div>
                    <div className="flex gap-1.5">
                      {human?.hole?.map((c, i) => <div key={i} className="animate-dealIn" style={{ animationDelay: `${i * 0.1}s` }}><CardComponent card={c} highlight={isMyTurn} /></div>)}
                    </div>
                  </div>
                  {human?.bet > 0 && <div className="text-[10px] text-[#86efac] ml-2">bet ${human.bet}</div>}
                  {human?.folded && <div className="text-[#f87171] text-xs ml-auto">FOLDED</div>}
                  {!isMyTurn && phase === 'betting' && !human?.folded && <div className="text-[9px] text-[#2a5a3a] ml-auto opacity-70">Waiting...</div>}
                </div>

                {/* Draws */}
                {drawInfo && drawInfo.draws.length > 0 && phase === 'betting' && board.length >= 3 && (
                  <div className="mb-2 bg-[#060f09] border border-[#1a3220] rounded-lg p-2 animate-fadeUp">
                    <div className="flex justify-between items-baseline mb-1.5">
                      <div className="text-[8px] tracking-[0.2em] text-[#2a5a3a]">YOUR OUTS</div>
                      {drawInfo.made && <div className="text-[9px] text-[#86efac]">Made: <b>{drawInfo.made}</b></div>}
                    </div>
                    {drawInfo.draws.map((d, di) => (
                      <div key={di} className={`${di < drawInfo.draws.length - 1 ? 'mb-2 pb-2 border-b border-[#0e2018]' : ''}`}>
                        <div className="flex items-center gap-1.5 mb-1">
                          <div className="w-1.5 h-1.5 rounded-full" style={{ background: d.color }} />
                          <div className="text-[10px] font-bold" style={{ color: d.color }}>{d.name}</div>
                          <div className="text-[9px] text-[#c8b89a] ml-auto"><b>{d.outs}</b> outs</div>
                        </div>
                        <div className="text-[9px] text-[#7a9a7a] leading-relaxed mb-1">{d.explain}</div>
                        {cardsLeft > 0 && (
                          <div className="bg-[#0a1610] rounded p-1.5 text-[9px] text-[#8aaa8a] leading-relaxed">
                            <span style={{ color: d.color }}>Rule of {cardsLeft === 2 ? 4 : 2}:</span> {d.outs} outs × {cardsLeft === 2 ? 4 : 2} ≈ <b className="text-[#c8b89a]">{outsEq(d.outs, cardsLeft)}%</b>
                            <span className="text-[#3a6a4a]"> (exact: {exactOutsEq(d.outs, drawInfo.unseenCount, cardsLeft)}%)</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Action buttons */}
                {isMyTurn && (
                  <div className="animate-fadeUp">
                    <div className="flex items-center gap-2 mb-2 p-1.5 px-2.5 rounded-lg border border-[#22c55e] animate-pulseTurn" style={{ background: 'linear-gradient(90deg, #0a2a1a, #0a1610)' }}>
                      <div className="w-1.5 h-1.5 rounded-full bg-[#4ade80]" style={{ boxShadow: '0 0 8px #4ade80' }} />
                      <div className="text-[10px] tracking-[0.25em] text-[#4ade80] font-bold">YOUR TURN</div>
                      {toCall > 0
                        ? <div className="text-[9px] text-[#86efac] ml-auto">${toCall} to call</div>
                        : <div className="text-[9px] text-[#6aa87a] ml-auto">action checked to you</div>}
                    </div>
                    <div className="flex gap-1.5 flex-wrap mb-1.5">
                      <ActionBtn border="#7f1d1d" bg="#2d0a0a" color="#fca5a5" label="FOLD" onClick={() => humanAct('fold')} />
                      {toCall === 0 && <ActionBtn border="#1e3a5f" bg="#0d1a2e" color="#93c5fd" label="CHECK" onClick={() => humanAct('check')} />}
                      {toCall > 0 && <ActionBtn border="#1e4a3a" bg="#0a2a1a" color="#6ee7b7" label={`CALL $${toCall}`} onClick={() => humanAct('call')} />}
                      {toCall === 0 && (
                        <>
                          <ActionBtn border="#713f12" bg="#1a0a00" color="#fcd34d" label={`½ POT $${Math.round(pot * 0.5)}`} onClick={() => humanAct('raise', Math.round(pot * 0.5))} />
                          <ActionBtn border="#713f12" bg="#1a0a00" color="#fcd34d" label={`⅔ POT $${Math.round(pot * 0.67)}`} onClick={() => humanAct('raise', Math.round(pot * 0.67))} />
                          <ActionBtn border="#713f12" bg="#1a0a00" color="#fcd34d" label={`POT $${pot}`} onClick={() => humanAct('raise', pot)} />
                        </>
                      )}
                      {toCall > 0 && <ActionBtn border="#713f12" bg="#1a0a00" color="#fcd34d" label={`RAISE $${minRaise}`} onClick={() => humanAct('raise', minRaise - human.bet)} />}
                    </div>
                    <div className="flex gap-1.5 items-center">
                      <input value={customBet} onChange={e => setCustomBet(e.target.value)} placeholder="Custom raise..."
                        className="bg-[#060f09] border border-[#1a3220] rounded-md py-1.5 px-2.5 text-[#c8b89a] text-[10px] w-24 outline-none" style={{ fontFamily: 'Georgia, serif' }} />
                      <ActionBtn border="#713f12" bg="#1a0a00" color="#fcd34d" label="BET" onClick={() => { const v = parseInt(customBet || '0'); if (v > 0) { humanAct('raise', v); setCustomBet(''); } }} />
                      <div className="text-[7px] text-[#2a5a3a] ml-auto hidden md:block">Keys: F·C·R</div>
                    </div>
                  </div>
                )}
              </div>

              {/* Pause panels */}
              {paused && paused.mode === 'prompt' && (
                <div className="mt-2 bg-[#0a1610] border-2 border-amber-500 rounded-xl p-3.5 animate-fadeUp">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-2 h-2 rounded-full bg-amber-500" style={{ boxShadow: '0 0 8px #f59e0b' }} />
                    <div className="text-[11px] tracking-[0.2em] text-[#fcd34d] font-bold">HAND PAUSED — STUDY MODE</div>
                  </div>
                  <div className="text-[10px] text-[#8aaa8a] leading-relaxed mb-2.5">
                    You folded on the {paused.snapshot.street}. Pick a way to study this position before the hand continues.
                  </div>
                  <div className="grid gap-1.5">
                    {([
                      { key: 'frozen', label: 'Just freeze the table', sub: "Stop the action so I can think", color: '#93c5fd', bg: '#0d1a2e', border: '#1e3a5f' },
                      { key: 'reveal', label: "Reveal opponents' hands", sub: `Show what the remaining players actually had`, color: '#fcd34d', bg: '#1a1200', border: '#713f12' },
                      { key: 'analyze', label: 'Show full analysis', sub: `Your equity was ${paused.snapshot.continuedEquity}%`, color: '#a78bfa', bg: '#1a0d2e', border: '#4c1d95' },
                      { key: 'resume', label: 'Resume — keep playing', sub: 'Continue the hand without studying', color: '#6ee7b7', bg: '#0a2a1a', border: '#1e4a3a' },
                    ] as const).map(opt => (
                      <button key={opt.key} onClick={() => {
                        if (opt.key === 'resume') { resumeAfterFold(); return; }
                        dispatch({ type: 'SET_PAUSE', mode: opt.key });
                      }} className="p-2.5 rounded-lg cursor-pointer text-left transition-all hover:brightness-130"
                        style={{ border: `1px solid ${opt.border}`, background: opt.bg, color: opt.color, fontFamily: 'Georgia, serif' }}>
                        <div className="text-[10px] font-bold tracking-wider mb-0.5">{opt.label}</div>
                        <div className="text-[9px] opacity-75">{opt.sub}</div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {paused && (paused.mode === 'frozen' || paused.mode === 'reveal' || paused.mode === 'analyze') && (
                <div className="mt-2 bg-[#0a1610] border border-[#1e3a5f] rounded-xl p-3.5 animate-fadeUp">
                  {paused.mode === 'reveal' && (
                    <>
                      <div className="text-[10px] tracking-[0.2em] text-[#fcd34d] font-bold mb-1.5">OPPONENTS REVEALED</div>
                      {paused.snapshot.opponents.map((o, i) => {
                        const score = paused.snapshot.board.length >= 3 ? bestHand(o.hole, paused.snapshot.board) : null;
                        const handName = score ? HAND_NAMES[score[0]] : '—';
                        return (
                          <div key={i} className="flex items-center gap-2 mb-1.5 p-1.5 bg-[#060f09] rounded-lg">
                            <div className="text-[10px] font-bold min-w-[34px]" style={{ color: o.personality?.color || '#c8b89a' }}>{o.pos}</div>
                            <div className="flex gap-1">{o.hole.map((c, j) => <CardComponent key={j} card={c} small />)}</div>
                            <div className="text-[9px] text-[#8aaa8a] ml-auto">{handName}</div>
                          </div>
                        );
                      })}
                    </>
                  )}
                  {paused.mode === 'frozen' && (
                    <div className="text-[10px] text-[#8aaa8a] leading-relaxed">
                      Table frozen on the {paused.snapshot.street}. Pot was <b className="text-[#c8b89a]">${paused.snapshot.pot}</b>. Take your time to study.
                    </div>
                  )}
                  {paused.mode === 'analyze' && (
                    <div>
                      <div className="text-[10px] tracking-[0.2em] text-[#c4b5fd] font-bold mb-2">FOLD ANALYSIS</div>
                      <div className="p-2.5 bg-[#060f09] rounded-lg mb-2">
                        <div className="text-[8px] tracking-wider text-[#2a5a3a] mb-1">YOUR EQUITY IF YOU'D STAYED</div>
                        <div className="text-[22px] font-bold" style={{ color: paused.snapshot.continuedEquity >= 50 ? '#4ade80' : paused.snapshot.continuedEquity >= 30 ? '#fcd34d' : '#fca5a5' }}>{paused.snapshot.continuedEquity}%</div>
                      </div>
                      {paused.snapshot.opponents.map((o, i) => {
                        const score = paused.snapshot.board.length >= 3 ? bestHand(o.hole, paused.snapshot.board) : null;
                        const handName = score ? HAND_NAMES[score[0]] : '—';
                        return (
                          <div key={i} className="flex items-center gap-2 mb-1 p-1.5 bg-[#060f09] rounded-lg">
                            <div className="text-[9px] font-bold" style={{ color: o.personality?.color }}>{o.pos}</div>
                            <div className="flex gap-1">{o.hole.map((c, j) => <CardComponent key={j} card={c} small />)}</div>
                            <div className="text-[9px] text-[#8aaa8a] ml-auto">{handName}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <button onClick={resumeAfterFold} className="w-full mt-2 p-2 rounded-lg border border-[#1e4a3a] bg-[#0a2a1a] text-[#4ade80] text-[10px] font-bold cursor-pointer tracking-[0.18em]" style={{ fontFamily: 'Georgia, serif' }}>
                    ▶ RESUME HAND
                  </button>
                </div>
              )}

              {phase === 'idle' && (
                <button onClick={() => dispatch({ type: 'DEAL_HAND' })}
                  className="w-full p-3.5 mt-2.5 rounded-xl border border-[#1e4a3a] text-[#4ade80] text-sm font-bold cursor-pointer tracking-[0.2em]"
                  style={{ background: 'linear-gradient(135deg, #0a2a1a, #051a0e)', fontFamily: 'Georgia, serif', boxShadow: '0 0 24px rgba(34, 197, 94, 0.1)' }}>
                  DEAL FIRST HAND
                </button>
              )}
            </div>

            {/* Right panel */}
            <div className="flex flex-col gap-2">
              {/* Opponent reads */}
              <div className="bg-[#0a1610] border border-[#1a3220] rounded-xl p-3">
                <div className="text-[8px] tracking-[0.25em] text-[#2a5a3a] mb-2">OPPONENT READS</div>
                {selectedOpp == null ? (
                  <div className="text-[10px] text-[#2a5a3a] leading-relaxed">Tap any opponent to see their tells.</div>
                ) : (() => {
                  const opp = players[selectedOpp];
                  const stats = oppStats[selectedOpp];
                  return (
                    <div className="animate-fadeUp">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="text-[11px] font-bold" style={{ color: opp?.personality?.color }}>{opp?.pos}</div>
                        {opp?.personality && <div className="px-2 py-0.5 rounded text-[8px]" style={{ color: opp.personality.color, border: `1px solid ${opp.personality.color}44`, background: `${opp.personality.color}11` }}>{opp.personality.full}</div>}
                      </div>
                      {opp?.personality && (
                        <div className="text-[9px] text-[#4a7a5a] leading-relaxed mb-2 p-1.5 bg-[#060f09] rounded-md">
                          {opp.personality.type === 'TAG' && 'Plays tight, bets big. Respect their raises.'}
                          {opp.personality.type === 'LAG' && 'Wide range, aggressive. Re-raise to test them.'}
                          {opp.personality.type === 'NIT' && "Only plays top 12%. If they raise, assume premium."}
                          {opp.personality.type === 'CS' && "Calls almost everything. Don't bluff them."}
                        </div>
                      )}
                      {stats && stats.totalActions > 0 && (
                        <div className="grid grid-cols-2 gap-1 mb-2">
                          {[['Raises', stats.raises], ['Calls', stats.calls], ['Checks', stats.checks], ['Folds', stats.folds]].map(([l, v]) => (
                            <div key={l as string} className="bg-[#060f09] rounded p-1 text-center">
                              <div className="text-[13px] font-bold text-[#c8b89a]">{v}</div>
                              <div className="text-[7px] text-[#2a5a3a] tracking-wider">{(l as string).toUpperCase()}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>

              {/* Advice */}
              <div className="bg-[#0a1610] border border-[#1a3220] rounded-xl p-3">
                <div className="text-[8px] tracking-[0.25em] text-[#2a5a3a] mb-2">LIVE GUIDE</div>
                {advice && equity != null ? (
                  <div className="animate-fadeUp">
                    <div className="inline-block px-2.5 py-1 rounded mb-2 text-[11px] font-bold tracking-wider"
                      style={{
                        background: advice.action.includes('BET') || advice.action.includes('RAISE') ? '#1a0a00' : advice.action.includes('CALL') ? '#0a2a1a' : advice.action.includes('FOLD') ? '#2d0a0a' : '#0d1a2e',
                        border: `1px solid ${advice.action.includes('BET') || advice.action.includes('RAISE') ? '#92400e' : advice.action.includes('CALL') ? '#065f46' : advice.action.includes('FOLD') ? '#7f1d1d' : '#1e3a5f'}`,
                        color: advice.action.includes('BET') || advice.action.includes('RAISE') ? '#fcd34d' : advice.action.includes('CALL') ? '#6ee7b7' : advice.action.includes('FOLD') ? '#fca5a5' : '#93c5fd',
                      }}>{advice.action}</div>
                    <div className="text-[10px] text-[#7a9a7a] leading-relaxed mb-2">{advice.reason}</div>
                    {toCall > 0 && (
                      <div className="bg-[#060f09] rounded-lg p-2">
                        <div className="text-[8px] tracking-wider text-[#2a5a3a] mb-1">POT ODDS</div>
                        <div className="flex justify-between text-[8px] mb-0.5"><span className="text-[#3a6a4a]">Equity needed</span><span className="text-[#fcd34d] font-bold">{advice.po}%</span></div>
                        <div className="flex justify-between text-[8px]"><span className="text-[#3a6a4a]">Your equity</span><span className={`font-bold ${equity > advice.po ? 'text-[#4ade80]' : 'text-[#f87171]'}`}>{equity}%</span></div>
                        <div className={`text-[8px] text-center mt-1 ${equity > advice.po ? 'text-[#4ade80]' : 'text-[#f87171]'}`}>{equity > advice.po ? '✓ Profitable call' : '✗ Not profitable'}</div>
                      </div>
                    )}
                  </div>
                ) : <div className="text-[10px] text-[#2a5a3a]">Deal a hand to begin.</div>}
              </div>

              {/* Showdown */}
              {phase === 'showdown' && showdown && (
                <div className="bg-[#0a1610] border border-[#22c55e] rounded-xl p-3 animate-fadeUp">
                  <div className="text-[8px] tracking-[0.25em] text-[#2a5a3a] mb-2">SHOWDOWN</div>
                  <div className="text-[13px] text-[#4ade80] font-bold mb-1">{showdown.winner} wins ${showdown.pot}</div>
                  {showdown.handName && <div className="text-[10px] text-[#6aa87a] mb-2">{showdown.handName}</div>}
                  {showdown.all && showdown.all.map(p => (
                    <div key={p.pos} className="mb-1.5">
                      <div className={`flex justify-between text-[9px] mb-0.5 ${p.isWinner ? 'text-[#4ade80]' : 'text-[#3a6a4a]'}`}>
                        <span>{p.pos} {p.isWinner ? '🏆' : ''}</span><span>{p.handName}</span>
                      </div>
                      <div className="flex gap-1">{p.hole?.map((c, j) => <CardComponent key={j} card={c} small highlight={p.isWinner} />)}</div>
                    </div>
                  ))}
                  <button onClick={() => dispatch({ type: 'DEAL_HAND' })}
                    className="w-full mt-2 p-2.5 rounded-lg border border-[#1e4a3a] bg-[#0a2a1a] text-[#4ade80] text-[11px] font-bold cursor-pointer tracking-wider" style={{ fontFamily: 'Georgia, serif' }}>
                    NEXT HAND ▸
                  </button>
                </div>
              )}

              {/* Log */}
              <div className="bg-[#0a1610] border border-[#1a3220] rounded-xl p-3">
                <div className="text-[8px] tracking-[0.25em] text-[#2a5a3a] mb-1.5">ACTION LOG</div>
                <div className="max-h-[140px] overflow-y-auto">
                  {log.length === 0 ? <div className="text-[9px] text-[#1a3220]">No actions yet.</div> : log.map(l => (
                    <div key={l.id} className="text-[9px] leading-relaxed mb-0.5" style={{ color: acCol[l.type] || '#6aa87a' }}>{l.msg}</div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* RANGES TAB */}
        {activeTab === 'range' && (
          <div className="bg-[#0a1610] border border-[#1a3220] rounded-2xl p-4 animate-fadeUp">
            <div className="text-[8px] tracking-[0.3em] text-[#2a5a3a] mb-3">PREFLOP OPENING RANGES — 6-MAX</div>
            <div className="flex gap-1.5 mb-3.5 flex-wrap">
              {POS6.map(p => (
                <button key={p} onClick={() => setRangePos(p)}
                  className={`px-3 py-1.5 rounded-md text-[9px] font-bold cursor-pointer transition-all ${rangePos === p ? 'bg-[#0a2a1a] text-[#4ade80] border-[#22c55e]' : 'bg-[#060f09] text-[#3a6a4a] border-[#1a3220]'}`}
                  style={{ border: `1px solid`, fontFamily: 'Georgia, serif' }}>{p}</button>
              ))}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <div className="text-[9px] tracking-wider text-[#2a5a3a] mb-2">OPEN RANGE: {rangePos}</div>
                <div className="grid grid-cols-13 gap-[1.5px] mb-2">
                  {GRID_RANKS.map((r1, i) => GRID_RANKS.map((r2, j) => {
                    const hand = i === j ? r1 + r1 : i < j ? r1 + r2 + 's' : r2 + r1 + 'o';
                    const cat = (RANGE_DATA[rangePos] || {})[hand] || '-';
                    return (
                      <div key={hand} title={hand} className="aspect-square rounded-sm flex items-center justify-center text-[4px] text-white/50 font-bold"
                        style={{ background: RANGE_COLORS[cat], opacity: cat === '-' ? 0.15 : 0.9 }}>
                        {cat !== '-' && hand.length <= 3 ? hand : ''}
                      </div>
                    );
                  }))}
                </div>
                <div className="flex gap-2 flex-wrap">
                  {[['p', 'Premium'], ['v', 'Value'], ['s', 'Speculative']].map(([k, l]) => (
                    <div key={k} className="flex items-center gap-1">
                      <div className="w-2 h-2 rounded-sm" style={{ background: RANGE_COLORS[k] }} />
                      <span className="text-[9px] text-[#4a7a5a]">{l}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-[8px] tracking-[0.2em] text-[#2a5a3a] mb-2.5">AI TYPES — HOW TO EXPLOIT</div>
                {PERSONALITIES.map(p => (
                  <div key={p.type} className="mb-2 p-2 bg-[#060f09] rounded-lg" style={{ border: `1px solid ${p.color}22` }}>
                    <div className="flex items-center gap-1.5 mb-1">
                      <div className="px-1.5 py-0.5 rounded text-[8px] font-bold" style={{ background: `${p.color}18`, border: `1px solid ${p.color}44`, color: p.color }}>{p.type}</div>
                      <div className="text-[9px]" style={{ color: p.color }}>{p.full}</div>
                    </div>
                    <div className="text-[9px] text-[#4a7a5a] leading-relaxed mb-1">VPIP {p.vpip}% · PFR {p.pfr}% · Bluff {Math.round(p.bluff * 100)}%</div>
                    <div className="text-[9px] text-[#6aa87a] leading-relaxed">
                      {p.type === 'TAG' && "Exploit: 3-bet light vs their steals. They fold too much to pressure."}
                      {p.type === 'LAG' && "Exploit: Trap with strong hands. Let them bluff off their stack."}
                      {p.type === 'NIT' && "Exploit: Steal their blinds constantly. Fold when they bet."}
                      {p.type === 'CS' && "Exploit: Value bet every street. Never bluff. Size up for maximum value."}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* GLOSSARY TAB */}
        {activeTab === 'glossary' && (
          <div className="bg-[#0a1610] border border-[#1a3220] rounded-2xl p-4 animate-fadeUp">
            <div className="text-[8px] tracking-[0.3em] text-[#2a5a3a] mb-3">POKER GLOSSARY</div>
            <input value={glossSearch} onChange={e => setGlossSearch(e.target.value)} placeholder="Search terms..."
              className="w-full bg-[#060f09] border border-[#1a3220] rounded-lg py-2 px-3 text-[#c8b89a] text-[11px] outline-none mb-3 box-border" style={{ fontFamily: 'Georgia, serif' }} />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {GLOSSARY.filter(g => g.term.toLowerCase().includes(glossSearch.toLowerCase()) || g.def.toLowerCase().includes(glossSearch.toLowerCase())).map(g => (
                <div key={g.term} className="bg-[#060f09] border border-[#1a3220] rounded-lg p-2.5">
                  <div className="text-[10px] text-[#4ade80] font-bold mb-1">{g.term}</div>
                  <div className="text-[9px] text-[#6aa87a] leading-relaxed">{g.def}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* STATS TAB */}
        {activeTab === 'stats' && (
          <div className="animate-fadeUp">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-2.5">
              {[
                { l: 'HANDS', v: session.hands },
                { l: 'WIN RATE', v: `${winRate}%`, c: winRate >= 50 ? '#4ade80' : winRate >= 35 ? '#f59e0b' : '#f87171' },
                { l: 'VPIP', v: `${vpipPct}%`, c: vpipPct >= 18 && vpipPct <= 32 ? '#4ade80' : '#f59e0b' },
                { l: 'PFR', v: `${pfrPct}%`, c: pfrPct >= 15 && pfrPct <= 26 ? '#4ade80' : '#f59e0b' },
                { l: 'CHIPS', v: `$${players[0]?.stack || START_STACK}`, c: (players[0]?.stack || START_STACK) > START_STACK ? '#4ade80' : (players[0]?.stack || START_STACK) < START_STACK ? '#f87171' : '#c8b89a' },
                { l: 'PROFIT', v: `${(players[0]?.stack || START_STACK) - START_STACK >= 0 ? '+' : ''}$${(players[0]?.stack || START_STACK) - START_STACK}`, c: (players[0]?.stack || START_STACK) >= START_STACK ? '#4ade80' : '#f87171' },
                { l: 'WINS', v: session.wins, c: '#4ade80' },
                { l: 'LOSSES', v: session.hands - session.wins, c: '#f87171' },
              ].map(s => (
                <div key={s.l} className="bg-[#0a1610] border border-[#1a3220] rounded-xl p-2.5 text-center">
                  <div className="text-[15px] font-bold mb-0.5" style={{ color: s.c || '#c8b89a' }}>{s.v}</div>
                  <div className="text-[7px] text-[#2a5a3a] tracking-wider">{s.l}</div>
                </div>
              ))}
            </div>
            <div className="bg-[#0a1610] border border-[#1a3220] rounded-xl p-3.5">
              <div className="text-[8px] tracking-[0.25em] text-[#2a5a3a] mb-2.5">HAND HISTORY</div>
              {session.hist.length === 0 ? <div className="text-[10px] text-[#2a5a3a]">No hands yet.</div> : session.hist.map((h, i) => (
                <div key={i} className="flex items-center gap-2 py-2 border-b border-[#0e2018]">
                  <div className={`w-6 h-4 rounded flex items-center justify-center shrink-0 ${h.result === 'win' ? 'bg-[#0a2a1a] border-[#22c55e]' : 'bg-[#2d0a0a] border-[#7f1d1d]'}`} style={{ border: '1px solid' }}>
                    <span className={`text-[7px] font-bold ${h.result === 'win' ? 'text-[#4ade80]' : 'text-[#f87171]'}`}>{h.result === 'win' ? 'W' : 'L'}</span>
                  </div>
                  <div className="flex gap-0.5 shrink-0">{h.hole?.map((c, j) => <CardComponent key={j} card={c} small />)}</div>
                  <div className="text-[8px] text-[#3a6a4a] flex-1">{h.handName || '—'}</div>
                  <div className="flex gap-0.5">{h.board?.slice(0, 3).map((c, j) => <CardComponent key={j} card={c} small />)}</div>
                  <div className={`text-[8px] font-bold shrink-0 ${h.result === 'win' ? 'text-[#4ade80]' : 'text-[#f87171]'}`}>{h.result === 'win' ? `+$${h.pot}` : '-'}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* READ TAB */}
        {activeTab === 'read' && (
          <div className="animate-fadeUp">
            <div className="bg-[#0a1610] border border-[#1a3220] rounded-xl p-3 mb-2">
              <div className="text-[8px] tracking-[0.25em] text-[#2a5a3a] mb-2">HAND-READING COACH</div>
              <div className="flex gap-1.5 mb-2">
                {[{ k: 'coach' as const, l: 'LIVE COACH', d: "Watch opponent's range narrow" }, { k: 'quiz' as const, l: 'QUIZ', d: 'Test yourself' }].map(m => (
                  <button key={m.k} onClick={() => setReadMode(m.k)}
                    className={`flex-1 p-2 rounded-lg cursor-pointer text-left transition-all ${readMode === m.k ? 'bg-[#4ade8015] border-[#4ade8066] text-[#4ade80]' : 'bg-[#060f09] border-[#1a3220] text-[#3a6a4a]'}`}
                    style={{ border: '1px solid', fontFamily: 'Georgia, serif' }}>
                    <div className="text-[10px] font-bold tracking-wider mb-0.5">{m.l}</div>
                    <div className="text-[8px] opacity-75">{m.d}</div>
                  </button>
                ))}
              </div>
              <div className="text-[8px] text-[#3a6a4a] leading-relaxed pt-1.5 border-t border-[#0e2018]">
                Hand reading = working out opponent cards by reasoning about their bets. The math is <b className="text-[#5a8a6a]">combinatorics</b>.
              </div>
            </div>

            {readMode === 'coach' && (() => {
              const opps = players.filter(p => !p.isHuman && !p.folded);
              if (opps.length === 0 || phase === 'idle') return <div className="bg-[#0a1610] border border-[#1a3220] rounded-xl p-6 text-center text-[11px] text-[#3a6a4a]">{phase === 'idle' ? 'Deal a hand to start hand reading.' : 'All opponents have folded.'}</div>;
              return (
                <>
                  <div className="bg-[#0a1610] border border-[#1a3220] rounded-xl p-3 mb-2">
                    <div className="text-[8px] tracking-[0.25em] text-[#2a5a3a] mb-2">PICK AN OPPONENT TO READ</div>
                    <div className="flex gap-1.5 flex-wrap">
                      {opps.map(o => (
                        <button key={o.id} onClick={() => setReadSelectedOpp(o.id)}
                          className={`px-3 py-2 rounded-lg text-[9px] font-bold cursor-pointer ${readSelectedOpp === o.id ? 'bg-[#0a2a1a]' : 'bg-[#060f09]'}`}
                          style={{ border: `1px solid ${readSelectedOpp === o.id ? (o.personality?.color || '#22c55e') : '#1a3220'}`, color: readSelectedOpp === o.id ? (o.personality?.color || '#4ade80') : '#3a6a4a', fontFamily: 'Georgia, serif' }}>
                          {o.pos} {o.personality && <span className="opacity-60 text-[7px]">·{o.personality.label}</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                  {readSelectedOpp != null && (() => {
                    const opp = players[readSelectedOpp];
                    const actions = oppActions[readSelectedOpp] || [];
                    const knownIds = new Set([...board, ...(players[0].hole || [])].map(c => c.id));
                    const result = narrowRange(opp.pos, board, actions, knownIds);
                    return (
                      <div className="animate-fadeUp">
                        <div className="bg-[#0a1610] border border-[#1a3220] rounded-xl p-3.5 mb-2">
                          <div className="text-[8px] tracking-[0.25em] text-[#2a5a3a] mb-2">HOW BETS NARROW THE RANGE</div>
                          {result.reasoning.map((r, i) => (
                            <div key={i} className={`mb-3 pb-3 ${i < result.reasoning.length - 1 ? 'border-b border-[#0e2018]' : ''}`}>
                              <div className="flex items-center gap-2 mb-1">
                                <div className="w-[18px] h-[18px] rounded-full bg-[#0a2a1a] border border-[#1e4a3a] flex items-center justify-center text-[9px] text-[#6ee7b7] font-bold">{i + 1}</div>
                                <div className="text-[11px] text-[#fcd34d] font-bold">{r.step}</div>
                                <div className="ml-auto text-[9px] text-[#86efac] font-bold">
                                  {r.before != null ? `${Math.round(r.before)} → ${Math.round(r.survivors)}` : `${Math.round(r.survivors)} combos`}
                                </div>
                              </div>
                              <div className="text-[9px] text-[#8aaa8a] leading-relaxed pl-7 mb-1">{r.detail}</div>
                              {r.keptHands && r.keptHands.length > 0 && (
                                <div className="pl-7 flex flex-wrap gap-1">
                                  {r.keptHands.slice(0, 18).map(h => (
                                    <span key={h} className="px-1.5 py-0.5 rounded bg-[#06140d] border border-[#1a3220] text-[8px] text-[#c8b89a] font-mono">{h}</span>
                                  ))}
                                  {r.keptHands.length > 18 && <span className="text-[8px] text-[#3a6a4a] self-center">+{r.keptHands.length - 18} more</span>}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                        <div className="text-center text-[9px] text-[#86efac] bg-[#0a1610] border border-[#1e4a3a] rounded-lg p-2.5">
                          <b className="text-[14px] text-[#fcd34d]">{Math.round(result.totalCombos)}</b> <span className="text-[#5a7a6a]">surviving combos</span>
                        </div>
                      </div>
                    );
                  })()}
                </>
              );
            })()}

            {readMode === 'quiz' && (
              <div className="bg-[#0a1610] border border-[#1a3220] rounded-xl p-4 text-center">
                <div className="text-[11px] text-[#8aaa8a] leading-relaxed mb-3">
                  Quiz mode: practice range estimation. Use the Live Coach mode during hands to learn first.
                </div>
                <div className="text-[9px] text-[#3a6a4a]">Full quiz system coming soon — use LIVE COACH for now.</div>
              </div>
            )}
          </div>
        )}

        {/* EXPLAIN TAB */}
        {activeTab === 'explain' && (
          <div className="animate-fadeUp">
            <div className="bg-[#0a1610] border border-[#1a3220] rounded-xl p-3 mb-2">
              <div className="flex items-center gap-2.5 mb-2.5">
                <div className="flex-1">
                  <div className="text-[8px] tracking-[0.25em] text-[#2a5a3a] mb-1">POKER TUTOR — FROZEN SNAPSHOT</div>
                  <div className="text-[9px] text-[#6aa87a] leading-relaxed">
                    {explainer ? `Captured on the ${explainer.cardsToCome === 2 ? 'flop' : explainer.cardsToCome === 1 ? 'turn' : 'river'}. Tap Refresh to recompute.` : 'Tap Refresh to analyse the current spot. Each concept gets a formula card and a worked example.'}
                  </div>
                </div>
                <button onClick={() => {
                  if (!human?.hole?.length) return;
                  const exp = buildExplainer(human.hole, board, Math.max(nOpp, 1), pot, toCall, human.stack, street);
                  setExplainer(exp);
                }} className="px-4 py-2 rounded-lg border border-[#1e4a3a] bg-[#0a2a1a] text-[#4ade80] text-[10px] font-bold cursor-pointer tracking-[0.15em]" style={{ fontFamily: 'Georgia, serif' }}>
                  ↻ REFRESH
                </button>
              </div>
              <div className="flex gap-1.5 pt-2 border-t border-[#0e2018]">
                <div className="text-[8px] tracking-[0.2em] text-[#3a6a4a] self-center mr-1.5">DEPTH:</div>
                {([
                  { l: 1, n: 'BEGINNER', c: '#4ade80' },
                  { l: 2, n: 'INTERMEDIATE', c: '#fcd34d' },
                  { l: 3, n: 'ADVANCED', c: '#a78bfa' },
                ] as const).map(opt => (
                  <button key={opt.l} onClick={() => setExplainerLevel(opt.l)}
                    className="flex-1 py-1.5 px-2 rounded-md text-[8px] tracking-[0.15em] font-bold cursor-pointer transition-all"
                    style={{ border: `1px solid ${explainerLevel >= opt.l ? opt.c + '66' : '#1a3220'}`, background: explainerLevel >= opt.l ? opt.c + '15' : '#060f09', color: explainerLevel >= opt.l ? opt.c : '#3a6a4a', fontFamily: 'Georgia, serif' }}>
                    {opt.n}
                  </button>
                ))}
              </div>
              <div className="text-[8px] text-[#3a6a4a] mt-1.5 leading-relaxed">
                {explainerLevel === 1 ? 'Showing core concepts only — pot odds, equity, decision rule, Rule of 2/4.' : explainerLevel === 2 ? 'Plus: implied odds, runner-runner, EV.' : 'All concepts — including SPR, position, fold equity.'}
              </div>
            </div>

            {!explainer && (
              <div className="bg-[#0a1610] border border-[#1a3220] rounded-xl p-8 text-center">
                <div className="text-[11px] text-[#3a6a4a] mb-1.5">This tab stays frozen so you can study one moment.</div>
                <div className="text-[9px] text-[#2a5a3a] leading-[1.7]">
                  Each concept will appear as a teaching card:<br/>
                  <span className="text-[#4ade80]">1.</span> The formula at the top<br/>
                  <span className="text-[#4ade80]">2.</span> Your numbers plugged in<br/>
                  <span className="text-[#4ade80]">3.</span> A step-by-step walkthrough explaining why
                </div>
              </div>
            )}

            {explainer && <>
              <div className="flex justify-around gap-2 text-center p-2.5 rounded-xl mb-2.5 border border-[#1e4a3a]" style={{ background: 'linear-gradient(90deg, #0a1610, #0a2a1a, #0a1610)' }}>
                <div><div className="text-[7px] tracking-[0.2em] text-[#3a6a4a]">EQUITY</div><div className="text-[16px] font-bold text-[#4ade80]">{explainer.equity}%</div></div>
                {explainer.toCall > 0 && <div><div className="text-[7px] tracking-[0.2em] text-[#3a6a4a]">POT ODDS</div><div className="text-[16px] font-bold text-[#fcd34d]">{explainer.po}%</div></div>}
                {explainer.totalOuts > 0 && <div><div className="text-[7px] tracking-[0.2em] text-[#3a6a4a]">OUTS</div><div className="text-[16px] font-bold text-[#a78bfa]">{explainer.totalOuts}</div></div>}
                <div><div className="text-[7px] tracking-[0.2em] text-[#3a6a4a]">SPR</div><div className="text-[16px] font-bold text-[#c8b89a]">{explainer.spr}</div></div>
              </div>

              {explainer.lessons.filter(l => l.level <= explainerLevel).map((lesson, idx) => {
                const lvCol = lesson.level === 1 ? '#4ade80' : lesson.level === 2 ? '#fcd34d' : '#a78bfa';
                const lvLabel = lesson.level === 1 ? 'BEGINNER' : lesson.level === 2 ? 'INTERMEDIATE' : 'ADVANCED';
                return (
                  <div key={lesson.id} className="bg-[#0a1610] border border-[#1a3220] rounded-xl p-3.5 mb-2 animate-fadeUp">
                    <div className="flex items-center gap-2 mb-1">
                      <div className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold" style={{ background: lvCol + '22', border: `1px solid ${lvCol}66`, color: lvCol }}>{idx + 1}</div>
                      <div className="flex-1 text-[13px] text-[#c8b89a] font-bold" style={{ fontFamily: 'Georgia, serif' }}>{lesson.title}</div>
                      <div className="px-1.5 py-0.5 rounded text-[7px] font-bold tracking-[0.15em]" style={{ background: lvCol + '15', border: `1px solid ${lvCol}33`, color: lvCol }}>{lvLabel}</div>
                    </div>
                    <div className="text-[10px] text-[#6aa87a] italic mb-2.5 pl-8">{lesson.tagline}</div>
                    <div className="rounded-lg p-2.5 mb-2" style={{ background: '#06140d', border: `1px solid ${lvCol}33` }}>
                      <div className="text-[7px] tracking-[0.25em] text-[#3a6a4a] mb-1">FORMULA</div>
                      <div className="text-[11px] font-semibold mb-2 leading-relaxed" style={{ color: lvCol, fontFamily: 'Georgia, serif' }}>{lesson.formula}</div>
                      <div className="text-[7px] tracking-[0.25em] text-[#3a6a4a] mb-1">YOUR NUMBERS</div>
                      <div className="text-[10px] text-[#c8b89a] font-mono mb-2 leading-relaxed break-words">{lesson.plug}</div>
                      <div className="flex justify-between items-baseline pt-2" style={{ borderTop: `1px solid ${lvCol}22` }}>
                        <div className="text-[7px] tracking-[0.25em] text-[#3a6a4a]">RESULT</div>
                        <div className="text-[14px] font-bold" style={{ color: lvCol, fontFamily: 'Georgia, serif' }}>{lesson.result}</div>
                      </div>
                    </div>
                    <div className="pl-1.5">
                      <div className="text-[7px] tracking-[0.25em] text-[#3a6a4a] mb-1.5">WORKED EXAMPLE — STEP BY STEP</div>
                      {lesson.example.map((step, i) => (
                        <div key={i} className="flex gap-2 mb-1.5 items-start">
                          <div className="shrink-0 w-3.5 h-3.5 rounded-full bg-[#0a2a1a] border border-[#1e4a3a] flex items-center justify-center text-[8px] text-[#6ee7b7] font-bold mt-0.5">{i + 1}</div>
                          <div className="text-[10px] text-[#8aaa8a] leading-relaxed flex-1">{step}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}

              {explainer.handDist.length > 0 && (
                <div className="bg-[#0a1610] border border-[#1a3220] rounded-xl p-3.5 mb-2">
                  <div className="text-[8px] tracking-[0.25em] text-[#2a5a3a] mb-1">HANDS YOU'LL SHOW DOWN WITH</div>
                  <div className="text-[9px] text-[#5a7a6a] mb-2.5 leading-relaxed">What hand you ended up with (and what beat you when you lost).</div>
                  {explainer.handDist.map((h, i) => (
                    <div key={i} className="mb-2">
                      <div className="flex justify-between text-[9px] mb-0.5">
                        <span className="text-[#c8b89a]">{h.name}</span>
                        <span><span className="text-[#4ade80]">+{h.winPct}%</span> <span className="text-[#3a6a4a]">/</span> <span className="text-[#fca5a5]">-{h.lossPct}%</span></span>
                      </div>
                      <div className="flex h-[5px] rounded-sm overflow-hidden bg-[#060f09]">
                        <div style={{ width: `${h.winPct}%`, background: '#22c55e' }} />
                        <div style={{ width: `${h.lossPct}%`, background: '#7f1d1d' }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {explainer.scenarios.length > 0 && (
                <div className="bg-[#0a1610] border border-[#1a3220] rounded-xl p-3.5 mb-2">
                  <div className="text-[8px] tracking-[0.25em] text-[#2a5a3a] mb-1">NEXT CARD SCENARIOS</div>
                  <div className="text-[9px] text-[#5a7a6a] mb-2.5 leading-relaxed">
                    What every possible {explainer.cardsToCome === 2 ? 'turn' : 'river'} card does to your hand. Currently: <b className="text-[#86efac]">{explainer.currentHandName}</b>.
                  </div>
                  {explainer.scenarios.map((s, i) => (
                    <div key={i} className="mb-2 p-2 bg-[#060f09] rounded-lg" style={{ border: `1px solid ${s.improved ? '#1e4a3a' : '#1a3220'}` }}>
                      <div className="flex justify-between items-center mb-1">
                        <div className="text-[10px] font-bold" style={{ color: s.improved ? '#4ade80' : '#8aaa8a' }}>{s.improved ? '↑ ' : ''}{s.key}</div>
                        <div className="text-[9px] text-[#c8b89a]"><b>{s.count}</b> cards · <b>{s.pct}%</b></div>
                      </div>
                      <div className="flex gap-0.5 flex-wrap">
                        {s.examples.map((c, j) => <CardComponent key={j} card={c} small />)}
                        {s.count > s.examples.length && <div className="text-[9px] text-[#3a6a4a] self-center ml-1">+{s.count - s.examples.length} more</div>}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {explainer.cardsToCome === 0 && (
                <div className="bg-[#0a1610] border border-[#1a3220] rounded-xl p-3.5 mb-2">
                  <div className="text-[8px] tracking-[0.25em] text-[#2a5a3a] mb-1.5">RIVER — NO MORE CARDS</div>
                  <div className="text-[9px] text-[#8aaa8a] leading-relaxed">
                    All five board cards are out. Your hand is <b className="text-[#86efac]">{explainer.currentHandName}</b>. Equity now reflects only the unknown opponent hole cards.
                  </div>
                </div>
              )}
            </>}
          </div>
        )}
      </div>
    </div>
  );
}

function ActionBtn({ border, bg, color, label, onClick }: { border: string; bg: string; color: string; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="px-3 py-2 rounded-lg text-[11px] font-bold cursor-pointer tracking-wider transition-all hover:brightness-120 min-h-[44px]"
      style={{ border: `1px solid ${border}`, background: bg, color, fontFamily: 'Georgia, serif' }}>
      {label}
    </button>
  );
}
