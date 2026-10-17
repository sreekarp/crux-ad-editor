// File import: PNG/JPG/WEBP, SVG and Photoshop PSD -> editable Design.
// OWNED BY the import workstream. The editor's upload flow calls ONLY importFile / ACCEPTED_FILES.
//   raster.ts  PNG/JPG/WEBP -> one locked 'flat-image' layer
//   svg.ts     SVG -> text/button/image layers + one movable artwork image (sanitized first)
//   psd.ts     PSD -> text/button/image layers (ag-psd, loaded on demand)
import type { Design } from '../types';
import { importPsd } from './psd';
import { importRaster } from './raster';
import { importSvg } from './svg';
import { errorText, ImportError, MAX_IMPORT_BYTES } from './util';

export type ImportKind = 'raster' | 'svg' | 'psd' | 'json';

export interface ImportResult {
  kind: ImportKind;
  /**
   * Editable design, scaled to 1080px wide. Text layers -> TextLayer (colour snapped to navy/white),
   * pixel/image layers -> ImageLayer (bottom-most background gets role 'flat-image').
   */
  design: Design;
  /** Flattened PNG preview uploaded to the backend (/static/uploads/...): use for /api/analyze and thumbnails. */
  previewUrl: string;
  /** Human-readable notes for the chat, e.g. "Imported 12 layers (3 text, 9 images); 2 hidden layers skipped." */
  notes: string[];
}

/** For <input accept> and drop-zone filtering. */
export const ACCEPTED_FILES =
  '.png,.jpg,.jpeg,.webp,.svg,.psd,.json,image/png,image/jpeg,image/webp,image/svg+xml,image/vnd.adobe.photoshop,application/json';

/** Reopens a design file saved with "Export → Design file (.json)". Only same-app asset URLs are kept. */
async function importDesignJson(file: File): Promise<ImportResult> {
  let d: Design;
  try {
    d = JSON.parse(await file.text());
  } catch {
    throw new ImportError(`${file.name} isn't a valid design file (could not read the JSON).`);
  }
  if (!d || typeof d !== 'object' || !Array.isArray(d.layers) || !(d.width > 0) || !(d.height > 0)) {
    throw new ImportError(`${file.name} isn't a Xero Copilot design file.`);
  }
  const local = (u: unknown) => typeof u === 'string' && /^\/(static|api)\//.test(u);
  const layers = d.layers.flatMap((l) => {
    if (l.kind === 'image' && !local(l.src)) return [];
    if (l.kind === 'photo' && l.src && !local(l.src)) return [{ ...l, src: null, status: 'error' as const }];
    if (l.kind === 'photo' && l.status === 'loading') return [{ ...l, status: l.src ? ('ready' as const) : ('error' as const) }];
    return [l];
  });
  const design: Design = { ...d, id: `import-${Date.now().toString(36)}`, layers };
  return { kind: 'json', design, previewUrl: '', notes: [`Reopened ${file.name}: ${layers.length} editable layers.`] };
}

export function importKindOf(file: File): ImportKind | null {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  if (name.endsWith('.json') || type === 'application/json') return 'json';
  if (name.endsWith('.psd') || /^(image\/vnd\.adobe\.photoshop|application\/(x-)?photoshop|image\/(x-)?psd)$/.test(type)) return 'psd';
  if (name.endsWith('.svg') || type === 'image/svg+xml') return 'svg';
  if (/\.(png|jpe?g|webp)$/.test(name) || /^image\/(png|jpeg|webp)$/.test(type)) return 'raster';
  return null;
}

export async function importFile(file: File): Promise<ImportResult> {
  const kind = importKindOf(file);
  if (!kind) throw new Error(`Unsupported file type: ${file.name}. Use PNG, JPG, WEBP, SVG or PSD.`);
  if (file.size === 0) throw new Error(`${file.name} is empty.`);
  if (file.size > MAX_IMPORT_BYTES) {
    throw new Error(`${file.name} is ${(file.size / 1048576).toFixed(0)} MB — the import limit is 150 MB. Save a smaller copy and try again.`);
  }
  try {
    if (kind === 'json') return await importDesignJson(file);
    if (kind === 'psd') return await importPsd(file);
    if (kind === 'svg') return await importSvg(file);
    return await importRaster(file);
  } catch (e) {
    if (e instanceof ImportError) throw e;
    console.error('[import]', e);
    throw new Error(`Couldn't import ${file.name}: ${errorText(e)}`);
  }
}
