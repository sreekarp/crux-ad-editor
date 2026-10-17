// Right panel: the Copilot chat, full height. Properties / Layers live in the Inspector column (Inspector.tsx).
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ACCEPTED_FILES } from '../import';
import { CHIPS, fixAll, fourLikeUpload, handleUpload, importPreviewOf, recreateUpload, runChip, sendMessage } from './copilot';
import { getActive, useEditor, type ChatAction, type ChatMsg } from './store';
import { Icon, IconButton, Spinner } from './ui';
import { agentContinue, agentPrompt } from '../agent/agent';
import { AgentQuestions } from '../agent/AgentQuestions';
import { StepList } from '../agent/StepList';

/** Long message bodies fold to this height (px) behind "Show more". */
const CLAMP_PX = 260;
/** Within this distance (px) of the bottom the list counts as "following" new messages. */
const STICK_PX = 80;

/** Lets a message tell the list "the user is reading here": stop following new content until they scroll down. */
const UnpinCtx = createContext<() => void>(() => {});
/** Lets content inside a message ask its Clamp to show everything (e.g. a step card opening its thinking panel). */
const RevealCtx = createContext<() => void>(() => {});

const timeOf = (at?: number) => (at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : undefined);

const NUM_RE = /^\s*(\d+)[.)]\s+(.*)$/;
const BULLET_RE = /^\s*[•\-–·*]\s+(.*)$/;
/** "## Fixed" -> a small section label (agent messages only; classic replies never start a line with "## "). */
const SECTION_RE = /^##\s+(.+)$/;

/**
 * Plain text with light structure: "## " lines are section labels, numbered / bulleted lines get a hanging indent,
 * the one line directly under a list item (e.g. a variation's quoted headline) stays indented with it, blank lines
 * become gaps.
 */
function RichText({ text }: { text: string }) {
  let afterItem = false;
  return (
    <>
      {text.split('\n').map((line, i) => {
        const section = SECTION_RE.exec(line);
        if (section) {
          afterItem = false;
          return (
            <div
              key={i}
              role="heading"
              aria-level={4}
              className={`${i ? 'mt-2' : ''} pb-px text-[10.5px] font-bold uppercase leading-5 tracking-wider text-slate-500`}
            >
              {section[1]}
            </div>
          );
        }
        const num = NUM_RE.exec(line);
        const bullet = BULLET_RE.exec(line);
        if (num || bullet) {
          afterItem = true;
          return (
            <div key={i} className="flex gap-1.5 py-px">
              <span className="w-4 shrink-0 text-right font-semibold tabular-nums text-slate-400">{num ? `${num[1]}.` : '•'}</span>
              <span className="min-w-0 flex-1">{num ? num[2] : bullet![1]}</span>
            </div>
          );
        }
        const indent = afterItem;
        afterItem = false;
        if (!line.trim()) return <div key={i} className="h-1.5" aria-hidden />;
        return (
          <div key={i} className={`py-px ${indent ? 'pl-[22px]' : ''}`}>
            {line}
          </div>
        );
      })}
    </>
  );
}

/** Folds tall content behind a fade + "Show more". Never folds while live (steps still running). */
function Clamp({ live, tone = 'light', children }: { live: boolean; tone?: 'light' | 'navy' | 'rose'; children: ReactNode }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(false);
  const collapsing = useRef(false);
  const unpin = useContext(UnpinCtx);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setTall(el.scrollHeight > CLAMP_PX + 40);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // "Show less" shrinks the message above the reader's eyes: bring its (now short) body back into view.
  useLayoutEffect(() => {
    if (open || !collapsing.current) return;
    collapsing.current = false;
    wrapRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open]);
  const folded = tall && !open && !live;
  const fade = tone === 'navy' ? 'from-navy' : tone === 'rose' ? 'from-rose-50' : 'from-white';
  // Something inside wants to be read in full: unfold (so it can't land behind "Show more") and hold the scroll still.
  const reveal = () => {
    unpin();
    setOpen(true);
  };
  return (
    <div ref={wrapRef}>
      <div ref={ref} className="relative overflow-hidden" style={folded ? { maxHeight: CLAMP_PX } : undefined}>
        <RevealCtx.Provider value={reveal}>{children}</RevealCtx.Provider>
        {folded ? <div className={`pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t ${fade} to-transparent`} /> : null}
      </div>
      {tall && !live ? (
        <button
          type="button"
          onClick={() => {
            // Expanding/collapsing keeps the message where it is instead of chasing the bottom of the list.
            unpin();
            collapsing.current = open;
            setOpen(!open);
          }}
          className={`mt-1 inline-flex items-center gap-1 text-[11px] font-semibold ${tone === 'navy' ? 'text-sky hover:text-white' : 'text-xblue hover:text-navy'}`}
        >
          {open ? 'Show less' : 'Show more'}
          <Icon name="chevronDown" size={12} stroke={2.4} className={open ? 'rotate-180' : ''} />
        </button>
      ) : null}
    </div>
  );
}

/** Step cards inside a Clamp: opening a card's thinking unfolds the message; closing it just keeps the scroll still. */
function MessageSteps({ steps }: { steps: NonNullable<ChatMsg['steps']> }) {
  const reveal = useContext(RevealCtx);
  const unpin = useContext(UnpinCtx);
  return <StepList steps={steps} onToggle={(open) => (open ? reveal() : unpin())} />;
}

function Message({ m, onAction }: { m: ChatMsg; onAction: (a: ChatAction) => void }) {
  const busy = useEditor((s) => s.busy);
  if (m.role === 'user') {
    return (
      <div className="flex justify-end pl-10" title={timeOf(m.at)}>
        <div className="min-w-0 rounded-2xl rounded-br-md bg-navy px-3.5 py-2.5 text-[13.5px] leading-relaxed text-white shadow-sm">
          {m.image ? <img src={m.image} alt="" className="mb-2 max-h-40 rounded-lg" /> : null}
          <Clamp live={false} tone="navy">
            <div className="whitespace-pre-wrap break-words">{m.text}</div>
          </Clamp>
        </div>
      </div>
    );
  }
  const live = !!m.progress || !!m.steps?.some((s) => s.status === 'running' || s.status === 'pending');
  return (
    <div className="flex gap-2.5" title={timeOf(m.at)}>
      <div className="mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-sky/20 text-navy">
        <Icon name="sparkle" size={13} />
      </div>
      <div className="min-w-0 flex-1">
        {m.text || m.steps?.length ? (
          <div
            className={`rounded-2xl rounded-tl-md border px-3.5 py-2.5 text-[13.5px] leading-relaxed ${
              m.error ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-slate-200/80 bg-white text-slate-700 shadow-[0_1px_2px_rgba(0,8,86,0.04)]'
            }`}
          >
            <Clamp live={live} tone={m.error ? 'rose' : 'light'}>
              {m.text ? (
                <div className="break-words">
                  <RichText text={m.text} />
                </div>
              ) : null}
              {m.steps?.length ? <MessageSteps steps={m.steps} /> : null}
            </Clamp>
          </div>
        ) : null}
        {m.questions?.length ? <AgentQuestions m={m} /> : null}
        {m.progress ? (
          <div className="mt-1.5 flex items-center gap-2 px-1 text-xs font-medium text-slate-500">
            <Spinner /> {m.progress}
          </div>
        ) : null}
        {m.actions?.length ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {m.actions.map((a) => (
              <button
                key={a.label}
                type="button"
                // The agent drops follow-ups while it is working: show that instead of a click that does nothing.
                disabled={busy && (a.kind === 'agent-prompt' || a.kind === 'agent-continue')}
                onClick={() => onAction(a)}
                className="inline-flex items-center gap-1 rounded-full border border-sky bg-white px-3 py-1 text-xs font-semibold text-navy hover:bg-sky/10 disabled:opacity-40"
              >
                {a.kind === 'agent-prompt' ? <Icon name="sparkle" size={11} className="text-sky" /> : null}
                {a.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Keeps the list pinned to the newest message while the user is at the bottom, and leaves it alone while they
 * scroll back through history. Returns whether there is unseen content below plus a jump-to-latest handler.
 */
function useStickyScroll(listRef: React.RefObject<HTMLDivElement | null>, bodyRef: React.RefObject<HTMLDivElement | null>, chat: ChatMsg[]) {
  const stick = useRef(true);
  const [unseen, setUnseen] = useState(false);

  const toBottom = () => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  // The user sending something always brings the conversation back into view. Send paths push the user message
  // and the assistant placeholder in one batch, so look at everything appended since the last run, not just the end.
  const seen = useRef(0);
  useLayoutEffect(() => {
    const fresh = chat.slice(seen.current);
    seen.current = chat.length;
    if (!fresh.length) return;
    if (fresh.some((m) => m.role === 'user')) stick.current = true;
    if (stick.current) toBottom();
    else setUnseen(true);
  }, [chat.length]);

  // Content growing in place (progress text, steps, images loading) or the viewport shrinking (window resize,
  // the reference bar above the input) keeps the newest message in view, but only when already pinned.
  useEffect(() => {
    const body = bodyRef.current;
    const list = listRef.current;
    if (!body || !list) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) toBottom();
    });
    ro.observe(body);
    ro.observe(list);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    if (stick.current) setUnseen(false);
  };

  const jump = () => {
    const el = listRef.current;
    stick.current = true;
    setUnseen(false);
    el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const unpin = () => {
    stick.current = false;
  };

  return { onScroll, jump, unpin, unseen };
}

function Copilot() {
  const chat = useEditor((s) => s.chat);
  const busy = useEditor((s) => s.busy);
  const selectedRefId = useEditor((s) => s.selectedRefId);
  const ref = useEditor((s) => s.references.find((r) => r.id === s.selectedRefId));
  const set = useEditor((s) => s.set);
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { onScroll, jump, unpin, unseen } = useStickyScroll(listRef, bodyRef, chat);

  const send = () => {
    const t = text.trim();
    if (!t || busy) return;
    setText('');
    void sendMessage(t);
  };

  const onAction = (a: ChatAction) => {
    const st = useEditor.getState();
    // Agent mode: the upload buttons go through the agent ("what I see" check + review) when they point at the active upload.
    const viaAgent = st.agentMode && !!a.payload && importPreviewOf(getActive()) === a.payload;
    if (a.kind === 'recreate-upload' && a.payload) void (viaAgent ? agentPrompt('Recreate this as an editable on-brand design') : recreateUpload(a.payload));
    else if (a.kind === 'four-like-upload' && a.payload) void (viaAgent ? agentPrompt('Make 3 variations like this') : fourLikeUpload(a.payload));
    else if (a.kind === 'fix-all') useEditor.getState().pushMsg({ role: 'assistant', text: fixAll() });
    else if (a.kind === 'select-design' && a.payload) useEditor.getState().setActive(a.payload);
    else if (a.kind === 'agent-prompt' && a.payload && !st.busy) void agentPrompt(a.payload);
    else if (a.kind === 'agent-continue' && a.payload && !st.busy) void agentContinue(a.payload);
  };

  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files?.[0];
        if (f) void handleUpload(f);
      }}
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="grid h-7 w-7 place-items-center rounded-lg bg-navy text-sky">
            <Icon name="sparkle" size={14} />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold text-navy">Copilot</div>
            <div className="text-[10px] text-slate-400">{chat.length > 1 ? `${chat.length} messages` : 'Ask for an ad or an edit'}</div>
          </div>
        </div>
        {busy ? (
          <span className="flex items-center gap-1.5 rounded-full bg-sky/10 px-2 py-1 text-[11px] font-medium text-navy">
            <Spinner /> working
          </span>
        ) : null}
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={listRef} onScroll={onScroll} className="h-full overflow-y-auto bg-slate-50/70">
          <div ref={bodyRef} className="space-y-4 px-4 py-4">
            <UnpinCtx.Provider value={unpin}>
              {chat.map((m) => (
                <Message key={m.id} m={m} onAction={onAction} />
              ))}
            </UnpinCtx.Provider>
          </div>
        </div>
        {unseen ? (
          <button
            type="button"
            onClick={jump}
            className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full bg-navy px-3 py-1.5 text-xs font-semibold text-white shadow-lg hover:bg-[#0b1878]"
          >
            <Icon name="arrowDown" size={13} stroke={2.2} /> New messages
          </button>
        ) : null}
      </div>
      <div className="border-t border-slate-200 bg-white px-3 pb-3 pt-2.5">
        <div className="relative mb-2">
          <div
            className="no-scrollbar flex gap-1.5 overflow-x-auto pr-6"
            // A plain mouse wheel only scrolls vertically: map it onto this row.
            onWheel={(e) => {
              if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
            }}
          >
            {CHIPS.map((c) => (
              <button
                key={c}
                type="button"
                disabled={busy}
                onClick={() => void runChip(c)}
                className="shrink-0 whitespace-nowrap rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 transition hover:border-sky hover:text-navy disabled:opacity-40"
              >
                {c}
              </button>
            ))}
          </div>
          <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-white to-transparent" />
        </div>
        {selectedRefId ? (
          <div className="mb-2 flex items-center gap-2 rounded-lg bg-sky/10 px-2 py-1.5">
            {ref ? <img src={ref.url} alt="" className="h-8 w-7 rounded object-cover" /> : null}
            <span className="flex-1 truncate text-[11px] text-navy">
              Using reference <b>{selectedRefId}</b>
            </span>
            <button type="button" className="text-slate-400 hover:text-navy" onClick={() => set({ selectedRefId: null })} title="Clear reference">
              <Icon name="x" size={14} />
            </button>
          </div>
        ) : null}
        <div className="flex items-end gap-1.5 rounded-xl border border-slate-200 bg-white p-1.5 focus-within:border-sky focus-within:ring-2 focus-within:ring-sky/20">
          <IconButton icon="clip" title="Upload PNG, JPG, SVG or PSD" onClick={() => fileRef.current?.click()} />
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPTED_FILES}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleUpload(f);
              e.target.value = '';
            }}
          />
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder={busy ? 'Working…' : 'Describe an ad or an edit…'}
            className="field-sizing-content max-h-40 min-h-8 flex-1 resize-none bg-transparent px-1 py-1.5 text-[13.5px] leading-snug text-slate-700 placeholder:text-slate-400 focus:outline-none"
          />
          <button
            type="button"
            onClick={send}
            disabled={busy || !text.trim()}
            className="grid h-8 w-8 place-items-center rounded-lg bg-navy text-white transition hover:bg-[#0b1878] disabled:opacity-30"
            title="Send (Enter) · new line: Shift+Enter"
          >
            <Icon name="send" size={15} />
          </button>
        </div>
      </div>
    </section>
  );
}

export function RightPanel() {
  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-slate-200 bg-white 2xl:w-[420px]">
      <Copilot />
    </aside>
  );
}
