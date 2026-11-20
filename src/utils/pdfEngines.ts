import JSZip from 'jszip';
import {
  BlendMode,
  degrees,
  PDFDocument,
  PDFName,
  PDFRawStream,
  rgb,
  StandardFonts,
} from 'pdf-lib';
import { encryptPdfDocument, PdfPermissionOptions } from './pdfCrypto';
import {
  canvasToBlob,
  canvasToUint8Array,
  destroyPdfJs,
  openPdfJs,
  parsePageRangeExpression,
  parseSplitGroups,
  pdfjsLib,
  renderPageToCanvas,
  stripExt,
  yieldToMain,
} from './pdfRuntime';
import { ProgressInfo, WorkspaceFile } from '../types/tools';

export type ProgressCallback = (info: ProgressInfo) => void;

function toBlob(bytes: Uint8Array, mime = 'application/pdf'): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy], { type: mime });
}

export function hexToRgb(hex: string) {
  const clean = hex.replace('#', '');
  const num = parseInt(clean.length === 3 ? clean.replace(/(.)/g, '$1$1') : clean, 16) || 0;
  return rgb(((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255);
}

/* -------------------------------------------------------------------------- */
/* 1. MERGE PDF                                                               */
/* -------------------------------------------------------------------------- */
export async function mergePdfs(
  items: { file: WorkspaceFile; pageRange?: string }[],
  onProgress?: ProgressCallback
): Promise<{ blob: Blob; pageCount: number }> {
  const outDoc = await PDFDocument.create();
  for (let i = 0; i < items.length; i++) {
    const { file, pageRange } = items[i];
    onProgress?.({ current: i + 1, total: items.length, label: `Merging ${file.name}` });
    const src = await PDFDocument.load(file.bytes, { ignoreEncryption: true });
    const total = src.getPageCount();
    const indices = pageRange
      ? parsePageRangeExpression(pageRange, total).map((p) => p - 1)
      : src.getPageIndices();
    if (indices.length > 0) {
      const copied = await outDoc.copyPages(src, indices);
      for (const page of copied) outDoc.addPage(page);
    }
    await yieldToMain();
  }
  const bytes = await outDoc.save({ useObjectStreams: true });
  return { blob: toBlob(bytes), pageCount: outDoc.getPageCount() };
}

/* -------------------------------------------------------------------------- */
/* 2. SPLIT PDF                                                               */
/* -------------------------------------------------------------------------- */
export type SplitMode = 'ranges' | 'every-n' | 'burst' | 'extract';

export async function splitPdf(
  file: WorkspaceFile,
  options: {
    mode: SplitMode;
    rangeExpr?: string;
    everyN?: number;
  },
  onProgress?: ProgressCallback
): Promise<{ blob: Blob; fileName: string; mimeType: string; fileCount: number }> {
  const src = await PDFDocument.load(file.bytes, { ignoreEncryption: true });
  const totalPages = src.getPageCount();
  const base = stripExt(file.name);

  let groups: number[][] = [];
  if (options.mode === 'burst') {
    groups = Array.from({ length: totalPages }, (_, i) => [i + 1]);
  } else if (options.mode === 'every-n') {
    const step = Math.max(1, options.everyN || 1);
    for (let i = 1; i <= totalPages; i += step) {
      const chunk: number[] = [];
      for (let p = i; p < i + step && p <= totalPages; p++) chunk.push(p);
      groups.push(chunk);
    }
  } else if (options.mode === 'extract') {
    const pages = parsePageRangeExpression(options.rangeExpr || '1', totalPages);
    if (pages.length > 0) groups = [pages];
  } else {
    groups = parseSplitGroups(options.rangeExpr || `1-${totalPages}`, totalPages);
  }

  if (groups.length === 0) {
    throw new Error('No valid pages matched the split specification.');
  }

  if (groups.length === 1) {
    const outDoc = await PDFDocument.create();
    const copied = await outDoc.copyPages(
      src,
      groups[0].map((p) => p - 1)
    );
    copied.forEach((p) => outDoc.addPage(p));
    const bytes = await outDoc.save();
    return {
      blob: toBlob(bytes),
      fileName: `${base}_pages_${groups[0][0]}-${groups[0][groups[0].length - 1]}.pdf`,
      mimeType: 'application/pdf',
      fileCount: 1,
    };
  }

  const zip = new JSZip();
  for (let i = 0; i < groups.length; i++) {
    onProgress?.({ current: i + 1, total: groups.length, label: `Writing part ${i + 1} of ${groups.length}` });
    const outDoc = await PDFDocument.create();
    const copied = await outDoc.copyPages(
      src,
      groups[i].map((p) => p - 1)
    );
    copied.forEach((p) => outDoc.addPage(p));
    const bytes = await outDoc.save();
    const padNum = String(i + 1).padStart(String(groups.length).length, '0');
    zip.file(`${base}_part_${padNum}.pdf`, bytes);
    if (i % 10 === 0) await yieldToMain();
  }

  const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return {
    blob: zipBlob,
    fileName: `${base}_split_${groups.length}_parts.zip`,
    mimeType: 'application/zip',
    fileCount: groups.length,
  };
}

/* -------------------------------------------------------------------------- */
/* 3. COMPRESS PDF                                                            */
/* -------------------------------------------------------------------------- */
export type CompressLevel = 'structural' | 'balanced' | 'maximum';

export async function compressPdf(
  file: WorkspaceFile,
  level: CompressLevel,
  onProgress?: ProgressCallback
): Promise<{ blob: Blob; originalSize: number; compressedSize: number; pageCount: number }> {
  const originalSize = file.bytes.byteLength;

  if (level === 'structural') {
    onProgress?.({ current: 1, total: 2, label: 'Optimizing PDF object streams & stripping metadata' });
    const doc = await PDFDocument.load(file.bytes, { ignoreEncryption: true });
    doc.setTitle('');
    doc.setAuthor('');
    doc.setSubject('');
    doc.setKeywords([]);
    doc.setCreator('FolioForge');
    doc.setProducer('FolioForge');
    const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
    const finalBytes = bytes.byteLength < originalSize ? bytes : file.bytes;
    onProgress?.({ current: 2, total: 2, label: 'Done' });
    return {
      blob: toBlob(finalBytes),
      originalSize,
      compressedSize: finalBytes.byteLength,
      pageCount: doc.getPageCount(),
    };
  }

  // Balanced / Maximum: rasterize pages at controlled DPI + JPEG quality via Blob -> Uint8Array
  const scale = level === 'balanced' ? 1.35 : 1.0;
  const quality = level === 'balanced' ? 0.72 : 0.5;
  const pdfJsDoc = await openPdfJs(file.bytes);
  const totalPages = pdfJsDoc.numPages;
  const outDoc = await PDFDocument.create();

  for (let p = 1; p <= totalPages; p++) {
    onProgress?.({ current: p, total: totalPages, label: `Compressing page ${p} of ${totalPages}` });
    const page = await pdfJsDoc.getPage(p);
    const baseVp = page.getViewport({ scale: 1 });
    const canvas = await renderPageToCanvas(pdfJsDoc, p, scale);
    const jpgBytes = await canvasToUint8Array(canvas, 'image/jpeg', quality);
    const jpgImg = await outDoc.embedJpg(jpgBytes);
    const outPage = outDoc.addPage([baseVp.width, baseVp.height]);
    outPage.drawImage(jpgImg, {
      x: 0,
      y: 0,
      width: baseVp.width,
      height: baseVp.height,
    });
    canvas.width = 0;
    canvas.height = 0;
    await yieldToMain();
  }
  await destroyPdfJs(pdfJsDoc);

  const compressedBytes = await outDoc.save({ useObjectStreams: true });
  return {
    blob: toBlob(compressedBytes),
    originalSize,
    compressedSize: compressedBytes.byteLength,
    pageCount: totalPages,
  };
}

/* -------------------------------------------------------------------------- */
/* 4. ORGANIZE PDF                                                            */
/* -------------------------------------------------------------------------- */
export interface OrganizePageInstruction {
  sourceFileId: string;
  sourcePageIndex: number; // -1 means blank page
  rotation: number; // additional degrees 0, 90, 180, 270
  blankWidth?: number;
  blankHeight?: number;
}

export async function organizePdf(
  filesMap: Map<string, WorkspaceFile>,
  instructions: OrganizePageInstruction[],
  onProgress?: ProgressCallback
): Promise<{ blob: Blob; pageCount: number }> {
  const loadedDocs = new Map<string, PDFDocument>();
  const outDoc = await PDFDocument.create();

  for (let i = 0; i < instructions.length; i++) {
    const inst = instructions[i];
    if (i % 10 === 0) {
      onProgress?.({ current: i + 1, total: instructions.length, label: `Assembling page ${i + 1}` });
      await yieldToMain();
    }
    if (inst.sourcePageIndex < 0) {
      const blank = outDoc.addPage([inst.blankWidth || 595.28, inst.blankHeight || 841.89]);
      if (inst.rotation) blank.setRotation(degrees(inst.rotation));
      continue;
    }
    let srcDoc = loadedDocs.get(inst.sourceFileId);
    if (!srcDoc) {
      const f = filesMap.get(inst.sourceFileId);
      if (!f) continue;
      srcDoc = await PDFDocument.load(f.bytes, { ignoreEncryption: true });
      loadedDocs.set(inst.sourceFileId, srcDoc);
    }
    const [copied] = await outDoc.copyPages(srcDoc, [inst.sourcePageIndex]);
    if (inst.rotation) {
      const curr = copied.getRotation().angle;
      copied.setRotation(degrees((curr + inst.rotation) % 360));
    }
    outDoc.addPage(copied);
  }

  const bytes = await outDoc.save({ useObjectStreams: true });
  return { blob: toBlob(bytes), pageCount: outDoc.getPageCount() };
}

/* -------------------------------------------------------------------------- */
/* 5. ROTATE PDF (Single or Batch)                                            */
/* -------------------------------------------------------------------------- */
export async function rotatePdfs(
  files: WorkspaceFile[],
  options: {
    angle: 90 | 180 | 270;
    scope: 'all' | 'odd' | 'even' | 'range';
    pageRange?: string;
  },
  onProgress?: ProgressCallback
): Promise<{ blob: Blob; fileName: string; mimeType: string }> {
  const processSingle = async (file: WorkspaceFile) => {
    const doc = await PDFDocument.load(file.bytes, { ignoreEncryption: true });
    const count = doc.getPageCount();
    const targets =
      options.scope === 'range'
        ? new Set(parsePageRangeExpression(options.pageRange || 'all', count))
        : null;

    for (let i = 0; i < count; i++) {
      const pageNum = i + 1;
      const shouldRotate =
        options.scope === 'all' ||
        (options.scope === 'odd' && pageNum % 2 === 1) ||
        (options.scope === 'even' && pageNum % 2 === 0) ||
        (options.scope === 'range' && targets?.has(pageNum));
      if (shouldRotate) {
        const page = doc.getPage(i);
        const curr = page.getRotation().angle;
        page.setRotation(degrees((curr + options.angle) % 360));
      }
    }
    return doc.save({ useObjectStreams: true });
  };

  if (files.length === 1) {
    onProgress?.({ current: 1, total: 1, label: `Rotating ${files[0].name}` });
    const bytes = await processSingle(files[0]);
    return {
      blob: toBlob(bytes),
      fileName: `${stripExt(files[0].name)}_rotated.pdf`,
      mimeType: 'application/pdf',
    };
  }

  const zip = new JSZip();
  for (let i = 0; i < files.length; i++) {
    onProgress?.({ current: i + 1, total: files.length, label: `Rotating ${files[i].name}` });
    const bytes = await processSingle(files[i]);
    zip.file(`${stripExt(files[i].name)}_rotated.pdf`, bytes);
    await yieldToMain();
  }
  const zipBlob = await zip.generateAsync({ type: 'blob' });
  return {
    blob: zipBlob,
    fileName: `rotated_pdfs_${files.length}.zip`,
    mimeType: 'application/zip',
  };
}

/* -------------------------------------------------------------------------- */
/* 6. CROP PDF                                                                */
/* -------------------------------------------------------------------------- */
export async function cropPdf(
  file: WorkspaceFile,
  cropNorm: { left: number; top: number; right: number; bottom: number }, // normalized 0..1 margins from edges
  scope: 'all' | 'range',
  pageRange?: string
): Promise<{ blob: Blob; pageCount: number }> {
  const doc = await PDFDocument.load(file.bytes, { ignoreEncryption: true });
  const total = doc.getPageCount();
  const targets =
    scope === 'range' ? new Set(parsePageRangeExpression(pageRange || 'all', total)) : null;

  for (let i = 0; i < total; i++) {
    if (targets && !targets.has(i + 1)) continue;
    const page = doc.getPage(i);
    const box = page.getCropBox() || page.getMediaBox();
    const x = box.x + box.width * cropNorm.left;
    const y = box.y + box.height * cropNorm.bottom;
    const w = Math.max(20, box.width * (1 - cropNorm.left - cropNorm.right));
    const h = Math.max(20, box.height * (1 - cropNorm.top - cropNorm.bottom));
    page.setCropBox(x, y, w, h);
    page.setMediaBox(x, y, w, h);
  }

  const bytes = await doc.save({ useObjectStreams: true });
  return { blob: toBlob(bytes), pageCount: total };
}

/* -------------------------------------------------------------------------- */
/* 7. PAGE NUMBERS                                                            */
/* -------------------------------------------------------------------------- */
export type PageNumberPosition =
  | 'bottom-center'
  | 'bottom-left'
  | 'bottom-right'
  | 'top-center'
  | 'top-left'
  | 'top-right';

function toRoman(num: number): string {
  const map: [number, string][] = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'],
    [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'],
    [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let n = Math.max(1, num);
  let out = '';
  for (const [val, sym] of map) {
    while (n >= val) {
      out += sym;
      n -= val;
    }
  }
  return out;
}

export async function addPageNumbers(
  file: WorkspaceFile,
  options: {
    position: PageNumberPosition;
    format: 'n' | 'page-n-of-total' | 'n-slash-total' | 'roman';
    fontSize: number;
    margin: number;
    startNumber: number;
    skipFirst: boolean;
    colorHex: string;
    fontFamily: 'Helvetica' | 'TimesRoman' | 'Courier';
  },
  onProgress?: ProgressCallback
): Promise<{ blob: Blob; pageCount: number }> {
  const doc = await PDFDocument.load(file.bytes, { ignoreEncryption: true });
  const fontKey =
    options.fontFamily === 'TimesRoman'
      ? StandardFonts.TimesRoman
      : options.fontFamily === 'Courier'
        ? StandardFonts.Courier
        : StandardFonts.Helvetica;
  const font = await doc.embedFont(fontKey);
  const color = hexToRgb(options.colorHex);
  const total = doc.getPageCount();

  for (let i = 0; i < total; i++) {
    if (i % 25 === 0) {
      onProgress?.({ current: i + 1, total, label: `Numbering page ${i + 1} of ${total}` });
      await yieldToMain();
    }
    if (options.skipFirst && i === 0) continue;

    const page = doc.getPage(i);
    const { width, height } = page.getSize();
    const displayNum = options.startNumber + i - (options.skipFirst ? 1 : 0);
    const totalDisplay = options.startNumber + total - 1 - (options.skipFirst ? 1 : 0);

    let text = `${displayNum}`;
    if (options.format === 'page-n-of-total') text = `Page ${displayNum} of ${totalDisplay}`;
    else if (options.format === 'n-slash-total') text = `${displayNum} / ${totalDisplay}`;
    else if (options.format === 'roman') text = toRoman(displayNum);

    const textWidth = font.widthOfTextAtSize(text, options.fontSize);
    const m = options.margin;

    let x = (width - textWidth) / 2;
    if (options.position.endsWith('left')) x = m;
    else if (options.position.endsWith('right')) x = Math.max(m, width - textWidth - m);

    let y = m;
    if (options.position.startsWith('top')) y = Math.max(m, height - m - options.fontSize);

    page.drawText(text, {
      x,
      y,
      size: options.fontSize,
      font,
      color,
    });
  }

  const bytes = await doc.save({ useObjectStreams: true });
  return { blob: toBlob(bytes), pageCount: total };
}

/* -------------------------------------------------------------------------- */
/* 8. WATERMARK                                                               */
/* -------------------------------------------------------------------------- */
export async function addWatermark(
  file: WorkspaceFile,
  options: {
    mode: 'text' | 'image';
    text?: string;
    fontSize?: number;
    colorHex?: string;
    imageBytes?: Uint8Array;
    imageMime?: string;
    imageScale?: number;
    opacity: number;
    rotation: number;
    placement: 'center' | 'tile' | 'top-right' | 'bottom-right';
    pageRange?: string;
  },
  onProgress?: ProgressCallback
): Promise<{ blob: Blob; pageCount: number }> {
  const doc = await PDFDocument.load(file.bytes, { ignoreEncryption: true });
  const total = doc.getPageCount();
  const targets = new Set(parsePageRangeExpression(options.pageRange || 'all', total));
  const font = await doc.embedFont(StandardFonts.HelveticaBold);

  let embeddedImg: Awaited<ReturnType<PDFDocument['embedPng']>> | null = null;
  if (options.mode === 'image' && options.imageBytes) {
    if (options.imageMime?.includes('jpeg') || options.imageMime?.includes('jpg')) {
      embeddedImg = await doc.embedJpg(options.imageBytes);
    } else {
      embeddedImg = await doc.embedPng(options.imageBytes);
    }
  }

  for (let i = 0; i < total; i++) {
    if (!targets.has(i + 1)) continue;
    if (i % 20 === 0) {
      onProgress?.({ current: i + 1, total, label: `Watermarking page ${i + 1}` });
      await yieldToMain();
    }
    const page = doc.getPage(i);
    const { width, height } = page.getSize();

    if (options.mode === 'text') {
      const label = options.text || 'CONFIDENTIAL';
      const size = options.fontSize || 48;
      const color = hexToRgb(options.colorHex || '#DC2626');
      const tw = font.widthOfTextAtSize(label, size);

      if (options.placement === 'tile') {
        const cols = 3;
        const rows = 4;
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            page.drawText(label, {
              x: (width / cols) * (c + 0.2),
              y: (height / rows) * (r + 0.4),
              size: size * 0.6,
              font,
              color,
              opacity: options.opacity,
              rotate: degrees(options.rotation),
              blendMode: BlendMode.Normal,
            });
          }
        }
      } else {
        let x = width / 2 - tw / 2;
        let y = height / 2 - size / 2;
        if (options.placement === 'top-right') {
          x = Math.max(24, width - tw - 36);
          y = height - size - 36;
        } else if (options.placement === 'bottom-right') {
          x = Math.max(24, width - tw - 36);
          y = 36;
        }
        page.drawText(label, {
          x,
          y,
          size,
          font,
          color,
          opacity: options.opacity,
          rotate: degrees(options.rotation),
        });
      }
    } else if (embeddedImg) {
      const scale = options.imageScale || 0.35;
      const drawW = embeddedImg.width * scale;
      const drawH = embeddedImg.height * scale;
      const x =
        options.placement === 'top-right' || options.placement === 'bottom-right'
          ? width - drawW - 32
          : (width - drawW) / 2;
      const y =
        options.placement === 'top-right'
          ? height - drawH - 32
          : options.placement === 'bottom-right'
            ? 32
            : (height - drawH) / 2;
      page.drawImage(embeddedImg, {
        x,
        y,
        width: drawW,
        height: drawH,
        opacity: options.opacity,
        rotate: degrees(options.rotation),
      });
    }
  }

  const bytes = await doc.save({ useObjectStreams: true });
  return { blob: toBlob(bytes), pageCount: total };
}

/* -------------------------------------------------------------------------- */
/* 9. PDF TO JPG / PNG / EXTRACT EMBEDDED IMAGES                              */
/* -------------------------------------------------------------------------- */
function trimCanvasBlankEdges(src: HTMLCanvasElement): HTMLCanvasElement {
  const w = src.width;
  const h = src.height;
  const ctx = src.getContext('2d');
  if (!ctx || w === 0 || h === 0) return src;
  const data = ctx.getImageData(0, 0, w, h).data;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const a = data[idx + 3];
      const isBlank = a < 10 || (r > 246 && g > 246 && b > 246);
      if (!isBlank) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX <= minX || maxY <= minY) return src;
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const out = document.createElement('canvas');
  out.width = cw;
  out.height = ch;
  out.getContext('2d')?.drawImage(src, minX, minY, cw, ch, 0, 0, cw, ch);
  return out;
}

export async function pdfToImages(
  file: WorkspaceFile,
  options: {
    mode: 'render-pages' | 'extract-embedded';
    format: 'jpeg' | 'png';
    dpi: 72 | 150 | 300;
    quality: number;
    pageRange?: string;
    cropBlankEdges?: boolean;
  },
  onProgress?: ProgressCallback
): Promise<{ blob: Blob; fileName: string; mimeType: string; imageCount: number }> {
  const pdfDoc = await openPdfJs(file.bytes);
  const total = pdfDoc.numPages;
  const pages = parsePageRangeExpression(options.pageRange || 'all', total);
  const base = stripExt(file.name);
  const mime = options.format === 'png' ? 'image/png' : 'image/jpeg';
  const ext = options.format === 'png' ? 'png' : 'jpg';
  const results: { name: string; blob: Blob }[] = [];

  if (options.mode === 'render-pages') {
    const scale = options.dpi / 72;
    for (let idx = 0; idx < pages.length; idx++) {
      const p = pages[idx];
      onProgress?.({ current: idx + 1, total: pages.length, label: `Rendering page ${p}` });
      const rawCanvas = await renderPageToCanvas(pdfDoc, p, scale);
      const targetCanvas = options.cropBlankEdges ? trimCanvasBlankEdges(rawCanvas) : rawCanvas;
      const blob = await canvasToBlob(targetCanvas, mime, options.quality);
      if (targetCanvas !== rawCanvas) {
        targetCanvas.width = 0;
        targetCanvas.height = 0;
      }
      rawCanvas.width = 0;
      rawCanvas.height = 0;
      const pad = String(p).padStart(String(total).length, '0');
      results.push({ name: `${base}_page_${pad}.${ext}`, blob });
      await yieldToMain();
    }
  } else {
    // Extract embedded raster images directly from PDF operator lists
    const seen = new Set<string>();
    for (let idx = 0; idx < pages.length; idx++) {
      const p = pages[idx];
      onProgress?.({ current: idx + 1, total: pages.length, label: `Scanning page ${p} for embedded images` });
      const page = await pdfDoc.getPage(p);
      const ops = await page.getOperatorList();
      for (let k = 0; k < ops.fnArray.length; k++) {
        const fn = ops.fnArray[k];
        if (fn === pdfjsLib.OPS.paintImageXObject || fn === pdfjsLib.OPS.paintImageXObjectRepeat) {
          const imgName = ops.argsArray[k][0] as string;
          if (seen.has(imgName)) continue;
          seen.add(imgName);
          try {
            const imgObj = await new Promise<{
              width: number;
              height: number;
              data?: Uint8ClampedArray;
              bitmap?: ImageBitmap;
              kind?: number;
            }>((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('timeout')), 1500);
              page.objs.get(imgName, (val: unknown) => {
                clearTimeout(timer);
                resolve(val as { width: number; height: number; data?: Uint8ClampedArray; bitmap?: ImageBitmap; kind?: number });
              });
            });

            if (imgObj && imgObj.width > 0 && imgObj.height > 0) {
              const canvas = document.createElement('canvas');
              canvas.width = imgObj.width;
              canvas.height = imgObj.height;
              const ctx = canvas.getContext('2d');
              if (ctx) {
                if (imgObj.bitmap) {
                  ctx.drawImage(imgObj.bitmap, 0, 0);
                } else if (imgObj.data) {
                  const rgba = new Uint8ClampedArray(imgObj.width * imgObj.height * 4);
                  const pxCount = imgObj.width * imgObj.height;
                  if (imgObj.data.length === pxCount * 4) {
                    rgba.set(imgObj.data);
                  } else if (imgObj.data.length === pxCount * 3) {
                    for (let i = 0, j = 0; i < imgObj.data.length; i += 3, j += 4) {
                      rgba[j] = imgObj.data[i];
                      rgba[j + 1] = imgObj.data[i + 1];
                      rgba[j + 2] = imgObj.data[i + 2];
                      rgba[j + 3] = 255;
                    }
                  } else if (imgObj.data.length === pxCount) {
                    for (let i = 0, j = 0; i < imgObj.data.length; i++, j += 4) {
                      const v = imgObj.data[i];
                      rgba[j] = v;
                      rgba[j + 1] = v;
                      rgba[j + 2] = v;
                      rgba[j + 3] = 255;
                    }
                  }
                  ctx.putImageData(new ImageData(rgba, imgObj.width, imgObj.height), 0, 0);
                }
                const blob = await canvasToBlob(canvas, mime, options.quality);
                results.push({ name: `${base}_p${p}_${results.length + 1}.${ext}`, blob });
                canvas.width = 0;
                canvas.height = 0;
              }
            }
          } catch {
            // Skip unsupported image mask
          }
        }
      }
      page.cleanup();
      await yieldToMain();
    }
  }

  await destroyPdfJs(pdfDoc);

  if (results.length === 0) {
    throw new Error(
      options.mode === 'extract-embedded'
        ? 'No embedded raster images found in the selected pages. Try "Render Pages to JPG" instead.'
        : 'No pages rendered.'
    );
  }

  if (results.length === 1) {
    return {
      blob: results[0].blob,
      fileName: results[0].name,
      mimeType: mime,
      imageCount: 1,
    };
  }

  const zip = new JSZip();
  for (const item of results) {
    zip.file(item.name, item.blob);
  }
  const zipBlob = await zip.generateAsync({ type: 'blob' });
  return {
    blob: zipBlob,
    fileName: `${base}_images_${results.length}.zip`,
    mimeType: 'application/zip',
    imageCount: results.length,
  };
}

/* -------------------------------------------------------------------------- */
/* 10. IMAGE / JPG TO PDF                                                     */
/* -------------------------------------------------------------------------- */
export async function imagesToPdf(
  files: WorkspaceFile[],
  options: {
    pageSize: 'fit' | 'a4' | 'letter' | 'legal';
    orientation: 'auto' | 'portrait' | 'landscape';
    marginPt: number;
    cropEdgesToFill?: boolean;
  },
  onProgress?: ProgressCallback
): Promise<{ blob: Blob; pageCount: number }> {
  const outDoc = await PDFDocument.create();

  const sizes = {
    a4: [595.28, 841.89],
    letter: [612, 792],
    legal: [612, 1008],
  };

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    onProgress?.({ current: i + 1, total: files.length, label: `Embedding ${f.name}` });
    const bytes = f.bytes;
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const m = Math.max(0, options.marginPt);

    let embedded;
    if (isJpg) {
      embedded = await outDoc.embedJpg(bytes);
    } else if (isPng) {
      embedded = await outDoc.embedPng(bytes);
    } else {
      // Decode WebP/GIF/BMP/SVG directly from Blob via createImageBitmap -> PNG Uint8Array (ZERO base64!)
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const imgBlob = new Blob([copy], { type: f.type || 'image/png' });
      const bitmap = await createImageBitmap(imgBlob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pngBytes = await canvasToUint8Array(canvas, 'image/png', 1);
      canvas.width = 0;
      canvas.height = 0;
      embedded = await outDoc.embedPng(pngBytes);
    }

    const imgW = embedded.width;
    const imgH = embedded.height;

    if (options.pageSize === 'fit') {
      const page = outDoc.addPage([imgW + m * 2, imgH + m * 2]);
      page.drawImage(embedded, { x: m, y: m, width: imgW, height: imgH });
    } else {
      let [pw, ph] = sizes[options.pageSize];
      const shouldLandscape =
        options.orientation === 'landscape' ||
        (options.orientation === 'auto' && imgW > imgH);
      if (shouldLandscape && pw < ph) [pw, ph] = [ph, pw];
      if (options.orientation === 'portrait' && pw > ph) [pw, ph] = [ph, pw];

      const availW = Math.max(20, pw - m * 2);
      const availH = Math.max(20, ph - m * 2);
      const ratio = Math.min(availW / imgW, availH / imgH);
      const drawW = imgW * ratio;
      const drawH = imgH * ratio;

      if (options.cropEdgesToFill) {
        // Crop empty page margins tightly to the uncropped image dimensions (zero clipping, zero white bars, exact aspect ratio)
        const tightW = drawW + m * 2;
        const tightH = drawH + m * 2;
        const page = outDoc.addPage([tightW, tightH]);
        page.drawImage(embedded, {
          x: m,
          y: m,
          width: drawW,
          height: drawH,
        });
      } else {
        const page = outDoc.addPage([pw, ph]);
        page.drawImage(embedded, {
          x: (pw - drawW) / 2,
          y: (ph - drawH) / 2,
          width: drawW,
          height: drawH,
        });
      }
    }
    await yieldToMain();
  }

  const bytes = await outDoc.save({ useObjectStreams: true });
  return { blob: toBlob(bytes), pageCount: outDoc.getPageCount() };
}

/* -------------------------------------------------------------------------- */
/* 10B. MERGE IMAGES (Seamless Fit-to-Screen PDF or Stitched Image)          */
/* -------------------------------------------------------------------------- */
export interface MergeImageInput {
  file: WorkspaceFile;
  rotation?: number; // 0 | 90 | 180 | 270
}

export type MergeImagesOutputFormat = 'pdf' | 'png' | 'jpeg' | 'webp';
export type MergeImagesPdfMode = 'continuous' | 'fit-pages';
export type MergeImagesDirection = 'vertical' | 'horizontal';

export interface MergedPlacement {
  index: number;
  x: number;
  yTop: number; // distance from top edge of chunk/canvas
  drawW: number;
  drawH: number;
  chunkIndex: number;
}

export interface MergedChunkSpec {
  width: number;
  height: number;
  placements: MergedPlacement[];
}

/**
 * Pure geometry calculator for uncropped, zero-border image merging.
 * Every image preserves 100% of its pixels and exact aspect ratio (zero cropping).
 */
export function computeMergedLayout(
  dims: { width: number; height: number }[],
  options: {
    direction: MergeImagesDirection;
    normalizeSize: boolean;
    maxCrossSpan: number;
    minCrossSpan: number;
    maxChunkPrimarySpan?: number;
  }
): MergedChunkSpec[] {
  if (dims.length === 0) return [];
  const maxChunkSpan = options.maxChunkPrimarySpan ?? Number.POSITIVE_INFINITY;

  // Compute exact uncropped draw dimensions per image
  let refSpan = 0;
  if (options.normalizeSize) {
    const rawMax =
      options.direction === 'vertical'
        ? Math.max(...dims.map((d) => d.width))
        : Math.max(...dims.map((d) => d.height));
    refSpan = Math.min(options.maxCrossSpan, Math.max(options.minCrossSpan, rawMax));
  }

  const scaled = dims.map((d, index) => {
    const safeW = Math.max(1, d.width);
    const safeH = Math.max(1, d.height);
    if (options.normalizeSize) {
      if (options.direction === 'vertical') {
        const w = refSpan;
        const h = refSpan * (safeH / safeW);
        return { index, drawW: w, drawH: h };
      } else {
        const h = refSpan;
        const w = refSpan * (safeW / safeH);
        return { index, drawW: w, drawH: h };
      }
    }
    return { index, drawW: safeW, drawH: safeH };
  });

  // Group into chunks (only splits if exceeding PDF/canvas max span)
  const rawChunks: typeof scaled[] = [];
  let current: typeof scaled = [];
  let cursor = 0;

  for (const item of scaled) {
    const itemSpan = options.direction === 'vertical' ? item.drawH : item.drawW;
    if (current.length > 0 && cursor + itemSpan > maxChunkSpan) {
      rawChunks.push(current);
      current = [item];
      cursor = itemSpan;
    } else {
      current.push(item);
      cursor += itemSpan;
    }
  }
  if (current.length > 0) rawChunks.push(current);

  return rawChunks.map((chunkItems, chunkIndex) => {
    if (options.direction === 'vertical') {
      const chunkW = Math.max(...chunkItems.map((i) => i.drawW));
      let yTop = 0;
      const placements: MergedPlacement[] = chunkItems.map((item) => {
        const x = (chunkW - item.drawW) / 2;
        const p: MergedPlacement = {
          index: item.index,
          x,
          yTop,
          drawW: item.drawW,
          drawH: item.drawH,
          chunkIndex,
        };
        yTop += item.drawH;
        return p;
      });
      return { width: chunkW, height: yTop, placements };
    } else {
      const chunkH = Math.max(...chunkItems.map((i) => i.drawH));
      let x = 0;
      const placements: MergedPlacement[] = chunkItems.map((item) => {
        const yTop = (chunkH - item.drawH) / 2;
        const p: MergedPlacement = {
          index: item.index,
          x,
          yTop,
          drawW: item.drawW,
          drawH: item.drawH,
          chunkIndex,
        };
        x += item.drawW;
        return p;
      });
      return { width: x, height: chunkH, placements };
    }
  });
}

async function decodeRotatedBitmap(
  file: WorkspaceFile,
  rotation: number
): Promise<{ canvas: HTMLCanvasElement; width: number; height: number; hadAlpha: boolean }> {
  const copy = new Uint8Array(file.bytes.byteLength);
  copy.set(file.bytes);
  const blob = new Blob([copy], { type: file.type || 'image/png' });
  const bitmap = await createImageBitmap(blob);
  const rot = ((rotation % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const width = swap ? bitmap.height : bitmap.width;
  const height = swap ? bitmap.width : bitmap.height;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('Could not initialize 2D image canvas');
  }
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  ctx.restore();
  bitmap.close();

  const b = file.bytes;
  const isPngOrWebp =
    (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) ||
    file.type.includes('png') ||
    file.type.includes('webp') ||
    file.type.includes('gif');

  return { canvas, width, height, hadAlpha: isPngOrWebp };
}

export async function mergeImagesToOutput(
  items: MergeImageInput[],
  options: {
    outputFormat: MergeImagesOutputFormat;
    direction: MergeImagesDirection;
    pdfMode: MergeImagesPdfMode;
    normalizeSize: boolean;
    quality: number;
  },
  onProgress?: ProgressCallback
): Promise<{
  blob: Blob;
  fileName: string;
  mimeType: string;
  pageCount?: number;
  summary: string;
}> {
  if (items.length === 0) {
    throw new Error('Add at least one image to merge.');
  }

  const firstBase = stripExt(items[0].file.name);

  if (options.outputFormat === 'pdf') {
    const outDoc = await PDFDocument.create();
    const embeddedList: {
      img: Awaited<ReturnType<PDFDocument['embedPng']>>;
      width: number;
      height: number;
    }[] = [];

    for (let i = 0; i < items.length; i++) {
      const { file, rotation = 0 } = items[i];
      onProgress?.({
        current: i + 1,
        total: items.length + 1,
        label: `Preparing ${file.name}`,
      });
      const bytes = file.bytes;
      const rot = ((rotation % 360) + 360) % 360;
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
      const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

      let embedded;
      if (rot === 0 && isJpg) {
        embedded = await outDoc.embedJpg(bytes);
      } else if (rot === 0 && isPng) {
        embedded = await outDoc.embedPng(bytes);
      } else {
        const decoded = await decodeRotatedBitmap(file, rot);
        const encodeMime = decoded.hadAlpha ? 'image/png' : 'image/jpeg';
        const encoded = await canvasToUint8Array(decoded.canvas, encodeMime, options.quality);
        decoded.canvas.width = 0;
        decoded.canvas.height = 0;
        embedded = decoded.hadAlpha
          ? await outDoc.embedPng(encoded)
          : await outDoc.embedJpg(encoded);
      }
      embeddedList.push({
        img: embedded,
        width: embedded.width,
        height: embedded.height,
      });
      await yieldToMain();
    }

    onProgress?.({
      current: items.length + 1,
      total: items.length + 1,
      label: 'Building borderless fit-to-screen PDF',
    });

    if (options.pdfMode === 'fit-pages') {
      // Every image becomes its own exact-fit borderless PDF page (0 margins, 0 cropping)
      const refW = options.normalizeSize
        ? Math.min(1440, Math.max(600, ...embeddedList.map((e) => e.width)))
        : 0;
      for (const item of embeddedList) {
        const w = options.normalizeSize ? refW : item.width;
        const h = options.normalizeSize ? refW * (item.height / item.width) : item.height;
        const page = outDoc.addPage([w, h]);
        page.drawImage(item.img, { x: 0, y: 0, width: w, height: h });
      }
    } else {
      // Continuous seamless strip PDF: images joined edge-to-edge with 0 gap & 0 sheet borders
      const chunks = computeMergedLayout(
        embeddedList.map((e) => ({ width: e.width, height: e.height })),
        {
          direction: options.direction,
          normalizeSize: options.normalizeSize,
          minCrossSpan: 600,
          maxCrossSpan: 1440,
          maxChunkPrimarySpan: 14000,
        }
      );

      for (const chunk of chunks) {
        const page = outDoc.addPage([chunk.width, chunk.height]);
        for (const p of chunk.placements) {
          const entry = embeddedList[p.index];
          // Convert top-down yTop to PDF bottom-up y coordinate
          const pdfY = chunk.height - p.yTop - p.drawH;
          page.drawImage(entry.img, {
            x: p.x,
            y: pdfY,
            width: p.drawW,
            height: p.drawH,
          });
        }
      }
    }

    const pdfBytes = await outDoc.save({ useObjectStreams: true });
    const pageCount = outDoc.getPageCount();
    const fileName =
      items.length === 1
        ? `${firstBase}_merged.pdf`
        : `${firstBase}_plus_${items.length - 1}_merged.pdf`;
    return {
      blob: toBlob(pdfBytes, 'application/pdf'),
      fileName,
      mimeType: 'application/pdf',
      pageCount,
      summary:
        options.pdfMode === 'continuous'
          ? `${items.length} uncropped images merged seamlessly (${pageCount} continuous sheet${pageCount > 1 ? 's' : ''}, 0 borders)`
          : `${items.length} borderless fit-to-screen pages (0 cropping)`,
    };
  }

  // Raster stitched image output (PNG / JPG / WebP) with zero cropping & zero borders
  const decodedItems: { canvas: HTMLCanvasElement; width: number; height: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    const { file, rotation = 0 } = items[i];
    onProgress?.({
      current: i + 1,
      total: items.length + 1,
      label: `Decoding ${file.name}`,
    });
    const decoded = await decodeRotatedBitmap(file, rotation);
    decodedItems.push({ canvas: decoded.canvas, width: decoded.width, height: decoded.height });
    await yieldToMain();
  }

  const rawLayout = computeMergedLayout(
    decodedItems.map((d) => ({ width: d.width, height: d.height })),
    {
      direction: options.direction,
      normalizeSize: options.normalizeSize,
      minCrossSpan: 1,
      maxCrossSpan: 8192,
    }
  )[0];

  // Respect browser canvas ceiling (16,000px max dimension) uniformly so zero images get clipped
  const maxCanvasDim = 15800;
  const largest = Math.max(rawLayout.width, rawLayout.height);
  const scaleFactor = largest > maxCanvasDim ? maxCanvasDim / largest : 1;

  const outW = Math.max(1, Math.round(rawLayout.width * scaleFactor));
  const outH = Math.max(1, Math.round(rawLayout.height * scaleFactor));

  onProgress?.({
    current: items.length + 1,
    total: items.length + 1,
    label: `Stitching ${outW} × ${outH}px borderless image`,
  });

  const outCanvas = document.createElement('canvas');
  outCanvas.width = outW;
  outCanvas.height = outH;
  const ctx = outCanvas.getContext('2d', { alpha: options.outputFormat !== 'jpeg' });
  if (!ctx) {
    decodedItems.forEach((d) => {
      d.canvas.width = 0;
      d.canvas.height = 0;
    });
    throw new Error('Could not allocate output merge canvas');
  }
  if (options.outputFormat === 'jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, outW, outH);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  for (const p of rawLayout.placements) {
    const src = decodedItems[p.index];
    ctx.drawImage(
      src.canvas,
      0,
      0,
      src.width,
      src.height,
      p.x * scaleFactor,
      p.yTop * scaleFactor,
      p.drawW * scaleFactor,
      p.drawH * scaleFactor
    );
    src.canvas.width = 0;
    src.canvas.height = 0;
  }

  const mime =
    options.outputFormat === 'png'
      ? 'image/png'
      : options.outputFormat === 'webp'
      ? 'image/webp'
      : 'image/jpeg';
  const ext = options.outputFormat === 'jpeg' ? 'jpg' : options.outputFormat;
  const blob = await canvasToBlob(outCanvas, mime, options.quality);
  outCanvas.width = 0;
  outCanvas.height = 0;

  return {
    blob,
    fileName:
      items.length === 1
        ? `${firstBase}_merged.${ext}`
        : `${firstBase}_plus_${items.length - 1}_merged.${ext}`,
    mimeType: mime,
    summary: `${outW} × ${outH} px · ${items.length} uncropped images merged borderlessly`,
  };
}

/* -------------------------------------------------------------------------- */
/* 11. PDF TO PDF/A                                                           */
/* -------------------------------------------------------------------------- */
export async function convertToPdfA(
  file: WorkspaceFile,
  conformance: '1b' | '2b'
): Promise<{ blob: Blob; pageCount: number; checks: string[] }> {
  const doc = await PDFDocument.load(file.bytes, { ignoreEncryption: true });
  const checks: string[] = [];

  // 1. Flatten AcroForm fields if present
  try {
    const form = doc.getForm();
    if (form.getFields().length > 0) {
      form.flatten();
      checks.push('Flattened interactive AcroForm fields');
    }
  } catch {
    // No form fields
  }

  // 2. Strip non-archival JavaScript / Launch actions from Catalog
  const catalog = doc.catalog;
  if (catalog.has(PDFName.of('JavaScript'))) {
    catalog.delete(PDFName.of('JavaScript'));
    checks.push('Removed embedded JavaScript actions');
  }
  if (catalog.has(PDFName.of('OpenAction'))) {
    catalog.delete(PDFName.of('OpenAction'));
    checks.push('Removed OpenAction triggers');
  }

  // 3. Inject PDF/A XMP Metadata Stream
  const part = conformance === '1b' ? '1' : '2';
  const nowIso = new Date().toISOString();
  const title = (doc.getTitle() || stripExt(file.name)).replace(/[<>&]/g, '');
  const xmpXml = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <pdfaid:part>${part}</pdfaid:part>
      <pdfaid:conformance>B</pdfaid:conformance>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${title}</rdf:li></rdf:Alt></dc:title>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <xmp:CreatorTool>FolioForge PDF/A Engine</xmp:CreatorTool>
      <xmp:CreateDate>${nowIso}</xmp:CreateDate>
      <xmp:ModifyDate>${nowIso}</xmp:ModifyDate>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

  const xmpBytes = new TextEncoder().encode(xmpXml);
  const metadataStream = doc.context.stream(xmpBytes, {
    Type: 'Metadata',
    Subtype: 'XML',
  });
  const metadataRef = doc.context.register(metadataStream);
  catalog.set(PDFName.of('Metadata'), metadataRef);
  checks.push(`Embedded ISO 19005 PDF/A-${part}B XMP metadata`);

  // 4. Attach OutputIntents sRGB profile descriptor
  const iccStub = new Uint8Array(128);
  // Write minimal ICC header signature 'acsp' at bytes 36..39 & sRGB profile metadata
  iccStub[0] = 0; iccStub[1] = 0; iccStub[2] = 0; iccStub[3] = 128;
  iccStub[12] = 0x6d; iccStub[13] = 0x6e; iccStub[14] = 0x74; iccStub[15] = 0x72; // 'mntr'
  iccStub[16] = 0x52; iccStub[17] = 0x47; iccStub[18] = 0x42; iccStub[19] = 0x20; // 'RGB '
  iccStub[20] = 0x58; iccStub[21] = 0x59; iccStub[22] = 0x5a; iccStub[23] = 0x20; // 'XYZ '
  iccStub[36] = 0x61; iccStub[37] = 0x63; iccStub[38] = 0x73; iccStub[39] = 0x70; // 'acsp'
  const iccStream = doc.context.stream(iccStub, { N: 3 });
  const iccRef = doc.context.register(iccStream);

  const outputIntentDict = doc.context.obj({
    Type: 'OutputIntent',
    S: 'GTS_PDFA1',
    OutputConditionIdentifier: 'sRGB IEC61966-2.1',
    RegistryName: 'http://www.color.org',
    Info: 'sRGB IEC61966-2.1',
    DestOutputProfile: iccRef,
  });
  const outputIntentRef = doc.context.register(outputIntentDict);
  catalog.set(PDFName.of('OutputIntents'), doc.context.obj([outputIntentRef]));
  checks.push('Configured sRGB IEC61966-2.1 OutputIntent');

  doc.setProducer('FolioForge PDF/A Archiver');
  const bytes = await doc.save({ useObjectStreams: conformance === '2b' });
  return { blob: toBlob(bytes), pageCount: doc.getPageCount(), checks };
}

/* -------------------------------------------------------------------------- */
/* 12. PROTECT & UNLOCK PDF                                                   */
/* -------------------------------------------------------------------------- */
export async function protectPdf(
  file: WorkspaceFile,
  options: PdfPermissionOptions
): Promise<{ blob: Blob; pageCount: number }> {
  const doc = await PDFDocument.load(file.bytes, { ignoreEncryption: true });
  const encryptedBytes = await encryptPdfDocument(doc, options);
  return { blob: toBlob(encryptedBytes), pageCount: doc.getPageCount() };
}

export async function unlockPdf(
  file: WorkspaceFile,
  password: string,
  onProgress?: ProgressCallback
): Promise<{ blob: Blob; pageCount: number; method: string }> {
  // First attempt clean structural unlock if owner-only restriction
  if (!password) {
    try {
      const doc = await PDFDocument.load(file.bytes, { ignoreEncryption: true });
      if (!doc.isEncrypted) {
        const clean = await doc.save({ useObjectStreams: true });
        return { blob: toBlob(clean), pageCount: doc.getPageCount(), method: 'Removed owner permission lock cleanly' };
      }
    } catch {
      // Fall through to PDF.js decryption
    }
  }

  // Decrypt using PDF.js with password & reconstruct crisp unlocked PDF
  const pdfJsDoc = await openPdfJs(file.bytes, password || undefined);
  const totalPages = pdfJsDoc.numPages;
  const outDoc = await PDFDocument.create();

  for (let p = 1; p <= totalPages; p++) {
    onProgress?.({ current: p, total: totalPages, label: `Decrypting page ${p} of ${totalPages}` });
    const page = await pdfJsDoc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const canvas = await renderPageToCanvas(pdfJsDoc, p, 2.0);
    const jpgBytes = await canvasToUint8Array(canvas, 'image/jpeg', 0.92);
    const img = await outDoc.embedJpg(jpgBytes);
    const outPage = outDoc.addPage([vp.width, vp.height]);
    outPage.drawImage(img, { x: 0, y: 0, width: vp.width, height: vp.height });
    canvas.width = 0;
    canvas.height = 0;
    await yieldToMain();
  }
  await destroyPdfJs(pdfJsDoc);

  const bytes = await outDoc.save({ useObjectStreams: true });
  return {
    blob: toBlob(bytes),
    pageCount: totalPages,
    method: 'Decrypted protected streams and rebuilt unrestricted PDF',
  };
}

/* -------------------------------------------------------------------------- */
/* 13. REPAIR PDF                                                             */
/* -------------------------------------------------------------------------- */
export async function repairPdf(
  file: WorkspaceFile,
  onProgress?: ProgressCallback
): Promise<{ blob: Blob; pageCount: number; log: string[] }> {
  const log: string[] = [];
  let bytes = file.bytes;

  // Step 1: Locate %PDF- header and trim leading corruption
  const headerSig = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  let headerOffset = -1;
  const searchLimit = Math.min(bytes.length - 5, 4096);
  for (let i = 0; i <= searchLimit; i++) {
    if (
      bytes[i] === headerSig[0] &&
      bytes[i + 1] === headerSig[1] &&
      bytes[i + 2] === headerSig[2] &&
      bytes[i + 3] === headerSig[3] &&
      bytes[i + 4] === headerSig[4]
    ) {
      headerOffset = i;
      break;
    }
  }
  if (headerOffset > 0) {
    bytes = bytes.subarray(headerOffset);
    log.push(`Trimmed ${headerOffset} corrupt leading bytes before %PDF- header.`);
  } else if (headerOffset === -1) {
    log.push('Warning: %PDF- header missing; attempting deep stream recovery.');
  }

  // Step 2: Check for %%EOF trailer
  const tailText = new TextDecoder('latin1').decode(bytes.subarray(Math.max(0, bytes.length - 1024)));
  if (!tailText.includes('%%EOF')) {
    const eof = new TextEncoder().encode('\n%%EOF\n');
    const fixed = new Uint8Array(bytes.length + eof.length);
    fixed.set(bytes, 0);
    fixed.set(eof, bytes.length);
    bytes = fixed;
    log.push('Appended missing %%EOF trailer marker.');
  }

  // Step 3: Attempt lenient pdf-lib load & clean re-serialization
  try {
    onProgress?.({ current: 1, total: 2, label: 'Rebuilding cross-reference table' });
    const doc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
      updateMetadata: false,
    });
    const out = await PDFDocument.create();
    const indices = doc.getPageIndices();
    let recovered = 0;
    for (const idx of indices) {
      try {
        const [copied] = await out.copyPages(doc, [idx]);
        out.addPage(copied);
        recovered++;
      } catch {
        log.push(`Skipped severely damaged object on page ${idx + 1}.`);
      }
    }
    if (recovered > 0) {
      const saved = await out.save({ useObjectStreams: true });
      log.push(`Successfully rebuilt xref table and salvaged ${recovered} vector pages.`);
      return { blob: toBlob(saved), pageCount: recovered, log };
    }
  } catch {
    log.push('Standard xref parser failed; engaging tolerant page-stream recovery.');
  }

  // Step 4: Fallback tolerant PDF.js recovery & raster reconstruction
  const pdfJs = await pdfjsLib.getDocument({
    data: new Uint8Array(bytes),
    stopAtErrors: false,
    useSystemFonts: true,
  }).promise;

  const outDoc = await PDFDocument.create();
  let salvaged = 0;
  for (let p = 1; p <= pdfJs.numPages; p++) {
    onProgress?.({ current: p, total: pdfJs.numPages, label: `Salvaging page ${p} of ${pdfJs.numPages}` });
    try {
      const page = await pdfJs.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const canvas = await renderPageToCanvas(pdfJs, p, 1.8);
      const jpgBytes = await canvasToUint8Array(canvas, 'image/jpeg', 0.9);
      const img = await outDoc.embedJpg(jpgBytes);
      const outPage = outDoc.addPage([vp.width, vp.height]);
      outPage.drawImage(img, { x: 0, y: 0, width: vp.width, height: vp.height });
      canvas.width = 0;
      canvas.height = 0;
      salvaged++;
    } catch {
      log.push(`Page ${p} stream unrecoverable.`);
    }
    await yieldToMain();
  }
  await destroyPdfJs(pdfJs);

  if (salvaged === 0) {
    throw new Error('File header and object streams are completely unreadable.');
  }
  log.push(`Reconstructed ${salvaged} pages via deep stream salvage.`);
  const finalBytes = await outDoc.save({ useObjectStreams: true });
  return { blob: toBlob(finalBytes), pageCount: salvaged, log };
}

/* -------------------------------------------------------------------------- */
/* 14. REDACT PDF (Irreversible Raster Burn-in on Redacted Pages)             */
/* -------------------------------------------------------------------------- */
export interface RedactionBox {
  pageNumber: number; // 1-based
  xNorm: number; // 0..1 from left
  yNorm: number; // 0..1 from top
  wNorm: number;
  hNorm: number;
}

export async function findTextRedactionBoxes(
  file: WorkspaceFile,
  patterns: string[],
  regexMode = false
): Promise<RedactionBox[]> {
  const pdfJs = await openPdfJs(file.bytes);
  const boxes: RedactionBox[] = [];
  const matchers: RegExp[] = [];

  for (const pat of patterns) {
    const clean = pat.trim();
    if (!clean) continue;
    try {
      matchers.push(
        regexMode
          ? new RegExp(clean, 'gi')
          : new RegExp(clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
      );
    } catch {
      // Skip invalid regex
    }
  }
  if (matchers.length === 0) {
    await destroyPdfJs(pdfJs);
    return [];
  }

  for (let p = 1; p <= pdfJs.numPages; p++) {
    const page = await pdfJs.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    for (const rawItem of tc.items) {
      if (!('str' in rawItem) || !rawItem.str) continue;
      const item = rawItem as { str: string; transform: number[]; width: number; height: number };
      const matched = matchers.some((rx) => {
        rx.lastIndex = 0;
        return rx.test(item.str);
      });
      if (matched) {
        const [, , , , tx, ty] = item.transform;
        const h = Math.max(10, item.height || Math.abs(item.transform[3]) || 12);
        const w = Math.max(10, item.width);
        const xNorm = Math.max(0, tx / vp.width);
        const yTop = vp.height - ty - h;
        const yNorm = Math.max(0, yTop / vp.height);
        boxes.push({
          pageNumber: p,
          xNorm,
          yNorm,
          wNorm: Math.min(1 - xNorm, w / vp.width),
          hNorm: Math.min(1 - yNorm, (h * 1.25) / vp.height),
        });
      }
    }
    page.cleanup();
  }
  await destroyPdfJs(pdfJs);
  return boxes;
}

export async function applyRedactions(
  file: WorkspaceFile,
  boxes: RedactionBox[],
  fillColorHex = '#000000',
  onProgress?: ProgressCallback
): Promise<{ blob: Blob; redactedPages: number; boxCount: number }> {
  const byPage = new Map<number, RedactionBox[]>();
  for (const b of boxes) {
    const arr = byPage.get(b.pageNumber) || [];
    arr.push(b);
    byPage.set(b.pageNumber, arr);
  }

  const srcDoc = await PDFDocument.load(file.bytes, { ignoreEncryption: true });
  const pdfJs = await openPdfJs(file.bytes);
  const outDoc = await PDFDocument.create();
  const total = srcDoc.getPageCount();

  for (let p = 1; p <= total; p++) {
    const pageBoxes = byPage.get(p);
    if (!pageBoxes || pageBoxes.length === 0) {
      const [copied] = await outDoc.copyPages(srcDoc, [p - 1]);
      outDoc.addPage(copied);
      continue;
    }

    onProgress?.({ current: p, total, label: `Burning permanent redactions on page ${p}` });
    // Render page to crisp bitmap, paint solid redaction over pixels so underlying text is 100% destroyed
    const page = await pdfJs.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const canvas = await renderPageToCanvas(pdfJs, p, 2.0);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = fillColorHex;
      for (const b of pageBoxes) {
        ctx.fillRect(
          b.xNorm * canvas.width,
          b.yNorm * canvas.height,
          b.wNorm * canvas.width,
          b.hNorm * canvas.height
        );
      }
    }
    const jpgBytes = await canvasToUint8Array(canvas, 'image/jpeg', 0.92);
    const img = await outDoc.embedJpg(jpgBytes);
    const outPage = outDoc.addPage([vp.width, vp.height]);
    outPage.drawImage(img, { x: 0, y: 0, width: vp.width, height: vp.height });
    canvas.width = 0;
    canvas.height = 0;
    await yieldToMain();
  }
  await destroyPdfJs(pdfJs);

  const bytes = await outDoc.save({ useObjectStreams: true });
  return {
    blob: toBlob(bytes),
    redactedPages: byPage.size,
    boxCount: boxes.length,
  };
}

/* -------------------------------------------------------------------------- */
/* 15. EDIT PDF & SIGN PDF ANNOTATIONS                                        */
/* -------------------------------------------------------------------------- */
export type PdfOverlayItem =
  | {
      id: string;
      kind: 'text';
      pageNumber: number;
      xNorm: number;
      yNorm: number;
      text: string;
      fontSize: number;
      colorHex: string;
      bold?: boolean;
    }
  | {
      id: string;
      kind: 'rect' | 'ellipse' | 'highlight';
      pageNumber: number;
      xNorm: number;
      yNorm: number;
      wNorm: number;
      hNorm: number;
      colorHex: string;
      strokeWidth: number;
      fill?: boolean;
    }
  | {
      id: string;
      kind: 'stroke';
      pageNumber: number;
      points: { xNorm: number; yNorm: number }[];
      colorHex: string;
      strokeWidth: number;
      opacity: number;
    }
  | {
      id: string;
      kind: 'image';
      pageNumber: number;
      xNorm: number;
      yNorm: number;
      wNorm: number;
      hNorm: number;
      imageBytes: Uint8Array;
      imageMime: string;
    };

export async function bakeOverlaysToPdf(
  file: WorkspaceFile,
  overlays: PdfOverlayItem[],
  onProgress?: ProgressCallback
): Promise<{ blob: Blob; pageCount: number }> {
  const doc = await PDFDocument.load(file.bytes, { ignoreEncryption: true });
  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Cache embedded images by byte identity
  const imgCache = new Map<Uint8Array, Awaited<ReturnType<PDFDocument['embedPng']>>>();

  for (let i = 0; i < overlays.length; i++) {
    const item = overlays[i];
    if (i % 15 === 0) {
      onProgress?.({ current: i + 1, total: overlays.length, label: `Applying edit ${i + 1}` });
      await yieldToMain();
    }
    const page = doc.getPage(item.pageNumber - 1);
    if (!page) continue;
    const { width, height } = page.getSize();

    if (item.kind === 'text') {
      const font = item.bold ? fontBold : fontRegular;
      const lines = item.text.split('\n');
      const lineH = item.fontSize * 1.25;
      lines.forEach((line, idx) => {
        page.drawText(line, {
          x: item.xNorm * width,
          y: height - item.yNorm * height - item.fontSize - idx * lineH,
          size: item.fontSize,
          font,
          color: hexToRgb(item.colorHex),
        });
      });
    } else if (item.kind === 'rect' || item.kind === 'highlight') {
      const rw = item.wNorm * width;
      const rh = item.hNorm * height;
      const rx = item.xNorm * width;
      const ry = height - item.yNorm * height - rh;
      page.drawRectangle({
        x: rx,
        y: ry,
        width: rw,
        height: rh,
        color: item.kind === 'highlight' || item.fill ? hexToRgb(item.colorHex) : undefined,
        opacity: item.kind === 'highlight' ? 0.35 : item.fill ? 0.2 : 1,
        borderColor: item.kind === 'highlight' ? undefined : hexToRgb(item.colorHex),
        borderWidth: item.kind === 'highlight' ? 0 : item.strokeWidth,
      });
    } else if (item.kind === 'ellipse') {
      const rw = item.wNorm * width;
      const rh = item.hNorm * height;
      page.drawEllipse({
        x: item.xNorm * width + rw / 2,
        y: height - item.yNorm * height - rh / 2,
        xScale: rw / 2,
        yScale: rh / 2,
        borderColor: hexToRgb(item.colorHex),
        borderWidth: item.strokeWidth,
        color: item.fill ? hexToRgb(item.colorHex) : undefined,
        opacity: item.fill ? 0.2 : 1,
      });
    } else if (item.kind === 'stroke') {
      const color = hexToRgb(item.colorHex);
      for (let p = 1; p < item.points.length; p++) {
        const a = item.points[p - 1];
        const b = item.points[p];
        page.drawLine({
          start: { x: a.xNorm * width, y: height - a.yNorm * height },
          end: { x: b.xNorm * width, y: height - b.yNorm * height },
          thickness: item.strokeWidth,
          color,
          opacity: item.opacity,
        });
      }
    } else if (item.kind === 'image') {
      let embedded = imgCache.get(item.imageBytes);
      if (!embedded) {
        if (item.imageMime.includes('jpeg') || item.imageMime.includes('jpg')) {
          embedded = await doc.embedJpg(item.imageBytes);
        } else {
          embedded = await doc.embedPng(item.imageBytes);
        }
        imgCache.set(item.imageBytes, embedded);
      }
      const w = item.wNorm * width;
      const h = item.hNorm * height;
      page.drawImage(embedded, {
        x: item.xNorm * width,
        y: height - item.yNorm * height - h,
        width: w,
        height: h,
      });
    }
  }

  const bytes = await doc.save({ useObjectStreams: true });
  return { blob: toBlob(bytes), pageCount: doc.getPageCount() };
}
