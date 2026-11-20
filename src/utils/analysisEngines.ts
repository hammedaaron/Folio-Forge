import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  rgb,
  StandardFonts,
} from 'pdf-lib';
import { createWorker } from 'tesseract.js';
import {
  canvasToBlob,
  destroyPdfJs,
  openPdfJs,
  parsePageRangeExpression,
  renderPageToCanvas,
  yieldToMain,
} from './pdfRuntime';
import { ProgressCallback } from './pdfEngines';
import { WorkspaceFile } from '../types/tools';

function toPdfBlob(bytes: Uint8Array): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy], { type: 'application/pdf' });
}

const sanitizeWinAnsi = (str: string) =>
  str.replace(/[^\x20-\x7E\xA0-\xFF]/g, ' ');

/* -------------------------------------------------------------------------- */
/* 1. OFFLINE OCR PDF (Tesseract.js + Invisible Searchable Layer)              */
/* -------------------------------------------------------------------------- */
export async function ocrPdfOffline(
  file: WorkspaceFile,
  options: {
    language: string;
    pageRange?: string;
    dpiScale?: number;
  },
  onProgress?: ProgressCallback
): Promise<{
  pdfBlob: Blob;
  extractedText: string;
  pageCount: number;
  wordCount: number;
}> {
  const pdfJs = await openPdfJs(file.bytes);
  const total = pdfJs.numPages;
  const targets = new Set(parsePageRangeExpression(options.pageRange || 'all', total));
  const scale = options.dpiScale || 2.0;

  onProgress?.({ current: 0, total: targets.size, label: 'Initializing offline Tesseract WASM engine' });
  const worker = await createWorker(options.language || 'eng', 1, {
    workerPath: '/tesseract/worker.min.js',
    corePath: '/tesseract/tesseract-core-simd-lstm.wasm.js',
  });

  const srcDoc = await PDFDocument.load(file.bytes, { ignoreEncryption: true });
  const outDoc = await PDFDocument.create();
  const font = await outDoc.embedFont(StandardFonts.Helvetica);

  const textParts: string[] = [];
  let totalWords = 0;
  let processed = 0;

  for (let p = 1; p <= total; p++) {
    if (!targets.has(p)) {
      const [copied] = await outDoc.copyPages(srcDoc, [p - 1]);
      outDoc.addPage(copied);
      continue;
    }

    processed++;
    onProgress?.({
      current: processed,
      total: targets.size,
      label: `Running OCR on page ${p} (${processed}/${targets.size})`,
    });

    const page = await pdfJs.getPage(p);
    const baseVp = page.getViewport({ scale: 1 });
    const canvas = await renderPageToCanvas(pdfJs, p, scale);
    const imgBlob = await canvasToBlob(canvas, 'image/jpeg', 0.9);
    const jpgBytes = new Uint8Array(await imgBlob.arrayBuffer());
    const embeddedImg = await outDoc.embedJpg(jpgBytes);

    const outPage = outDoc.addPage([baseVp.width, baseVp.height]);
    outPage.drawImage(embeddedImg, {
      x: 0,
      y: 0,
      width: baseVp.width,
      height: baseVp.height,
    });

    const result = await worker.recognize(imgBlob, {}, { blocks: true });
    const pageText = (result.data.text || '').trim();
    textParts.push(`--- Page ${p} ---\n${pageText}`);

    // Overlay invisible searchable words at exact normalized bounding boxes
    const words =
      result.data.blocks?.flatMap((b) =>
        b.paragraphs.flatMap((para) => para.lines.flatMap((line) => line.words))
      ) || [];

    for (const w of words) {
      const clean = sanitizeWinAnsi(w.text).trim();
      if (!clean) continue;
      totalWords++;
      const x = (w.bbox.x0 / canvas.width) * baseVp.width;
      const boxH = Math.max(6, ((w.bbox.y1 - w.bbox.y0) / canvas.height) * baseVp.height);
      const y = baseVp.height - (w.bbox.y1 / canvas.height) * baseVp.height;
      outPage.drawText(clean, {
        x,
        y,
        size: Math.min(48, Math.max(5, boxH * 0.85)),
        font,
        color: rgb(0, 0, 0),
        opacity: 0, // Invisible selectable text layer
      });
    }

    canvas.width = 0;
    canvas.height = 0;
    page.cleanup();
    await yieldToMain();
  }

  await worker.terminate();
  await destroyPdfJs(pdfJs);

  const bytes = await outDoc.save({ useObjectStreams: true });
  return {
    pdfBlob: toPdfBlob(bytes),
    extractedText: textParts.join('\n\n'),
    pageCount: total,
    wordCount: totalWords,
  };
}

/* -------------------------------------------------------------------------- */
/* 2. COMPARE PDF (Pixel Heatmap + Word-level Text Diff)                      */
/* -------------------------------------------------------------------------- */
export interface WordDiffToken {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

export interface PageCompareResult {
  pageNumber: number;
  leftBlobUrl: string;
  rightBlobUrl: string;
  diffBlobUrl: string;
  pixelDiffPercent: number;
  wordDiffs: WordDiffToken[];
  addedCount: number;
  removedCount: number;
}

function computeWordDiff(aWords: string[], bWords: string[]): WordDiffToken[] {
  // Fast Hirschberg-style window / bounded LCS for crisp diffing on any page length
  const n = aWords.length;
  const m = bWords.length;
  if (n > 1200 || m > 1200) {
    // Fallback linear set diff for massive pages
    const bSet = new Set(bWords);
    const aSet = new Set(aWords);
    const out: WordDiffToken[] = [];
    for (const w of aWords) out.push({ kind: bSet.has(w) ? 'same' : 'removed', text: w });
    for (const w of bWords) if (!aSet.has(w)) out.push({ kind: 'added', text: w });
    return out;
  }

  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (aWords[i] === bWords[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const tokens: WordDiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aWords[i] === bWords[j]) {
      tokens.push({ kind: 'same', text: aWords[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      tokens.push({ kind: 'removed', text: aWords[i] });
      i++;
    } else {
      tokens.push({ kind: 'added', text: bWords[j] });
      j++;
    }
  }
  while (i < n) tokens.push({ kind: 'removed', text: aWords[i++] });
  while (j < m) tokens.push({ kind: 'added', text: bWords[j++] });
  return tokens;
}

export async function comparePdfPage(
  fileA: WorkspaceFile,
  fileB: WorkspaceFile,
  pageNumber: number
): Promise<PageCompareResult> {
  const [docA, docB] = await Promise.all([openPdfJs(fileA.bytes), openPdfJs(fileB.bytes)]);

  const renderOrBlank = async (doc: typeof docA, p: number) => {
    if (p > doc.numPages) {
      const blank = document.createElement('canvas');
      blank.width = 595;
      blank.height = 842;
      const ctx = blank.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, blank.width, blank.height);
      return { canvas: blank, words: [] as string[] };
    }
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const words = tc.items
      .map((it) => ('str' in it ? it.str.trim() : ''))
      .join(' ')
      .split(/\s+/)
      .filter(Boolean);
    const canvas = await renderPageToCanvas(doc, p, 1.35);
    page.cleanup();
    return { canvas, words };
  };

  const [resA, resB] = await Promise.all([
    renderOrBlank(docA, pageNumber),
    renderOrBlank(docB, pageNumber),
  ]);
  await Promise.all([destroyPdfJs(docA), destroyPdfJs(docB)]);

  const w = Math.max(resA.canvas.width, resB.canvas.width);
  const h = Math.max(resA.canvas.height, resB.canvas.height);

  const normCanvas = (src: HTMLCanvasElement) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0);
    return ctx.getImageData(0, 0, w, h);
  };

  const imgA = normCanvas(resA.canvas);
  const imgB = normCanvas(resB.canvas);
  const diffCanvas = document.createElement('canvas');
  diffCanvas.width = w;
  diffCanvas.height = h;
  const diffCtx = diffCanvas.getContext('2d')!;
  const diffData = diffCtx.createImageData(w, h);

  let diffPixels = 0;
  const totalPixels = w * h;
  for (let idx = 0; idx < imgA.data.length; idx += 4) {
    const dr = Math.abs(imgA.data[idx] - imgB.data[idx]);
    const dg = Math.abs(imgA.data[idx + 1] - imgB.data[idx + 1]);
    const db = Math.abs(imgA.data[idx + 2] - imgB.data[idx + 2]);
    if (dr + dg + db > 45) {
      diffPixels++;
      // Highlight differences strongly in crimson
      diffData.data[idx] = 220;
      diffData.data[idx + 1] = 38;
      diffData.data[idx + 2] = 38;
      diffData.data[idx + 3] = 255;
    } else {
      // Muted background ghost of B
      diffData.data[idx] = Math.round(255 - (255 - imgB.data[idx]) * 0.25);
      diffData.data[idx + 1] = Math.round(255 - (255 - imgB.data[idx + 1]) * 0.25);
      diffData.data[idx + 2] = Math.round(255 - (255 - imgB.data[idx + 2]) * 0.25);
      diffData.data[idx + 3] = 255;
    }
  }
  diffCtx.putImageData(diffData, 0, 0);

  const [leftBlob, rightBlob, diffBlob] = await Promise.all([
    canvasToBlob(resA.canvas, 'image/png'),
    canvasToBlob(resB.canvas, 'image/png'),
    canvasToBlob(diffCanvas, 'image/png'),
  ]);

  resA.canvas.width = 0;
  resB.canvas.width = 0;
  diffCanvas.width = 0;

  const wordDiffs = computeWordDiff(resA.words, resB.words);
  return {
    pageNumber,
    leftBlobUrl: URL.createObjectURL(leftBlob),
    rightBlobUrl: URL.createObjectURL(rightBlob),
    diffBlobUrl: URL.createObjectURL(diffBlob),
    pixelDiffPercent: Number(((diffPixels / Math.max(1, totalPixels)) * 100).toFixed(2)),
    wordDiffs,
    addedCount: wordDiffs.filter((t) => t.kind === 'added').length,
    removedCount: wordDiffs.filter((t) => t.kind === 'removed').length,
  };
}

/* -------------------------------------------------------------------------- */
/* 3. PDF FORMS (Auto-detect, Fill, and Create AcroForm Fields)               */
/* -------------------------------------------------------------------------- */
export interface DetectedFormField {
  name: string;
  kind: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'list';
  value: string | boolean;
  options?: string[];
  pageNumber?: number;
  xNorm?: number;
  yNorm?: number;
  wNorm?: number;
  hNorm?: number;
}

export interface NewFormFieldSpec {
  id: string;
  name: string;
  kind: 'text' | 'checkbox' | 'radio' | 'dropdown';
  pageNumber: number;
  xNorm: number;
  yNorm: number;
  wNorm: number;
  hNorm: number;
  defaultValue?: string;
  checked?: boolean;
  options?: string[];
  fontSize?: number;
}

export async function detectAcroFormFields(file: WorkspaceFile): Promise<DetectedFormField[]> {
  const doc = await PDFDocument.load(file.bytes, { ignoreEncryption: true });
  const form = doc.getForm();
  const fields = form.getFields();
  const pages = doc.getPages();

  // Build widget ref -> page location lookup
  const widgetMap = new Map<string, { pageNumber: number; xNorm: number; yNorm: number; wNorm: number; hNorm: number }>();
  pages.forEach((page, pIdx) => {
    const { width, height } = page.getSize();
    const annots = page.node.Annots();
    if (!annots) return;
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      const tag = ref.toString();
      widgetMap.set(tag, { pageNumber: pIdx + 1, xNorm: 0.1, yNorm: 0.1, wNorm: 0.25, hNorm: 0.04 });
    }
    void width;
    void height;
  });

  const out: DetectedFormField[] = [];
  for (const field of fields) {
    const name = field.getName();
    const widgets = field.acroField.getWidgets();
    let pageNumber = 1;
    let xNorm: number | undefined;
    let yNorm: number | undefined;
    let wNorm: number | undefined;
    let hNorm: number | undefined;

    if (widgets.length > 0) {
      const rect = widgets[0].getRectangle();
      const pageRef = widgets[0].P();
      const matchedPageIdx = pageRef
        ? pages.findIndex((p) => p.ref === pageRef)
        : 0;
      const pIdx = matchedPageIdx >= 0 ? matchedPageIdx : 0;
      pageNumber = pIdx + 1;
      const { width, height } = pages[pIdx].getSize();
      xNorm = rect.x / width;
      wNorm = rect.width / width;
      hNorm = rect.height / height;
      yNorm = 1 - (rect.y + rect.height) / height;
    }

    if (field instanceof PDFTextField) {
      out.push({
        name,
        kind: 'text',
        value: field.getText() || '',
        pageNumber,
        xNorm,
        yNorm,
        wNorm,
        hNorm,
      });
    } else if (field instanceof PDFCheckBox) {
      out.push({
        name,
        kind: 'checkbox',
        value: field.isChecked(),
        pageNumber,
        xNorm,
        yNorm,
        wNorm,
        hNorm,
      });
    } else if (field instanceof PDFRadioGroup) {
      out.push({
        name,
        kind: 'radio',
        value: field.getSelected() || '',
        options: field.getOptions(),
        pageNumber,
        xNorm,
        yNorm,
        wNorm,
        hNorm,
      });
    } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      out.push({
        name,
        kind: field instanceof PDFDropdown ? 'dropdown' : 'list',
        value: field.getSelected()[0] || '',
        options: field.getOptions(),
        pageNumber,
        xNorm,
        yNorm,
        wNorm,
        hNorm,
      });
    }
  }
  return out;
}

export async function saveFormChanges(
  file: WorkspaceFile,
  existingValues: Record<string, string | boolean>,
  newFields: NewFormFieldSpec[],
  flatten: boolean
): Promise<{ blob: Blob; pageCount: number }> {
  const doc = await PDFDocument.load(file.bytes, { ignoreEncryption: true });
  const form = doc.getForm();

  // 1. Update existing detected fields
  for (const field of form.getFields()) {
    const name = field.getName();
    if (!(name in existingValues)) continue;
    const val = existingValues[name];
    try {
      if (field instanceof PDFTextField) {
        field.setText(String(val ?? ''));
      } else if (field instanceof PDFCheckBox) {
        if (val) field.check();
        else field.uncheck();
      } else if (field instanceof PDFRadioGroup && typeof val === 'string' && val) {
        field.select(val);
      } else if ((field instanceof PDFDropdown || field instanceof PDFOptionList) && typeof val === 'string' && val) {
        field.select(val);
      }
    } catch {
      // Ignore mismatched values
    }
  }

  // 2. Add newly created interactive AcroForm fields
  const usedNames = new Set(form.getFields().map((f) => f.getName()));
  for (const nf of newFields) {
    const page = doc.getPage(nf.pageNumber - 1);
    if (!page) continue;
    const { width, height } = page.getSize();
    let fieldName = nf.name.trim() || `field_${nf.id}`;
    while (usedNames.has(fieldName)) fieldName += '_1';
    usedNames.add(fieldName);

    const x = nf.xNorm * width;
    const w = Math.max(16, nf.wNorm * width);
    const h = Math.max(14, nf.hNorm * height);
    const y = height - nf.yNorm * height - h;

    if (nf.kind === 'text') {
      const tf = form.createTextField(fieldName);
      if (nf.defaultValue) tf.setText(nf.defaultValue);
      tf.addToPage(page, { x, y, width: w, height: h, borderWidth: 1 });
      if (nf.fontSize) tf.setFontSize(nf.fontSize);
    } else if (nf.kind === 'checkbox') {
      const cb = form.createCheckBox(fieldName);
      cb.addToPage(page, { x, y, width: Math.min(w, h), height: Math.min(w, h), borderWidth: 1 });
      if (nf.checked) cb.check();
    } else if (nf.kind === 'dropdown') {
      const dd = form.createDropdown(fieldName);
      const opts = nf.options?.length ? nf.options : ['Option A', 'Option B', 'Option C'];
      dd.addOptions(opts);
      if (nf.defaultValue && opts.includes(nf.defaultValue)) dd.select(nf.defaultValue);
      dd.addToPage(page, { x, y, width: w, height: h, borderWidth: 1 });
    } else if (nf.kind === 'radio') {
      const rg = form.createRadioGroup(fieldName);
      const opts = nf.options?.length ? nf.options : ['Choice 1', 'Choice 2'];
      opts.forEach((opt, idx) => {
        rg.addOptionToPage(opt, page, {
          x: x + idx * 72,
          y,
          width: 14,
          height: 14,
          borderWidth: 1,
        });
      });
      if (nf.defaultValue && opts.includes(nf.defaultValue)) rg.select(nf.defaultValue);
    }
  }

  if (flatten) {
    form.flatten();
  }

  const bytes = await doc.save({ useObjectStreams: true });
  return { blob: toPdfBlob(bytes), pageCount: doc.getPageCount() };
}

/* -------------------------------------------------------------------------- */
/* 4. DETERMINISTIC EXTRACTIVE SUMMARIZER (TextRank + TF-IDF, ZERO AI)        */
/* -------------------------------------------------------------------------- */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be', 'been', 'being', 'have',
  'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall', 'should', 'can',
  'could', 'may', 'might', 'must', 'that', 'this', 'these', 'those', 'it', 'its',
  'they', 'their', 'them', 'we', 'our', 'you', 'your', 'he', 'she', 'his', 'her',
  'not', 'no', 'if', 'then', 'than', 'when', 'where', 'which', 'who', 'whom', 'what',
  'so', 'up', 'out', 'about', 'into', 'over', 'after', 'also', 'more', 'most', 'such',
]);

export interface ExtractiveSummaryResult {
  keySentences: { sentence: string; pageNumber: number; score: number }[];
  keywords: { term: string; score: number; count: number }[];
  headings: { title: string; pageNumber: number }[];
  stats: {
    pageCount: number;
    wordCount: number;
    sentenceCount: number;
    readingMinutes: number;
  };
  fullText: string;
}

export async function summarizePdfExtractive(
  file: WorkspaceFile,
  sentenceCountTarget = 7,
  onProgress?: ProgressCallback
): Promise<ExtractiveSummaryResult> {
  const pdfJs = await openPdfJs(file.bytes);
  const totalPages = pdfJs.numPages;

  const sentences: { text: string; pageNumber: number; tokens: string[] }[] = [];
  const headings: { title: string; pageNumber: number }[] = [];
  const pageTexts: string[] = [];
  let totalWords = 0;

  for (let p = 1; p <= totalPages; p++) {
    if (p % 10 === 0 || p === 1) {
      onProgress?.({ current: p, total: totalPages, label: `Analyzing page ${p} of ${totalPages}` });
      await yieldToMain();
    }
    const page = await pdfJs.getPage(p);
    const tc = await page.getTextContent();
    const rawPageText = tc.items
      .map((it) => ('str' in it ? it.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    pageTexts.push(rawPageText);

    // Heuristic heading detection from larger spans
    for (const raw of tc.items) {
      if (!('str' in raw)) continue;
      const item = raw as { str: string; transform: number[] };
      const sz = Math.hypot(item.transform[0], item.transform[1]);
      const clean = item.str.trim();
      if (sz >= 14 && clean.length >= 4 && clean.length <= 90 && !/^\d+$/.test(clean)) {
        if (headings.length === 0 || headings[headings.length - 1].title !== clean) {
          headings.push({ title: clean, pageNumber: p });
        }
      }
    }

    const split = rawPageText.match(/[^.!?]+[.!?]+/g) || (rawPageText ? [rawPageText] : []);
    for (const s of split) {
      const clean = s.trim();
      const words = clean.toLowerCase().match(/[a-z0-9]{2,}/g) || [];
      totalWords += words.length;
      if (words.length >= 6 && words.length <= 80) {
        const tokens = words.filter((w) => !STOPWORDS.has(w));
        if (tokens.length >= 3) {
          sentences.push({ text: clean, pageNumber: p, tokens });
        }
      }
    }
    page.cleanup();
  }
  await destroyPdfJs(pdfJs);

  // Compute Term Frequency & Document Frequency across sentences
  const tfGlobal = new Map<string, number>();
  const dfMap = new Map<string, number>();
  for (const sent of sentences) {
    const uniq = new Set(sent.tokens);
    for (const t of sent.tokens) tfGlobal.set(t, (tfGlobal.get(t) || 0) + 1);
    for (const t of uniq) dfMap.set(t, (dfMap.get(t) || 0) + 1);
  }

  const N = Math.max(1, sentences.length);
  const keywords = Array.from(tfGlobal.entries())
    .map(([term, count]) => {
      const idf = Math.log(1 + N / (1 + (dfMap.get(term) || 1)));
      return { term, count, score: Number((count * idf).toFixed(2)) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 16);

  // TextRank similarity over sentences (capped at top 450 candidate sentences for O(N^2) speed on 1000-page PDFs)
  const candidates =
    sentences.length <= 450
      ? sentences
      : sentences.filter((_, idx) => idx % Math.ceil(sentences.length / 450) === 0);

  const M = candidates.length;
  const scores = new Float64Array(M).fill(1 / Math.max(1, M));
  const sets = candidates.map((c) => new Set(c.tokens));

  // Precompute sparse similarity weights
  const simMatrix: number[][] = Array.from({ length: M }, () => []);
  const rowSums = new Float64Array(M);

  for (let i = 0; i < M; i++) {
    for (let j = i + 1; j < M; j++) {
      let overlap = 0;
      for (const tok of sets[i]) if (sets[j].has(tok)) overlap++;
      if (overlap > 0) {
        const norm = Math.log(sets[i].size + 1) + Math.log(sets[j].size + 1);
        const w = overlap / Math.max(1, norm);
        simMatrix[i][j] = w;
        simMatrix[j][i] = w;
        rowSums[i] += w;
        rowSums[j] += w;
      }
    }
  }

  // 18 TextRank power iterations
  const damping = 0.85;
  for (let iter = 0; iter < 18; iter++) {
    const next = new Float64Array(M);
    for (let i = 0; i < M; i++) {
      let sum = 0;
      for (let j = 0; j < M; j++) {
        const w = simMatrix[j][i];
        if (w && rowSums[j] > 0) {
          sum += (w / rowSums[j]) * scores[j];
        }
      }
      next[i] = (1 - damping) / Math.max(1, M) + damping * sum;
    }
    scores.set(next);
  }

  const ranked = candidates
    .map((c, idx) => ({
      idx,
      sentence: c.text,
      pageNumber: c.pageNumber,
      score: scores[idx] + (idx < 3 ? 0.02 : 0), // Slight lead-sentence boost
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(sentenceCountTarget, M))
    .sort((a, b) => a.idx - b.idx);

  return {
    keySentences: ranked.map(({ sentence, pageNumber, score }) => ({
      sentence,
      pageNumber,
      score: Number(score.toFixed(4)),
    })),
    keywords,
    headings: headings.slice(0, 40),
    stats: {
      pageCount: totalPages,
      wordCount: totalWords,
      sentenceCount: sentences.length,
      readingMinutes: Math.max(1, Math.ceil(totalWords / 225)),
    },
    fullText: pageTexts.map((t, idx) => `[Page ${idx + 1}]\n${t}`).join('\n\n'),
  };
}

/* -------------------------------------------------------------------------- */
/* 5. OFFLINE LEXICON & GLOSSARY LAYOUT-PRESERVING PDF TRANSLATOR             */
/* -------------------------------------------------------------------------- */
export type TargetLang = 'es' | 'fr' | 'de' | 'pt' | 'it';

const OFFLINE_LEXICON: Record<TargetLang, Record<string, string>> = {
  es: {
    document: 'documento', summary: 'resumen', page: 'página', pages: 'páginas',
    total: 'total', date: 'fecha', name: 'nombre', address: 'dirección',
    invoice: 'factura', report: 'informe', contract: 'contrato', agreement: 'acuerdo',
    signature: 'firma', signed: 'firmado', amount: 'importe', price: 'precio',
    subtotal: 'subtotal', tax: 'impuesto', quantity: 'cantidad', description: 'descripción',
    section: 'sección', chapter: 'capítulo', table: 'tabla', contents: 'contenido',
    introduction: 'introducción', conclusion: 'conclusión', notes: 'notas',
    confidential: 'confidencial', approved: 'aprobado', draft: 'borrador',
    company: 'empresa', client: 'cliente', customer: 'cliente', email: 'correo electrónico',
    phone: 'teléfono', number: 'número', title: 'título', author: 'autor',
    project: 'proyecto', status: 'estado', completed: 'completado', pending: 'pendiente',
    and: 'y', or: 'o', the: 'el', of: 'de', in: 'en', for: 'para', with: 'con', to: 'a',
    from: 'de', by: 'por', on: 'en', at: 'en', is: 'es', are: 'son', this: 'este',
  },
  fr: {
    document: 'document', summary: 'résumé', page: 'page', pages: 'pages',
    total: 'total', date: 'date', name: 'nom', address: 'adresse',
    invoice: 'facture', report: 'rapport', contract: 'contrat', agreement: 'accord',
    signature: 'signature', signed: 'signé', amount: 'montant', price: 'prix',
    subtotal: 'sous-total', tax: 'taxe', quantity: 'quantité', description: 'description',
    section: 'section', chapter: 'chapitre', table: 'tableau', contents: 'sommaire',
    introduction: 'introduction', conclusion: 'conclusion', notes: 'notes',
    confidential: 'confidentiel', approved: 'approuvé', draft: 'brouillon',
    company: 'entreprise', client: 'client', customer: 'client', email: 'courriel',
    phone: 'téléphone', number: 'numéro', title: 'titre', author: 'auteur',
    project: 'projet', status: 'statut', completed: 'terminé', pending: 'en attente',
    and: 'et', or: 'ou', the: 'le', of: 'de', in: 'dans', for: 'pour', with: 'avec', to: 'à',
    from: 'de', by: 'par', on: 'sur', at: 'à', is: 'est', are: 'sont', this: 'ce',
  },
  de: {
    document: 'Dokument', summary: 'Zusammenfassung', page: 'Seite', pages: 'Seiten',
    total: 'Gesamt', date: 'Datum', name: 'Name', address: 'Adresse',
    invoice: 'Rechnung', report: 'Bericht', contract: 'Vertrag', agreement: 'Vereinbarung',
    signature: 'Unterschrift', signed: 'unterschrieben', amount: 'Betrag', price: 'Preis',
    subtotal: 'Zwischensumme', tax: 'Steuer', quantity: 'Menge', description: 'Beschreibung',
    section: 'Abschnitt', chapter: 'Kapitel', table: 'Tabelle', contents: 'Inhalt',
    introduction: 'Einleitung', conclusion: 'Fazit', notes: 'Hinweise',
    confidential: 'Vertraulich', approved: 'Genehmigt', draft: 'Entwurf',
    company: 'Unternehmen', client: 'Kunde', customer: 'Kunde', email: 'E-Mail',
    phone: 'Telefon', number: 'Nummer', title: 'Titel', author: 'Autor',
    project: 'Projekt', status: 'Status', completed: 'Abgeschlossen', pending: 'Ausstehend',
    and: 'und', or: 'oder', the: 'der', of: 'von', in: 'in', for: 'für', with: 'mit', to: 'zu',
    from: 'von', by: 'durch', on: 'auf', at: 'bei', is: 'ist', are: 'sind', this: 'dieser',
  },
  pt: {
    document: 'documento', summary: 'resumo', page: 'página', pages: 'páginas',
    total: 'total', date: 'data', name: 'nome', address: 'endereço',
    invoice: 'fatura', report: 'relatório', contract: 'contrato', agreement: 'acordo',
    signature: 'assinatura', signed: 'assinado', amount: 'valor', price: 'preço',
    subtotal: 'subtotal', tax: 'imposto', quantity: 'quantidade', description: 'descrição',
    section: 'seção', chapter: 'capítulo', table: 'tabela', contents: 'conteúdo',
    introduction: 'introdução', conclusion: 'conclusão', notes: 'notas',
    confidential: 'confidencial', approved: 'aprovado', draft: 'rascunho',
    company: 'empresa', client: 'cliente', customer: 'cliente', email: 'e-mail',
    phone: 'telefone', number: 'número', title: 'título', author: 'autor',
    project: 'projeto', status: 'estado', completed: 'concluído', pending: 'pendente',
    and: 'e', or: 'ou', the: 'o', of: 'de', in: 'em', for: 'para', with: 'com', to: 'para',
    from: 'de', by: 'por', on: 'em', at: 'em', is: 'é', are: 'são', this: 'este',
  },
  it: {
    document: 'documento', summary: 'riepilogo', page: 'pagina', pages: 'pagine',
    total: 'totale', date: 'data', name: 'nome', address: 'indirizzo',
    invoice: 'fattura', report: 'rapporto', contract: 'contratto', agreement: 'accordo',
    signature: 'firma', signed: 'firmato', amount: 'importo', price: 'prezzo',
    subtotal: 'subtotale', tax: 'imposta', quantity: 'quantità', description: 'descrizione',
    section: 'sezione', chapter: 'capitolo', table: 'tabella', contents: 'indice',
    introduction: 'introduzione', conclusion: 'conclusione', notes: 'note',
    confidential: 'riservato', approved: 'approvato', draft: 'bozza',
    company: 'azienda', client: 'cliente', customer: 'cliente', email: 'e-mail',
    phone: 'telefono', number: 'numero', title: 'titolo', author: 'autore',
    project: 'progetto', status: 'stato', completed: 'completato', pending: 'in attesa',
    and: 'e', or: 'o', the: 'il', of: 'di', in: 'in', for: 'per', with: 'con', to: 'a',
    from: 'da', by: 'da', on: 'su', at: 'a', is: 'è', are: 'sono', this: 'questo',
  },
};

export interface TranslatableBlock {
  id: string;
  pageNumber: number;
  x: number;
  y: number; // PDF bottom-up y
  width: number;
  height: number;
  fontSize: number;
  original: string;
  translated: string;
}

export function translateStringWithGlossary(
  text: string,
  targetLang: TargetLang,
  customGlossary: Record<string, string>
): string {
  const dict = OFFLINE_LEXICON[targetLang];
  // Apply custom multi-word glossary phrases first (case-insensitive)
  let out = text;
  const sortedGlossary = Object.entries(customGlossary).sort((a, b) => b[0].length - a[0].length);
  for (const [src, dst] of sortedGlossary) {
    if (!src.trim()) continue;
    const rx = new RegExp(`\\b${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    out = out.replace(rx, dst);
  }
  // Apply word-level built-in lexicon preserving capitalization
  return out.replace(/\b[A-Za-z]+\b/g, (word) => {
    const lower = word.toLowerCase();
    const mapped = dict[lower];
    if (!mapped) return word;
    if (word === word.toUpperCase() && word.length > 1) return mapped.toUpperCase();
    if (word[0] === word[0].toUpperCase()) return mapped[0].toUpperCase() + mapped.slice(1);
    return mapped;
  });
}

export async function extractTranslatableBlocks(
  file: WorkspaceFile,
  targetLang: TargetLang,
  customGlossary: Record<string, string>
): Promise<TranslatableBlock[]> {
  const pdfJs = await openPdfJs(file.bytes);
  const blocks: TranslatableBlock[] = [];

  for (let p = 1; p <= pdfJs.numPages; p++) {
    const page = await pdfJs.getPage(p);
    const tc = await page.getTextContent();
    // Group items on same baseline
    const lineItems: { x: number; y: number; w: number; h: number; str: string }[] = [];
    for (const raw of tc.items) {
      if (!('str' in raw) || !raw.str.trim()) continue;
      const item = raw as { str: string; transform: number[]; width: number; height: number };
      const x = item.transform[4];
      const y = item.transform[5];
      const h = Math.max(7, Math.hypot(item.transform[0], item.transform[1]) || item.height || 10);
      const prev = lineItems[lineItems.length - 1];
      if (prev && Math.abs(prev.y - y) <= h * 0.45 && x - (prev.x + prev.w) < h * 2.5) {
        prev.str += (x - (prev.x + prev.w) > 2 ? ' ' : '') + item.str;
        prev.w = Math.max(prev.w, x + item.width - prev.x);
      } else {
        lineItems.push({ x, y, w: Math.max(12, item.width), h, str: item.str });
      }
    }

    lineItems.forEach((li, idx) => {
      const original = li.str.trim();
      if (!original) return;
      blocks.push({
        id: `p${p}_${idx}`,
        pageNumber: p,
        x: li.x,
        y: li.y,
        width: li.w,
        height: li.h,
        fontSize: li.h,
        original,
        translated: translateStringWithGlossary(original, targetLang, customGlossary),
      });
    });
    page.cleanup();
  }
  await destroyPdfJs(pdfJs);
  return blocks;
}

export async function exportTranslatedPdf(
  file: WorkspaceFile,
  blocks: TranslatableBlock[],
  onProgress?: ProgressCallback
): Promise<{ blob: Blob; pageCount: number }> {
  const doc = await PDFDocument.load(file.bytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (i % 40 === 0) {
      onProgress?.({ current: i + 1, total: blocks.length, label: `Writing translated blocks (${i + 1}/${blocks.length})` });
      await yieldToMain();
    }
    if (b.translated === b.original) continue;
    const page = doc.getPage(b.pageNumber - 1);
    if (!page) continue;

    // Mask original text span cleanly with white background & draw translated text at exact font size/position
    page.drawRectangle({
      x: Math.max(0, b.x - 1),
      y: Math.max(0, b.y - b.fontSize * 0.25),
      width: b.width + 4,
      height: b.fontSize * 1.25,
      color: rgb(1, 1, 1),
    });

    const clean = sanitizeWinAnsi(b.translated);
    const textWidth = font.widthOfTextAtSize(clean, b.fontSize);
    const fitSize =
      textWidth > b.width * 1.25 && b.width > 20
        ? Math.max(6, b.fontSize * ((b.width * 1.15) / textWidth))
        : b.fontSize;

    page.drawText(clean, {
      x: b.x,
      y: b.y,
      size: Math.min(36, Math.max(6, fitSize)),
      font,
      color: rgb(0.08, 0.1, 0.14),
    });
  }

  const bytes = await doc.save({ useObjectStreams: true });
  return { blob: toPdfBlob(bytes), pageCount: doc.getPageCount() };
}
