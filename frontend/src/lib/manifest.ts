import { assetUrl } from '../brand';
import type { Manifest } from '../types';

let cached: Manifest | null = null;
let inflight: Promise<Manifest | null> | null = null;

/** Brand asset manifest, or null while workstream A hasn't produced it yet. Never throws. */
export function loadManifest(force = false): Promise<Manifest | null> {
  if (cached && !force) return Promise.resolve(cached);
  if (inflight && !force) return inflight;
  inflight = fetch(assetUrl.manifest, { cache: 'no-cache' })
    .then(async (r) => {
      if (!r.ok) return null;
      const m = (await r.json()) as Manifest;
      cached = m && typeof m === 'object' ? m : null;
      return cached;
    })
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function getCachedManifest(): Manifest | null {
  return cached;
}
