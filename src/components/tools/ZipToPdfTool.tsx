import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowDownAZ,
  ArrowUp,
  ArrowUpDown,
  FileArchive,
  FileCode,
  FileSpreadsheet,
  FileText,
  GripVertical,
  Image as ImageIcon,
  Plus,
  Presentation,
  Trash2,
  X,
} from 'lucide-react';
import { ProgressInfo, ToolId, ToolOutput, WorkspaceFile } from '../../types/tools';
import {
  convertOrderedItemsToPdf,
  ConvertibleEntry,
  ConvertibleFileKind,
  unzipToConvertibleItems,
} from '../../utils/officeEngines';
import { fileToWorkspaceFile, formatBytes, stripExt } from '../../utils/pdfRuntime';
import { FileDropZone } from '../FileDropZone';
import { OutputPanel } from '../OutputPanel';

interface ZipToPdfToolProps {
  files: WorkspaceFile[];
  setFiles: React.Dispatch<React.SetStateAction<WorkspaceFile[]>>;
  sessionFiles: WorkspaceFile[];
  onOutputCreated: (output: ToolOutput) => void;
  output: ToolOutput | null;
  onChainToTool: (targetTool: ToolId, output: ToolOutput) => void;
}

const KIND_LABELS: Record<ConvertibleFileKind, string> = {
  pdf: 'PDF',
  image: 'Image',
  word: 'Word / Doc',
  excel: 'Excel / CSV',
  powerpoint: 'PowerPoint',
  html: 'HTML',
  text: 'Text / Markdown',
  unsupported: 'Unsupported',
};

function EntryIcon({ kind }: { kind: ConvertibleFileKind }) {
  if (kind === 'image') return <ImageIcon className="w-4 h-4 text-red-600 shrink-0" />;
  if (kind === 'excel') return <FileSpreadsheet className="w-4 h-4 text-emerald-600 shrink-0" />;
  if (kind === 'powerpoint') return <Presentation className="w-4 h-4 text-amber-600 shrink-0" />;
  if (kind === 'html') return <FileCode className="w-4 h-4 text-sky-600 shrink-0" />;
  return <FileText className="w-4 h-4 text-red-600 shrink-0" />;
}

export const ZipToPdfTool: React.FC<ZipToPdfToolProps> = ({
  files,
  setFiles,
  sessionFiles,
  onOutputCreated,
  output,
  onChainToTool,
}) => {
  const [entries, setEntries] = useState<ConvertibleEntry[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<ProgressInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  // Drag-and-drop reorder state
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  // Image thumbnail ObjectURL map (zero base64)
  const [thumbUrls, setThumbUrls] = useState<Map<string, string>>(new Map());
  const thumbUrlsRef = useRef<Map<string, string>>(thumbUrls);
  thumbUrlsRef.current = thumbUrls;
  const unpackedFileIds = useRef<Set<string>>(new Set());

  // Conversion options (0 edge borders on images by default)
  const [pageSize, setPageSize] = useState<'a4' | 'letter' | 'fit'>('a4');
  const [imageOrientation, setImageOrientation] = useState<'auto' | 'portrait' | 'landscape'>('auto');
  const [excelOrientation, setExcelOrientation] = useState<'landscape' | 'portrait'>('landscape');
  const [borderlessImages, setBorderlessImages] = useState(true);
  const [marginPt, setMarginPt] = useState(0);
  const [cropEdgesToFill, setCropEdgesToFill] = useState(true);
  const [addFileDividers, setAddFileDividers] = useState(false);

  // Unpack any newly added workspace files automatically
  useEffect(() => {
    if (files.length === 0) {
      unpackedFileIds.current.clear();
      setEntries([]);
      setThumbUrls((prev) => {
        prev.forEach((url) => URL.revokeObjectURL(url));
        return new Map();
      });
      return;
    }

    let cancelled = false;
    const unpackPending = async () => {
      const pending = files.filter((f) => !unpackedFileIds.current.has(f.id));
      if (pending.length === 0) return;

      setExtracting(true);
      setError(null);
      try {
        const newlyExtracted: ConvertibleEntry[] = [];
        for (const f of pending) {
          unpackedFileIds.current.add(f.id);
          const items = await unzipToConvertibleItems(f, setProgress);
          newlyExtracted.push(...items);
        }
        if (!cancelled) {
          setEntries((prev) => [...prev, ...newlyExtracted]);
          // Create ephemeral ObjectURL thumbnails for image entries
          setThumbUrls((prev) => {
            const next = new Map(prev);
            for (const item of newlyExtracted) {
              if (item.kind === 'image') {
                const copy = new Uint8Array(item.bytes.byteLength);
                copy.set(item.bytes);
                next.set(item.id, URL.createObjectURL(new Blob([copy], { type: item.mime })));
              }
            }
            return next;
          });
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to unpack ZIP archive.');
      } finally {
        if (!cancelled) {
          setExtracting(false);
          setProgress(null);
        }
      }
    };

    void unpackPending();
    return () => {
      cancelled = true;
    };
  }, [files]);

  // Revoke all thumbnail ObjectURLs on unmount
  useEffect(() => {
    return () => {
      thumbUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  const moveEntry = (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx || toIdx < 0 || toIdx >= entries.length) return;
    setEntries((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  };

  const removeEntry = (id: string) => {
    setThumbUrls((prev) => {
      const url = prev.get(id);
      if (url) {
        URL.revokeObjectURL(url);
        const next = new Map(prev);
        next.delete(id);
        return next;
      }
      return prev;
    });
    setEntries((prev) => prev.filter((e) => e.id !== id));
  };

  const handleConvertAndMerge = async () => {
    setProcessing(true);
    setError(null);
    setWarnings([]);
    try {
      const res = await convertOrderedItemsToPdf(
        entries,
        {
          pageSize,
          imageOrientation,
          excelOrientation,
          marginPt: borderlessImages ? 0 : marginPt,
          addFileDividers,
          cropEdgesToFill,
        },
        setProgress
      );
      if (res.skippedNames.length > 0) {
        setWarnings(
          res.skippedNames.map((n) => `Skipped unreadable or encrypted file: ${n}`)
        );
      }
      const base = files[0] ? stripExt(files[0].name) : 'archive';
      onOutputCreated({
        id: `${Date.now()}`,
        blob: res.blob,
        fileName: `${base}_merged.pdf`,
        mimeType: 'application/pdf',
        bytesLength: res.blob.size,
        pageCount: res.pageCount,
        summary: `Merged ${res.convertedCount} file(s) into ${res.pageCount} PDF pages`,
        canChainToPdfTools: true,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ZIP to PDF conversion failed.');
    } finally {
      setProcessing(false);
      setProgress(null);
    }
  };

  const includedCount = entries.filter((e) => e.include && e.kind !== 'unsupported').length;
  const unsupportedCount = entries.filter((e) => e.kind === 'unsupported').length;

  return (
    <div className="space-y-6">
      {files.length === 0 ? (
        <>
          <OutputPanel output={output} onChainToTool={onChainToTool} />
          <FileDropZone
            accept=".zip,.pdf,image/*,.docx,.xlsx,.xls,.csv,.pptx,.html,.htm,.txt,.md"
            multiple
            label="Drop ZIP archive(s) here to unpack, inspect, reorder, and merge to PDF"
            sublabel="Supports PDFs, JPG/PNG/WebP, Word, Excel, PowerPoint, HTML, Markdown, TXT, and nested ZIPs — 100% offline"
            onFilesAdded={(added) => setFiles(added)}
            existingLibrary={sessionFiles}
          />
        </>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left: Extracted & Reorderable File Queue */}
          <div className="lg:col-span-8 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 dark:border-slate-800 pb-3">
              <div className="flex items-center gap-2.5">
                <FileArchive className="w-4 h-4 text-red-600" />
                <div>
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                    Files to Convert & Merge ({includedCount} of {entries.length} selected)
                  </h2>
                  <p className="text-xs text-slate-500">
                    Drag rows or use arrows to set the exact order in the final PDF
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() =>
                    setEntries((prev) =>
                      [...prev].sort((a, b) =>
                        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
                      )
                    )
                  }
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                  title="Sort A to Z"
                >
                  <ArrowDownAZ className="w-3.5 h-3.5" />
                  A–Z
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setEntries((prev) =>
                      [...prev].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
                    )
                  }
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                  title="Group by File Type"
                >
                  Type
                </button>
                <button
                  type="button"
                  onClick={() => setEntries((prev) => [...prev].reverse())}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                  title="Reverse Order"
                >
                  <ArrowUpDown className="w-3.5 h-3.5" />
                  Reverse
                </button>
                <label className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer">
                  <Plus className="w-3.5 h-3.5" />
                  Add ZIP / Files
                  <input
                    type="file"
                    multiple
                    accept=".zip,.pdf,image/*,.docx,.xlsx,.xls,.csv,.pptx,.html,.htm,.txt,.md"
                    className="hidden"
                    onChange={async (e) => {
                      if (!e.target.files) return;
                      const loaded = await Promise.all(
                        Array.from(e.target.files).map((f) => fileToWorkspaceFile(f))
                      );
                      setFiles((prev) => [...prev, ...loaded]);
                      e.target.value = '';
                    }}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setFiles([])}
                  className="inline-flex items-center gap-1 px-2 py-1.5 text-xs text-slate-500 hover:text-red-600 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Reset
                </button>
              </div>
            </div>

            {extracting ? (
              <div className="py-10 text-center text-xs text-slate-500 font-mono">
                {progress ? `${progress.label} (${progress.current}/${progress.total})` : 'Unpacking archive...'}
              </div>
            ) : entries.length === 0 ? (
              <div className="py-10 text-center text-xs text-slate-500">
                No files found inside the archive.
              </div>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-[600px] overflow-y-auto pr-1">
                {entries.map((item, idx) => {
                  const thumbUrl = thumbUrls.get(item.id);
                  const isSupported = item.kind !== 'unsupported';
                  const isDragging = dragIdx === idx;
                  const isOver = overIdx === idx && dragIdx !== idx;

                  return (
                    <div
                      key={item.id}
                      draggable
                      onDragStart={() => setDragIdx(idx)}
                      onDragOver={(e) => {
                        e.preventDefault();
                        if (overIdx !== idx) setOverIdx(idx);
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (dragIdx !== null) moveEntry(dragIdx, idx);
                        setDragIdx(null);
                        setOverIdx(null);
                      }}
                      onDragEnd={() => {
                        setDragIdx(null);
                        setOverIdx(null);
                      }}
                      className={`flex items-center justify-between gap-3 py-2.5 px-2 rounded-lg transition-colors ${
                        isDragging ? 'opacity-45 bg-slate-100 dark:bg-slate-800' : ''
                      } ${isOver ? 'border-t-2 border-red-600 bg-red-50/40 dark:bg-red-950/20' : ''} ${
                        !item.include || !isSupported ? 'opacity-60' : ''
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0 flex-1">
                        <GripVertical className="w-4 h-4 text-slate-400 cursor-grab shrink-0" />
                        <input
                          type="checkbox"
                          checked={item.include && isSupported}
                          disabled={!isSupported}
                          onChange={(e) =>
                            setEntries((prev) =>
                              prev.map((x) =>
                                x.id === item.id ? { ...x, include: e.target.checked } : x
                              )
                            )
                          }
                          className="accent-red-600 cursor-pointer shrink-0"
                          aria-label={`Include ${item.name}`}
                        />
                        <span className="w-6 text-xs font-mono tabular-nums text-slate-400 shrink-0">
                          #{idx + 1}
                        </span>

                        {thumbUrl ? (
                          <img
                            src={thumbUrl}
                            alt={item.name}
                            className="w-9 h-9 rounded border border-slate-200 dark:border-slate-700 object-cover bg-slate-50 shrink-0"
                          />
                        ) : (
                          <div className="w-9 h-9 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 flex items-center justify-center shrink-0">
                            <EntryIcon kind={item.kind} />
                          </div>
                        )}

                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                            {item.name}
                          </p>
                          <p className="text-xs text-slate-500 dark:text-slate-400 truncate font-mono tabular-nums">
                            {KIND_LABELS[item.kind]} · {formatBytes(item.size)}
                            {item.pageCount ? ` · ${item.pageCount}p` : ''}
                            {item.path !== item.name ? ` · ${item.path}` : ''}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => moveEntry(idx, idx - 1)}
                          disabled={idx === 0}
                          className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-30 cursor-pointer"
                          aria-label="Move up"
                        >
                          <ArrowUp className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveEntry(idx, idx + 1)}
                          disabled={idx === entries.length - 1}
                          className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-30 cursor-pointer"
                          aria-label="Move down"
                        >
                          <ArrowDown className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeEntry(item.id)}
                          className="p-1 text-slate-400 hover:text-red-600 cursor-pointer"
                          aria-label="Remove item"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {unsupportedCount > 0 && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {unsupportedCount} unsupported binary file(s) inside the archive were automatically excluded.
              </p>
            )}
          </div>

          {/* Right: Merge & Layout Options */}
          <div className="lg:col-span-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-white border-b border-slate-100 dark:border-slate-800 pb-3">
              PDF Output & Merge Settings
            </h2>

            <div>
              <label className="block text-xs font-medium mb-1">Page Size (Images & Docs)</label>
              <select
                value={pageSize}
                onChange={(e) => setPageSize(e.target.value as 'a4' | 'letter' | 'fit')}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
              >
                <option value="a4">A4 (210 × 297 mm)</option>
                <option value="letter">US Letter</option>
                <option value="fit">Fit to Image Dimensions (A4 for Docs)</option>
              </select>
            </div>

            {pageSize !== 'fit' && (
              <div>
                <label className="block text-xs font-medium mb-1">Image Orientation</label>
                <select
                  value={imageOrientation}
                  onChange={(e) =>
                    setImageOrientation(e.target.value as 'auto' | 'portrait' | 'landscape')
                  }
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
                >
                  <option value="auto">Auto (Match Image Aspect)</option>
                  <option value="portrait">Portrait</option>
                  <option value="landscape">Landscape</option>
                </select>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium mb-1">Spreadsheet Orientation</label>
              <select
                value={excelOrientation}
                onChange={(e) => setExcelOrientation(e.target.value as 'landscape' | 'portrait')}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
              >
                <option value="landscape">Landscape (Best for Excel/CSV)</option>
                <option value="portrait">Portrait</option>
              </select>
            </div>

            <div className="space-y-2.5 pt-1">
              <label className="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={borderlessImages}
                  onChange={(e) => setBorderlessImages(e.target.checked)}
                  className="mt-0.5 accent-red-600"
                />
                <span>Borderless images (no edge margins)</span>
              </label>

              <label className="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={cropEdgesToFill}
                  onChange={(e) => setCropEdgesToFill(e.target.checked)}
                  className="mt-0.5 accent-red-600"
                />
                <span>Crop page margins to fit full content (never crops images)</span>
              </label>

              {!borderlessImages && (
                <div>
                  <label className="block text-xs font-medium mb-1">Image Margin ({marginPt} pt)</label>
                  <input
                    type="range"
                    min={0}
                    max={60}
                    step={6}
                    value={marginPt}
                    onChange={(e) => setMarginPt(Number(e.target.value))}
                    className="w-full"
                  />
                </div>
              )}

              <label className="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={addFileDividers}
                  onChange={(e) => setAddFileDividers(e.target.checked)}
                  className="mt-0.5 accent-red-600"
                />
                <span>Insert filename divider cover page before each file</span>
              </label>
            </div>

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

            {warnings.length > 0 && (
              <ul className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 p-3 space-y-1 text-xs text-amber-800 dark:text-amber-300">
                {warnings.map((w, i) => (
                  <li key={i}>• {w}</li>
                ))}
              </ul>
            )}

            <button
              type="button"
              onClick={handleConvertAndMerge}
              disabled={processing || extracting || includedCount === 0}
              className="w-full rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 py-2.5 px-4 text-sm font-semibold text-white transition-colors cursor-pointer"
            >
              {processing
                ? 'Converting & Merging...'
                : `Convert & Merge ${includedCount} File(s) to PDF`}
            </button>

            <OutputPanel output={output} onChainToTool={onChainToTool} compact />
          </div>
        </div>
      )}
    </div>
  );
};
