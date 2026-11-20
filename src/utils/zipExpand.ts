import JSZip from 'jszip';
import { WorkspaceFile } from '../types/tools';
import { destroyPdfJs, fileToWorkspaceFile, openPdfJs, uid } from './pdfRuntime';

export type DetectedKind =
  | 'pdf'
  | 'image'
  | 'word'
  | 'excel'
  | 'powerpoint'
  | 'html'
  | 'zip'
  | 'other';

const OOXML_OR_PACKAGE_EXT = /\.(docx|xlsx|xls|xlsm|pptx|pptm|odt|ods|odp)$/i;

export function isZipFile(name: string, mime = '', bytes?: Uint8Array): boolean {
  const lower = name.toLowerCase();
  if (OOXML_OR_PACKAGE_EXT.test(lower)) return false;
  if (
    lower.endsWith('.zip') ||
    mime === 'application/zip' ||
    mime === 'application/x-zip-compressed' ||
    mime === 'multipart/x-zip'
  ) {
    return true;
  }
  if (
    bytes &&
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
    !lower.includes('.')
  ) {
    return true;
  }
  return false;
}

export function withZipAccept(accept: string): string {
  if (!accept || accept === '*' || accept === '*/*') return accept;
  if (accept.toLowerCase().includes('.zip')) return accept;
  return `${accept},.zip,application/zip,application/x-zip-compressed`;
}

export function classifyBinaryFile(
  name: string,
  bytes: Uint8Array,
  mime = ''
): { kind: DetectedKind; mime: string } {
  const lower = name.toLowerCase();

  if (isZipFile(name, mime, bytes)) {
    return { kind: 'zip', mime: 'application/zip' };
  }

  // PDF magic bytes (%PDF-)
  if (
    (bytes.length >= 5 &&
      bytes[0] === 0x25 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x44 &&
      bytes[3] === 0x46 &&
      bytes[4] === 0x2d) ||
    lower.endsWith('.pdf') ||
    mime === 'application/pdf'
  ) {
    return { kind: 'pdf', mime: 'application/pdf' };
  }

  // Raster images (magic bytes + extension)
  if (
    (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    mime === 'image/jpeg'
  ) {
    return { kind: 'image', mime: 'image/jpeg' };
  }
  if (
    (bytes.length >= 4 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47) ||
    lower.endsWith('.png') ||
    mime === 'image/png'
  ) {
    return { kind: 'image', mime: 'image/png' };
  }
  if (
    (bytes.length >= 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50) ||
    lower.endsWith('.webp') ||
    mime === 'image/webp'
  ) {
    return { kind: 'image', mime: 'image/webp' };
  }
  if (
    (bytes.length >= 4 &&
      bytes[0] === 0x47 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x38) ||
    lower.endsWith('.gif') ||
    mime === 'image/gif'
  ) {
    return { kind: 'image', mime: 'image/gif' };
  }
  if (
    (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) ||
    lower.endsWith('.bmp') ||
    mime === 'image/bmp'
  ) {
    return { kind: 'image', mime: 'image/bmp' };
  }
  if (lower.endsWith('.svg') || mime === 'image/svg+xml') {
    return { kind: 'image', mime: 'image/svg+xml' };
  }

  // Word / Text documents
  if (
    lower.endsWith('.docx') ||
    lower.endsWith('.rtf') ||
    lower.endsWith('.txt') ||
    lower.endsWith('.md') ||
    lower.endsWith('.markdown')
  ) {
    return {
      kind: 'word',
      mime: lower.endsWith('.docx')
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'text/plain',
    };
  }

  // Spreadsheets
  if (
    lower.endsWith('.xlsx') ||
    lower.endsWith('.xls') ||
    lower.endsWith('.csv') ||
    lower.endsWith('.ods')
  ) {
    return {
      kind: 'excel',
      mime: lower.endsWith('.csv')
        ? 'text/csv'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }

  // Presentations
  if (lower.endsWith('.pptx')) {
    return {
      kind: 'powerpoint',
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
  }

  // HTML
  if (lower.endsWith('.html') || lower.endsWith('.htm') || mime === 'text/html') {
    return { kind: 'html', mime: 'text/html' };
  }

  return { kind: 'other', mime: mime || 'application/octet-stream' };
}

export function doesEntryMatchAccept(
  name: string,
  bytes: Uint8Array,
  mime: string,
  accept: string
): boolean {
  if (!accept || accept === '*' || accept === '*/*') return true;
  const { kind, mime: detectedMime } = classifyBinaryFile(name, bytes, mime);
  const lowerAccept = accept.toLowerCase();
  const lowerName = name.toLowerCase();

  if (lowerAccept.includes('image/*') || lowerAccept.includes('image/png,image/jpeg')) {
    if (lowerAccept === 'image/png,image/jpeg') {
      return detectedMime === 'image/png' || detectedMime === 'image/jpeg' || kind === 'image';
    }
    return kind === 'image';
  }
  if (lowerAccept.includes('.pdf') || lowerAccept.includes('application/pdf')) {
    if (kind === 'pdf') return true;
  }
  if (lowerAccept.includes('.docx')) {
    if (kind === 'word') return true;
  }
  if (lowerAccept.includes('.xlsx') || lowerAccept.includes('.csv')) {
    if (kind === 'excel') return true;
  }
  if (lowerAccept.includes('.pptx')) {
    if (kind === 'powerpoint') return true;
  }
  if (lowerAccept.includes('.html') || lowerAccept.includes('text/html')) {
    if (kind === 'html') return true;
  }

  const tokens = lowerAccept
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  return tokens.some((tok) => {
    if (tok.startsWith('.')) return lowerName.endsWith(tok);
    if (tok.endsWith('/*')) return detectedMime.startsWith(tok.slice(0, -1));
    return detectedMime === tok;
  });
}

export interface ZipExpandResult {
  matched: WorkspaceFile[];
  zipCount: number;
  totalInsideZip: number;
  skippedNames: string[];
}

export async function expandWorkspaceFilesForAccept(
  items: WorkspaceFile[],
  accept: string
): Promise<ZipExpandResult> {
  // ZIP-to-PDF manages full multi-format archives directly via unzipToConvertibleItems
  if (accept.toLowerCase().includes('.zip')) {
    return {
      matched: items,
      zipCount: 0,
      totalInsideZip: 0,
      skippedNames: [],
    };
  }

  const matched: WorkspaceFile[] = [];
  let zipCount = 0;
  let totalInsideZip = 0;
  const skippedNames: string[] = [];

  const extractArchiveBytes = async (zipBytes: Uint8Array, depth = 0) => {
    if (depth > 3) return;
    const zip = await JSZip.loadAsync(zipBytes);
    const paths = Object.keys(zip.files).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
    );

    for (const fullPath of paths) {
      const obj = zip.files[fullPath];
      if (obj.dir) continue;
      if (
        fullPath.includes('__MACOSX/') ||
        fullPath.endsWith('.DS_Store') ||
        fullPath.endsWith('Thumbs.db')
      ) {
        continue;
      }

      const bytes = await obj.async('uint8array');
      const baseName = fullPath.split('/').pop() || fullPath;

      if (isZipFile(baseName, '', bytes)) {
        await extractArchiveBytes(bytes, depth + 1);
        continue;
      }

      totalInsideZip++;
      const classified = classifyBinaryFile(baseName, bytes);
      if (!doesEntryMatchAccept(baseName, bytes, classified.mime, accept)) {
        skippedNames.push(baseName);
        continue;
      }

      let pageCount: number | undefined;
      if (classified.kind === 'pdf') {
        try {
          const proxy = await openPdfJs(bytes);
          pageCount = proxy.numPages;
          await destroyPdfJs(proxy);
        } catch {
          // Leave undefined if encrypted or damaged so repair/unlock tools can still open it
        }
      }

      matched.push({
        id: uid('zipitem'),
        name: baseName,
        size: bytes.byteLength,
        type: classified.mime,
        bytes,
        pageCount,
        createdAt: Date.now(),
      });
    }
  };

  for (const item of items) {
    if (isZipFile(item.name, item.type, item.bytes)) {
      zipCount++;
      await extractArchiveBytes(item.bytes, 0);
    } else {
      matched.push(item);
    }
  }

  return { matched, zipCount, totalInsideZip, skippedNames };
}

export async function expandFileListForAccept(
  fileList: FileList | File[],
  accept: string
): Promise<ZipExpandResult> {
  const arr = Array.from(fileList);
  const loaded = await Promise.all(arr.map((f) => fileToWorkspaceFile(f)));
  return expandWorkspaceFilesForAccept(loaded, accept);
}

export interface ZipSummary {
  counts: Record<Exclude<DetectedKind, 'zip'>, number>;
  totalFiles: number;
}

export async function inspectZipArchiveSummary(zipFile: WorkspaceFile): Promise<ZipSummary> {
  const counts: ZipSummary['counts'] = {
    pdf: 0,
    image: 0,
    word: 0,
    excel: 0,
    powerpoint: 0,
    html: 0,
    other: 0,
  };
  let totalFiles = 0;

  const walk = async (zipBytes: Uint8Array, depth = 0) => {
    if (depth > 3) return;
    const zip = await JSZip.loadAsync(zipBytes);
    for (const fullPath of Object.keys(zip.files)) {
      const obj = zip.files[fullPath];
      if (obj.dir) continue;
      if (
        fullPath.includes('__MACOSX/') ||
        fullPath.endsWith('.DS_Store') ||
        fullPath.endsWith('Thumbs.db')
      ) {
        continue;
      }
      const bytes = await obj.async('uint8array');
      const baseName = fullPath.split('/').pop() || fullPath;
      if (isZipFile(baseName, '', bytes)) {
        await walk(bytes, depth + 1);
        continue;
      }
      totalFiles++;
      const { kind } = classifyBinaryFile(baseName, bytes);
      if (kind !== 'zip') counts[kind]++;
    }
  };

  await walk(zipFile.bytes, 0);
  return { counts, totalFiles };
}
