// Shared image cache for every Konva stage (main canvas, thumbnails, render route).
// One <img> per URL, a global in-flight counter so the render route knows when everything has loaded,
// and failures resolve to null (a missing asset is skipped, never thrown).
import { useEffect, useReducer } from 'react';

export type ImgStatus = 'none' | 'loading' | 'loaded' | 'failed';

interface Entry {
  url: string;
  img?: HTMLImageElement;
  status: 'loading' | 'loaded' | 'failed';
  promise: Promise<HTMLImageElement | null>;
  failedAt?: number;
}

const cache = new Map<string, Entry>();
let inflight = 0;
const idleWaiters = new Set<() => void>();
const RETRY_FAILED_AFTER_MS = 10_000;

/** Backend URLs (http://localhost:8000/static/...) are rewritten to same-origin paths so the Vite proxy
 *  serves them and the canvas stays untainted (PNG export keeps working). */
export function normalizeUrl(url: string | null | undefined): string {
  if (!url) return '';
  if (/^(data|blob):/i.test(url)) return url;
  if (/^https?:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      if (
        u.origin !== window.location.origin &&
        /^\/(static|api)\//.test(u.pathname) &&
        /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(u.hostname)
      ) {
        return u.pathname + u.search;
      }
    } catch {
      /* keep as is */
    }
  }
  return url;
}

function finish() {
  inflight = Math.max(0, inflight - 1);
  if (inflight === 0) {
    const waiters = [...idleWaiters];
    idleWaiters.clear();
    waiters.forEach((w) => w());
  }
}

function start(url: string): Entry {
  inflight++;
  const entry: Entry = { url, status: 'loading', promise: Promise.resolve(null) };
  entry.promise = new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    if (/^https?:\/\//i.test(url)) {
      try {
        if (new URL(url).origin !== window.location.origin) img.crossOrigin = 'anonymous';
      } catch {
        /* ignore */
      }
    }
    img.onload = () => {
      img
        .decode()
        .catch(() => undefined)
        .finally(() => {
          entry.img = img;
          entry.status = 'loaded';
          finish();
          resolve(img);
        });
    };
    img.onerror = () => {
      entry.status = 'failed';
      entry.failedAt = Date.now();
      finish();
      resolve(null);
    };
    img.src = url;
  });
  cache.set(url, entry);
  return entry;
}

function getEntry(url: string): Entry {
  const e = cache.get(url);
  if (e && !(e.status === 'failed' && Date.now() - (e.failedAt ?? 0) > RETRY_FAILED_AFTER_MS)) return e;
  return start(url);
}

/** Load (or reuse) an image. Resolves null on failure. */
export function loadImage(url: string | null | undefined): Promise<HTMLImageElement | null> {
  const u = normalizeUrl(url);
  if (!u) return Promise.resolve(null);
  return getEntry(u).promise;
}

/** React hook: [image | undefined, status]. Empty url -> 'none'. */
export function useImg(url: string | null | undefined): [HTMLImageElement | undefined, ImgStatus] {
  const u = normalizeUrl(url);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const entry = u ? getEntry(u) : undefined;
  useEffect(() => {
    if (!entry || entry.status !== 'loading') return;
    let alive = true;
    entry.promise.then(() => {
      if (alive) bump();
    });
    return () => {
      alive = false;
    };
  }, [entry]);
  return [entry?.status === 'loaded' ? entry.img : undefined, entry ? entry.status : 'none'];
}

export function pendingImageCount(): number {
  return inflight;
}

/** Resolves when no image is loading. */
export function whenImagesIdle(): Promise<void> {
  if (inflight === 0) return Promise.resolve();
  return new Promise((r) => idleWaiters.add(r));
}
