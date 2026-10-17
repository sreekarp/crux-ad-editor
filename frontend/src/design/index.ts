// Design engine public API. OWNED BY the design-engine workstream (templates, checker, ops).
// The editor imports ONLY from this file. Signatures are the contract — do not change them.
import type { AsyncOp, Design, Issue, Layer, Manifest, Op, Slots } from '../types';
import { buildDesignImpl } from './templates';
import { brandScoreImpl, checkDesignImpl } from './checker';
import { applyOpsImpl } from './ops';

export type { Size } from './templates';
export { setTextMeasurer, measureText } from './text';
export type { TextMeasurer } from './text';
// Extra helpers (additive; safe for the editor to use).
export { normalizeSlots, effectiveColourway, needsDisclaimer } from './templates';

/** Compact view of a design sent to the LLM (no URLs, rounded numbers). */
export interface DesignSummary {
  width: number;
  height: number;
  background: Design['background'];
  template?: Design['template'];
  colourway?: Design['colourway'];
  layers: {
    id: string;
    kind: Layer['kind'];
    role?: Layer['role'];
    text?: string;
    colour?: string;
    box: [number, number, number, number];
  }[];
}

/** Slots -> fully laid-out Design. Pure and deterministic (same slots + size -> same design). */
export function buildDesign(
  slots: Slots,
  size: import('./templates').Size,
  manifest: Manifest | null,
  opts: { id?: string; name?: string } = {},
): Design {
  return buildDesignImpl(slots, size, manifest, opts);
}

/** Brand rules -> issues. Pure. */
export function checkDesign(design: Design, manifest: Manifest | null): Issue[] {
  return checkDesignImpl(design, manifest);
}

/** Apply every available fix (repeats until stable). Pure. */
export function autoFix(design: Design, manifest: Manifest | null): { design: Design; fixed: Issue[] } {
  let d = design;
  const applied = new Map<string, Issue>();
  for (let pass = 0; pass < 4; pass++) {
    const fixable = checkDesignImpl(d, manifest).filter((i) => i.fix?.length);
    if (!fixable.length) break;
    const before = JSON.stringify(d.layers);
    d = applyOpsImpl(d, fixable.flatMap((i) => i.fix!), manifest).design;
    fixable.forEach((i) => applied.has(i.id) || applied.set(i.id, i));
    if (JSON.stringify(d.layers) === before) break;
  }
  const remaining = new Set(checkDesignImpl(d, manifest).map((i) => i.id));
  return { design: d, fixed: [...applied.values()].filter((i) => !remaining.has(i.id)) };
}

/** 0-100. */
export function brandScore(issues: Issue[]): number {
  return brandScoreImpl(issues);
}

/** Apply ops. Returns the new design plus async ops (photo / pixel_edit) for the caller to run. Pure. */
export function applyOps(
  design: Design,
  ops: Op[],
  manifest: Manifest | null,
): { design: Design; pending: AsyncOp[]; errors: string[] } {
  return applyOpsImpl(design, ops, manifest);
}

function colourOf(l: Layer): string | undefined {
  switch (l.kind) {
    case 'text':
    case 'rect':
    case 'tags':
      return l.fill;
    case 'button':
      return `${l.fill} (text ${l.textFill})`;
    case 'logo':
      return l.pill ? `${l.colour} on ${l.pill} pill` : l.colour;
    case 'bloom':
      return `${l.colour} ${l.shape}`;
    case 'bgshape':
      return `${l.colour} ${l.bgId}`;
    case 'charm':
      return `${l.colour} ${l.charm}`;
    case 'photo':
      return l.mask ? `masked by ${l.mask}` : undefined;
    default:
      return undefined;
  }
}

function textOf(l: Layer): string | undefined {
  if (l.kind === 'text') return l.text.replace(/\s*\n\s*/g, ' ');
  if (l.kind === 'button') return l.text;
  if (l.kind === 'stat') return `${l.label}: ${l.value}`;
  if (l.kind === 'tags') return l.items.join(' · ');
  return undefined;
}

export function summarizeDesign(design: Design): DesignSummary {
  return {
    width: design.width,
    height: design.height,
    background: design.background,
    template: design.template,
    colourway: design.colourway,
    layers: design.layers.map((l) => {
      const text = textOf(l);
      const colour = colourOf(l);
      return {
        id: l.id,
        kind: l.kind,
        role: l.role,
        ...(text !== undefined ? { text } : {}),
        ...(colour !== undefined ? { colour } : {}),
        box: [Math.round(l.x), Math.round(l.y), Math.round(l.width), Math.round(l.height)] as [number, number, number, number],
      };
    }),
  };
}
