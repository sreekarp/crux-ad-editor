// Small shared UI primitives (icons, buttons, swatches) for the editor chrome.
import type { ButtonHTMLAttributes, ReactNode } from 'react';

const PATHS: Record<string, string> = {
  undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'm15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  download: 'M12 3v12m0 0-4-4m4 4 4-4M5 21h14',
  sparkle: 'M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z',
  send: 'M5 12h14M13 6l6 6-6 6',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A9.8 9.8 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
  lock: 'M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11',
  unlock: 'M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 6.8-1.2',
  up: 'M12 19V5m0 0-6 6m6-6 6 6',
  down: 'M12 5v14m0 0-6-6m6 6 6-6',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
  clip: 'M21 11.5 12.5 20a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6L15 7.1',
  check: 'M5 12.5 10 17 19 7',
  alert: 'M12 8v5m0 3.5v.5M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  x: 'M6 6l12 12M18 6 6 18',
  plus: 'M12 5v14M5 12h14',
  layers: 'M12 3 2 8l10 5 10-5-10-5zM2 13l10 5 10-5M2 17.5l10 5 10-5',
  wand: 'M4 20 15 9m2-6v3m0 0v3m0-3h3m-3 0h-3m-1.5 7.5L13 13',
  image: 'M4 5h16v14H4zM4 15l4.5-4.5L13 15l2.5-2.5L20 17M15 9.5a1.5 1.5 0 1 0 0-.01',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  frame: 'M7 3v18M17 3v18M3 7h18M3 17h18',
  shield: 'M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3z',
  copy: 'M8 8h12v12H8zM16 8V4H4v12h4',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  flip: 'M12 3v18M8 7 3 12l5 5M16 7l5 5-5 5',
  sliders: 'M4 6h9m4 0h3M4 12h3m4 0h9M4 18h11m4 0h1M13 4v4M7 10v4M15 16v4',
  panelOpen: 'M4 4h16v16H4zM15 4v16M11 9l-3 3 3 3',
  panelClose: 'M4 4h16v16H4zM15 4v16M8 9l3 3-3 3',
  chevronDown: 'm6 9 6 6 6-6',
  arrowDown: 'M12 5v14m0 0-5-5m5 5 5-5',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z',
};

export function Icon({
  name,
  size = 16,
  className = '',
  stroke = 1.8,
  filled = false,
}: {
  name: keyof typeof PATHS | string;
  size?: number;
  className?: string;
  stroke?: number;
  /** Fill the shape with the current colour (e.g. a "saved" star). */
  filled?: boolean;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return <span className={`inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-sky border-t-transparent ${className}`} />;
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'soft' | 'outline'; size?: 'sm' | 'md' };

export function Button({ variant = 'soft', size = 'md', className = '', children, ...rest }: BtnProps) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition select-none disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap';
  const sizes = size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-sm';
  const variants = {
    primary: 'bg-navy text-white hover:bg-[#0b1878] shadow-sm',
    ghost: 'text-slate-600 hover:bg-slate-100 hover:text-navy',
    soft: 'bg-slate-100 text-slate-700 hover:bg-sky/15 hover:text-navy',
    outline: 'border border-slate-200 bg-white text-slate-700 hover:border-sky hover:text-navy',
  }[variant];
  return (
    <button type="button" className={`${base} ${sizes} ${variants} ${className}`} {...rest}>
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  title,
  active,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; title: string; active?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg transition disabled:opacity-30 disabled:pointer-events-none ${
        active ? 'bg-sky/20 text-navy' : 'text-slate-500 hover:bg-slate-100 hover:text-navy'
      } ${className}`}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
}

export function Swatch({ colour, active, onClick, title, size = 22 }: { colour: string; active?: boolean; onClick?: () => void; title?: string; size?: number }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`shrink-0 rounded-full border transition ${active ? 'ring-2 ring-sky ring-offset-2' : 'hover:scale-110'} ${
        colour.toUpperCase() === '#FFFFFF' ? 'border-slate-300' : 'border-black/5'
      }`}
      style={{ width: size, height: size, background: colour }}
    />
  );
}

export function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="border-b border-slate-100 px-4 py-3 last:border-0">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{title}</h4>
        {right}
      </div>
      {children}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className = '',
}: {
  options: { value: T; label: ReactNode; title?: string }[];
  value: T | null;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={`inline-flex rounded-lg bg-slate-100 p-0.5 ${className}`}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
            value === o.value ? 'bg-white text-navy shadow-sm' : 'text-slate-500 hover:text-navy'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  onCommit,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  onCommit?: () => void;
  format?: (v: number) => string;
}) {
  return (
    <label className="block">
      <div className="mb-1 flex justify-between text-xs text-slate-600">
        <span>{label}</span>
        <span className="tabular-nums text-slate-400">{format ? format(value) : value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        className="w-full accent-[#000856]"
      />
    </label>
  );
}
