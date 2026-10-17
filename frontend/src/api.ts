// Typed client for the backend API (docs/CONTRACT.md). Every call throws ApiError with a readable message.
import type { DesignSummary, Size } from './design';
import type { Op, PhotoBankItem, Reference, Slots } from './types';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 120_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(path, { ...init, signal: ctrl.signal });
  } catch (e) {
    window.clearTimeout(timer);
    if ((e as Error).name === 'AbortError') throw new ApiError(`Request timed out (${Math.round(timeoutMs / 1000)}s): ${path}`);
    throw new ApiError('Backend unreachable — is the API server running on :8000?');
  }
  window.clearTimeout(timer);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const detail = body && typeof body === 'object' && 'detail' in body ? (body as { detail: unknown }).detail : null;
    let msg = typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : '';
    if (!msg) msg = res.status >= 500 && !text ? 'Backend unavailable (is it running on :8000?)' : `HTTP ${res.status}`;
    throw new ApiError(msg, res.status);
  }
  if (body === null && text) throw new ApiError(`Invalid JSON from ${path}`, res.status);
  return body as T;
}

const post = <T>(path: string, data: unknown, timeoutMs?: number) =>
  request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }, timeoutMs);

export interface Health {
  ok: boolean;
  models?: { pro?: string; flash?: string; image?: string };
  keys?: { pro?: boolean; flash?: boolean; openai?: boolean };
  /** Key names the backend has no value for (those AI features will fail). */
  missing?: string[];
}

export interface ConceptsRequest {
  prompt: string;
  count: number;
  referenceId?: string;
  reference?: Slots;
  size: Size;
  brief?: string;
  /** Agent Mode: one subject per concept, in order (e.g. "bakery owner"). Absent = old behaviour. */
  subjects?: string[];
  /** Agent Mode: campaign theme carried by every concept's copy and photo scene (e.g. "Christmas"). */
  theme?: string;
}

export interface EditRequest {
  message: string;
  design: DesignSummary;
  slots?: Slots;
  history?: { role: 'user' | 'assistant'; content: string }[];
}

export interface ImageResult {
  url: string;
  w: number;
  h: number;
  /** /api/photo only: main subject (face) position as [x, y] fractions, when the backend found one. */
  focus?: [number, number];
  /** /api/photo only: essential region of the main subject (whole head with hair, plus what makes the crop read well)
   *  as [x0, y0, x1, y1] fractions of the image, when the backend found one. */
  box?: [number, number, number, number];
}

/** Body of POST /api/photo. aspect/fit describe the shape the photo will be placed in (absent = old behaviour). */
export interface PhotoRequest {
  prompt: string;
  tag?: string;
  orientation?: 'landscape' | 'square' | 'portrait';
  quality?: 'low' | 'medium' | 'high';
  /** Width/height of the layer box the image is cover-fitted into (picks the generation size). */
  aspect?: number;
  /** Kind of shape: bloom mask, rounded frame, or full-bleed box. */
  fit?: 'bloom' | 'frame' | 'full';
  /** Visible part of the box as [x0, y0, x1, y1] box fractions (photoVisibleRect): the backend composes the subject's
   *  essential part inside it. Absent = the plain `fit` composition clause. */
  region?: [number, number, number, number];
}

export interface AnalyzeResult {
  method: 'vision' | 'ocr' | 'none';
  slots?: Partial<Slots>;
  texts?: string[];
  palette?: string[];
}

export const api = {
  health: () => request<Health>('/api/health', {}, 8_000),
  references: () => request<Reference[]>('/api/references', {}, 15_000),
  photos: () => request<PhotoBankItem[]>('/api/photos', {}, 15_000),
  concepts: (body: ConceptsRequest) => post<{ reply: string; concepts: Slots[] }>('/api/design/concepts', body, 180_000),
  edit: (body: EditRequest) => post<{ reply: string; ops: Op[] }>('/api/design/edit', body, 120_000),
  photo: (body: PhotoRequest) => post<ImageResult>('/api/photo', body, 240_000),
  // Uploads go through src/import (importFile), which owns POST /api/upload.
  analyze: (url: string) => post<AnalyzeResult>('/api/analyze', { url }, 120_000),
  pixelEdit: (url: string, prompt: string) => post<ImageResult>('/api/pixel-edit', { url, prompt }, 240_000),
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
