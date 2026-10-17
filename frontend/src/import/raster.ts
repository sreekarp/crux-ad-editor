// PNG / JPG / WEBP -> one locked 'flat-image' layer (pixel edits via chat, "recreate" via /api/analyze).
import type { Design, ImageLayer } from '../types';
import type { ImportResult } from './index';
import {
  backgroundOf,
  baseName,
  canvasToBlob,
  DESIGN_W,
  ImportError,
  MAX_UPLOAD_BYTES,
  scaleCanvas,
  uploadBlob,
  type Uploaded,
} from './util';

export async function importRaster(file: File): Promise<ImportResult> {
  const notes: string[] = [];
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    bitmap = null; // the backend has the final say on whether it's an image
  }

  let blob: Blob = file;
  let filename = file.name;
  if (file.size > MAX_UPLOAD_BYTES) {
    if (!bitmap) throw new ImportError(`${file.name} is over 25 MB and could not be decoded to shrink it. Try exporting a smaller PNG or JPG.`);
    const s = Math.min(1, 2160 / bitmap.width);
    const c = scaleCanvas(bitmap, bitmap.width * s, bitmap.height * s);
    blob = await canvasToBlob(c, 'image/png');
    if (blob.size > MAX_UPLOAD_BYTES) blob = await canvasToBlob(c, 'image/jpeg', 0.9);
    filename = `${baseName(file.name)}.${blob.type === 'image/png' ? 'png' : 'jpg'}`;
    notes.push(`Large image downscaled to ${c.width}px wide before upload.`);
  }

  let up: Uploaded;
  try {
    up = await uploadBlob(blob, filename);
  } catch (e) {
    if (e instanceof ImportError && /\(400/.test(e.message)) {
      throw new ImportError(`${file.name} could not be opened as an image — the file may be corrupt.`);
    }
    throw e;
  }

  const W = DESIGN_W;
  const H = Math.max(1, Math.round(((up.h || 1350) / (up.w || 1080)) * W));
  let background: Design['background'] = 'white';
  if (bitmap) {
    try {
      background = backgroundOf(scaleCanvas(bitmap, Math.min(320, bitmap.width), Math.min(320, bitmap.width) * (bitmap.height / bitmap.width)));
    } catch {
      /* keep white */
    }
    bitmap.close();
  }

  const layer: ImageLayer = {
    id: 'image-1',
    kind: 'image',
    role: 'flat-image',
    name: file.name,
    src: up.url,
    x: 0,
    y: 0,
    width: W,
    height: H,
    locked: true,
  };
  const design: Design = {
    id: `import-${Date.now().toString(36)}`,
    name: baseName(file.name),
    width: W,
    height: H,
    background,
    layers: [layer],
  };
  notes.unshift(`Imported ${file.name} as a flat image (pixel edits via chat).`);
  return { kind: 'raster', design, previewUrl: up.url, notes };
}
