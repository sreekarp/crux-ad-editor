// Shape-aware photo placement: the essential subject region (subjectBox) must stay on the visible part of the shape.
import { describe, expect, it } from 'vitest';
import type { BloomShape, Design, Layer, PhotoLayer, Slots } from '../../types';
import { PHOTO_MASKS } from '../../brand';
import { applyOps, buildDesign } from '../index';
import { frameSubject, reframePhoto, subjectCoverage } from '../frame';
import { MIN_COVERAGE, fitPhotoLayer, photoTargetAspect, photoVisibleRect } from '../photoFit';

type Box4 = [number, number, number, number];

function boldDesign(bloom: BloomShape): { d: Design; p: PhotoLayer } {
  const slots = {
    template: 'bold', colourway: 'dark', bloom, headline: 'Cash flow without the suspense.', sub: 'See what is coming in.',
    cta: 'Find out more', hero: { type: 'photo', photoTag: 'florist', photoUrl: '/static/gen/bank/florist_1.png' }, charms: [],
  } as Slots;
  const d = buildDesign(slots, { width: 1080, height: 1350 }, null);
  const p = d.layers.find((l): l is PhotoLayer => l.kind === 'photo')!;
  return { d, p };
}

/** Same design with the photo layer's props replaced. */
function withPhoto(d: Design, id: string, props: Partial<PhotoLayer>): { d: Design; p: PhotoLayer } {
  const layers = d.layers.map((l) => (l.id === id ? ({ ...l, ...props } as Layer) : l));
  return { d: { ...d, layers }, p: layers.find((l) => l.id === id) as PhotoLayer };
}

function fullBleed(): Design {
  const photo: PhotoLayer = { id: 'ph', kind: 'photo', x: 0, y: 0, width: 1080, height: 1350, src: '/x.png', mask: null, zoom: 1, focusX: 0.5, focusY: 0.5 } as PhotoLayer;
  return { id: 'd', name: 'd', width: 1080, height: 1350, background: 'white', layers: [photo] };
}

describe('photoFit', () => {
  it('a photo composed for the visible part of each chunky bloom fits it (>= 95%, no regenerate, mask kept)', () => {
    for (const mask of PHOTO_MASKS) {
      const { d: d0, p: p0 } = boldDesign(mask);
      expect(p0.mask).toBe(mask);
      // Where the visible rect lands in a square source at the default crop (cover-fit, centred).
      const [vx0, vy0, vx1, vy1] = photoVisibleRect(p0, d0);
      const S = 1024;
      const k = Math.max(p0.width / S, p0.height / S);
      const dx = (p0.width - S * k) / 2;
      const dy = (p0.height - S * k) / 2;
      const toSrc = (u: number, v: number) => [(u * p0.width - dx) / (S * k), (v * p0.height - dy) / (S * k)];
      const [a0, b0] = toSrc(vx0, vy0);
      const [a1, b1] = toSrc(vx1, vy1);
      const mx = (a1 - a0) * 0.1;
      const my = (b1 - b0) * 0.1;
      const subjectBox: Box4 = [a0 + mx, b0 + my, a1 - mx, b1 - my];
      const { d, p } = withPhoto(d0, p0.id, { subjectBox, subject: [(a0 + a1) / 2, b0 + 3 * my], srcW: S, srcH: S });
      const fit = fitPhotoLayer(d, p.id);
      expect(fit.coverage, `${mask}`).toBeGreaterThanOrEqual(MIN_COVERAGE);
      expect(fit.needsRegenerate).toBe(false);
      expect(fit.props.mask).toBeUndefined();
      expect(fit.coverage).toBeCloseTo(subjectCoverage({ ...p, ...fit.props }, d), 6);
    }
  });

  it('close-up and working-shot boxes fit a full-bleed frame without over-zooming', () => {
    const d0 = fullBleed();
    for (const [subjectBox, subject] of [
      [[0.3, 0.12, 0.7, 0.55], [0.5, 0.28]],
      [[0.2, 0.1, 0.8, 0.8], [0.5, 0.22]],
    ] as [Box4, [number, number]][]) {
      const { d, p } = withPhoto(d0, 'ph', { subjectBox, subject, srcW: 1024, srcH: 1536 });
      const fit = fitPhotoLayer(d, p.id);
      expect(fit.coverage).toBeGreaterThanOrEqual(0.995);
      expect(fit.needsRegenerate).toBe(false);
      expect(fit.props.zoom).toBe(1); // a small box is never blown up to fill the shape
    }
  });

  it('a head at the very top of a portrait source: the ladder reports honestly (coverage = subjectCoverage)', () => {
    const { d: d0, p: p0 } = boldDesign('harmony');
    const { d, p } = withPhoto(d0, p0.id, { subjectBox: [0.3, 0.0, 0.7, 0.6], subject: [0.5, 0.12], srcW: 1024, srcH: 1536 });
    const fit = fitPhotoLayer(d, p.id);
    const applied = { ...p, ...fit.props } as PhotoLayer;
    expect(fit.coverage).toBeCloseTo(subjectCoverage(applied, d), 6);
    expect(fit.needsRegenerate).toBe(fit.coverage < MIN_COVERAGE);
    if (fit.props.mask) expect(PHOTO_MASKS.filter((m) => m !== 'harmony')).toContain(fit.props.mask);
    // Whatever survives a forced cut keeps the head band rather than the waist.
    expect(fit.coverage).toBeLessThan(1);
  });

  it('without a subject box nothing changes: same crop as the point framing, coverage 1', () => {
    const { d: d0, p: p0 } = boldDesign('harmony');
    for (const subject of [[0.5, 0.15], [0.3, 0.3], [0.7, 0.25]] as [number, number][]) {
      const { d, p } = withPhoto(d0, p0.id, { subject, srcW: 1536, srcH: 1024 });
      const fit = fitPhotoLayer(d, p.id);
      expect(fit.props).toEqual(reframePhoto(p, d));
      expect(fit.coverage).toBe(1);
      expect(fit.needsRegenerate).toBe(false);
      const src = { w: 1536, h: 1024 };
      expect(frameSubject({ ...p, zoom: 1 }, d, subject, src, null)).toEqual(frameSubject({ ...p, zoom: 1 }, d, subject, src));
      const r = applyOps(d, [{ op: 'reframe', id: p.id }], null).design.layers.find((l) => l.id === p.id) as PhotoLayer;
      expect({ focusX: r.focusX, focusY: r.focusY, zoom: r.zoom }).toEqual(reframePhoto(p, d));
    }
  });

  it('photoTargetAspect describes the VISIBLE part of a bloom (it sits low), not the whole box', () => {
    const { d, p } = boldDesign('harmony');
    const [x0, y0, x1, y1] = photoVisibleRect(p, d);
    expect(y0).toBeGreaterThan(0.2);
    expect(photoTargetAspect(p, d)).toBeCloseTo(((x1 - x0) * p.width) / ((y1 - y0) * p.height), 6);
    expect(Math.abs(photoTargetAspect(p, d) - p.width / p.height)).toBeGreaterThan(0.1);
    const frame = fullBleed().layers[0] as PhotoLayer;
    expect(photoTargetAspect(frame, fullBleed())).toBeCloseTo(1080 / 1350, 6);
  });

  it('a new image drops the old subject box; a rebuild keeps it and re-fits', () => {
    const { d: d0, p: p0 } = boldDesign('harmony');
    const { d } = withPhoto(d0, p0.id, { subjectBox: [0.3, 0.2, 0.7, 0.7], subject: [0.5, 0.3], srcW: 1024, srcH: 1024 });
    const swapped = applyOps(d, [{ op: 'update', id: p0.id, props: { src: '/other.png' } as Partial<Layer> }], null).design;
    const ps = swapped.layers.find((l) => l.id === p0.id) as PhotoLayer;
    expect(ps.subjectBox).toBeUndefined();
    expect(ps.subject).toBeUndefined();
    const rebuilt = applyOps(d, [{ op: 'rebuild', slots: { colourway: 'light' } }], null).design;
    const pr = rebuilt.layers.find((l): l is PhotoLayer => l.kind === 'photo')!;
    expect(pr.subjectBox).toEqual([0.3, 0.2, 0.7, 0.7]);
    expect(subjectCoverage(pr, rebuilt)).toBeCloseTo(fitPhotoLayer(rebuilt, pr.id).coverage, 6);
  });
});
