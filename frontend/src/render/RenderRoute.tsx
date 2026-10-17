// Headless render route for screenshots:
//   /?render=ref:<id>&size=4:5|1:1|9:16   -> reference slots -> buildDesign
//   /?render=json:<url>                   -> Design JSON
// Renders at 1:1 pixel scale with no UI and sets document.title = 'READY' once fonts + all images are loaded
// ('ERROR' on failure). Extras: &fix=1 applies autoFix; window.__design holds the rendered Design.
import { useEffect, useRef, useState } from 'react';
import type Konva from 'konva';
import { api } from '../api';
import { SIZES, type SizeKey } from '../brand';
import { withPhotoFocus } from '../lib/photoFocus';
import { DesignStage } from '../canvas/DesignStage';
import { autoFix, buildDesign } from '../design';
import { ensureFonts } from '../lib/fonts';
import { pendingImageCount, whenImagesIdle } from '../lib/images';
import { loadManifest } from '../lib/manifest';
import type { Design, PhotoBankItem, Reference } from '../types';

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function findReference(refs: Reference[], id: string): Reference | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/^ref_?/, '').replace(/\.png$/, '');
  return (
    refs.find((r) => r.id === id) ??
    refs.find((r) => norm(r.id) === norm(id)) ??
    refs.find((r) => r.url.toLowerCase().includes(norm(id)))
  );
}

function pickPhoto(photos: PhotoBankItem[], tag: string | undefined): string | null {
  return (photos.find((p) => p.tag === tag) ?? photos[0])?.url ?? null;
}

async function buildFromSpec(spec: string, sizeKey: string, fix: boolean): Promise<Design> {
  await ensureFonts();
  const manifest = await loadManifest();
  let design: Design;
  if (spec.startsWith('ref:')) {
    const id = spec.slice(4);
    const size = SIZES[(sizeKey in SIZES ? sizeKey : '4:5') as SizeKey];
    const refs = await api.references();
    const ref = findReference(refs, id);
    if (!ref) throw new Error(`reference not found: ${id}`);
    const photos = await api.photos().catch(() => [] as PhotoBankItem[]);
    const hero = { ...ref.slots.hero };
    if (hero.type === 'photo' && !hero.photoUrl) hero.photoUrl = pickPhoto(photos, hero.photoTag);
    design = withPhotoFocus(
      buildDesign({ ...ref.slots, hero }, { width: size.width, height: size.height }, manifest, { name: ref.id }),
      photos,
    );
  } else if (spec.startsWith('json:')) {
    const url = spec.slice(5);
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
    const data = await res.json();
    design = (data && data.layers ? data : data?.design) as Design;
    if (!design || !Array.isArray(design.layers)) throw new Error('JSON is not a Design');
  } else {
    throw new Error(`unknown render spec "${spec}" (use ref:<id> or json:<url>)`);
  }
  if (fix) design = autoFix(design, manifest).design;
  return design;
}

export default function RenderRoute({ spec, sizeKey, fix }: { spec: string; sizeKey: string; fix: boolean }) {
  const [design, setDesign] = useState<Design | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stageRef = useRef<Konva.Stage>(null);

  useEffect(() => {
    let alive = true;
    document.title = 'LOADING';
    buildFromSpec(spec, sizeKey, fix)
      .then((d) => {
        if (!alive) return;
        (window as unknown as { __design?: Design }).__design = d;
        setDesign(d);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[render]', msg);
        setError(msg);
        document.title = 'ERROR';
      });
    return () => {
      alive = false;
    };
  }, [spec, sizeKey, fix]);

  useEffect(() => {
    if (!design) return;
    let cancelled = false;
    (async () => {
      const t0 = performance.now();
      await frame();
      await frame();
      // Image loads start during render; wait until none are in flight (max 20 s), then let React + Konva settle.
      do {
        await Promise.race([whenImagesIdle(), sleep(1000)]);
        await frame();
        await frame();
      } while (!cancelled && pendingImageCount() > 0 && performance.now() - t0 < 20_000);
      if (cancelled) return;
      if (pendingImageCount() > 0) console.warn('[render] timed out waiting for images');
      await frame();
      stageRef.current?.draw();
      await frame();
      if (cancelled) return;
      document.body.dataset.ready = '1';
      document.title = 'READY';
    })();
    return () => {
      cancelled = true;
    };
  }, [design]);

  if (error) {
    return (
      <div id="render-error" style={{ padding: 24, fontFamily: 'Inter, sans-serif', color: '#b00020' }}>
        Render error: {error}
      </div>
    );
  }
  if (!design) return null;
  return (
    <div id="render-root" style={{ width: design.width, height: design.height, overflow: 'hidden' }}>
      <DesignStage design={design} scale={1} detail="full" stageRef={stageRef} />
    </div>
  );
}
