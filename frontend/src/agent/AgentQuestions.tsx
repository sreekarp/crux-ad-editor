// Clarifying questions under an agent chat message: single-select chips per question (multi-select when q.multi, e.g.
// "Which businesses?"), an "Other…" chip with an inline text box, "Continue" (once every question has an answer) and
// "Just go — best guess" (always). A multi answer is sent as "A, B, C".
import { useEffect, useId, useRef, useState } from 'react';
import type { ChatMsg } from '../editor/store';
import { Button, Icon } from '../editor/ui';
import { answerQuestions } from './agent';
import type { AgentQuestion } from './types';

const OTHER = '\u0000other';

function Chip({
  label,
  active,
  locked,
  dashed,
  multi,
  onClick,
}: {
  label: string;
  active: boolean;
  locked: boolean;
  dashed?: boolean;
  multi?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role={multi ? 'checkbox' : 'radio'}
      aria-checked={active}
      disabled={locked}
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium leading-none transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky/50 ${
        active
          ? 'border-navy bg-navy text-white shadow-sm'
          : `${dashed ? 'border-dashed' : ''} border-slate-300 bg-white text-slate-600 hover:border-sky hover:text-navy`
      } ${locked ? (active ? 'cursor-default' : 'cursor-default opacity-40') : ''}`}
    >
      {active ? <Icon name="check" size={11} stroke={2.6} /> : null}
      {label}
    </button>
  );
}

function QuestionRow({
  q,
  index,
  picked,
  selected,
  other,
  locked,
  onPick,
  onToggle,
  onOther,
  onEnter,
}: {
  q: AgentQuestion;
  index: number;
  picked: string | undefined;
  /** Multi-select only: the picked answers (options and added "Other" texts), in click order. */
  selected: string[];
  other: string;
  locked: boolean;
  onPick: (v: string) => void;
  onToggle: (v: string) => void;
  onOther: (v: string) => void;
  onEnter: () => void;
}) {
  const multi = !!q.multi;
  const extras = multi ? selected.filter((v) => !q.options.includes(v)) : [];
  const labelId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const otherOn = picked === OTHER;
  useEffect(() => {
    if (otherOn && !locked) inputRef.current?.focus();
  }, [otherOn, locked]);
  return (
    <div>
      <div id={labelId} className="mb-1.5 flex items-baseline gap-1.5 text-[12px] font-semibold leading-snug text-navy">
        <span className="text-[10px] font-bold text-sky">{index + 1}</span>
        {q.q}
      </div>
      <div role={multi ? 'group' : 'radiogroup'} aria-labelledby={labelId} className="flex flex-wrap items-center gap-1.5">
        {q.options.map((o) =>
          multi ? (
            <Chip key={o} label={o} multi active={selected.includes(o)} locked={locked} onClick={() => onToggle(o)} />
          ) : (
            <Chip key={o} label={o} active={picked === o} locked={locked} onClick={() => onPick(o)} />
          ),
        )}
        {extras.map((o) => (
          <Chip key={`x:${o}`} label={o} multi active locked={locked} onClick={() => onToggle(o)} />
        ))}
        {otherOn ? (
          <input
            ref={inputRef}
            value={other}
            disabled={locked}
            onChange={(e) => onOther(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                // Multi: Enter adds the typed answer as a chip (and keeps the box open for another); empty Enter submits.
                if (multi && other.trim()) {
                  if (!selected.includes(other.trim())) onToggle(other.trim());
                  onOther('');
                } else onEnter();
              } else if (e.key === 'Escape' && !other) {
                onPick('');
              }
            }}
            placeholder={multi ? 'Type and press Enter…' : 'Type your answer…'}
            aria-label={`${q.q} — your own answer`}
            className="h-[23px] min-w-[7rem] flex-1 rounded-full border border-navy bg-white px-2.5 text-[11px] text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-sky/40 disabled:border-slate-200 disabled:bg-slate-50"
          />
        ) : (
          <Chip label="Other…" dashed active={false} locked={locked} onClick={() => onPick(OTHER)} />
        )}
      </div>
    </div>
  );
}

export function AgentQuestions({ m }: { m: ChatMsg }) {
  const questions = m.questions ?? [];
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<'answers' | 'best' | null>(null);
  const locked = !!sent || !!m.answered;

  const answerOf = (q: AgentQuestion) => {
    if (q.multi) {
      // Selected chips, plus a typed "Other" answer that wasn't added with Enter yet.
      const typed = picked[q.id] === OTHER ? (other[q.id] ?? '').trim() : '';
      const list = [...(chosen[q.id] ?? [])];
      if (typed && !list.includes(typed)) list.push(typed);
      return list.join(', ');
    }
    const p = picked[q.id];
    return p === OTHER ? (other[q.id] ?? '').trim() : (p ?? '');
  };
  const answeredCount = questions.filter((q) => answerOf(q)).length;
  const ready = answeredCount === questions.length;

  const submit = (best: boolean) => {
    if (locked || (!best && !ready)) return;
    setSent(best ? 'best' : 'answers');
    const answers = best ? null : Object.fromEntries(questions.map((q) => [q.q, answerOf(q)]));
    void answerQuestions(m.id, answers);
  };

  if (!questions.length) return null;
  return (
    <div className={`mt-1.5 rounded-xl border bg-white p-2.5 transition ${locked ? 'border-slate-200' : 'border-sky/60 shadow-sm'}`}>
      <div className="space-y-2.5">
        {questions.map((q, i) => (
          <QuestionRow
            key={q.id}
            q={q}
            index={i}
            picked={picked[q.id]}
            selected={chosen[q.id] ?? []}
            other={other[q.id] ?? ''}
            locked={locked}
            onPick={(v) => setPicked((s) => ({ ...s, [q.id]: v }))}
            onToggle={(v) =>
              setChosen((s) => {
                const cur = s[q.id] ?? [];
                return { ...s, [q.id]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] };
              })
            }
            onOther={(v) => setOther((s) => ({ ...s, [q.id]: v }))}
            onEnter={() => submit(false)}
          />
        ))}
      </div>
      <div className="mt-2.5 flex items-center gap-1.5 border-t border-slate-100 pt-2">
        {locked ? (
          <span className="flex items-center gap-1 text-[11px] font-medium text-slate-400">
            <Icon name="check" size={12} /> {sent === 'best' ? 'Going with my best guess' : 'Answered'}
          </span>
        ) : (
          <>
            <Button
              variant="primary"
              size="sm"
              disabled={!ready}
              onClick={() => submit(false)}
              title={ready ? 'Continue with these answers' : 'Pick an answer for each question first'}
            >
              Continue <Icon name="send" size={12} />
            </Button>
            <Button variant="outline" size="sm" onClick={() => submit(true)} title="Skip the questions and let the agent decide">
              <Icon name="wand" size={12} /> Just go — best guess
            </Button>
            {questions.length > 1 ? (
              <span className="ml-auto text-[10px] tabular-nums text-slate-400" aria-live="polite">
                {answeredCount}/{questions.length}
              </span>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
