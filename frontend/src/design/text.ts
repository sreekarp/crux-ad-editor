// Text measurement + line breaking. Pure (the browser swaps in real canvas metrics via setTextMeasurer).

/** Width in px of a single line of text. The editor registers a canvas measureText-based one after fonts load. */
export type TextMeasurer = (
  text: string,
  font: 'headline' | 'body',
  fontWeight: number,
  fontSize: number,
  letterSpacing: number,
) => number;

const estimate: TextMeasurer = (text, font, _w, size, ls) =>
  text.length * size * (font === 'headline' ? 0.42 : 0.55) + text.length * ls;

let measurer: TextMeasurer = estimate;

export function setTextMeasurer(fn: TextMeasurer): void {
  measurer = fn;
}
export const measureText: TextMeasurer = (...a) => measurer(...a);

export interface TextStyle {
  font: 'headline' | 'body';
  weight: number;
  size: number;
  letterSpacing: number;
}

export const textWidth = (t: string, st: TextStyle) => measureText(t, st.font, st.weight, st.size, st.letterSpacing);

/** Greedy word wrap at maxWidth (explicit \n respected). Words wider than the box stay on their own line. */
export function wrap(text: string, st: TextStyle, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push('');
      continue;
    }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const cand = `${line} ${words[i]}`;
      if (textWidth(cand, st) <= maxWidth) line = cand;
      else {
        out.push(line);
        line = words[i];
      }
    }
    out.push(line);
  }
  return out;
}

export const maxLineWidth = (lines: string[], st: TextStyle) => lines.reduce((m, l) => Math.max(m, textWidth(l, st)), 0);

/** Same line count as greedy, but with the narrowest box that keeps it: even, designed-looking rag. */
export function balancedWrap(text: string, st: TextStyle, maxWidth: number): string[] {
  const greedy = wrap(text, st, maxWidth);
  if (greedy.length <= 1 || text.includes('\n')) return greedy;
  const words = text.split(/\s+/).filter(Boolean);
  let lo = words.reduce((m, w) => Math.max(m, textWidth(w, st)), 0);
  let hi = maxWidth;
  if (lo >= hi) return greedy;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (wrap(text, st, mid).length <= greedy.length) hi = mid;
    else lo = mid;
  }
  const best = wrap(text, st, hi);
  return best.length <= greedy.length ? best : greedy;
}

/** Split after . ? ! when followed by a space ("Data in. Doubt out." -> 2 sentences). */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+(?=\S)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Headline line breaking. Designers put each short sentence on its own line ("Data in. / Doubt out.",
 * "Get a Xero Coach. / Get ahead.") when the sentences are of similar length and each fits on one line;
 * otherwise balanced wrapping (one sentence per line only if it costs no extra lines).
 */
export function headlineLines(text: string, st: TextStyle, maxWidth: number, maxLines = 4): string[] {
  const clean = text.replace(/\s*\n\s*/g, ' ').trim();
  const plain = balancedWrap(clean, st, maxWidth);
  const parts = sentences(clean);
  if (parts.length >= 2 && parts.length <= maxLines) {
    const widths = parts.map((p) => textWidth(p, st));
    const fitsEach = widths.every((w) => w <= maxWidth);
    const ratio = Math.min(...widths) / Math.max(...widths);
    // 2-3 similar sentences, costing at most one extra line ("Payroll? Automated. Super? Sorted." stays 2 lines)
    if (fitsEach && ratio >= 0.4 && parts.length <= 3 && parts.length <= plain.length + 1) return parts;
    const bySentence = parts.flatMap((p) => balancedWrap(p, st, maxWidth));
    if (bySentence.length <= plain.length && maxLineWidth(bySentence, st) <= maxWidth) return bySentence;
  }
  return plain;
}

export interface FitResult {
  text: string;
  lines: string[];
  fontSize: number;
  letterSpacing: number;
  lineHeight: number;
  /** Box height = lines * fontSize * lineHeight. */
  height: number;
  /** Widest line. */
  width: number;
}

export interface FitOptions {
  base: number;
  maxWidth: number;
  maxLines: number;
  /** Try to reach this many lines (down to preferMinScale) before accepting more. */
  preferLines?: number;
  preferMinScale?: number;
  minScale?: number;
  lineHeight?: number;
  weight?: number;
  font?: 'headline' | 'body';
  /** letterSpacing = em * fontSize (headline: -0.005). */
  trackingEm?: number;
  /** Sentence-aware balanced breaking (headlines) vs plain greedy (body). */
  balance?: boolean;
}

/** Fit text into maxLines at the box width, shrinking the font (down to minScale) when needed. */
export function fitText(text: string, o: FitOptions): FitResult {
  const lineHeight = o.lineHeight ?? 0.98;
  const font = o.font ?? 'headline';
  const weight = o.weight ?? 800;
  const tracking = o.trackingEm ?? (font === 'headline' ? -0.005 : 0);
  const minScale = o.minScale ?? 0.7;
  const at = (scale: number) => {
    const size = Math.round(o.base * scale * 10) / 10;
    const st: TextStyle = { font, weight, size, letterSpacing: Math.round(tracking * size * 100) / 100 };
    const lines = o.balance === false ? wrap(text, st, o.maxWidth) : headlineLines(text, st, o.maxWidth, o.maxLines);
    return { st, lines, width: maxLineWidth(lines, st) };
  };
  const ok = (r: ReturnType<typeof at>, maxLines: number) => r.lines.length <= maxLines && r.width <= o.maxWidth + 0.5;
  let pick: ReturnType<typeof at> | null = null;
  if (o.preferLines && o.preferLines < o.maxLines) {
    for (let s = 1; s >= (o.preferMinScale ?? 0.86) - 1e-9; s -= 0.02) {
      const r = at(s);
      if (ok(r, o.preferLines)) {
        pick = r;
        break;
      }
    }
  }
  if (!pick) {
    for (let s = 1; s >= minScale - 1e-9; s -= 0.02) {
      const r = at(s);
      if (ok(r, o.maxLines)) {
        pick = r;
        break;
      }
    }
  }
  if (!pick) {
    // Still too long: keep shrinking until it at least fits the width (never overflow the box sideways).
    let s = minScale;
    pick = at(s);
    while (pick.width > o.maxWidth + 0.5 && s > 0.35) {
      s -= 0.03;
      pick = at(s);
    }
  }
  const { st, lines, width } = pick;
  return {
    text: o.balance === false ? text : lines.join('\n'),
    lines,
    fontSize: st.size,
    letterSpacing: st.letterSpacing,
    lineHeight,
    height: lines.length * st.size * lineHeight,
    width,
  };
}

/** Measured height of an existing text box (wraps at its width). */
export function measureBox(
  text: string,
  font: 'headline' | 'body',
  weight: number,
  size: number,
  letterSpacing: number,
  lineHeight: number,
  width: number,
): { lines: string[]; height: number; width: number } {
  const st: TextStyle = { font, weight, size, letterSpacing };
  const lines = wrap(text, st, width);
  return { lines, height: lines.length * size * lineHeight, width: maxLineWidth(lines, st) };
}
