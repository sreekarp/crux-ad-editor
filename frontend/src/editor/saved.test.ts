import { beforeEach, describe, expect, it } from 'vitest';
import type { Design, PhotoLayer } from '../types';
import { useEditor } from './store';

const photo = (patch: Partial<PhotoLayer> = {}): PhotoLayer => ({
  id: 'p1',
  kind: 'photo',
  x: 0,
  y: 0,
  width: 500,
  height: 500,
  src: '/static/photos/a.jpg',
  mask: null,
  zoom: 1,
  focusX: 0.5,
  focusY: 0.5,
  status: 'ready',
  ...patch,
});

const design = (layers: Design['layers'] = [photo()]): Design => ({
  id: 'd1',
  name: 'Test',
  width: 1080,
  height: 1350,
  background: 'sky',
  layers,
});

const S = () => useEditor.getState();
const active = () => S().designs.find((d) => d.id === S().activeId)!;

beforeEach(() => {
  useEditor.setState({ designs: [], batches: [], history: {}, saved: [], activeId: null, selection: [], busy: false });
});

describe('saved versions', () => {
  it('needs a design to save', () => {
    expect(S().saveVersion()).toBeNull();
  });

  it('saves the current state once and numbers versions', () => {
    S().addDesigns([design()], 'Test');
    const v1 = S().saveVersion()!;
    expect(v1.n).toBe(1);
    expect(S().saveVersion()).toBe(v1);
    S().apply([{ op: 'update', id: 'p1', props: { zoom: 2 } }]);
    expect(S().saveVersion()!.n).toBe(2);
    expect(S().saved).toHaveLength(2);
  });

  it('keeps the saved snapshot unchanged while editing continues', () => {
    S().addDesigns([design()], 'Test');
    const v1 = S().saveVersion()!;
    S().apply([{ op: 'update', id: 'p1', props: { zoom: 3 } }]);
    expect((v1.design.layers[0] as PhotoLayer).zoom).toBe(1);
    expect((active().layers[0] as PhotoLayer).zoom).toBe(3);
  });

  it('restores as one undoable step and re-activates the design', () => {
    S().addDesigns([design(), { ...design(), id: 'd2' }], 'Test');
    const v1 = S().saveVersion()!;
    S().apply([{ op: 'update', id: 'p1', props: { zoom: 3 } }]);
    const edited = active();
    S().setActive('d2');
    expect(S().restoreVersion(v1.id)).toBe(v1);
    expect(S().activeId).toBe('d1');
    expect(active()).toBe(v1.design);
    S().undo();
    expect(active()).toBe(edited);
  });

  it('takes a finished photo from the live design when the version was saved mid-generation', () => {
    S().addDesigns([design([photo({ src: null, status: 'loading' })])], 'Test');
    const v1 = S().saveVersion()!;
    S().apply([{ op: 'update', id: 'p1', props: { src: '/static/photos/new.jpg', status: 'ready' } }], { history: false });
    S().apply([{ op: 'update', id: 'p1', props: { zoom: 2 } }]);
    S().restoreVersion(v1.id);
    const p = active().layers[0] as PhotoLayer;
    expect(p.status).toBe('ready');
    expect(p.src).toBe('/static/photos/new.jpg');
    expect(p.zoom).toBe(1);
  });

  it('undo past a mid-generation state keeps the finished photo (no endless spinner)', () => {
    S().addDesigns([design([photo({ src: null, status: 'loading' })])], 'Test');
    S().apply([{ op: 'update', id: 'p1', props: { zoom: 2 } }]);
    S().apply([{ op: 'update', id: 'p1', props: { src: '/static/photos/new.jpg', status: 'ready' } }], { history: false });
    S().undo();
    const p = active().layers[0] as PhotoLayer;
    expect(p.zoom).toBe(1);
    expect(p.status).toBe('ready');
    expect(p.src).toBe('/static/photos/new.jpg');
  });

  it('removes a version without renumbering the others', () => {
    S().addDesigns([design()], 'Test');
    const v1 = S().saveVersion()!;
    S().apply([{ op: 'update', id: 'p1', props: { zoom: 2 } }]);
    S().saveVersion();
    S().removeSaved(v1.id);
    expect(S().saved.map((v) => v.n)).toEqual([2]);
    S().apply([{ op: 'update', id: 'p1', props: { zoom: 3 } }]);
    expect(S().saveVersion()!.n).toBe(3);
  });
});
