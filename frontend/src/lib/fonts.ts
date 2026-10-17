// Fonts must be loaded before Konva draws or measures text (otherwise it wraps with the fallback font).
// After loading we register a real canvas-based text measurer with the design engine.
import { useEffect, useState } from 'react';
import { FONTS } from '../brand';
import { setTextMeasurer } from '../design';

let ready: Promise<void> | null = null;
let isReady = false;

const SAMPLE = 'AaBbQq £$%€0123?!';

function registerMeasurer() {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  setTextMeasurer((text, font, fontWeight, fontSize, letterSpacing) => {
    // Same font string Konva builds: `${fontStyle} ${fontVariant} ${size}px "${family}"` (fontStyle = weight).
    ctx.font = `${fontWeight} normal ${fontSize}px "${FONTS[font]}"`;
    // Konva measures without kerning when letterSpacing != 0 (per-character draw path).
    ctx.fontKerning = letterSpacing ? 'none' : 'auto';
    return ctx.measureText(text).width + (letterSpacing || 0) * Array.from(text).length;
  });
}

export function ensureFonts(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const specs = [
        ...['600', '700', '800'].map((w) => `${w} 40px "${FONTS.headline}"`),
        ...['400', '500', '600', '700'].map((w) => `${w} 20px "${FONTS.body}"`),
      ];
      try {
        await Promise.all(specs.map((s) => document.fonts.load(s, SAMPLE)));
      } catch (e) {
        console.warn('[fonts] load failed', e);
      }
      try {
        await document.fonts.ready;
      } catch {
        /* ignore */
      }
      registerMeasurer();
      isReady = true;
    })();
  }
  return ready;
}

export function useFontsReady(): boolean {
  const [ok, setOk] = useState(isReady);
  useEffect(() => {
    if (isReady) return;
    let alive = true;
    ensureFonts().then(() => alive && setOk(true));
    return () => {
      alive = false;
    };
  }, []);
  return ok;
}
