import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from 'docx';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import PptxGenJS from 'pptxgenjs';
import * as XLSX from 'xlsx';
import {
  destroyPdfJs,
  openPdfJs,
  stripExt,
  yieldToMain,
} from './pdfRuntime';
import { ProgressCallback, hexToRgb, imagesToPdf } from './pdfEngines';
import { WorkspaceFile } from '../types/tools';

function toPdfBlob(bytes: Uint8Array): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy], { type: 'application/pdf' });
}

interface TextSpan {
  str: string;
  x: number;
  y: number; // top-down
  w: number;
  h: number;
  fontSize: number;
  fontName: string;
}

interface TextLine {
  y: number;
  fontSize: number;
  isBold: boolean;
  isMono: boolean;
  text: string;
  spans: TextSpan[];
}

async function extractStructuredLines(
  file: WorkspaceFile,
  onProgress?: ProgressCallback,
  trimEdgeMargins = false
): Promise<{
  pages: { pageNumber: number; width: number; height: number; lines: TextLine[] }[];
  medianFontSize: number;
}> {
  const pdfJs = await openPdfJs(file.bytes);
  const total = pdfJs.numPages;
  const pages: { pageNumber: number; width: number; height: number; lines: TextLine[] }[] = [];
  const fontSizes: number[] = [];

  for (let p = 1; p <= total; p++) {
    if (p % 5 === 0 || p === 1) {
      onProgress?.({ current: p, total, label: `Extracting layout from page ${p} of ${total}` });
      await yieldToMain();
    }
    const page = await pdfJs.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const styles = tc.styles as Record<string, { fontFamily?: string }>;

    const spans: TextSpan[] = [];
    for (const raw of tc.items) {
      if (!('str' in raw) || !raw.str) continue;
      const item = raw as {
        str: string;
        transform: number[];
        width: number;
        height: number;
        fontName: string;
      };
      const fontSize = Math.max(6, Math.hypot(item.transform[0], item.transform[1]) || item.height || 10);
      fontSizes.push(fontSize);
      spans.push({
        str: item.str,
        x: item.transform[4],
        y: vp.height - item.transform[5],
        w: item.width,
        h: fontSize,
        fontSize,
        fontName: (styles[item.fontName]?.fontFamily || item.fontName || '').toLowerCase(),
      });
    }

    // Group spans into lines by Y proximity
    spans.sort((a, b) => a.y - b.y || a.x - b.x);
    const lines: TextLine[] = [];
    for (const sp of spans) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - sp.y) <= Math.max(3, sp.fontSize * 0.45)) {
        last.spans.push(sp);
      } else {
        lines.push({
          y: sp.y,
          fontSize: sp.fontSize,
          isBold: sp.fontName.includes('bold') || sp.fontName.includes('black'),
          isMono: sp.fontName.includes('mono') || sp.fontName.includes('courier'),
          text: '',
          spans: [sp],
        });
      }
    }

    for (const line of lines) {
      line.spans.sort((a, b) => a.x - b.x);
      let joined = '';
      let prevEnd = -1;
      for (const s of line.spans) {
        if (prevEnd >= 0 && s.x - prevEnd > s.fontSize * 0.25 && !joined.endsWith(' ') && !s.str.startsWith(' ')) {
          joined += ' ';
        }
        joined += s.str;
        prevEnd = s.x + s.w;
      }
      line.text = joined.trim();
      line.fontSize =
        line.spans.reduce((acc, s) => acc + s.fontSize, 0) / Math.max(1, line.spans.length);
      line.isBold = line.spans.some((s) => s.fontName.includes('bold') || s.fontName.includes('heavy'));
      line.isMono = line.spans.every((s) => s.fontName.includes('mono') || s.fontName.includes('courier'));
    }

    const filteredLines = trimEdgeMargins
      ? lines.filter((l) => {
          if (l.text.length === 0) return false;
          const xMin = Math.min(...l.spans.map((s) => s.x));
          const xMax = Math.max(...l.spans.map((s) => s.x + s.w));
          const yRatio = l.y / Math.max(1, vp.height);
          const xStartRatio = xMin / Math.max(1, vp.width);
          const xEndRatio = xMax / Math.max(1, vp.width);
          // Trim outer ~5% header/footer/margin strips cleanly
          return yRatio >= 0.05 && yRatio <= 0.95 && xEndRatio >= 0.04 && xStartRatio <= 0.96;
        })
      : lines.filter((l) => l.text.length > 0);

    pages.push({
      pageNumber: p,
      width: vp.width,
      height: vp.height,
      lines: filteredLines,
    });
    page.cleanup();
  }
  await destroyPdfJs(pdfJs);

  fontSizes.sort((a, b) => a - b);
  const medianFontSize = fontSizes.length > 0 ? fontSizes[Math.floor(fontSizes.length / 2)] : 11;
  return { pages, medianFontSize };
}

/* -------------------------------------------------------------------------- */
/* 1. PDF TO WORD (.docx)                                                     */
/* -------------------------------------------------------------------------- */
export async function pdfToWord(
  file: WorkspaceFile,
  onProgress?: ProgressCallback,
  trimEdgeMargins = false
): Promise<{ blob: Blob; fileName: string; pageCount: number }> {
  const { pages, medianFontSize } = await extractStructuredLines(file, onProgress, trimEdgeMargins);
  const children: Paragraph[] = [];

  for (let idx = 0; idx < pages.length; idx++) {
    const pg = pages[idx];
    if (idx > 0) {
      children.push(new Paragraph({ pageBreakBefore: true }));
    }
    for (const line of pg.lines) {
      const ratio = line.fontSize / medianFontSize;
      if (ratio >= 1.5) {
        children.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 200, after: 100 },
            children: [new TextRun({ text: line.text, bold: true, size: Math.round(line.fontSize * 2) })],
          })
        );
      } else if (ratio >= 1.22) {
        children.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 140, after: 80 },
            children: [new TextRun({ text: line.text, bold: true, size: Math.round(line.fontSize * 2) })],
          })
        );
      } else if (/^([•●▪◦\-*]|\d+\.)\s+/.test(line.text)) {
        children.push(
          new Paragraph({
            bullet: { level: 0 },
            children: [new TextRun({ text: line.text.replace(/^([•●▪◦\-*]|\d+\.)\s+/, ''), size: 22 })],
          })
        );
      } else {
        children.push(
          new Paragraph({
            alignment: AlignmentType.LEFT,
            spacing: { after: 80 },
            children: [
              new TextRun({
                text: line.text,
                bold: line.isBold,
                size: Math.max(16, Math.min(36, Math.round(line.fontSize * 2))),
              }),
            ],
          })
        );
      }
    }
  }

  const doc = new Document({
    sections: [{ children: children.length > 0 ? children : [new Paragraph('Empty PDF')] }],
  });
  const blob = await Packer.toBlob(doc);
  return {
    blob,
    fileName: `${stripExt(file.name)}.docx`,
    pageCount: pages.length,
  };
}

/* -------------------------------------------------------------------------- */
/* 2. PDF TO POWERPOINT (.pptx)                                               */
/* -------------------------------------------------------------------------- */
export async function pdfToPowerPoint(
  file: WorkspaceFile,
  addSlideHeaderRule: boolean,
  onProgress?: ProgressCallback,
  trimEdgeMargins = false
): Promise<{ blob: Blob; fileName: string; slideCount: number }> {
  const { pages, medianFontSize } = await extractStructuredLines(file, onProgress, trimEdgeMargins);
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';

  for (let i = 0; i < pages.length; i++) {
    const pg = pages[i];
    onProgress?.({ current: i + 1, total: pages.length, label: `Building slide ${i + 1} of ${pages.length}` });
    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };
    if (addSlideHeaderRule) {
      slide.addShape(pptx.ShapeType.rect, {
        x: 0.35,
        y: 0.18,
        w: 9.3,
        h: 0.04,
        fill: { color: 'DC2626' },
      });
    }

    const slideW = 10;
    const slideH = 5.625;
    for (const line of pg.lines) {
      const firstX = line.spans[0]?.x ?? 36;
      const xIn = Math.max(0.25, Math.min(9.1, (firstX / pg.width) * slideW));
      const yIn = Math.max(0.25, Math.min(5.2, (line.y / pg.height) * slideH));
      const wIn = Math.max(1.5, slideW - xIn - 0.25);
      const ptSize = Math.max(8, Math.min(36, Math.round(line.fontSize * 0.95)));
      slide.addText(line.text, {
        x: xIn,
        y: yIn,
        w: wIn,
        h: Math.max(0.28, (ptSize / 72) * 1.6),
        fontSize: ptSize,
        bold: line.isBold || line.fontSize > medianFontSize * 1.25,
        color: '1E293B',
      });
    }
    await yieldToMain();
  }

  const out = (await pptx.write({ outputType: 'blob' })) as Blob;
  return {
    blob: out,
    fileName: `${stripExt(file.name)}.pptx`,
    slideCount: pages.length,
  };
}

/* -------------------------------------------------------------------------- */
/* 3. PDF TO EXCEL (.xlsx / .csv)                                             */
/* -------------------------------------------------------------------------- */
export async function extractPdfTables(
  file: WorkspaceFile,
  onProgress?: ProgressCallback,
  trimEdgeMargins = false
): Promise<{ sheets: { name: string; rows: string[][] }[] }> {
  const { pages } = await extractStructuredLines(file, onProgress, trimEdgeMargins);
  const sheets: { name: string; rows: string[][] }[] = [];

  for (const pg of pages) {
    // Cluster X-coordinates across spans to detect column boundaries
    const rows: string[][] = [];
    const xStarts = pg.lines.flatMap((l) => l.spans.map((s) => s.x)).sort((a, b) => a - b);
    const colAnchors: number[] = [];
    for (const x of xStarts) {
      if (colAnchors.length === 0 || x - colAnchors[colAnchors.length - 1] > 28) {
        colAnchors.push(x);
      }
    }

    for (const line of pg.lines) {
      // Group spans on the same line separated by wide horizontal gaps (> 12pt) into cells
      const cells: { colIdx: number; text: string }[] = [];
      let currText = '';
      let currStart = line.spans[0]?.x ?? 0;
      let prevEnd = -1;

      const flushCell = () => {
        if (!currText.trim()) return;
        let bestCol = 0;
        let bestDist = Infinity;
        for (let c = 0; c < colAnchors.length; c++) {
          const d = Math.abs(currStart - colAnchors[c]);
          if (d < bestDist) {
            bestDist = d;
            bestCol = c;
          }
        }
        cells.push({ colIdx: bestCol, text: currText.trim() });
      };

      for (const sp of line.spans) {
        if (prevEnd >= 0 && sp.x - prevEnd > Math.max(12, sp.fontSize * 1.1)) {
          flushCell();
          currText = sp.str;
          currStart = sp.x;
        } else {
          currText += (prevEnd >= 0 && sp.x - prevEnd > 2 && !currText.endsWith(' ') ? ' ' : '') + sp.str;
        }
        prevEnd = sp.x + sp.w;
      }
      flushCell();

      if (cells.length > 0) {
        const maxCol = Math.max(...cells.map((c) => c.colIdx));
        const row = Array(maxCol + 1).fill('');
        for (const c of cells) {
          row[c.colIdx] = row[c.colIdx] ? `${row[c.colIdx]} ${c.text}` : c.text;
        }
        rows.push(row);
      }
    }

    sheets.push({
      name: `Page_${pg.pageNumber}`,
      rows: rows.length > 0 ? rows : [['(No text detected on page)']],
    });
  }

  return { sheets };
}

export async function pdfToExcel(
  file: WorkspaceFile,
  combineSheets: boolean,
  onProgress?: ProgressCallback,
  trimEdgeMargins = false
): Promise<{ blob: Blob; fileName: string; sheets: { name: string; rows: string[][] }[] }> {
  const { sheets } = await extractPdfTables(file, onProgress, trimEdgeMargins);
  const wb = XLSX.utils.book_new();

  if (combineSheets) {
    const allRows: string[][] = [];
    for (const s of sheets) {
      allRows.push(...s.rows);
    }
    const ws = XLSX.utils.aoa_to_sheet(allRows);
    XLSX.utils.book_append_sheet(wb, ws, 'Extracted_Data');
  } else {
    for (const s of sheets) {
      const ws = XLSX.utils.aoa_to_sheet(s.rows);
      XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
    }
  }

  const outBytes = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return {
    blob: new Blob([outBytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
    fileName: `${stripExt(file.name)}.xlsx`,
    sheets,
  };
}

/* -------------------------------------------------------------------------- */
/* 4. PDF TO MARKDOWN (.md)                                                   */
/* -------------------------------------------------------------------------- */
export async function pdfToMarkdown(
  file: WorkspaceFile,
  includePageDividers: boolean,
  onProgress?: ProgressCallback,
  trimEdgeMargins = false
): Promise<{ markdown: string; blob: Blob; fileName: string; pageCount: number }> {
  const { pages, medianFontSize } = await extractStructuredLines(file, onProgress, trimEdgeMargins);
  const mdBlocks: string[] = [];

  for (let i = 0; i < pages.length; i++) {
    const pg = pages[i];
    if (includePageDividers && i > 0) {
      mdBlocks.push(`\n---\n<!-- Page ${pg.pageNumber} -->\n`);
    }
    let inCode = false;
    for (let li = 0; li < pg.lines.length; li++) {
      const line = pg.lines[li];
      const ratio = line.fontSize / medianFontSize;

      // Detect code blocks
      if (line.isMono && !inCode) {
        mdBlocks.push('```');
        inCode = true;
      } else if (!line.isMono && inCode) {
        mdBlocks.push('```');
        inCode = false;
      }

      if (inCode) {
        mdBlocks.push(line.text);
        continue;
      }

      // Detect table-like multi-column lines (3+ wide gaps)
      let wideGaps = 0;
      const cellTexts: string[] = [];
      let buf = '';
      let prevEnd = -1;
      for (const sp of line.spans) {
        if (prevEnd >= 0 && sp.x - prevEnd > 18) {
          wideGaps++;
          cellTexts.push(buf.trim());
          buf = sp.str;
        } else {
          buf += (prevEnd >= 0 && sp.x - prevEnd > 2 ? ' ' : '') + sp.str;
        }
        prevEnd = sp.x + sp.w;
      }
      cellTexts.push(buf.trim());

      if (wideGaps >= 2 && cellTexts.length >= 3) {
        mdBlocks.push(`| ${cellTexts.join(' | ')} |`);
        const prevLine = pg.lines[li - 1];
        if (!prevLine || !mdBlocks[mdBlocks.length - 2]?.startsWith('|')) {
          mdBlocks.push(`| ${cellTexts.map(() => '---').join(' | ')} |`);
        }
        continue;
      }

      if (ratio >= 1.65) {
        mdBlocks.push(`\n# ${line.text}\n`);
      } else if (ratio >= 1.35) {
        mdBlocks.push(`\n## ${line.text}\n`);
      } else if (ratio >= 1.18 && line.isBold) {
        mdBlocks.push(`\n### ${line.text}\n`);
      } else if (/^[•●▪◦]\s*/.test(line.text)) {
        mdBlocks.push(`- ${line.text.replace(/^[•●▪◦]\s*/, '')}`);
      } else if (/^\d+[.)]\s+/.test(line.text)) {
        mdBlocks.push(line.text);
      } else if (line.isBold && line.text.length < 100) {
        mdBlocks.push(`**${line.text}**`);
      } else {
        mdBlocks.push(line.text);
      }
    }
    if (inCode) mdBlocks.push('```');
  }

  const markdown = mdBlocks.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  return {
    markdown,
    blob: new Blob([markdown], { type: 'text/markdown;charset=utf-8' }),
    fileName: `${stripExt(file.name)}.md`,
    pageCount: pages.length,
  };
}

/* -------------------------------------------------------------------------- */
/* 5. SHARED PAGINATED VECTOR TEXT/BLOCK -> PDF BUILDER                       */
/* -------------------------------------------------------------------------- */
interface LayoutBlock {
  kind: 'h1' | 'h2' | 'h3' | 'p' | 'li' | 'hr' | 'table';
  text?: string;
  rows?: string[][];
}

async function renderBlocksToPdf(
  blocks: LayoutBlock[],
  pageSize: 'a4' | 'letter' = 'a4',
  margin = 50
): Promise<{ blob: Blob; pageCount: number }> {
  const doc = await PDFDocument.create();
  const fontReg = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const [pw, ph] = pageSize === 'letter' ? [612, 792] : [595.28, 841.89];
  const maxW = pw - margin * 2;
  let page = doc.addPage([pw, ph]);
  let y = ph - margin;

  const ensureSpace = (needed: number) => {
    if (y - needed < margin) {
      page = doc.addPage([pw, ph]);
      y = ph - margin;
    }
  };

  // WinAnsi sanitizer so non-Latin1 characters don't crash pdf-lib standard fonts
  const sanitize = (str: string) =>
    str.replace(/[^\x20-\x7E\xA0-\xFF]/g, (ch) => {
      if (ch === '\u2022' || ch === '\u25CF') return '*';
      if (ch === '\u2013' || ch === '\u2014') return '-';
      if (ch === '\u2018' || ch === '\u2019') return "'";
      if (ch === '\u201C' || ch === '\u201D') return '"';
      return ' ';
    });

  const wrapText = (text: string, font: typeof fontReg, size: number, width: number): string[] => {
    const clean = sanitize(text);
    const words = clean.split(/\s+/);
    const lines: string[] = [];
    let current = '';
    for (const w of words) {
      const test = current ? `${current} ${w}` : w;
      if (font.widthOfTextAtSize(test, size) <= width) {
        current = test;
      } else {
        if (current) lines.push(current);
        current = w;
      }
    }
    if (current) lines.push(current);
    return lines.length > 0 ? lines : [''];
  };

  for (const b of blocks) {
    if (b.kind === 'hr') {
      ensureSpace(16);
      page.drawLine({
        start: { x: margin, y: y - 4 },
        end: { x: pw - margin, y: y - 4 },
        thickness: 0.75,
        color: rgb(0.8, 0.84, 0.88),
      });
      y -= 16;
      continue;
    }

    if (b.kind === 'table' && b.rows && b.rows.length > 0) {
      const cols = Math.max(1, ...b.rows.map((r) => r.length));
      const colW = maxW / cols;
      const cellSize = 9;
      for (let r = 0; r < b.rows.length; r++) {
        const row = b.rows[r];
        const rowH = 18;
        ensureSpace(rowH + 4);
        if (r === 0) {
          page.drawRectangle({
            x: margin,
            y: y - rowH + 4,
            width: maxW,
            height: rowH,
            color: rgb(0.94, 0.96, 0.98),
          });
        }
        for (let c = 0; c < cols; c++) {
          const val = sanitize(String(row[c] ?? '')).slice(0, 40);
          page.drawRectangle({
            x: margin + c * colW,
            y: y - rowH + 4,
            width: colW,
            height: rowH,
            borderColor: rgb(0.82, 0.85, 0.9),
            borderWidth: 0.5,
          });
          page.drawText(val, {
            x: margin + c * colW + 4,
            y: y - rowH + 9,
            size: cellSize,
            font: r === 0 ? fontBold : fontReg,
            color: rgb(0.1, 0.14, 0.2),
            maxWidth: colW - 8,
          });
        }
        y -= rowH;
      }
      y -= 10;
      continue;
    }

    const text = b.text || '';
    if (!text.trim()) {
      y -= 8;
      continue;
    }

    const isHeading = b.kind === 'h1' || b.kind === 'h2' || b.kind === 'h3';
    const font = isHeading ? fontBold : fontReg;
    const size = b.kind === 'h1' ? 19 : b.kind === 'h2' ? 15 : b.kind === 'h3' ? 12.5 : 10.5;
    const indent = b.kind === 'li' ? 14 : 0;
    const display = b.kind === 'li' ? `* ${text}` : text;
    const lines = wrapText(display, font, size, maxW - indent);
    const lineH = size * 1.42;

    if (isHeading) y -= 6;
    for (const line of lines) {
      ensureSpace(lineH);
      page.drawText(line, {
        x: margin + indent,
        y: y - size,
        size,
        font,
        color: isHeading ? rgb(0.06, 0.09, 0.16) : rgb(0.18, 0.22, 0.29),
      });
      y -= lineH;
    }
    y -= isHeading ? 6 : 5;
  }

  const bytes = await doc.save({ useObjectStreams: true });
  return { blob: toPdfBlob(bytes), pageCount: doc.getPageCount() };
}

function htmlStringToBlocks(html: string): LayoutBlock[] {
  const parser = new DOMParser();
  const dom = parser.parseFromString(html, 'text/html');
  const blocks: LayoutBlock[] = [];

  const walk = (el: Element) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'h1') blocks.push({ kind: 'h1', text: el.textContent?.trim() || '' });
    else if (tag === 'h2') blocks.push({ kind: 'h2', text: el.textContent?.trim() || '' });
    else if (tag === 'h3' || tag === 'h4') blocks.push({ kind: 'h3', text: el.textContent?.trim() || '' });
    else if (tag === 'li') blocks.push({ kind: 'li', text: el.textContent?.trim() || '' });
    else if (tag === 'hr') blocks.push({ kind: 'hr' });
    else if (tag === 'table') {
      const rows: string[][] = [];
      el.querySelectorAll('tr').forEach((tr) => {
        const row: string[] = [];
        tr.querySelectorAll('th, td').forEach((cell) => row.push(cell.textContent?.trim() || ''));
        if (row.length > 0) rows.push(row);
      });
      if (rows.length > 0) blocks.push({ kind: 'table', rows });
    } else if (tag === 'p' || tag === 'blockquote' || tag === 'pre') {
      const t = el.textContent?.trim();
      if (t) blocks.push({ kind: 'p', text: t });
    } else {
      for (const child of Array.from(el.children)) {
        walk(child);
      }
      if (el.children.length === 0 && el.textContent?.trim()) {
        blocks.push({ kind: 'p', text: el.textContent.trim() });
      }
    }
  };

  walk(dom.body);
  return blocks;
}

/* -------------------------------------------------------------------------- */
/* 6. WORD / TXT / MD / RTF TO PDF                                            */
/* -------------------------------------------------------------------------- */
export async function wordToPdf(
  file: WorkspaceFile,
  pageSize: 'a4' | 'letter' = 'a4',
  options?: { cropEdgesToFill?: boolean }
): Promise<{ blob: Blob; pageCount: number }> {
  const lower = file.name.toLowerCase();
  let blocks: LayoutBlock[] = [];

  if (lower.endsWith('.docx')) {
    const buf = file.bytes.buffer.slice(
      file.bytes.byteOffset,
      file.bytes.byteOffset + file.bytes.byteLength
    ) as ArrayBuffer;
    const res = await mammoth.convertToHtml({ arrayBuffer: buf });
    blocks = htmlStringToBlocks(res.value);
  } else {
    const rawText = new TextDecoder('utf-8').decode(file.bytes);
    const cleaned = lower.endsWith('.rtf')
      ? rawText.replace(/\\[a-z]+\d*\s?|[{}]/g, ' ').replace(/\s+/g, ' ')
      : rawText;
    for (const line of cleaned.split(/\r?\n/)) {
      if (line.startsWith('# ')) blocks.push({ kind: 'h1', text: line.slice(2) });
      else if (line.startsWith('## ')) blocks.push({ kind: 'h2', text: line.slice(3) });
      else if (line.startsWith('### ')) blocks.push({ kind: 'h3', text: line.slice(4) });
      else if (/^[-*]\s+/.test(line)) blocks.push({ kind: 'li', text: line.replace(/^[-*]\s+/, '') });
      else blocks.push({ kind: 'p', text: line });
    }
  }

  return renderBlocksToPdf(blocks, pageSize, options?.cropEdgesToFill ? 14 : 50);
}

/* -------------------------------------------------------------------------- */
/* 7. EXCEL (.xlsx/.xls/.csv) TO PDF                                          */
/* -------------------------------------------------------------------------- */
export async function excelToPdf(
  file: WorkspaceFile,
  options: { orientation: 'landscape' | 'portrait'; sheetIndex?: number; cropEdgesToFill?: boolean }
): Promise<{ blob: Blob; pageCount: number; sheetNames: string[] }> {
  const wb = XLSX.read(file.bytes, { type: 'array' });
  const sheetNames = wb.SheetNames;
  const targetNames =
    options.sheetIndex !== undefined && options.sheetIndex >= 0
      ? [sheetNames[options.sheetIndex]].filter(Boolean)
      : sheetNames;

  const doc = await PDFDocument.create();
  const fontReg = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const [pw, ph] = options.orientation === 'landscape' ? [841.89, 595.28] : [595.28, 841.89];
  const margin = options.cropEdgesToFill ? 8 : 36;
  const availW = pw - margin * 2;
  const rowH = 18;
  const sanitize = (s: string) => s.replace(/[^\x20-\x7E\xA0-\xFF]/g, ' ');

  for (const sName of targetNames) {
    const ws = wb.Sheets[sName];
    const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' });
    if (rows.length === 0) continue;
    const maxCols = Math.max(1, ...rows.map((r) => r.length));
    const colW = Math.max(48, availW / Math.min(maxCols, options.cropEdgesToFill ? maxCols : 14));
    const visibleCols = Math.min(maxCols, Math.floor(availW / colW));

    let page = doc.addPage([pw, ph]);
    let y = ph - margin;

    const drawHeaderBanner = () => {
      page.drawText(sanitize(sName), {
        x: margin,
        y: y - 12,
        size: 12,
        font: fontBold,
        color: rgb(0.08, 0.12, 0.2),
      });
      y -= 24;
    };
    drawHeaderBanner();

    for (let r = 0; r < rows.length; r++) {
      if (y - rowH < margin) {
        page = doc.addPage([pw, ph]);
        y = ph - margin;
        drawHeaderBanner();
      }
      const row = rows[r];
      if (r === 0) {
        page.drawRectangle({
          x: margin,
          y: y - rowH,
          width: colW * visibleCols,
          height: rowH,
          color: rgb(0.93, 0.95, 0.97),
        });
      }
      for (let c = 0; c < visibleCols; c++) {
        const val = sanitize(String(row[c] ?? ''));
        page.drawRectangle({
          x: margin + c * colW,
          y: y - rowH,
          width: colW,
          height: rowH,
          borderColor: rgb(0.84, 0.87, 0.91),
          borderWidth: 0.5,
        });
        page.drawText(val.slice(0, Math.floor(colW / 5)), {
          x: margin + c * colW + 4,
          y: y - rowH + 5,
          size: 8.5,
          font: r === 0 ? fontBold : fontReg,
          color: rgb(0.12, 0.16, 0.24),
        });
      }
      y -= rowH;
    }
  }

  if (doc.getPageCount() === 0) doc.addPage([pw, ph]);
  const bytes = await doc.save({ useObjectStreams: true });
  return { blob: toPdfBlob(bytes), pageCount: doc.getPageCount(), sheetNames };
}

/* -------------------------------------------------------------------------- */
/* 8. POWERPOINT (.pptx) TO PDF                                               */
/* -------------------------------------------------------------------------- */
export async function powerPointToPdf(
  file: WorkspaceFile,
  onProgress?: ProgressCallback,
  options?: { cropEdgesToFill?: boolean }
): Promise<{ blob: Blob; pageCount: number }> {
  const zip = await JSZip.loadAsync(file.bytes);
  const slideFiles = Object.keys(zip.files)
    .filter((k) => /^ppt\/slides\/slide\d+\.xml$/i.test(k))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)\.xml/i)?.[1] || '0', 10);
      const nb = parseInt(b.match(/slide(\d+)\.xml/i)?.[1] || '0', 10);
      return na - nb;
    });

  if (slideFiles.length === 0) {
    throw new Error('No slides found inside PPTX archive.');
  }

  // Read presentation.xml for slide dimensions in EMU (1 pt = 12700 EMU)
  let slideW = 960;
  let slideH = 540;
  const presXml = await zip.file('ppt/presentation.xml')?.async('string');
  if (presXml) {
    const sldSzMatch = presXml.match(/sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
    if (sldSzMatch) {
      slideW = Math.round(parseInt(sldSzMatch[1], 10) / 12700);
      slideH = Math.round(parseInt(sldSzMatch[2], 10) / 12700);
    }
  }

  const doc = await PDFDocument.create();
  const fontReg = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const parser = new DOMParser();
  const sanitize = (s: string) => s.replace(/[^\x20-\x7E\xA0-\xFF]/g, ' ');

  for (let idx = 0; idx < slideFiles.length; idx++) {
    const slidePath = slideFiles[idx];
    onProgress?.({ current: idx + 1, total: slideFiles.length, label: `Converting slide ${idx + 1}` });
    const xmlStr = await zip.file(slidePath)!.async('string');
    const xml = parser.parseFromString(xmlStr, 'application/xml');
    const page = doc.addPage([slideW, slideH]);

    // Check slide background solidFill if present
    const bgSrgb = xml.querySelector('bg a\\:srgbClr, bg srgbClr')?.getAttribute('val');
    if (bgSrgb && /^[0-9A-Fa-f]{6}$/.test(bgSrgb)) {
      page.drawRectangle({
        x: 0,
        y: 0,
        width: slideW,
        height: slideH,
        color: hexToRgb(bgSrgb),
      });
    }

    // Parse slide relationships for embedded images
    const relPath = slidePath.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
    const relMap = new Map<string, string>();
    const relXmlStr = await zip.file(relPath)?.async('string');
    if (relXmlStr) {
      const relDom = parser.parseFromString(relXmlStr, 'application/xml');
      relDom.querySelectorAll('Relationship').forEach((rel) => {
        const id = rel.getAttribute('Id');
        const target = rel.getAttribute('Target');
        if (id && target) {
          const resolved = target.startsWith('../') ? `ppt/${target.slice(3)}` : `ppt/slides/${target}`;
          relMap.set(id, resolved);
        }
      });
    }

    // Draw pictures (<p:pic>)
    const pics = Array.from(xml.getElementsByTagNameNS('*', 'pic'));
    for (const pic of pics) {
      const blip = pic.getElementsByTagNameNS('*', 'blip')[0];
      const rId = blip?.getAttribute('r:embed') || blip?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
      const mediaPath = rId ? relMap.get(rId) : undefined;
      const xfrm = pic.getElementsByTagNameNS('*', 'xfrm')[0];
      const off = xfrm?.getElementsByTagNameNS('*', 'off')[0];
      const ext = xfrm?.getElementsByTagNameNS('*', 'ext')[0];
      if (mediaPath && off && ext) {
        const mediaBytes = await zip.file(mediaPath)?.async('uint8array');
        if (mediaBytes) {
          const px = (parseInt(off.getAttribute('x') || '0', 10) || 0) / 12700;
          const pyTop = (parseInt(off.getAttribute('y') || '0', 10) || 0) / 12700;
          const pw = (parseInt(ext.getAttribute('cx') || '0', 10) || 0) / 12700;
          const ph = (parseInt(ext.getAttribute('cy') || '0', 10) || 0) / 12700;
          try {
            const embedded = mediaPath.toLowerCase().endsWith('.png')
              ? await doc.embedPng(mediaBytes)
              : await doc.embedJpg(mediaBytes);
            page.drawImage(embedded, {
              x: px,
              y: slideH - pyTop - ph,
              width: pw,
              height: ph,
            });
          } catch {
            // Skip non-PNG/JPG media
          }
        }
      }
    }

    // Draw shape text frames (<p:sp>)
    const shapes = Array.from(xml.getElementsByTagNameNS('*', 'sp'));
    for (const sp of shapes) {
      const xfrm = sp.getElementsByTagNameNS('*', 'xfrm')[0];
      const off = xfrm?.getElementsByTagNameNS('*', 'off')[0];
      const ext = xfrm?.getElementsByTagNameNS('*', 'ext')[0];
      const bx = off ? (parseInt(off.getAttribute('x') || '0', 10) || 0) / 12700 : 48;
      const byTop = off ? (parseInt(off.getAttribute('y') || '0', 10) || 0) / 12700 : 48;
      const bw = ext ? Math.max(80, (parseInt(ext.getAttribute('cx') || '0', 10) || 0) / 12700) : slideW - 96;

      const paragraphs = Array.from(sp.getElementsByTagNameNS('*', 'p'));
      let cursorY = slideH - byTop - 20;
      for (const para of paragraphs) {
        const runs = Array.from(para.getElementsByTagNameNS('*', 'r'));
        const text = sanitize(runs.map((r) => r.textContent || '').join('')).trim();
        if (!text) {
          cursorY -= 12;
          continue;
        }
        const rPr = runs[0]?.getElementsByTagNameNS('*', 'rPr')[0];
        const szAttr = rPr?.getAttribute('sz');
        const fontSize = szAttr ? Math.max(9, Math.min(48, parseInt(szAttr, 10) / 100)) : 16;
        const isBold = rPr?.getAttribute('b') === '1';
        const font = isBold ? fontBold : fontReg;

        // Wrap line to box width
        const words = text.split(/\s+/);
        let line = '';
        for (const w of words) {
          const test = line ? `${line} ${w}` : w;
          if (font.widthOfTextAtSize(test, fontSize) <= bw) {
            line = test;
          } else {
            if (line && cursorY > 12) {
              page.drawText(line, { x: bx, y: cursorY, size: fontSize, font, color: rgb(0.1, 0.14, 0.2) });
              cursorY -= fontSize * 1.3;
            }
            line = w;
          }
        }
        if (line && cursorY > 12) {
          page.drawText(line, { x: bx, y: cursorY, size: fontSize, font, color: rgb(0.1, 0.14, 0.2) });
          cursorY -= fontSize * 1.35;
        }
      }
    }
    await yieldToMain();
  }

  if (options?.cropEdgesToFill) {
    // Keep 100% of slide content intact; normalize empty outer margin cleanly only via tight layout without clipping elements
    for (const p of doc.getPages()) {
      p.setCropBox(0, 0, slideW, slideH);
      p.setMediaBox(0, 0, slideW, slideH);
    }
  }

  const bytes = await doc.save({ useObjectStreams: true });
  return { blob: toPdfBlob(bytes), pageCount: doc.getPageCount() };
}

/* -------------------------------------------------------------------------- */
/* 9. HTML TO PDF                                                             */
/* -------------------------------------------------------------------------- */
export async function htmlToPdf(
  htmlContent: string,
  pageSize: 'a4' | 'letter' = 'a4',
  options?: { cropEdgesToFill?: boolean }
): Promise<{ blob: Blob; pageCount: number }> {
  const blocks = htmlStringToBlocks(htmlContent);
  if (blocks.length === 0) {
    blocks.push({ kind: 'p', text: htmlContent.replace(/<[^>]+>/g, ' ').trim() || 'Empty HTML Document' });
  }
  return renderBlocksToPdf(blocks, pageSize, options?.cropEdgesToFill ? 14 : 50);
}

/* -------------------------------------------------------------------------- */
/* 10. ZIP TO PDF (Recursive Unzip + Multi-Format Convert + Ordered Merge)    */
/* -------------------------------------------------------------------------- */
export type ConvertibleFileKind =
  | 'pdf'
  | 'image'
  | 'word'
  | 'excel'
  | 'powerpoint'
  | 'html'
  | 'text'
  | 'unsupported';

export interface ConvertibleEntry {
  id: string;
  path: string;
  name: string;
  kind: ConvertibleFileKind;
  mime: string;
  bytes: Uint8Array;
  size: number;
  pageCount?: number;
  include: boolean;
  sourceArchive?: string;
}

function classifyEntry(name: string, bytes: Uint8Array): { kind: ConvertibleFileKind; mime: string } {
  const lower = name.toLowerCase();
  // Magic-byte checks first for reliability
  const isPdfMagic =
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d;
  if (isPdfMagic || lower.endsWith('.pdf')) {
    return { kind: 'pdf', mime: 'application/pdf' };
  }
  if (
    (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg')
  ) {
    return { kind: 'image', mime: 'image/jpeg' };
  }
  if (
    (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) ||
    lower.endsWith('.png')
  ) {
    return { kind: 'image', mime: 'image/png' };
  }
  if (lower.endsWith('.webp')) return { kind: 'image', mime: 'image/webp' };
  if (lower.endsWith('.gif')) return { kind: 'image', mime: 'image/gif' };
  if (lower.endsWith('.bmp')) return { kind: 'image', mime: 'image/bmp' };
  if (lower.endsWith('.docx') || lower.endsWith('.rtf')) {
    return {
      kind: 'word',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
  }
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.csv') || lower.endsWith('.ods')) {
    return {
      kind: 'excel',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }
  if (lower.endsWith('.pptx')) {
    return {
      kind: 'powerpoint',
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
  }
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    return { kind: 'html', mime: 'text/html' };
  }
  if (/\.(txt|md|markdown|log|json|xml|yaml|yml|ini|cfg)$/i.test(lower)) {
    return { kind: 'text', mime: 'text/plain' };
  }
  return { kind: 'unsupported', mime: 'application/octet-stream' };
}

export async function unzipToConvertibleItems(
  file: WorkspaceFile,
  onProgress?: ProgressCallback
): Promise<ConvertibleEntry[]> {
  const entries: ConvertibleEntry[] = [];

  const processZipBytes = async (zipBytes: Uint8Array, archiveLabel: string, depth = 0) => {
    if (depth > 3) return;
    const zip = await JSZip.loadAsync(zipBytes);
    const paths = Object.keys(zip.files).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
    );

    for (let i = 0; i < paths.length; i++) {
      const fullPath = paths[i];
      const zipObj = zip.files[fullPath];
      if (zipObj.dir) continue;
      // Skip OS metadata junk
      if (
        fullPath.includes('__MACOSX/') ||
        fullPath.endsWith('.DS_Store') ||
        fullPath.endsWith('Thumbs.db')
      ) {
        continue;
      }

      onProgress?.({
        current: i + 1,
        total: paths.length,
        label: `Unpacking ${fullPath}`,
      });

      const bytes = await zipObj.async('uint8array');
      const baseName = fullPath.split('/').pop() || fullPath;

      if (baseName.toLowerCase().endsWith('.zip')) {
        await processZipBytes(bytes, baseName, depth + 1);
        continue;
      }

      const { kind, mime } = classifyEntry(baseName, bytes);
      let pageCount: number | undefined;
      if (kind === 'pdf') {
        try {
          const proxy = await openPdfJs(bytes);
          pageCount = proxy.numPages;
          await destroyPdfJs(proxy);
        } catch {
          // Leave pageCount undefined if encrypted/damaged
        }
      }

      entries.push({
        id: `zip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        path: fullPath,
        name: baseName,
        kind,
        mime,
        bytes,
        size: bytes.byteLength,
        pageCount,
        include: kind !== 'unsupported',
        sourceArchive: archiveLabel,
      });

      if (i % 15 === 0) await yieldToMain();
    }
  };

  if (file.name.toLowerCase().endsWith('.zip') || file.type.includes('zip')) {
    await processZipBytes(file.bytes, file.name);
  } else {
    const { kind, mime } = classifyEntry(file.name, file.bytes);
    entries.push({
      id: `loose_${file.id}`,
      path: file.name,
      name: file.name,
      kind,
      mime,
      bytes: file.bytes,
      size: file.size,
      pageCount: file.pageCount,
      include: kind !== 'unsupported',
    });
  }

  return entries;
}

export async function convertOrderedItemsToPdf(
  items: ConvertibleEntry[],
  options: {
    pageSize: 'a4' | 'letter' | 'fit';
    imageOrientation: 'auto' | 'portrait' | 'landscape';
    excelOrientation: 'landscape' | 'portrait';
    marginPt: number;
    addFileDividers: boolean;
    cropEdgesToFill?: boolean;
  },
  onProgress?: ProgressCallback
): Promise<{ blob: Blob; pageCount: number; convertedCount: number; skippedNames: string[] }> {
  const activeItems = items.filter((it) => it.include && it.kind !== 'unsupported');
  if (activeItems.length === 0) {
    throw new Error('No supported files selected for PDF conversion.');
  }

  const outDoc = await PDFDocument.create();
  const fontBold = await outDoc.embedFont(StandardFonts.HelveticaBold);
  const fontReg = await outDoc.embedFont(StandardFonts.Helvetica);
  const sanitize = (s: string) => s.replace(/[^\x20-\x7E\xA0-\xFF]/g, ' ');
  const skippedNames: string[] = [];
  let convertedCount = 0;

  for (let i = 0; i < activeItems.length; i++) {
    const item = activeItems[i];
    onProgress?.({
      current: i + 1,
      total: activeItems.length,
      label: `Converting & merging (${i + 1}/${activeItems.length}): ${item.name}`,
    });

    const wf: WorkspaceFile = {
      id: item.id,
      name: item.name,
      size: item.size,
      type: item.mime,
      bytes: item.bytes,
      pageCount: item.pageCount,
      createdAt: Date.now(),
    };

    try {
      let itemDocBytes: Uint8Array | null = null;

      if (item.kind === 'pdf') {
        itemDocBytes = item.bytes;
      } else if (item.kind === 'image') {
        const res = await imagesToPdf([wf], {
          pageSize: options.pageSize,
          orientation: options.imageOrientation,
          marginPt: options.marginPt,
          cropEdgesToFill: options.cropEdgesToFill,
        });
        itemDocBytes = new Uint8Array(await res.blob.arrayBuffer());
      } else if (item.kind === 'word' || item.kind === 'text') {
        const res = await wordToPdf(wf, options.pageSize === 'letter' ? 'letter' : 'a4', {
          cropEdgesToFill: options.cropEdgesToFill,
        });
        itemDocBytes = new Uint8Array(await res.blob.arrayBuffer());
      } else if (item.kind === 'excel') {
        const res = await excelToPdf(wf, {
          orientation: options.excelOrientation,
          cropEdgesToFill: options.cropEdgesToFill,
        });
        itemDocBytes = new Uint8Array(await res.blob.arrayBuffer());
      } else if (item.kind === 'powerpoint') {
        const res = await powerPointToPdf(wf, undefined, {
          cropEdgesToFill: options.cropEdgesToFill,
        });
        itemDocBytes = new Uint8Array(await res.blob.arrayBuffer());
      } else if (item.kind === 'html') {
        const htmlStr = new TextDecoder('utf-8').decode(item.bytes);
        const res = await htmlToPdf(htmlStr, options.pageSize === 'letter' ? 'letter' : 'a4', {
          cropEdgesToFill: options.cropEdgesToFill,
        });
        itemDocBytes = new Uint8Array(await res.blob.arrayBuffer());
      }

      if (itemDocBytes) {
        const srcDoc = await PDFDocument.load(itemDocBytes, { ignoreEncryption: true });
        if (options.addFileDividers) {
          const [dw, dh] = options.pageSize === 'letter' ? [612, 792] : [595.28, 841.89];
          const divPage = outDoc.addPage([dw, dh]);
          divPage.drawText(sanitize(item.name), {
            x: 56,
            y: dh / 2 + 12,
            size: 20,
            font: fontBold,
            color: rgb(0.08, 0.12, 0.2),
            maxWidth: dw - 112,
          });
          divPage.drawText(sanitize(item.path), {
            x: 56,
            y: dh / 2 - 14,
            size: 10.5,
            font: fontReg,
            color: rgb(0.4, 0.45, 0.55),
            maxWidth: dw - 112,
          });
        }

        if (
          options.cropEdgesToFill &&
          options.pageSize !== 'fit' &&
          (item.kind === 'pdf' || item.kind === 'powerpoint')
        ) {
          // Fit page dimensions proportionally to content without cropping or adding letterbox borders
          const [tw, th] = options.pageSize === 'letter' ? [612, 792] : [595.28, 841.89];
          for (const srcPage of srcDoc.getPages()) {
            const { width: sw, height: sh } = srcPage.getSize();
            const isLandscape = sw > sh;
            const [pw, ph] = isLandscape ? [th, tw] : [tw, th];
            const embeddedPage = await outDoc.embedPage(srcPage);
            const scale = Math.min(pw / Math.max(1, sw), ph / Math.max(1, sh));
            const dw = sw * scale;
            const dh = sh * scale;
            const outPage = outDoc.addPage([dw, dh]);
            outPage.drawPage(embeddedPage, {
              x: 0,
              y: 0,
              width: dw,
              height: dh,
            });
          }
        } else {
          const copied = await outDoc.copyPages(srcDoc, srcDoc.getPageIndices());
          copied.forEach((p) => outDoc.addPage(p));
        }
        convertedCount++;
      }
    } catch {
      skippedNames.push(item.name);
    }

    await yieldToMain();
  }

  if (outDoc.getPageCount() === 0) {
    throw new Error('Could not convert any of the selected files into PDF pages.');
  }

  const finalBytes = await outDoc.save({ useObjectStreams: true });
  return {
    blob: toPdfBlob(finalBytes),
    pageCount: outDoc.getPageCount(),
    convertedCount,
    skippedNames,
  };
}
