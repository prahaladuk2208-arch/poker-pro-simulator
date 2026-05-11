import type { Card } from '../../engine/types';
import { RED } from '../../engine/deck';

interface Props {
  card?: Card;
  hidden?: boolean;
  small?: boolean;
  highlight?: boolean;
}

export function CardComponent({ card, hidden = false, small = false, highlight = false }: Props) {
  const red = card && RED.has(card.s);
  const w = small ? 'w-9' : 'w-13';
  const h = small ? 'h-13' : 'h-[74px]';

  if (hidden) {
    return (
      <div className={`${w} ${h} rounded-lg shrink-0 flex items-center justify-center relative overflow-hidden border-2 border-[#1e3a5f]`}
        style={{ background: 'linear-gradient(145deg, #1a3a5c, #0d1f35)', boxShadow: '0 2px 6px #0006' }}>
        <span className={`${small ? 'text-[10px]' : 'text-[16px]'} text-[#1e3a5f] opacity-30`}>◈</span>
      </div>
    );
  }

  if (!card) return null;

  const textColor = red ? 'text-red-600' : 'text-slate-800';
  const borderColor = highlight ? 'border-amber-500/25' : red ? 'border-red-600/10' : 'border-slate-800/6';
  const shadow = highlight ? '0 0 10px rgba(245, 158, 11, 0.27)' : '0 2px 6px rgba(0,0,0,0.2)';

  return (
    <div className={`${w} ${h} rounded-lg shrink-0 flex flex-col items-center justify-center relative overflow-hidden border-2 ${borderColor} bg-[#faf6f0]`}
      style={{ fontFamily: 'Georgia, serif', boxShadow: shadow }}>
      <div className={`absolute top-0.5 left-1 ${small ? 'text-[7px]' : 'text-[9px]'} font-bold leading-tight ${textColor}`}>
        {card.r}<br /><span className={small ? 'text-[6px]' : 'text-[8px]'}>{card.s}</span>
      </div>
      <div className={`${small ? 'text-[13px]' : 'text-[20px]'} ${textColor}`}>{card.s}</div>
      <div className={`absolute bottom-0.5 right-1 ${small ? 'text-[7px]' : 'text-[9px]'} font-bold leading-tight ${textColor} rotate-180`}>
        {card.r}<br /><span className={small ? 'text-[6px]' : 'text-[8px]'}>{card.s}</span>
      </div>
    </div>
  );
}
