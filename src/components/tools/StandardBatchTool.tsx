import React, { useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowDownAZ,
  ArrowUp,
  ArrowUpDown,
  FileText,
  GripVertical,
  Image as ImageIcon,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import {
  ProgressInfo,
  ToolId,
  ToolOutput,
  WorkspaceFile,
} from '../../types/tools';
import {
  addPageNumbers,
  addWatermark,
  compressPdf,
  CompressLevel,
  convertToPdfA,
  imagesToPdf,
  mergePdfs,
  PageNumberPosition,
  pdfToImages,
  protectPdf,
  repairPdf,
  rotatePdfs,
  splitPdf,
  SplitMode,
  unlockPdf,
} from '../../utils/pdfEngines';
import { formatBytes, stripExt } from '../../utils/pdfRuntime';
import { expandFileListForAccept, withZipAccept } from '../../utils/zipExpand';
import { FileDropZone } from '../FileDropZone';
import { OutputPanel } from '../OutputPanel';
import { usePdfJsDocument, VirtualPageThumb } from '../VirtualPageGrid';

interface StandardBatchToolProps {
  toolId: ToolId;
  files: WorkspaceFile[];
  setFiles: React.Dispatch<React.SetStateAction<WorkspaceFile[]>>;
  sessionFiles: WorkspaceFile[];
  onOutputCreated: (output: ToolOutput) => void;
  output: ToolOutput | null;
  onChainToTool: (targetTool: ToolId, output: ToolOutput) => void;
}

export const StandardBatchTool: React.FC<StandardBatchToolProps> = ({
  toolId,
  files,
  setFiles,
  sessionFiles,
  onOutputCreated,
  output,
  onChainToTool,
}) => {
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<ProgressInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [infoLog, setInfoLog] = useState<string[]>([]);

  // Merge per-file page ranges
  const [mergeRanges, setMergeRanges] = useState<Record<string, string>>({});

  // Split options
  const [splitMode, setSplitMode] = useState<SplitMode>('ranges');
  const [splitRangeExpr, setSplitRangeExpr] = useState('1-2; 3-4');
  const [splitEveryN, setSplitEveryN] = useState(1);

  // Compress options
  const [compressLevel, setCompressLevel] = useState<CompressLevel>('balanced');

  // Rotate options
  const [rotateAngle, setRotateAngle] = useState<90 | 180 | 270>(90);
  const [rotateScope, setRotateScope] = useState<'all' | 'odd' | 'even' | 'range'>('all');
  const [rotateRange, setRotateRange] = useState('1-3');

  // Page numbers options
  const [pnPos, setPnPos] = useState<PageNumberPosition>('bottom-center');
  const [pnFormat, setPnFormat] = useState<'n' | 'page-n-of-total' | 'n-slash-total' | 'roman'>('page-n-of-total');
  const [pnFontSize, setPnFontSize] = useState(11);
  const [pnMargin, setPnMargin] = useState(24);
  const [pnStart, setPnStart] = useState(1);
  const [pnSkipFirst, setPnSkipFirst] = useState(false);
  const [pnColor, setPnColor] = useState('#334155');
  const [pnFontFamily, setPnFontFamily] = useState<'Helvetica' | 'TimesRoman' | 'Courier'>('Helvetica');

  // Watermark options
  const [wmMode, setWmMode] = useState<'text' | 'image'>('text');
  const [wmText, setWmText] = useState('CONFIDENTIAL');
  const [wmSize, setWmSize] = useState(48);
  const [wmColor, setWmColor] = useState('#DC2626');
  const [wmOpacity, setWmOpacity] = useState(0.25);
  const [wmRotation, setWmRotation] = useState(45);
  const [wmPlacement, setWmPlacement] = useState<'center' | 'tile' | 'top-right' | 'bottom-right'>('center');
  const [wmPageRange, setWmPageRange] = useState('all');
  const [wmImageFile, setWmImageFile] = useState<WorkspaceFile | null>(null);
  const [wmImageScale, setWmImageScale] = useState(0.35);

  // PDF to JPG options
  const [p2iMode, setP2iMode] = useState<'render-pages' | 'extract-embedded'>('render-pages');
  const [p2iFormat, setP2iFormat] = useState<'jpeg' | 'png'>('jpeg');
  const [p2iDpi, setP2iDpi] = useState<72 | 150 | 300>(150);
  const [p2iQuality, setP2iQuality] = useState(0.88);
  const [p2iRange, setP2iRange] = useState('all');
  const [p2iCropEdges, setP2iCropEdges] = useState(false);

  // Image / JPG to PDF options (0 edge borders by default)
  const [i2pPageSize, setI2pPageSize] = useState<'fit' | 'a4' | 'letter' | 'legal'>('a4');
  const [i2pOrientation, setI2pOrientation] = useState<'auto' | 'portrait' | 'landscape'>('auto');
  const [i2pBorderless, setI2pBorderless] = useState(true);
  const [i2pMargin, setI2pMargin] = useState(0);
  const [i2pCropEdgesToFill, setI2pCropEdgesToFill] = useState(true);

  // PDF/A options
  const [pdfaConf, setPdfaConf] = useState<'1b' | '2b'>('2b');

  // Protect / Unlock options
  const [userPassword, setUserPassword] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [allowPrint, setAllowPrint] = useState(true);
  const [allowCopy, setAllowCopy] = useState(false);
  const [allowModify, setAllowModify] = useState(false);
  const [unlockPassword, setUnlockPassword] = useState('');

  const isMultiFile =
    toolId === 'merge-pdf' ||
    toolId === 'rotate-pdf' ||
    toolId === 'image-to-pdf' ||
    toolId === 'jpg-to-pdf';

  const isImageInput = toolId === 'image-to-pdf' || toolId === 'jpg-to-pdf';
  const primaryFile = files[0];
  const { doc: previewDoc, numPages: previewPages } = usePdfJsDocument(
    !isImageInput && primaryFile ? primaryFile.bytes : undefined
  );

  // Drag-and-drop reorder state & ObjectURL thumbnails for image queues
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [imgThumbMap, setImgThumbMap] = useState<Map<string, string>>(new Map());
  const imgThumbMapRef = React.useRef<Map<string, string>>(imgThumbMap);
  imgThumbMapRef.current = imgThumbMap;

  useEffect(() => {
    if (!isImageInput) return;
    setImgThumbMap((prev) => {
      const next = new Map(prev);
      const activeIds = new Set(files.map((f) => f.id));
      for (const [id, url] of next.entries()) {
        if (!activeIds.has(id)) {
          URL.revokeObjectURL(url);
          next.delete(id);
        }
      }
      for (const f of files) {
        if (!next.has(f.id)) {
          const copy = new Uint8Array(f.bytes.byteLength);
          copy.set(f.bytes);
          next.set(f.id, URL.createObjectURL(new Blob([copy], { type: f.type || 'image/jpeg' })));
        }
      }
      return next;
    });
  }, [files, isImageInput]);

  useEffect(() => {
    return () => {
      imgThumbMapRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  const moveFile = (idx: number, dir: -1 | 1) => {
    const next = [...files];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    setFiles(next);
  };

  const reorderFile = (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx || toIdx < 0 || toIdx >= files.length) return;
    const next = [...files];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    setFiles(next);
  };

  const handleRun = async () => {
    if (files.length === 0) return;
    setProcessing(true);
    setError(null);
    setInfoLog([]);
    setProgress({ current: 0, total: 1, label: 'Starting...' });

    try {
      const base = stripExt(files[0].name);

      if (toolId === 'merge-pdf') {
        const res = await mergePdfs(
          files.map((f) => ({ file: f, pageRange: mergeRanges[f.id] })),
          setProgress
        );
        onOutputCreated({
          id: `${Date.now()}`,
          blob: res.blob,
          fileName: `${base}_merged.pdf`,
          mimeType: 'application/pdf',
          bytesLength: res.blob.size,
          pageCount: res.pageCount,
          summary: `Combined ${files.length} PDFs`,
          canChainToPdfTools: true,
        });
      } else if (toolId === 'split-pdf') {
        const res = await splitPdf(
          files[0],
          { mode: splitMode, rangeExpr: splitRangeExpr, everyN: splitEveryN },
          setProgress
        );
        onOutputCreated({
          id: `${Date.now()}`,
          blob: res.blob,
          fileName: res.fileName,
          mimeType: res.mimeType,
          bytesLength: res.blob.size,
          summary: `Created ${res.fileCount} file(s)`,
          canChainToPdfTools: res.mimeType === 'application/pdf',
        });
      } else if (toolId === 'compress-pdf') {
        const res = await compressPdf(files[0], compressLevel, setProgress);
        const pct = Math.max(
          0,
          Math.round(((res.originalSize - res.compressedSize) / Math.max(1, res.originalSize)) * 100)
        );
        onOutputCreated({
          id: `${Date.now()}`,
          blob: res.blob,
          fileName: `${base}_compressed.pdf`,
          mimeType: 'application/pdf',
          bytesLength: res.compressedSize,
          pageCount: res.pageCount,
          summary: `Saved ${pct}% (${formatBytes(res.originalSize)} → ${formatBytes(res.compressedSize)})`,
          canChainToPdfTools: true,
        });
      } else if (toolId === 'rotate-pdf') {
        const res = await rotatePdfs(
          files,
          { angle: rotateAngle, scope: rotateScope, pageRange: rotateRange },
          setProgress
        );
        onOutputCreated({
          id: `${Date.now()}`,
          blob: res.blob,
          fileName: res.fileName,
          mimeType: res.mimeType,
          bytesLength: res.blob.size,
          summary: `Rotated ${rotateAngle}° (${files.length} file${files.length > 1 ? 's' : ''})`,
          canChainToPdfTools: res.mimeType === 'application/pdf',
        });
      } else if (toolId === 'page-numbers') {
        const res = await addPageNumbers(
          files[0],
          {
            position: pnPos,
            format: pnFormat,
            fontSize: pnFontSize,
            margin: pnMargin,
            startNumber: pnStart,
            skipFirst: pnSkipFirst,
            colorHex: pnColor,
            fontFamily: pnFontFamily,
          },
          setProgress
        );
        onOutputCreated({
          id: `${Date.now()}`,
          blob: res.blob,
          fileName: `${base}_numbered.pdf`,
          mimeType: 'application/pdf',
          bytesLength: res.blob.size,
          pageCount: res.pageCount,
          summary: `Numbered ${res.pageCount} pages`,
          canChainToPdfTools: true,
        });
      } else if (toolId === 'watermark') {
        const res = await addWatermark(
          files[0],
          {
            mode: wmMode,
            text: wmText,
            fontSize: wmSize,
            colorHex: wmColor,
            imageBytes: wmImageFile?.bytes,
            imageMime: wmImageFile?.type,
            imageScale: wmImageScale,
            opacity: wmOpacity,
            rotation: wmRotation,
            placement: wmPlacement,
            pageRange: wmPageRange,
          },
          setProgress
        );
        onOutputCreated({
          id: `${Date.now()}`,
          blob: res.blob,
          fileName: `${base}_watermarked.pdf`,
          mimeType: 'application/pdf',
          bytesLength: res.blob.size,
          pageCount: res.pageCount,
          summary: `Watermark stamped`,
          canChainToPdfTools: true,
        });
      } else if (toolId === 'pdf-to-jpg') {
        const res = await pdfToImages(
          files[0],
          {
            mode: p2iMode,
            format: p2iFormat,
            dpi: p2iDpi,
            quality: p2iQuality,
            pageRange: p2iRange,
            cropBlankEdges: p2iCropEdges,
          },
          setProgress
        );
        onOutputCreated({
          id: `${Date.now()}`,
          blob: res.blob,
          fileName: res.fileName,
          mimeType: res.mimeType,
          bytesLength: res.blob.size,
          summary: `Exported ${res.imageCount} image(s)`,
          canChainToPdfTools: false,
        });
      } else if (toolId === 'image-to-pdf' || toolId === 'jpg-to-pdf') {
        const res = await imagesToPdf(
          files,
          {
            pageSize: i2pPageSize,
            orientation: i2pOrientation,
            marginPt: i2pBorderless ? 0 : i2pMargin,
            cropEdgesToFill: i2pCropEdgesToFill,
          },
          setProgress
        );
        onOutputCreated({
          id: `${Date.now()}`,
          blob: res.blob,
          fileName: `${base}_images.pdf`,
          mimeType: 'application/pdf',
          bytesLength: res.blob.size,
          pageCount: res.pageCount,
          summary: `Compiled ${res.pageCount} image(s)`,
          canChainToPdfTools: true,
        });
      } else if (toolId === 'pdf-to-pdfa') {
        const res = await convertToPdfA(files[0], pdfaConf);
        setInfoLog(res.checks);
        onOutputCreated({
          id: `${Date.now()}`,
          blob: res.blob,
          fileName: `${base}_PDFA-${pdfaConf.toUpperCase()}.pdf`,
          mimeType: 'application/pdf',
          bytesLength: res.blob.size,
          pageCount: res.pageCount,
          summary: `ISO PDF/A-${pdfaConf.toUpperCase()} compliant`,
          canChainToPdfTools: true,
        });
      } else if (toolId === 'protect-pdf') {
        if (!userPassword.trim()) throw new Error('Please enter an open password to encrypt the PDF.');
        const res = await protectPdf(files[0], {
          userPassword,
          ownerPassword: ownerPassword || userPassword,
          allowPrint,
          allowCopy,
          allowModify,
          allowAnnotations: allowModify,
        });
        onOutputCreated({
          id: `${Date.now()}`,
          blob: res.blob,
          fileName: `${base}_protected.pdf`,
          mimeType: 'application/pdf',
          bytesLength: res.blob.size,
          pageCount: res.pageCount,
          summary: 'Encrypted with RC4-128 security',
          canChainToPdfTools: false,
        });
      } else if (toolId === 'unlock-pdf') {
        const res = await unlockPdf(files[0], unlockPassword, setProgress);
        setInfoLog([res.method]);
        onOutputCreated({
          id: `${Date.now()}`,
          blob: res.blob,
          fileName: `${base}_unlocked.pdf`,
          mimeType: 'application/pdf',
          bytesLength: res.blob.size,
          pageCount: res.pageCount,
          summary: res.method,
          canChainToPdfTools: true,
        });
      } else if (toolId === 'repair-pdf') {
        const res = await repairPdf(files[0], setProgress);
        setInfoLog(res.log);
        onOutputCreated({
          id: `${Date.now()}`,
          blob: res.blob,
          fileName: `${base}_repaired.pdf`,
          mimeType: 'application/pdf',
          bytesLength: res.blob.size,
          pageCount: res.pageCount,
          summary: `Recovered ${res.pageCount} pages`,
          canChainToPdfTools: true,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Processing failed.');
    } finally {
      setProcessing(false);
      setProgress(null);
    }
  };

  const actionLabelMap: Partial<Record<ToolId, string>> = {
    'merge-pdf': 'Merge PDFs',
    'split-pdf': 'Split PDF',
    'compress-pdf': 'Compress PDF',
    'rotate-pdf': 'Apply Rotation',
    'page-numbers': 'Add Page Numbers',
    watermark: 'Apply Watermark',
    'pdf-to-jpg': 'Export Images',
    'image-to-pdf': 'Create PDF from Images',
    'jpg-to-pdf': 'Create PDF from JPGs',
    'pdf-to-pdfa': 'Convert to PDF/A',
    'protect-pdf': 'Encrypt PDF',
    'unlock-pdf': 'Unlock PDF',
    'repair-pdf': 'Repair PDF',
  };

  return (
    <div className="space-y-6">
      {files.length === 0 ? (
        <>
          <OutputPanel output={output} onChainToTool={onChainToTool} />
          <FileDropZone
            accept={isImageInput ? 'image/*' : '.pdf,application/pdf'}
            multiple={isMultiFile}
            label={
              isImageInput
                ? 'Drop JPG, PNG, WebP, or GIF images here'
                : isMultiFile
                  ? 'Drop one or more PDF files here'
                  : 'Drop a PDF file here'
            }
            onFilesAdded={(added) => setFiles(isMultiFile ? added : [added[0]])}
            existingLibrary={sessionFiles}
          />
        </>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left: File Queue or Virtualized Page Grid */}
          <div className="lg:col-span-8 space-y-4">
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                    Files to Convert ({files.length})
                  </h2>
                  {isMultiFile && files.length > 1 && (
                    <p className="text-xs text-slate-500">
                      Drag rows or use arrows to reorder before generating PDF
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {isMultiFile && files.length > 1 && (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          setFiles((prev) =>
                            [...prev].sort((a, b) =>
                              a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
                            )
                          )
                        }
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                      >
                        <ArrowDownAZ className="w-3.5 h-3.5" />
                        A–Z
                      </button>
                      <button
                        type="button"
                        onClick={() => setFiles((prev) => [...prev].reverse())}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                      >
                        <ArrowUpDown className="w-3.5 h-3.5" />
                        Reverse
                      </button>
                    </>
                  )}
                  {isMultiFile && (
                    <label className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer">
                      <Plus className="w-3.5 h-3.5" />
                      Add More
                      <input
                        type="file"
                        multiple
                        accept={withZipAccept(isImageInput ? 'image/*' : '.pdf,application/pdf')}
                        className="hidden"
                        onChange={async (e) => {
                          if (!e.target.files) return;
                          const acceptPattern = isImageInput ? 'image/*' : '.pdf,application/pdf';
                          const res = await expandFileListForAccept(e.target.files, acceptPattern);
                          if (res.matched.length > 0) {
                            setFiles((prev) => [...prev, ...res.matched]);
                          } else if (res.zipCount > 0) {
                            setError(
                              `ZIP unpacked (${res.totalInsideZip} files), none matched ${isImageInput ? 'image formats' : 'PDF'}.`
                            );
                          }
                          e.target.value = '';
                        }}
                      />
                    </label>
                  )}
                  <button
                    type="button"
                    onClick={() => setFiles([])}
                    className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-red-600 cursor-pointer px-1.5"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Reset
                  </button>
                </div>
              </div>

              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {files.map((f, idx) => {
                  const thumbUrl = isImageInput ? imgThumbMap.get(f.id) : undefined;
                  const isDragging = dragIdx === idx;
                  const isOver = overIdx === idx && dragIdx !== idx;
                  return (
                    <div
                      key={f.id}
                      draggable={isMultiFile}
                      onDragStart={() => isMultiFile && setDragIdx(idx)}
                      onDragOver={(e) => {
                        if (!isMultiFile) return;
                        e.preventDefault();
                        if (overIdx !== idx) setOverIdx(idx);
                      }}
                      onDrop={(e) => {
                        if (!isMultiFile) return;
                        e.preventDefault();
                        if (dragIdx !== null) reorderFile(dragIdx, idx);
                        setDragIdx(null);
                        setOverIdx(null);
                      }}
                      onDragEnd={() => {
                        setDragIdx(null);
                        setOverIdx(null);
                      }}
                      className={`flex flex-wrap items-center justify-between gap-3 py-2.5 px-1.5 rounded-lg transition-colors ${
                        isDragging ? 'opacity-45 bg-slate-100 dark:bg-slate-800' : ''
                      } ${isOver ? 'border-t-2 border-red-600 bg-red-50/40 dark:bg-red-950/20' : ''}`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        {isMultiFile && (
                          <GripVertical className="w-4 h-4 text-slate-400 cursor-grab shrink-0" />
                        )}
                        <span className="text-xs font-mono tabular-nums text-slate-400 w-6 shrink-0">
                          #{idx + 1}
                        </span>
                        {thumbUrl ? (
                          <img
                            src={thumbUrl}
                            alt={f.name}
                            className="w-9 h-9 rounded border border-slate-200 dark:border-slate-700 object-cover bg-slate-50 shrink-0"
                          />
                        ) : isImageInput ? (
                          <ImageIcon className="w-4 h-4 text-red-600 shrink-0" />
                        ) : (
                          <FileText className="w-4 h-4 text-red-600 shrink-0" />
                        )}
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate max-w-[280px]">
                            {f.name}
                          </p>
                          <p className="text-xs text-slate-500 font-mono tabular-nums">
                            {formatBytes(f.size)}
                            {f.pageCount ? ` · ${f.pageCount} pages` : ''}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {toolId === 'merge-pdf' && (
                          <input
                            type="text"
                            value={mergeRanges[f.id] || ''}
                            onChange={(e) =>
                              setMergeRanges((prev) => ({ ...prev, [f.id]: e.target.value }))
                            }
                            placeholder="Pages (e.g. 1-3, 5)"
                            className="w-36 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2 py-1 text-xs text-slate-800 dark:text-slate-100"
                          />
                        )}
                        {isMultiFile && (
                          <>
                            <button
                              type="button"
                              onClick={() => moveFile(idx, -1)}
                              disabled={idx === 0}
                              className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-30 cursor-pointer"
                              aria-label="Move up"
                            >
                              <ArrowUp className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => moveFile(idx, 1)}
                              disabled={idx === files.length - 1}
                              className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-30 cursor-pointer"
                              aria-label="Move down"
                            >
                              <ArrowDown className="w-4 h-4" />
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() => setFiles((prev) => prev.filter((x) => x.id !== f.id))}
                          className="p-1 text-slate-400 hover:text-red-600 cursor-pointer"
                          aria-label="Remove file"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Virtualized Page Preview for single PDF */}
            {!isImageInput && previewDoc && previewPages > 0 && (
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                    Document Preview ({previewPages} pages · lazy-rendered)
                  </h3>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 max-h-[520px] overflow-y-auto pr-1">
                  {Array.from({ length: previewPages }, (_, i) => i + 1).map((pNum) => (
                    <div
                      key={pNum}
                      className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden bg-slate-50 dark:bg-slate-950"
                    >
                      <VirtualPageThumb
                        pdfDoc={previewDoc}
                        pageNumber={pNum}
                        rotation={toolId === 'rotate-pdf' ? rotateAngle : 0}
                        width={170}
                        className="aspect-[3/4]"
                      />
                      <div className="px-2 py-1 text-center text-[11px] font-mono tabular-nums text-slate-500 border-t border-slate-100 dark:border-slate-800">
                        Page {pNum}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right: Tool Inspector Panel */}
          <div className="lg:col-span-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-5">
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-white border-b border-slate-100 dark:border-slate-800 pb-3">
              Parameters & Options
            </h2>

            {toolId === 'split-pdf' && (
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Split Method
                  </label>
                  <select
                    value={splitMode}
                    onChange={(e) => setSplitMode(e.target.value as SplitMode)}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
                  >
                    <option value="ranges">Custom Range Groups (;-separated)</option>
                    <option value="every-n">Fixed Chunk (Every N Pages)</option>
                    <option value="extract">Extract Specific Pages to 1 PDF</option>
                    <option value="burst">Burst All Pages into Separate PDFs</option>
                  </select>
                </div>
                {(splitMode === 'ranges' || splitMode === 'extract') && (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      {splitMode === 'ranges' ? 'Range Groups (e.g. 1-3; 4-8; 9)' : 'Pages to Extract (e.g. 1, 3-5)'}
                    </label>
                    <input
                      type="text"
                      value={splitRangeExpr}
                      onChange={(e) => setSplitRangeExpr(e.target.value)}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm font-mono"
                    />
                  </div>
                )}
                {splitMode === 'every-n' && (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                      Pages per Output PDF
                    </label>
                    <input
                      type="number"
                      min={1}
                      value={splitEveryN}
                      onChange={(e) => setSplitEveryN(Math.max(1, Number(e.target.value)))}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm font-mono"
                    />
                  </div>
                )}
              </div>
            )}

            {toolId === 'compress-pdf' && (
              <div className="space-y-3">
                {(
                  [
                    {
                      id: 'structural',
                      title: 'Lossless Structural Optimization',
                      desc: 'Keeps vector text 100% intact; enables object streams & strips metadata.',
                    },
                    {
                      id: 'balanced',
                      title: 'Balanced Compression (Recommended)',
                      desc: 'Re-encodes pages at crisp 100 DPI JPEG for significant size reduction.',
                    },
                    {
                      id: 'maximum',
                      title: 'Maximum Compression',
                      desc: 'Aggressive 72 DPI JPEG encoding for smallest possible file weight.',
                    },
                  ] as const
                ).map((lvl) => (
                  <button
                    key={lvl.id}
                    type="button"
                    onClick={() => setCompressLevel(lvl.id)}
                    className={`w-full rounded-lg border p-3 text-left transition-colors cursor-pointer ${
                      compressLevel === lvl.id
                        ? 'border-red-600 bg-red-50/60 dark:bg-red-950/30'
                        : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'
                    }`}
                  >
                    <p className="text-xs font-semibold text-slate-900 dark:text-white">{lvl.title}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{lvl.desc}</p>
                  </button>
                ))}
              </div>
            )}

            {toolId === 'rotate-pdf' && (
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Rotation Angle
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {([90, 180, 270] as const).map((deg) => (
                      <button
                        key={deg}
                        type="button"
                        onClick={() => setRotateAngle(deg)}
                        className={`rounded-lg border py-2 text-xs font-mono font-semibold cursor-pointer ${
                          rotateAngle === deg
                            ? 'border-red-600 bg-red-600 text-white'
                            : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200'
                        }`}
                      >
                        {deg}°
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    Target Pages
                  </label>
                  <select
                    value={rotateScope}
                    onChange={(e) => setRotateScope(e.target.value as 'all' | 'odd' | 'even' | 'range')}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
                  >
                    <option value="all">All Pages</option>
                    <option value="odd">Odd Pages Only</option>
                    <option value="even">Even Pages Only</option>
                    <option value="range">Custom Range</option>
                  </select>
                </div>
                {rotateScope === 'range' && (
                  <input
                    type="text"
                    value={rotateRange}
                    onChange={(e) => setRotateRange(e.target.value)}
                    placeholder="e.g. 1-3, 5"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm font-mono"
                  />
                )}
              </div>
            )}

            {toolId === 'page-numbers' && (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium mb-1">Position</label>
                  <select
                    value={pnPos}
                    onChange={(e) => setPnPos(e.target.value as PageNumberPosition)}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
                  >
                    <option value="bottom-center">Bottom Center</option>
                    <option value="bottom-left">Bottom Left</option>
                    <option value="bottom-right">Bottom Right</option>
                    <option value="top-center">Top Center</option>
                    <option value="top-left">Top Left</option>
                    <option value="top-right">Top Right</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Format</label>
                  <select
                    value={pnFormat}
                    onChange={(e) =>
                      setPnFormat(e.target.value as 'n' | 'page-n-of-total' | 'n-slash-total' | 'roman')
                    }
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
                  >
                    <option value="page-n-of-total">Page 1 of N</option>
                    <option value="n">1, 2, 3...</option>
                    <option value="n-slash-total">1 / N</option>
                    <option value="roman">Roman (i, ii, iii)</option>
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-medium mb-1">Font</label>
                    <select
                      value={pnFontFamily}
                      onChange={(e) =>
                        setPnFontFamily(e.target.value as 'Helvetica' | 'TimesRoman' | 'Courier')
                      }
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-2 text-xs"
                    >
                      <option value="Helvetica">Helvetica</option>
                      <option value="TimesRoman">Times Roman</option>
                      <option value="Courier">Courier</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Size (pt)</label>
                    <input
                      type="number"
                      min={6}
                      max={36}
                      value={pnFontSize}
                      onChange={(e) => setPnFontSize(Number(e.target.value))}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-2 text-xs font-mono"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="block text-xs font-medium mb-1">Start #</label>
                    <input
                      type="number"
                      min={1}
                      value={pnStart}
                      onChange={(e) => setPnStart(Number(e.target.value))}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1.5 text-xs font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Margin</label>
                    <input
                      type="number"
                      min={8}
                      max={96}
                      value={pnMargin}
                      onChange={(e) => setPnMargin(Number(e.target.value))}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1.5 text-xs font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Color</label>
                    <input
                      type="color"
                      value={pnColor}
                      onChange={(e) => setPnColor(e.target.value)}
                      className="h-8 w-full rounded border border-slate-200 dark:border-slate-700 cursor-pointer"
                    />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={pnSkipFirst}
                    onChange={(e) => setPnSkipFirst(e.target.checked)}
                  />
                  Skip cover page (page 1)
                </label>
              </div>
            )}

            {toolId === 'watermark' && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setWmMode('text')}
                    className={`rounded-lg py-2 text-xs font-semibold border cursor-pointer ${
                      wmMode === 'text'
                        ? 'border-red-600 bg-red-600 text-white'
                        : 'border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    Text Stamp
                  </button>
                  <button
                    type="button"
                    onClick={() => setWmMode('image')}
                    className={`rounded-lg py-2 text-xs font-semibold border cursor-pointer ${
                      wmMode === 'image'
                        ? 'border-red-600 bg-red-600 text-white'
                        : 'border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    Image Stamp
                  </button>
                </div>

                {wmMode === 'text' ? (
                  <>
                    <input
                      type="text"
                      value={wmText}
                      onChange={(e) => setWmText(e.target.value)}
                      placeholder="Watermark text"
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-xs mb-1">Font Size</label>
                        <input
                          type="number"
                          value={wmSize}
                          onChange={(e) => setWmSize(Number(e.target.value))}
                          className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1.5 text-xs font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-xs mb-1">Color</label>
                        <input
                          type="color"
                          value={wmColor}
                          onChange={(e) => setWmColor(e.target.value)}
                          className="h-8 w-full rounded border border-slate-200 dark:border-slate-700"
                        />
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="space-y-2">
                    <label className="block rounded-lg border border-dashed border-slate-300 dark:border-slate-700 p-3 text-center text-xs cursor-pointer hover:border-red-500">
                      {wmImageFile ? wmImageFile.name : 'Upload PNG or JPG watermark image'}
                      <input
                        type="file"
                        accept={withZipAccept('image/png,image/jpeg')}
                        className="hidden"
                        onChange={async (e) => {
                          if (!e.target.files?.length) return;
                          const res = await expandFileListForAccept(e.target.files, 'image/png,image/jpeg');
                          if (res.matched[0]) {
                            setWmImageFile(res.matched[0]);
                          }
                          e.target.value = '';
                        }}
                      />
                    </label>
                    <div>
                      <label className="block text-xs mb-1">
                        Scale ({Math.round(wmImageScale * 100)}%)
                      </label>
                      <input
                        type="range"
                        min={0.1}
                        max={1.2}
                        step={0.05}
                        value={wmImageScale}
                        onChange={(e) => setWmImageScale(Number(e.target.value))}
                        className="w-full"
                      />
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-xs mb-1">Placement</label>
                  <select
                    value={wmPlacement}
                    onChange={(e) =>
                      setWmPlacement(
                        e.target.value as 'center' | 'tile' | 'top-right' | 'bottom-right'
                      )
                    }
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
                  >
                    <option value="center">Center</option>
                    <option value="tile">Tiled Grid</option>
                    <option value="top-right">Top Right</option>
                    <option value="bottom-right">Bottom Right</option>
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs mb-1">
                      Opacity ({Math.round(wmOpacity * 100)}%)
                    </label>
                    <input
                      type="range"
                      min={0.05}
                      max={1}
                      step={0.05}
                      value={wmOpacity}
                      onChange={(e) => setWmOpacity(Number(e.target.value))}
                      className="w-full"
                    />
                  </div>
                  <div>
                    <label className="block text-xs mb-1">Angle ({wmRotation}°)</label>
                    <input
                      type="number"
                      value={wmRotation}
                      onChange={(e) => setWmRotation(Number(e.target.value))}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1 text-xs font-mono"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs mb-1">Page Range</label>
                  <input
                    type="text"
                    value={wmPageRange}
                    onChange={(e) => setWmPageRange(e.target.value)}
                    placeholder="all or 1-5"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-mono"
                  />
                </div>
              </div>
            )}

            {toolId === 'pdf-to-jpg' && (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium mb-1">Mode</label>
                  <select
                    value={p2iMode}
                    onChange={(e) =>
                      setP2iMode(e.target.value as 'render-pages' | 'extract-embedded')
                    }
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
                  >
                    <option value="render-pages">Convert Every Page to Image</option>
                    <option value="extract-embedded">Extract Embedded Images Only</option>
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs mb-1">Format</label>
                    <select
                      value={p2iFormat}
                      onChange={(e) => setP2iFormat(e.target.value as 'jpeg' | 'png')}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-2 text-xs"
                    >
                      <option value="jpeg">JPG</option>
                      <option value="png">PNG</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs mb-1">Resolution</label>
                    <select
                      value={p2iDpi}
                      onChange={(e) => setP2iDpi(Number(e.target.value) as 72 | 150 | 300)}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-2 text-xs font-mono"
                    >
                      <option value={72}>72 DPI</option>
                      <option value={150}>150 DPI</option>
                      <option value={300}>300 DPI</option>
                    </select>
                  </div>
                </div>
                {p2iFormat === 'jpeg' && (
                  <div>
                    <label className="block text-xs mb-1">
                      JPEG Quality ({Math.round(p2iQuality * 100)}%)
                    </label>
                    <input
                      type="range"
                      min={0.4}
                      max={1}
                      step={0.05}
                      value={p2iQuality}
                      onChange={(e) => setP2iQuality(Number(e.target.value))}
                      className="w-full"
                    />
                  </div>
                )}
                <div>
                  <label className="block text-xs mb-1">Pages</label>
                  <input
                    type="text"
                    value={p2iRange}
                    onChange={(e) => setP2iRange(e.target.value)}
                    placeholder="all or 1-4"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-mono"
                  />
                </div>
                {p2iMode === 'render-pages' && (
                  <label className="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer pt-1">
                    <input
                      type="checkbox"
                      checked={p2iCropEdges}
                      onChange={(e) => setP2iCropEdges(e.target.checked)}
                      className="mt-0.5 accent-red-600"
                    />
                    <span>Crop blank page margins (never crops content)</span>
                  </label>
                )}
              </div>
            )}

            {(toolId === 'image-to-pdf' || toolId === 'jpg-to-pdf') && (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium mb-1">Page Size</label>
                  <select
                    value={i2pPageSize}
                    onChange={(e) =>
                      setI2pPageSize(e.target.value as 'fit' | 'a4' | 'letter' | 'legal')
                    }
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
                  >
                    <option value="a4">A4 (210 × 297 mm)</option>
                    <option value="letter">US Letter</option>
                    <option value="legal">US Legal</option>
                    <option value="fit">Fit Page to Image Size</option>
                  </select>
                </div>
                {i2pPageSize !== 'fit' && (
                  <div>
                    <label className="block text-xs font-medium mb-1">Orientation</label>
                    <select
                      value={i2pOrientation}
                      onChange={(e) =>
                        setI2pOrientation(e.target.value as 'auto' | 'portrait' | 'landscape')
                      }
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
                    >
                      <option value="auto">Auto (Match Image)</option>
                      <option value="portrait">Portrait</option>
                      <option value="landscape">Landscape</option>
                    </select>
                  </div>
                )}
                <label className="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={i2pBorderless}
                    onChange={(e) => setI2pBorderless(e.target.checked)}
                    className="mt-0.5 accent-red-600"
                  />
                  <span>Borderless images (no edge margins)</span>
                </label>
                {i2pPageSize !== 'fit' && (
                  <label className="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={i2pCropEdgesToFill}
                      onChange={(e) => setI2pCropEdgesToFill(e.target.checked)}
                      className="mt-0.5 accent-red-600"
                    />
                    <span>Crop page margins to fit full image (never crops image)</span>
                  </label>
                )}
                {!i2pBorderless && (
                  <div>
                    <label className="block text-xs font-medium mb-1">Margin ({i2pMargin} pt)</label>
                    <input
                      type="range"
                      min={0}
                      max={72}
                      step={6}
                      value={i2pMargin}
                      onChange={(e) => setI2pMargin(Number(e.target.value))}
                      className="w-full"
                    />
                  </div>
                )}
              </div>
            )}

            {toolId === 'pdf-to-pdfa' && (
              <div className="space-y-3">
                <label className="block text-xs font-medium">ISO Archival Standard</label>
                <select
                  value={pdfaConf}
                  onChange={(e) => setPdfaConf(e.target.value as '1b' | '2b')}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
                >
                  <option value="2b">PDF/A-2b (ISO 19005-2, Recommended)</option>
                  <option value="1b">PDF/A-1b (ISO 19005-1 Legacy)</option>
                </select>
                <p className="text-xs text-slate-500">
                  Flattens interactive forms, strips active triggers, embeds XMP archival metadata and sRGB OutputIntent.
                </p>
              </div>
            )}

            {toolId === 'protect-pdf' && (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium mb-1">Open Password (Required)</label>
                  <input
                    type="password"
                    value={userPassword}
                    onChange={(e) => setUserPassword(e.target.value)}
                    placeholder="Enter strong password"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Owner Permissions Password (Optional)</label>
                  <input
                    type="password"
                    value={ownerPassword}
                    onChange={(e) => setOwnerPassword(e.target.value)}
                    placeholder="Defaults to open password"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
                  />
                </div>
                <div className="space-y-1.5 pt-1 text-xs">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={allowPrint}
                      onChange={(e) => setAllowPrint(e.target.checked)}
                    />
                    Allow Printing
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={allowCopy}
                      onChange={(e) => setAllowCopy(e.target.checked)}
                    />
                    Allow Text & Image Copying
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={allowModify}
                      onChange={(e) => setAllowModify(e.target.checked)}
                    />
                    Allow Document Modifications
                  </label>
                </div>
              </div>
            )}

            {toolId === 'unlock-pdf' && (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium mb-1">
                    Document Password (leave blank for owner-only locks)
                  </label>
                  <input
                    type="password"
                    value={unlockPassword}
                    onChange={(e) => setUnlockPassword(e.target.value)}
                    placeholder="Enter PDF password if required"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
                  />
                </div>
              </div>
            )}

            {toolId === 'repair-pdf' && (
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                Repairs corrupted headers, broken xref tables, missing EOF trailers, and salvages readable pages using tolerant stream decoding.
              </p>
            )}

            {toolId === 'merge-pdf' && (
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                Reorder files using the arrows on the left. Optionally specify page ranges per file (e.g. <span className="font-mono">1-3, 5</span>).
              </p>
            )}

            {progress && (
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs text-slate-600 dark:text-slate-300">
                  <span className="truncate">{progress.label}</span>
                  <span className="font-mono tabular-nums">
                    {progress.current}/{progress.total}
                  </span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                  <div
                    className="h-full bg-red-600 transition-all"
                    style={{
                      width: `${Math.min(100, Math.round((progress.current / Math.max(1, progress.total)) * 100))}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {error && (
              <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-3 text-xs text-red-700 dark:text-red-300">
                {error}
              </div>
            )}

            {infoLog.length > 0 && (
              <ul className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3 space-y-1 text-xs text-slate-600 dark:text-slate-300">
                {infoLog.map((line, i) => (
                  <li key={i}>• {line}</li>
                ))}
              </ul>
            )}

            <button
              type="button"
              onClick={handleRun}
              disabled={processing}
              className="w-full rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 py-2.5 px-4 text-sm font-semibold text-white transition-colors cursor-pointer"
            >
              {processing ? 'Processing locally...' : actionLabelMap[toolId] || 'Run Tool'}
            </button>

            <OutputPanel output={output} onChainToTool={onChainToTool} compact />
          </div>
        </div>
      )}
    </div>
  );
};
