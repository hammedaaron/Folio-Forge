import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  FilePlus,
  PlusSquare,
  RotateCw,
  Trash2,
} from 'lucide-react';
import { ToolId, ToolOutput, WorkspaceFile } from '../../types/tools';
import { cropPdf, organizePdf, OrganizePageInstruction } from '../../utils/pdfEngines';
import { destroyPdfJs, openPdfJs, pdfjsLib, stripExt } from '../../utils/pdfRuntime';
import { expandFileListForAccept, withZipAccept } from '../../utils/zipExpand';
import { FileDropZone } from '../FileDropZone';
import { OutputPanel } from '../OutputPanel';
import { InteractivePageCanvas, usePdfJsDocument, VirtualPageThumb } from '../VirtualPageGrid';

interface OrganizeCropToolProps {
  toolId: 'organize-pdf' | 'crop-pdf';
  files: WorkspaceFile[];
  setFiles: React.Dispatch<React.SetStateAction<WorkspaceFile[]>>;
  sessionFiles: WorkspaceFile[];
  onOutputCreated: (output: ToolOutput) => void;
  output: ToolOutput | null;
  onChainToTool: (targetTool: ToolId, output: ToolOutput) => void;
}

interface PageItem {
  uid: string;
  sourceFileId: string;
  sourcePageIndex: number; // -1 = blank
  rotation: number;
}

export const OrganizeCropTool: React.FC<OrganizeCropToolProps> = ({
  toolId,
  files,
  setFiles,
  sessionFiles,
  onOutputCreated,
  output,
  onChainToTool,
}) => {
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Organize state
  const [pageItems, setPageItems] = useState<PageItem[]>([]);
  const [proxyMap, setProxyMap] = useState<Map<string, pdfjsLib.PDFDocumentProxy>>(new Map());
  const loadedFileIds = useRef<Set<string>>(new Set());

  // Crop state
  const [cropPage, setCropPage] = useState(1);
  const [cropScope, setCropScope] = useState<'all' | 'range'>('all');
  const [cropRange, setCropRange] = useState('1');
  const [cropMargins, setCropMargins] = useState({ left: 0.08, top: 0.08, right: 0.08, bottom: 0.08 });
  const cropStageRef = useRef<HTMLDivElement>(null);
  const [draggingBox, setDraggingBox] = useState(false);
  const dragStartRef = useRef<{ nx: number; ny: number } | null>(null);

  const primaryFile = files[0];
  const { doc: cropDoc, numPages: cropTotal } = usePdfJsDocument(
    toolId === 'crop-pdf' && primaryFile ? primaryFile.bytes : undefined
  );

  // Sync organize PDF.js proxies and initial pages whenever files are added
  useEffect(() => {
    if (toolId !== 'organize-pdf') return;
    let cancelled = false;

    const loadNewFiles = async () => {
      for (const f of files) {
        if (loadedFileIds.current.has(f.id)) continue;
        loadedFileIds.current.add(f.id);
        try {
          const proxy = await openPdfJs(f.bytes);
          if (cancelled) {
            await destroyPdfJs(proxy);
            return;
          }
          setProxyMap((prev) => {
            const next = new Map(prev);
            next.set(f.id, proxy);
            return next;
          });
          setPageItems((prev) => [
            ...prev,
            ...Array.from({ length: proxy.numPages }, (_, idx) => ({
              uid: `${f.id}_p${idx}_${Math.random().toString(36).slice(2, 6)}`,
              sourceFileId: f.id,
              sourcePageIndex: idx,
              rotation: 0,
            })),
          ]);
        } catch {
          // Ignore unreadable
        }
      }
    };

    if (files.length === 0) {
      loadedFileIds.current.clear();
      setPageItems([]);
      setProxyMap((prev) => {
        prev.forEach((p) => {
          void destroyPdfJs(p);
        });
        return new Map();
      });
    } else {
      void loadNewFiles();
    }

    return () => {
      cancelled = true;
    };
  }, [files, toolId]);

  const handleApplyOrganize = async () => {
    if (pageItems.length === 0) return;
    setProcessing(true);
    setError(null);
    try {
      const filesMap = new Map(files.map((f) => [f.id, f]));
      const inst: OrganizePageInstruction[] = pageItems.map((p) => ({
        sourceFileId: p.sourceFileId,
        sourcePageIndex: p.sourcePageIndex,
        rotation: p.rotation,
      }));
      const res = await organizePdf(filesMap, inst);
      onOutputCreated({
        id: `${Date.now()}`,
        blob: res.blob,
        fileName: `${stripExt(files[0].name)}_organized.pdf`,
        mimeType: 'application/pdf',
        bytesLength: res.blob.size,
        pageCount: res.pageCount,
        summary: `Organized ${res.pageCount} pages`,
        canChainToPdfTools: true,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to organize PDF');
    } finally {
      setProcessing(false);
    }
  };

  const handleApplyCrop = async () => {
    if (!primaryFile) return;
    setProcessing(true);
    setError(null);
    try {
      const res = await cropPdf(primaryFile, cropMargins, cropScope, cropRange);
      onOutputCreated({
        id: `${Date.now()}`,
        blob: res.blob,
        fileName: `${stripExt(primaryFile.name)}_cropped.pdf`,
        mimeType: 'application/pdf',
        bytesLength: res.blob.size,
        pageCount: res.pageCount,
        summary: `Cropped ${cropScope === 'all' ? 'all pages' : `pages ${cropRange}`}`,
        canChainToPdfTools: true,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to crop PDF');
    } finally {
      setProcessing(false);
    }
  };

  if (files.length === 0) {
    return (
      <div className="space-y-6">
        <OutputPanel output={output} onChainToTool={onChainToTool} />
        <FileDropZone
          accept=".pdf,application/pdf"
          multiple={toolId === 'organize-pdf'}
          label={
            toolId === 'organize-pdf'
              ? 'Drop PDF file(s) to reorder, rotate, delete, or insert pages'
              : 'Drop a PDF file to visually crop margins'
          }
          onFilesAdded={(added) => setFiles(toolId === 'organize-pdf' ? added : [added[0]])}
          existingLibrary={sessionFiles}
        />
      </div>
    );
  }

  if (toolId === 'organize-pdf') {
    return (
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-slate-900 dark:text-white mr-2 font-mono tabular-nums">
              {pageItems.length} pages
            </span>
            <button
              type="button"
              onClick={() =>
                setPageItems((prev) => [
                  ...prev,
                  {
                    uid: `blank_${Date.now()}`,
                    sourceFileId: '',
                    sourcePageIndex: -1,
                    rotation: 0,
                  },
                ])
              }
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
            >
              <PlusSquare className="w-3.5 h-3.5" />
              Insert Blank Page
            </button>
            <label className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer">
              <FilePlus className="w-3.5 h-3.5" />
              Append Another PDF
              <input
                type="file"
                multiple
                accept={withZipAccept('.pdf,application/pdf')}
                className="hidden"
                onChange={async (e) => {
                  if (!e.target.files?.length) return;
                  const res = await expandFileListForAccept(e.target.files, '.pdf,application/pdf');
                  if (res.matched.length > 0) {
                    setFiles((prev) => [...prev, ...res.matched]);
                  }
                  e.target.value = '';
                }}
              />
            </label>
            <button
              type="button"
              onClick={() => setFiles([])}
              className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-red-600 px-2 py-1.5 cursor-pointer"
            >
              Reset
            </button>
          </div>

          <button
            type="button"
            onClick={handleApplyOrganize}
            disabled={processing || pageItems.length === 0}
            className="rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 px-5 py-2 text-sm font-semibold text-white transition-colors cursor-pointer"
          >
            {processing ? 'Building PDF...' : 'Save Organized PDF'}
          </button>
        </div>

        <OutputPanel output={output} onChainToTool={onChainToTool} />

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            {error}
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
          {pageItems.map((item, idx) => (
            <div
              key={item.uid}
              className="flex flex-col rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden"
            >
              {item.sourcePageIndex < 0 ? (
                <div className="aspect-[3/4] flex flex-col items-center justify-center bg-slate-50 dark:bg-slate-950 text-xs text-slate-400">
                  Blank Page
                </div>
              ) : (
                <VirtualPageThumb
                  pdfDoc={proxyMap.get(item.sourceFileId) || null}
                  pageNumber={item.sourcePageIndex + 1}
                  rotation={item.rotation}
                  width={170}
                  className="aspect-[3/4]"
                />
              )}

              <div className="border-t border-slate-100 dark:border-slate-800 p-2 flex items-center justify-between gap-1">
                <span className="text-[11px] font-mono tabular-nums font-semibold text-slate-600 dark:text-slate-300">
                  #{idx + 1}
                </span>
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    disabled={idx === 0}
                    onClick={() => {
                      const next = [...pageItems];
                      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                      setPageItems(next);
                    }}
                    className="p-1 text-slate-400 hover:text-slate-800 dark:hover:text-white disabled:opacity-25 cursor-pointer"
                    title="Move Left"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={idx === pageItems.length - 1}
                    onClick={() => {
                      const next = [...pageItems];
                      [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
                      setPageItems(next);
                    }}
                    className="p-1 text-slate-400 hover:text-slate-800 dark:hover:text-white disabled:opacity-25 cursor-pointer"
                    title="Move Right"
                  >
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setPageItems((prev) =>
                        prev.map((p) =>
                          p.uid === item.uid ? { ...p, rotation: (p.rotation + 90) % 360 } : p
                        )
                      )
                    }
                    className="p-1 text-slate-400 hover:text-slate-800 dark:hover:text-white cursor-pointer"
                    title="Rotate 90°"
                  >
                    <RotateCw className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setPageItems((prev) => {
                        const copy = { ...item, uid: `${item.uid}_dup_${Date.now()}` };
                        return [...prev.slice(0, idx + 1), copy, ...prev.slice(idx + 1)];
                      })
                    }
                    className="p-1 text-slate-400 hover:text-slate-800 dark:hover:text-white cursor-pointer"
                    title="Duplicate Page"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setPageItems((prev) => prev.filter((p) => p.uid !== item.uid))}
                    className="p-1 text-slate-400 hover:text-red-600 cursor-pointer"
                    title="Delete Page"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // CROP PDF WORKBENCH
  const getNormPos = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = cropStageRef.current?.getBoundingClientRect();
    if (!rect) return { nx: 0, ny: 0 };
    return {
      nx: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      ny: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-8 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-950 p-4 flex flex-col items-center">
          <div className="flex items-center justify-between w-full mb-3">
            <span className="text-xs text-slate-600 dark:text-slate-400">
              Drag directly on the page preview to draw the crop area
            </span>
            <div className="flex items-center gap-2 text-xs font-mono">
              <button
                type="button"
                disabled={cropPage <= 1}
                onClick={() => setCropPage((p) => Math.max(1, p - 1))}
                className="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 disabled:opacity-40 cursor-pointer"
              >
                Prev
              </button>
              <span>
                {cropPage} / {cropTotal || 1}
              </span>
              <button
                type="button"
                disabled={cropPage >= cropTotal}
                onClick={() => setCropPage((p) => Math.min(cropTotal, p + 1))}
                className="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 disabled:opacity-40 cursor-pointer"
              >
                Next
              </button>
            </div>
          </div>

          <div
            ref={cropStageRef}
            onMouseDown={(e) => {
              const pos = getNormPos(e);
              dragStartRef.current = pos;
              setDraggingBox(true);
            }}
            onMouseMove={(e) => {
              if (!draggingBox || !dragStartRef.current) return;
              const curr = getNormPos(e);
              const x0 = Math.min(dragStartRef.current.nx, curr.nx);
              const x1 = Math.max(dragStartRef.current.nx, curr.nx);
              const y0 = Math.min(dragStartRef.current.ny, curr.ny);
              const y1 = Math.max(dragStartRef.current.ny, curr.ny);
              if (x1 - x0 > 0.05 && y1 - y0 > 0.05) {
                setCropMargins({
                  left: Number(x0.toFixed(3)),
                  top: Number(y0.toFixed(3)),
                  right: Number((1 - x1).toFixed(3)),
                  bottom: Number((1 - y1).toFixed(3)),
                });
              }
            }}
            onMouseUp={() => setDraggingBox(false)}
            className="relative inline-block cursor-crosshair select-none"
          >
            <InteractivePageCanvas pdfDoc={cropDoc} pageNumber={cropPage} scale={1.15} />
            {/* Visual crop mask overlay */}
            <div
              className="pointer-events-none absolute inset-0 border-2 border-red-600 bg-slate-950/35"
              style={{
                clipPath: `polygon(
                  0% 0%, 100% 0%, 100% 100%, 0% 100%,
                  0% ${cropMargins.top * 100}%,
                  ${cropMargins.left * 100}% ${cropMargins.top * 100}%,
                  ${cropMargins.left * 100}% ${(1 - cropMargins.bottom) * 100}%,
                  ${(1 - cropMargins.right) * 100}% ${(1 - cropMargins.bottom) * 100}%,
                  ${(1 - cropMargins.right) * 100}% ${cropMargins.top * 100}%,
                  0% ${cropMargins.top * 100}%
                )`,
              }}
            />
            <div
              className="pointer-events-none absolute border-2 border-red-600"
              style={{
                left: `${cropMargins.left * 100}%`,
                top: `${cropMargins.top * 100}%`,
                right: `${cropMargins.right * 100}%`,
                bottom: `${cropMargins.bottom * 100}%`,
              }}
            />
          </div>
        </div>

        <div className="lg:col-span-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
            <h2 className="font-display text-sm font-semibold">Crop Margins (%)</h2>
            <button
              type="button"
              onClick={() => setFiles([])}
              className="text-xs text-slate-500 hover:text-red-600 cursor-pointer"
            >
              Change File
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {(['top', 'bottom', 'left', 'right'] as const).map((side) => (
              <div key={side}>
                <label className="block text-xs capitalize mb-1">
                  {side} ({Math.round(cropMargins[side] * 100)}%)
                </label>
                <input
                  type="range"
                  min={0}
                  max={0.45}
                  step={0.01}
                  value={cropMargins[side]}
                  onChange={(e) =>
                    setCropMargins((prev) => ({ ...prev, [side]: Number(e.target.value) }))
                  }
                  className="w-full"
                />
              </div>
            ))}
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Apply To</label>
            <select
              value={cropScope}
              onChange={(e) => setCropScope(e.target.value as 'all' | 'range')}
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
            >
              <option value="all">Whole Document</option>
              <option value="range">Specific Pages / Range</option>
            </select>
          </div>

          {cropScope === 'range' && (
            <input
              type="text"
              value={cropRange}
              onChange={(e) => setCropRange(e.target.value)}
              placeholder="e.g. 1, 3-5"
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm font-mono"
            />
          )}

          {error && <p className="text-xs text-red-600">{error}</p>}

          <button
            type="button"
            onClick={handleApplyCrop}
            disabled={processing}
            className="w-full rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 py-2.5 text-sm font-semibold text-white cursor-pointer"
          >
            {processing ? 'Cropping...' : 'Apply Crop'}
          </button>

          <OutputPanel output={output} onChainToTool={onChainToTool} compact />
        </div>
      </div>
    </div>
  );
};
