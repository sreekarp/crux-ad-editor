// Offscreen renderer for the agent's review loop: any design (active or not) -> JPEG data URL.
// Mounts a read-only <DesignStage> in a hidden container far off-screen, waits for fonts and images the same
// way the render route does, then snapshots the stage. One render at a time (promise queue); never throws.
import { createRoot } from 'react-dom/client';
import { createRef } from 'react';
import type Konva from 'konva';
import { DesignStage } from '../canvas/DesignStage';
import { ensureFonts } from '../lib/fonts';
import { pendingImageCount, whenImagesIdle } from '../lib/images';
import type { Design } from '../types';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// rAF is paused in background tabs; the timeout keeps a review running if the user switches away.
const frame = () => Promise.race([new Promise<void>((r) => requestAnimationFrame(() => r())), sleep(100)]);

const IMAGE_WAIT_MS = 5_000;
const MOUNT_WAIT_MS = 2_000;

let queue: Promise<unknown> = Promise.resolve();

async function renderNow(design: Design, maxSide: number): Promise<string | null> {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = `position:fixed;left:-100000px;top:0;width:${design.width}px;height:${design.height}px;overflow:hidden;pointer-events:none;`;
  document.body.appendChild(host);
  const root = createRoot(host);
  const stageRef = createRef<Konva.Stage>();
  try {
    // Fonts first, so Konva wraps and measures text with the brand fonts (not the fallback).
    await Promise.race([ensureFonts(), sleep(5_000)]);
    root.render(<DesignStage design={design} scale={1} detail="full" stageRef={stageRef} />);

    // createRoot renders asynchronously: wait for the commit that attaches the stage.
    const t0 = performance.now();
    while (!stageRef.current && performance.now() - t0 < MOUNT_WAIT_MS) await frame();
    if (!stageRef.current) return null;

    // Image loads start during the first render; wait until none are in flight, then let React + Konva settle
    // (useImg re-renders once a load resolves, and the photo is composed in that render).
    const t1 = performance.now();
    await frame();
    await frame();
    while (pendingImageCount() > 0 && performance.now() - t1 < IMAGE_WAIT_MS) {
      await Promise.race([whenImagesIdle(), sleep(500)]);
      await frame();
      await frame();
    }
    if (pendingImageCount() > 0) console.warn('[offscreen] timed out waiting for images');
    await frame();

    const stage = stageRef.current;
    if (!stage) return null;
    stage.draw();
    const pixelRatio = maxSide / Math.max(design.width, design.height, 1);
    // The design background is an opaque rect, so JPEG (no alpha) is safe.
    return stage.toDataURL({ mimeType: 'image/jpeg', quality: 0.85, pixelRatio });
  } catch (e) {
    console.warn('[offscreen] render failed', e);
    return null;
  } finally {
    try {
      root.unmount();
    } catch {
      /* ignore */
    }
    host.remove();
  }
}

/** Render a design to a JPEG data URL (longest side `maxSide`). Serialized; resolves null on any failure. */
export function renderDesignToDataUrl(design: Design, maxSide = 768): Promise<string | null> {
  const run = queue.then(() => renderNow(design, maxSide)).catch(() => null);
  queue = run;
  return run;
}
