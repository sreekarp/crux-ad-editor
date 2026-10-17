// Live agent pipeline inside a chat message: one card per step, joined by a dashed connector (spec §8).
// Cards carry the agent role (Strategist / Producer / Art Director) and a live status ("analysing…" -> "✓ Done").
// A card with `thinking` gets a chevron: clicking the card header opens an inline panel with what that role saw and decided.
import { useEffect, useId, useRef, useState } from 'react';
import { Icon, Spinner } from '../editor/ui';
import type { AgentRole, AgentStep, AgentStepStatus, StepThought } from './types';

const LABEL: Record<AgentStepStatus, string> = {
  pending: 'Pending',
  running: 'In progress',
  done: 'Done',
  warn: 'Needs work',
  failed: 'Failed',
  skipped: 'Skipped',
};

/** Role -> pill text + card tint (bloom tokens: sky, mint, lilac). */
const ROLE: Record<AgentRole, { name: string; card: string; pill: string }> = {
  strategist: { name: 'Strategist', card: 'border-sky/40 bg-sky/[0.07]', pill: 'bg-sky/20 text-navy' },
  producer: { name: 'Producer', card: 'border-mint/50 bg-mint/[0.09]', pill: 'bg-mint/30 text-navy' },
  'art-director': { name: 'Art Director', card: 'border-[#CF89FE]/45 bg-[#CF89FE]/[0.08]', pill: 'bg-[#CF89FE]/25 text-navy' },
};

function Status({ s }: { s: AgentStep }) {
  if (s.status === 'running') {
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-slate-500">
        <Spinner className="!h-3 !w-3" /> {s.detail ?? 'analysing…'}
      </span>
    );
  }
  if (s.status === 'pending') return <span className="shrink-0 text-[11px] text-slate-400">{s.detail ?? 'queued'}</span>;
  if (s.status === 'failed') return <span className="shrink-0 text-[11px] font-semibold text-rose-600">✗ {s.detail ?? 'Failed'}</span>;
  if (s.status === 'skipped') return <span className="shrink-0 text-[11px] text-slate-400">– {s.detail ?? 'Skipped'}</span>;
  if (s.status === 'warn') {
    return <span className="shrink-0 text-[11px] font-semibold tabular-nums text-amber-600">⚠ {s.detail ?? 'Needs work'}</span>;
  }
  return (
    <span className="flex shrink-0 items-center gap-1 text-[11px] font-semibold tabular-nums text-navy">
      <span className="text-emerald-500">✓</span> {s.detail ?? 'Done'}
    </span>
  );
}

/** The opened "thinking" panel: titled sections of short lines, scrolls inside itself when long. Renders live. */
function Thinking({ id, sections }: { id: string; sections: StepThought[] }) {
  return (
    <div
      id={id}
      className="mt-1.5 max-h-60 overflow-y-auto overscroll-contain rounded-lg border border-white/70 bg-white/60 px-2 py-1.5"
    >
      {sections.map((t, i) => (
        <section key={`${i}-${t.title}`} className={i ? 'mt-1.5' : ''}>
          {t.title ? <div className="text-[11px] font-bold leading-snug text-navy">{t.title}</div> : null}
          {t.lines?.length ? (
            <ul className="mt-0.5 flex flex-col gap-px">
              {t.lines.map((l, j) => (
                <li key={j} className="flex gap-1.5 text-[12px] leading-snug text-slate-600">
                  <span aria-hidden className="shrink-0 text-slate-400">
                    •
                  </span>
                  <span className="min-w-0 flex-1 break-words">{l}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}
    </div>
  );
}

function StepCard({ s, first, onToggle }: { s: AgentStep; first: boolean; onToggle?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const justOpened = useRef(false);
  const role = s.role ? ROLE[s.role] : null;
  const muted = s.status === 'pending' || s.status === 'skipped';
  const hasThinking = !!s.thinking?.length;
  const shown = open && hasThinking;

  // Bring a freshly opened panel into view (minimal scroll), never on later live updates.
  useEffect(() => {
    if (!shown || !justOpened.current) return;
    justOpened.current = false;
    panelRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [shown]);

  const toggle = () => {
    const next = !open;
    justOpened.current = next;
    setOpen(next);
    onToggle?.(next);
  };
  const onHeader = () => {
    // Dragging to select the label text should not toggle the panel.
    if (window.getSelection?.()?.isCollapsed === false) return;
    toggle();
  };

  return (
    <li className="flex flex-col">
      {!first ? <span aria-hidden className="ml-5 h-2 border-l border-dashed border-slate-300" /> : null}
      <div
        className={`rounded-xl border px-2.5 py-1.5 shadow-[0_1px_2px_rgba(0,8,86,0.05)] backdrop-blur-sm transition-colors ${
          role ? role.card : 'border-slate-200 bg-white'
        } ${muted && !shown ? 'opacity-60' : ''} ${s.status === 'failed' ? '!border-rose-200 !bg-rose-50' : ''}`}
      >
        <div
          className={`group flex items-start gap-2 text-[12px] ${hasThinking ? 'cursor-pointer' : ''}`}
          title={LABEL[s.status]}
          onClick={hasThinking ? onHeader : undefined}
        >
          {s.icon ? (
            <span aria-hidden className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-white/80 text-[11px] shadow-sm">
              {s.icon}
            </span>
          ) : null}
          {/* Long labels wrap at word boundaries; a card with thinking folds to 2 lines until opened. */}
          <span
            className={`min-w-0 flex-1 break-words leading-5 text-pretty text-slate-700 ${s.status === 'running' ? 'font-semibold' : 'font-medium'} ${
              hasThinking && !shown ? 'line-clamp-2' : ''
            }`}
            title={hasThinking && !shown ? s.label : undefined}
          >
            {s.label}
          </span>
          <span className="flex min-h-5 shrink-0 items-center">
            <Status s={s} />
          </span>
          {hasThinking ? (
            <button
              type="button"
              aria-label="Show thinking"
              aria-expanded={shown}
              aria-controls={shown ? panelId : undefined}
              title={shown ? 'Hide thinking' : 'Show thinking'}
              onClick={(e) => {
                e.stopPropagation();
                toggle();
              }}
              className="-mr-1 grid h-5 w-5 shrink-0 place-items-center rounded-md text-slate-400 transition-colors hover:bg-white/80 hover:text-navy focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky group-hover:text-navy"
            >
              <Icon name="chevronDown" size={12} stroke={2.4} className={`transition-transform ${shown ? 'rotate-180' : ''}`} />
            </button>
          ) : null}
        </div>
        {role || s.chips?.length ? (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {role ? (
              <span className={`rounded-full px-1.5 py-px text-[9.5px] font-bold uppercase tracking-wide ${role.pill}`}>{role.name}</span>
            ) : null}
            {s.chips?.map((c) => (
              <span key={c} className="rounded-md border border-white/70 bg-white/70 px-1.5 py-px text-[10px] font-medium text-slate-600">
                {c}
              </span>
            ))}
          </div>
        ) : null}
        {shown ? (
          <div ref={panelRef}>
            <Thinking id={panelId} sections={s.thinking!} />
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The agent's step cards. `onToggle` fires when a card's thinking panel opens/closes, so the host message can
 * unfold itself and stop the chat from chasing the bottom while the reader looks at it.
 */
export function StepList({ steps, onToggle }: { steps: AgentStep[]; onToggle?: (open: boolean) => void }) {
  if (!steps.length) return null;
  return (
    <ol className="mt-1.5 flex flex-col">
      {steps.map((s, i) => (
        <StepCard key={s.id} s={s} first={i === 0} onToggle={onToggle} />
      ))}
    </ol>
  );
}
