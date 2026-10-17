// Live agent pipeline inside a chat message: one card per step, joined by a dashed connector (spec §8).
// Cards carry the agent role (Strategist / Producer / Art Director) and a live status ("analysing…" -> "✓ Done").
import { Spinner } from '../editor/ui';
import type { AgentRole, AgentStep, AgentStepStatus } from './types';

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

export function StepList({ steps }: { steps: AgentStep[] }) {
  if (!steps.length) return null;
  return (
    <ol className="mt-1.5 flex flex-col">
      {steps.map((s, i) => {
        const role = s.role ? ROLE[s.role] : null;
        const muted = s.status === 'pending' || s.status === 'skipped';
        return (
          <li key={s.id} className="flex flex-col" title={LABEL[s.status]}>
            {i > 0 ? <span aria-hidden className="ml-5 h-2 border-l border-dashed border-slate-300" /> : null}
            <div
              className={`rounded-xl border px-2.5 py-1.5 shadow-[0_1px_2px_rgba(0,8,86,0.05)] backdrop-blur-sm transition-colors ${
                role ? role.card : 'border-slate-200 bg-white'
              } ${muted ? 'opacity-60' : ''} ${s.status === 'failed' ? '!border-rose-200 !bg-rose-50' : ''}`}
            >
              <div className="flex items-center gap-2 text-[12px] leading-snug">
                {s.icon ? (
                  <span aria-hidden className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-white/80 text-[11px] shadow-sm">
                    {s.icon}
                  </span>
                ) : null}
                <span className={`min-w-0 flex-1 break-words text-slate-700 ${s.status === 'running' ? 'font-semibold' : 'font-medium'}`}>
                  {s.label}
                </span>
                <Status s={s} />
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
            </div>
          </li>
        );
      })}
    </ol>
  );
}
