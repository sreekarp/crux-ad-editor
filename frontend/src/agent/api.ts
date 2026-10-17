// Agent Mode endpoints. Kept out of src/api.ts so agent work doesn't touch the shared client.
import { ApiError } from '../api';
import type { CritiqueRequest, CritiqueResponse, PlanRequest, PlanResponse } from './types';

async function post<T>(path: string, data: unknown, timeoutMs: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new ApiError((e as Error).name === 'AbortError' ? `Request timed out (${Math.round(timeoutMs / 1000)}s): ${path}` : 'Backend unreachable — is the API server running on :8000?');
  } finally {
    window.clearTimeout(timer);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const detail = body && typeof body === 'object' && 'detail' in body ? (body as { detail: unknown }).detail : null;
    throw new ApiError(typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : `HTTP ${res.status}`, res.status);
  }
  if (body === null) throw new ApiError(`Invalid JSON from ${path}`, res.status);
  return body as T;
}

export const agentApi = {
  plan: (body: PlanRequest) => post<PlanResponse>('/api/agent/plan', body, 30_000),
  critique: (body: CritiqueRequest) => post<CritiqueResponse>('/api/agent/critique', body, 40_000),
};
