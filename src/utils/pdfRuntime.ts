import * as pdfjsLib from 'pdfjs-dist';
import { WorkspaceFile } from '../types/tools';

// Configure PDF.js to use the locally precached worker for 100% offline execution
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

export { pdfjsLib };

export function uid(prefix = 'id'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(i > 1 ? 2 : 1))} ${sizes[i]}`;
}

export function stripExt(name: string): string {
  return name.replace(/\.[^/.]+$/, '');
}

export async function fileToWorkspaceFile(file: File): Promise<WorkspaceFile> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let pageCount: number | undefined;
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    try {
      const doc = await openPdfJs(bytes);
      pageCount = doc.numPages;
      await destroyPdfJs(doc);
    } catch {
      // Corrupt or encrypted PDF; pageCount stays undefined until unlocked/repaired
    }
  }
  return {
    id: uid('file'),
    name: file.name,
    size: bytes.byteLength,
    type: file.type || 'application/octet-stream',
    bytes,
    pageCount,
    createdAt: Date.now(),
  };
}

export async function blobToWorkspaceFile(
  blob: Blob,
  name: string,
  pageCount?: number
): Promise<WorkspaceFile> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  return {
    id: uid('file'),
    name,
    size: bytes.byteLength,
    type: blob.type || 'application/pdf',
    bytes,
    pageCount,
    createdAt: Date.now(),
  };
}

export async function openPdfJs(bytes: Uint8Array, password?: string) {
  // Pass a copy of Uint8Array so PDF.js worker transfer does not detach the caller's buffer
  const copy = new Uint8Array(bytes);
  const loadingTask = pdfjsLib.getDocument({
    data: copy,
    password,
    useSystemFonts: true,
  });
  return loadingTask.promise;
}

export async function destroyPdfJs(doc: pdfjsLib.PDFDocumentProxy | null | undefined): Promise<void> {
  if (!doc) return;
  const d = doc as unknown as { destroy?: () => Promise<void>; cleanup?: () => void };
  if (typeof d.destroy === 'function') await d.destroy();
  else if (typeof d.cleanup === 'function') d.cleanup();
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' = 'image/png',
  quality = 0.92
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Failed to encode canvas blob'));
      },
      mimeType,
      quality
    );
  });
}

export async function canvasToUint8Array(
  canvas: HTMLCanvasElement,
  mimeType: 'image/png' | 'image/jpeg' = 'image/jpeg',
  quality = 0.88
): Promise<Uint8Array> {
  const blob = await canvasToBlob(canvas, mimeType, quality);
  return new Uint8Array(await blob.arrayBuffer());
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 4000);
}

/**
 * Parse page range syntax like "1-3, 5, 8-12" into 1-based page indices.
 * Supports arbitrary page counts with zero artificial caps.
 */
export function parsePageRangeExpression(expr: string, maxPages: number): number[] {
  const trimmed = expr.trim();
  if (!trimmed || trimmed.toLowerCase() === 'all') {
    return Array.from({ length: maxPages }, (_, i) => i + 1);
  }
  const result: number[] = [];
  const parts = trimmed.split(',').map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    if (part.includes('-')) {
      const [startStr, endStr] = part.split('-').map((s) => s.trim());
      const start = Math.max(1, parseInt(startStr, 10) || 1);
      const end = endStr === '' ? maxPages : Math.min(maxPages, parseInt(endStr, 10) || maxPages);
      if (start <= end) {
        for (let p = start; p <= end; p++) result.push(p);
      } else {
        for (let p = start; p >= Math.max(1, end); p--) result.push(p);
      }
    } else {
      const p = parseInt(part, 10);
      if (!Number.isNaN(p) && p >= 1 && p <= maxPages) {
        result.push(p);
      }
    }
  }
  return result;
}

/**
 * Parse range groups separated by semicolons or newlines for Split PDF, e.g. "1-3; 4-6"
 */
export function parseSplitGroups(expr: string, maxPages: number): number[][] {
  const groups = expr
    .split(/[;\n]+/)
    .map((g) => g.trim())
    .filter(Boolean);
  return groups
    .map((g) => parsePageRangeExpression(g, maxPages))
    .filter((pages) => pages.length > 0);
}

export async function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function renderPageToCanvas(
  pdfDoc: pdfjsLib.PDFDocumentProxy,
  pageNumber: number,
  scale = 1.5,
  extraRotation = 0
): Promise<HTMLCanvasElement> {
  const page = await pdfDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale, rotation: (page.rotate + extraRotation) % 360 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Could not create 2D canvas context');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  page.cleanup();
  return canvas;
}
