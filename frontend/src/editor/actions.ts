// Direct-manipulation actions shared by the panels. All changes go through store.apply (applyOps).
import { CTA_STYLES, SIZES, TEXT_COLOURS } from '../brand';
import type { CharmColour, ColourToken, CoreColour, Design, Layer, LogoColour, PhotoLayer } from '../types';
import { getActive, uid, useEditor } from './store';

const S = () => useEditor.getState();

export function ensureDesign(): Design {
  const cur = getActive();
  if (cur) return cur;
  const d: Design = {
    id: uid('d_'),
    name: 'Untitled design',
    width: SIZES['4:5'].width,
    height: SIZES['4:5'].height,
    background: 'sky',
    colourway: 'light',
    layers: [],
  };
  S().addDesigns([d], 'Blank design');
  return d;
}

/** Adds a layer (top of stack) centred unless x/y given, selects it. */
export function addLayer(make: (d: Design) => Layer) {
  const d = ensureDesign();
  const layer = make(d);
  S().apply([{ op: 'add', layer }], { designId: d.id });
  S().set({ selection: [layer.id], rightTab: 'properties' });
}

export function centred(d: Design, w: number, h: number) {
  return { x: (d.width - w) / 2, y: (d.height - h) / 2, width: w, height: h };
}

export function aspectOf(w?: number, h?: number, fallback = 1) {
  return w && h ? w / h : fallback;
}

export function updateLayer(id: string, props: Partial<Layer>, history = true) {
  S().apply([{ op: 'update', id, props }], { history });
}

/** Live update during a slider drag (one undo step per gesture). */
export function liveUpdate(id: string, props: Partial<Layer>) {
  S().beginGesture();
  S().apply([{ op: 'update', id, props }], { history: false });
}

export function commitLive() {
  S().commitGesture();
}

const CHARM_FROM_TOKEN: Partial<Record<ColourToken, CharmColour>> = {
  blue: 'blue',
  sky: 'blue',
  navy: 'blue',
  mint: 'green',
  yellow: 'yellow',
  pink: 'pink',
  lilac: 'purple',
};

/** Palette swatch -> recolour the selected layer within brand rules. Returns a message when refused. */
export function recolourSelected(token: ColourToken): string | null {
  const d = getActive();
  const id = S().selection[0];
  const l = d?.layers.find((x) => x.id === id);
  if (!d || !l) return 'Select a layer to recolour';
  switch (l.kind) {
    case 'rect':
      updateLayer(l.id, { fill: token });
      return null;
    case 'text':
    case 'tags':
      if (!TEXT_COLOURS.includes(token)) return 'Text is navy or white only (brand rule)';
      updateLayer(l.id, { fill: token });
      return null;
    case 'button': {
      if (token !== 'sky' && token !== 'navy' && token !== 'white') return 'CTA buttons are sky, navy or white';
      updateLayer(l.id, { fill: CTA_STYLES[token].fill, textFill: CTA_STYLES[token].textFill } as Partial<Layer>);
      return null;
    }
    case 'bloom':
      updateLayer(l.id, { colour: token } as Partial<Layer>);
      return null;
    case 'bgshape':
      if (!['navy', 'blue', 'sky', 'white'].includes(token)) return 'Background shapes use core colours only';
      updateLayer(l.id, { colour: token as CoreColour } as Partial<Layer>);
      return null;
    case 'logo':
      if (!['navy', 'sky', 'white'].includes(token)) return 'The logo is navy, sky or white only';
      updateLayer(l.id, { colour: token as LogoColour } as Partial<Layer>);
      return null;
    case 'charm': {
      const c = CHARM_FROM_TOKEN[token];
      if (!c) return 'No charm in that colour';
      updateLayer(l.id, { colour: c } as Partial<Layer>);
      return null;
    }
    default:
      return 'This layer has no colour';
  }
}

/** Sets the design background (core colours only). */
export function setBackground(c: CoreColour) {
  const d = getActive();
  if (!d) return;
  S().replace(d.id, { ...d, background: c }, true);
}

export function applyBankPhoto(url: string) {
  const d = getActive();
  const sel = S().selection[0];
  const target = d?.layers.find((l): l is PhotoLayer => l.kind === 'photo' && l.id === sel);
  if (d && target) {
    updateLayer(target.id, { src: url, status: 'ready' } as Partial<Layer>);
    return;
  }
  addLayer((dd) => {
    const w = dd.width * 0.6;
    const h = w * 1.2;
    return {
      id: uid(),
      kind: 'photo',
      role: 'photo',
      name: 'Photo',
      ...centred(dd, w, h),
      src: url,
      mask: null,
      cornerRadius: dd.width * 0.04,
      zoom: 1,
      focusX: 0.5,
      focusY: 0.5,
      status: 'ready',
    };
  });
}

export function deleteSelected() {
  const s = S();
  const d = getActive();
  if (!d || !s.selection.length) return;
  const ids = s.selection.filter((id) => !d.layers.find((l) => l.id === id)?.locked);
  if (!ids.length) return s.showToast('Layer is locked');
  s.apply(ids.map((id) => ({ op: 'delete' as const, id })));
  s.set({ selection: [] });
}

export function nudgeSelected(dx: number, dy: number) {
  const s = S();
  const d = getActive();
  if (!d || !s.selection.length) return;
  const ops = s.selection
    .map((id) => d.layers.find((l) => l.id === id))
    .filter((l): l is Layer => !!l && !l.locked)
    .map((l) => ({ op: 'update' as const, id: l.id, props: { x: l.x + dx, y: l.y + dy } }));
  if (ops.length) s.apply(ops);
}

export function duplicateSelected() {
  const s = S();
  const d = getActive();
  const l = d?.layers.find((x) => x.id === s.selection[0]);
  if (!d || !l) return;
  const copy = { ...l, id: uid(), x: l.x + d.width * 0.03, y: l.y + d.width * 0.03, locked: false } as Layer;
  const index = d.layers.findIndex((x) => x.id === l.id) + 1;
  s.apply([{ op: 'add', layer: copy, index }]);
  s.set({ selection: [copy.id] });
}
