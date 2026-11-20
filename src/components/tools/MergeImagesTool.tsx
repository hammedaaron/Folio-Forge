import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowDownAZ,
  ArrowUp,
  ArrowUpDown,
  Columns2,
  GripVertical,
  Image as ImageIcon,
  Plus,
  RotateCw,
  Rows3,
  Trash2,
  X,
} from 'lucide-react';
import { ProgressInfo, ToolId, ToolOutput, WorkspaceFile } from '../../types/tools';
import {
  computeMergedLayout,
  MergeImagesDirection,
  MergeImagesOutputFormat,
  MergeImagesPdfMode,
  mergeImagesToOutput,
} from '../../utils/pdfEngines';
import { formatBytes } from '../../utils/pdfRuntime';
import { expandFileListForAccept, withZipAccept } from '../../utils/zipExpand';
import { FileDropZone } from '../FileDropZone';
import { OutputPanel } from '../OutputPanel';

interface MergeImagesToolProps {
  files: WorkspaceFile[];
  setFiles: React.Dispatch<React.SetStateAction<WorkspaceFile[]>>;
  sessionFiles: WorkspaceFile[];
  onOutputCreated: (output: ToolOutput) => void;
  output: ToolOutput | null;
  onChainToTool: (targetTool: ToolId, output: ToolOutput) => void;
}

const RotatedImageTile: React.FC<{
  url: string;
  alt: string;
  rotation: number;
  className?: string;
  style?: React.CSSProperties;
}> = ({ url, alt, rotation, className = '', style }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (rotation % 360 === 0 || !url) return;
    let active = true;
    const img = new Image();
    img.onload = () => {
      if (!active || !canvasRef.current) return;
      const rot = ((rotation % 360) + 360) % 360;
      const swap = rot === 90 || rot === 270;
      const maxPreview = 640;
      const scale = Math.min(1, maxPreview / Math.max(img.naturalWidth, img.naturalHeight));
      const srcW = Math.max(1, Math.round(img.naturalWidth * scale));
      const srcH = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = canvasRef.current;
      canvas.width = swap ? srcH : srcW;
      canvas.height = swap ? srcW : srcH;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((rot * Math.PI) / 180);
      ctx.drawImage(img, -srcW / 2, -srcH / 2, srcW, srcH);
      ctx.restore();
    };
    img.src = url;
    return () => {
      active = false;
    };
  }, [url, rotation]);

  if (rotation % 360 === 0) {
    return <img src={url} alt={alt} className={className} style={style} />;
  }
  return <canvas ref={canvasRef} aria-label={alt} className={className} style={style} />;
};

export const MergeImagesTool: React.FC<MergeImagesToolProps> = ({
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

  // Merge configuration (defaults: borderless continuous fit-to-screen PDF, zero crop)
  const [outputFormat, setOutputFormat] = useState<MergeImagesOutputFormat>('pdf');
  const [pdfMode, setPdfMode] = useState<MergeImagesPdfMode>('continuous');
  const [direction, setDirection] = useState<MergeImagesDirection>('vertical');
  const [normalizeSize, setNormalizeSize] = useState(true);
  const [quality, setQuality] = useState(0.94);

  // Per-file rotation & natural pixel dimensions
  const [rotations, setRotations] = useState<Record<string, number>>({});
  const [dimensions, setDimensions] = useState<Record<string, { width: number; height: number }>>({});

  // Drag-and-drop reorder state
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  // Ephemeral ObjectURL thumbnail lifecycle (cleaned cleanly via ref)
  const [thumbMap, setThumbMap] = useState<Map<string, string>>(new Map());
  const thumbMapRef = useRef<Map<string, string>>(thumbMap);
  thumbMapRef.current = thumbMap;

  useEffect(() => {
    setThumbMap((prev) => {
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
  }, [files]);

  useEffect(() => {
    return () => {
      for (const url of thumbMapRef.current.values()) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);

  // Decode natural image dimensions cleanly once per image file
  useEffect(() => {
    let cancelled = false;
    const missing = files.filter((f) => !dimensions[f.id]);
    if (missing.length === 0) return;

    (async () => {
      const additions: Record<string, { width: number; height: number }> = {};
      for (const f of missing) {
        try {
          const copy = new Uint8Array(f.bytes.byteLength);
          copy.set(f.bytes);
          const bmp = await createImageBitmap(new Blob([copy], { type: f.type || 'image/png' }));
          additions[f.id] = { width: bmp.width, height: bmp.height };
          bmp.close();
        } catch {
          additions[f.id] = { width: 800, height: 600 };
        }
      }
      if (!cancelled && Object.keys(additions).length > 0) {
        setDimensions((prev) => ({ ...prev, ...additions }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [files, dimensions]);

  const effectiveDims = useMemo(() => {
    return files.map((f) => {
      const base = dimensions[f.id] || { width: 800, height: 600 };
      const rot = ((rotations[f.id] || 0) % 360 + 360) % 360;
      const swap = rot === 90 || rot === 270;
      return {
        width: swap ? base.height : base.width,
        height: swap ? base.width : base.height,
      };
    });
  }, [files, dimensions, rotations]);

  const layoutSummary = useMemo(() => {
    if (files.length === 0) return null;
    if (outputFormat === 'pdf' && pdfMode === 'fit-pages') {
      return `${files.length} borderless fit-to-screen PDF page${files.length > 1 ? 's' : ''} (0 margins, 0 crop)`;
    }
    const chunks = computeMergedLayout(effectiveDims, {
      direction,
      normalizeSize,
      minCrossSpan: outputFormat === 'pdf' ? 600 : 1,
      maxCrossSpan: outputFormat === 'pdf' ? 1440 : 8192,
      maxChunkPrimarySpan: outputFormat === 'pdf' ? 14000 : undefined,
    });
    if (chunks.length === 0) return null;
    const first = chunks[0];
    const totalW = Math.round(first.width);
    const totalH = Math.round(chunks.reduce((acc, c) => acc + c.height, 0));
    if (outputFormat === 'pdf') {
      return `${totalW} × ${totalH} pt · ${chunks.length} continuous fit-to-screen page${chunks.length > 1 ? 's' : ''}`;
    }
    return `${totalW} × ${totalH} px · ${outputFormat.toUpperCase()} borderless sheet`;
  }, [files.length, effectiveDims, outputFormat, pdfMode, direction, normalizeSize]);

  const moveFile = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= files.length) return;
    setFiles((prev) => {
      const copy = [...prev];
      const [item] = copy.splice(index, 1);
      copy.splice(target, 0, item);
      return copy;
    });
  };

  const reorderByDrop = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= files.length || to >= files.length) return;
    setFiles((prev) => {
      const copy = [...prev];
      const [item] = copy.splice(from, 1);
      copy.splice(to, 0, item);
      return copy;
    });
  };

  const rotateItem = (id: string) => {
    setRotations((prev) => ({
      ...prev,
      [id]: ((prev[id] || 0) + 90) % 360,
    }));
  };

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const addMoreFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const res = await expandFileListForAccept(fileList, 'image/*');
    if (res.matched.length > 0) {
      setError(null);
      setFiles((prev) => [...prev, ...res.matched]);
    } else if (res.zipCount > 0) {
      setError(
        `Unpacked ${res.totalInsideZip} file${res.totalInsideZip === 1 ? '' : 's'} from ZIP, but none were images.`
      );
    }
  };

  const handleRun = async () => {
    if (files.length === 0) {
      setError('Add at least one image first.');
      return;
    }
    setError(null);
    setProcessing(true);
    setProgress({ current: 0, total: files.length, label: 'Initializing merge...' });

    try {
      const res = await mergeImagesToOutput(
        files.map((file) => ({ file, rotation: rotations[file.id] || 0 })),
        {
          outputFormat,
          direction,
          pdfMode,
          normalizeSize,
          quality,
        },
        setProgress
      );

      onOutputCreated({
        id: `out_${Date.now()}`,
        blob: res.blob,
        fileName: res.fileName,
        mimeType: res.mimeType,
        bytesLength: res.blob.size,
        pageCount: res.pageCount,
        summary: res.summary,
        canChainToPdfTools: res.mimeType === 'application/pdf',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to merge images.');
    } finally {
      setProcessing(false);
      setProgress(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Reorderable Image Queue + Live Borderless Preview */}
        <div className="lg:col-span-8 space-y-4">
          {files.length === 0 ? (
            <FileDropZone
              accept="image/*"
              multiple
              label="Drop multiple JPG, PNG, WebP, GIF, or BMP images to merge"
              sublabel="100% offline · Never crops images · Zero sheet borders"
              onFilesAdded={(added) => {
                setError(null);
                setFiles(added);
              }}
              existingLibrary={sessionFiles}
            />
          ) : (
            <>
              {/* Queue Container */}
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/70">
                  <div>
                    <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                      Images to Merge ({files.length})
                    </span>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      Drag rows or use arrows to reorder cleanly before merging.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setFiles((prev) =>
                          [...prev].sort((a, b) =>
                            a.name.localeCompare(b.name, undefined, { numeric: true })
                          )
                        )
                      }
                      title="Sort alphabetically A–Z"
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-red-500 cursor-pointer"
                    >
                      <ArrowDownAZ className="w-3.5 h-3.5" />
                      A–Z
                    </button>
                    <button
                      type="button"
                      onClick={() => setFiles((prev) => [...prev].reverse())}
                      title="Reverse order"
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-red-500 cursor-pointer"
                    >
                      <ArrowUpDown className="w-3.5 h-3.5" />
                      Reverse
                    </button>
                    <label className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-red-500 cursor-pointer">
                      <Plus className="w-3.5 h-3.5" />
                      Add More
                      <input
                        type="file"
                        accept={withZipAccept('image/*')}
                        multiple
                        className="hidden"
                        onChange={(e) => {
                          void addMoreFiles(e.target.files);
                          e.target.value = '';
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setFiles([]);
                        setRotations({});
                        setError(null);
                      }}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-500 hover:text-red-600 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Clear
                    </button>
                  </div>
                </div>

                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {files.map((f, idx) => {
                    const thumbUrl = thumbMap.get(f.id);
                    const rot = rotations[f.id] || 0;
                    const d = effectiveDims[idx];
                    return (
                      <li
                        key={f.id}
                        draggable
                        onDragStart={() => setDragIdx(idx)}
                        onDragOver={(e) => {
                          e.preventDefault();
                          if (overIdx !== idx) setOverIdx(idx);
                        }}
                        onDragLeave={() => {
                          if (overIdx === idx) setOverIdx(null);
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (dragIdx !== null) reorderByDrop(dragIdx, idx);
                          setDragIdx(null);
                          setOverIdx(null);
                        }}
                        onDragEnd={() => {
                          setDragIdx(null);
                          setOverIdx(null);
                        }}
                        className={`flex items-center gap-3 px-4 py-2.5 transition-colors cursor-grab active:cursor-grabbing ${
                          overIdx === idx && dragIdx !== idx
                            ? 'bg-red-50/70 dark:bg-red-950/30 ring-1 ring-inset ring-red-500/40'
                            : ''
                        }`}
                      >
                        <GripVertical className="w-4 h-4 text-slate-400 shrink-0" />
                        <span className="w-6 text-xs font-mono tabular-nums text-slate-400 shrink-0">
                          {idx + 1}.
                        </span>
                        {thumbUrl ? (
                          <RotatedImageTile
                            url={thumbUrl}
                            alt={f.name}
                            rotation={rot}
                            className="h-10 w-10 rounded object-contain border border-slate-200 dark:border-slate-700 shrink-0 bg-slate-100 dark:bg-slate-800"
                          />
                        ) : (
                          <div className="h-10 w-10 rounded bg-slate-100 dark:bg-slate-800 flex items-center justify-center shrink-0">
                            <ImageIcon className="w-4 h-4 text-slate-400" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                            {f.name}
                          </p>
                          <p className="text-xs text-slate-500 font-mono tabular-nums">
                            {d ? `${d.width} × ${d.height} px` : '...'} · {formatBytes(f.size)}
                            {rot !== 0 ? ` · ${rot}°` : ''}
                          </p>
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => rotateItem(f.id)}
                            title="Rotate 90° clockwise"
                            className="p-1.5 rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-red-500 cursor-pointer"
                          >
                            <RotateCw className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => moveFile(idx, -1)}
                            disabled={idx === 0}
                            title="Move up"
                            className="p-1.5 rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 disabled:opacity-30 hover:border-red-500 cursor-pointer"
                          >
                            <ArrowUp className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => moveFile(idx, 1)}
                            disabled={idx === files.length - 1}
                            title="Move down"
                            className="p-1.5 rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 disabled:opacity-30 hover:border-red-500 cursor-pointer"
                          >
                            <ArrowDown className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => removeFile(f.id)}
                            title="Remove"
                            className="p-1.5 rounded border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-red-600 hover:border-red-500 cursor-pointer"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>

              {/* Live Seamless Uncropped Merge Preview */}
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                      Live Borderless Merge Preview
                    </h3>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      Shows exact uncropped fit-to-screen layout with zero margins or clipped edges.
                    </p>
                  </div>
                  {layoutSummary && (
                    <span className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                      {layoutSummary}
                    </span>
                  )}
                </div>

                {outputFormat === 'pdf' && pdfMode === 'fit-pages' ? (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 max-h-[460px] overflow-y-auto p-3 rounded-lg bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                    {files.map((f, idx) => {
                      const url = thumbMap.get(f.id);
                      const rot = rotations[f.id] || 0;
                      const d = effectiveDims[idx];
                      return (
                        <div key={f.id} className="space-y-1">
                          <div className="overflow-hidden shadow-sm bg-white dark:bg-slate-900">
                            {url && (
                              <RotatedImageTile
                                url={url}
                                alt={f.name}
                                rotation={rot}
                                className="block w-full h-auto"
                              />
                            )}
                          </div>
                          <p className="text-[10px] font-mono tabular-nums text-slate-500 truncate">
                            Page {idx + 1} · {d.width}×{d.height}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                ) : direction === 'vertical' ? (
                  <div className="max-h-[480px] overflow-y-auto rounded-lg bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 p-3 flex justify-center">
                    <div className="w-full max-w-md flex flex-col items-center shadow-md overflow-hidden bg-transparent">
                      {files.map((f, idx) => {
                        const url = thumbMap.get(f.id);
                        const rot = rotations[f.id] || 0;
                        const maxW = Math.max(...effectiveDims.map((x) => x.width), 1);
                        const pct = normalizeSize
                          ? 100
                          : Math.max(15, (effectiveDims[idx].width / maxW) * 100);
                        return url ? (
                          <RotatedImageTile
                            key={f.id}
                            url={url}
                            alt={f.name}
                            rotation={rot}
                            className="block h-auto"
                            style={{ width: `${pct}%` }}
                          />
                        ) : null;
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="max-w-full overflow-x-auto rounded-lg bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 p-3">
                    <div className="inline-flex items-center shadow-md overflow-hidden bg-transparent">
                      {files.map((f, idx) => {
                        const url = thumbMap.get(f.id);
                        const rot = rotations[f.id] || 0;
                        const maxH = Math.max(...effectiveDims.map((x) => x.height), 1);
                        const targetH = normalizeSize
                          ? 220
                          : Math.max(40, Math.round((effectiveDims[idx].height / maxH) * 220));
                        return url ? (
                          <RotatedImageTile
                            key={f.id}
                            url={url}
                            alt={f.name}
                            rotation={rot}
                            className="block w-auto shrink-0"
                            style={{ height: `${targetH}px` }}
                          />
                        ) : null;
                      })}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Right: Output Format & Borderless Controls + CTA + OutputPanel */}
        <div className="lg:col-span-4 space-y-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
          <div className="space-y-4">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white border-b border-slate-100 dark:border-slate-800 pb-2.5">
              Merge Settings
            </h2>

            {/* Output Format */}
            <div>
              <label className="text-xs font-medium text-slate-700 dark:text-slate-300 block mb-1.5">
                Output Format
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                {(
                  [
                    ['pdf', 'PDF (Fit-to-Screen)'],
                    ['png', 'PNG (Lossless)'],
                    ['jpeg', 'JPG (Compact)'],
                    ['webp', 'WebP (Modern)'],
                  ] as const
                ).map(([fmt, label]) => (
                  <button
                    key={fmt}
                    type="button"
                    onClick={() => setOutputFormat(fmt)}
                    className={`rounded-lg border px-2.5 py-2 text-xs font-medium text-left transition-colors cursor-pointer ${
                      outputFormat === fmt
                        ? 'border-red-600 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300'
                        : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:border-slate-300'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* PDF Mode selector */}
            {outputFormat === 'pdf' && (
              <div>
                <label className="text-xs font-medium text-slate-700 dark:text-slate-300 block mb-1.5">
                  PDF Page Framing
                </label>
                <div className="space-y-1.5">
                  <button
                    type="button"
                    onClick={() => setPdfMode('continuous')}
                    className={`w-full rounded-lg border p-2.5 text-left transition-colors cursor-pointer ${
                      pdfMode === 'continuous'
                        ? 'border-red-600 bg-red-50/70 dark:bg-red-950/30'
                        : 'border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    <p className="text-xs font-semibold text-slate-900 dark:text-white">
                      Continuous Seamless Sheet
                    </p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                      Fuses all images edge-to-edge on one borderless fit-to-screen scroll sheet. Zero cropping.
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => setPdfMode('fit-pages')}
                    className={`w-full rounded-lg border p-2.5 text-left transition-colors cursor-pointer ${
                      pdfMode === 'fit-pages'
                        ? 'border-red-600 bg-red-50/70 dark:bg-red-950/30'
                        : 'border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    <p className="text-xs font-semibold text-slate-900 dark:text-white">
                      Separate Fit-to-Screen Pages
                    </p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                      Each PDF page wraps tightly to its photo’s exact aspect ratio with zero paper borders.
                    </p>
                  </button>
                </div>
              </div>
            )}

            {/* Direction selector (Continuous PDF & Image outputs) */}
            {(outputFormat !== 'pdf' || pdfMode === 'continuous') && (
              <div>
                <label className="text-xs font-medium text-slate-700 dark:text-slate-300 block mb-1.5">
                  Merge Direction
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setDirection('vertical')}
                    className={`inline-flex items-center justify-center gap-1.5 rounded-lg border py-2 text-xs font-medium cursor-pointer ${
                      direction === 'vertical'
                        ? 'border-red-600 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300'
                        : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <Rows3 className="w-3.5 h-3.5" />
                    Vertical
                  </button>
                  <button
                    type="button"
                    onClick={() => setDirection('horizontal')}
                    className={`inline-flex items-center justify-center gap-1.5 rounded-lg border py-2 text-xs font-medium cursor-pointer ${
                      direction === 'horizontal'
                        ? 'border-red-600 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300'
                        : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <Columns2 className="w-3.5 h-3.5" />
                    Horizontal
                  </button>
                </div>
              </div>
            )}

            {/* Proportional edge-to-edge scaling toggle */}
            <label className="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={normalizeSize}
                onChange={(e) => setNormalizeSize(e.target.checked)}
                className="mt-0.5 rounded border-slate-300 text-red-600 focus:ring-red-500"
              />
              <span>
                Align edges proportionally to fit screen cleanly (never crops any image or adds side bars)
              </span>
            </label>

            {/* Quality Slider */}
            {(outputFormat === 'jpeg' || outputFormat === 'webp') && (
              <div>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="font-medium text-slate-700 dark:text-slate-300">
                    Compression Quality
                  </span>
                  <span className="font-mono tabular-nums text-slate-500">
                    {Math.round(quality * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0.6}
                  max={1}
                  step={0.02}
                  value={quality}
                  onChange={(e) => setQuality(Number(e.target.value))}
                  className="w-full accent-red-600"
                />
              </div>
            )}
          </div>

          {progress && (
            <div className="space-y-1.5 pt-2">
              <div className="flex justify-between text-xs text-slate-600 dark:text-slate-300">
                <span className="truncate">{progress.label}</span>
                <span className="font-mono tabular-nums">
                  {progress.current}/{progress.total}
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
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

          <button
            type="button"
            disabled={processing || files.length === 0}
            onClick={() => void handleRun()}
            className="w-full rounded-lg bg-red-600 hover:bg-red-700 disabled:bg-slate-300 dark:disabled:bg-slate-800 disabled:text-slate-500 py-2.5 px-4 text-sm font-semibold text-white transition-colors cursor-pointer"
          >
            {processing
              ? 'Merging Images...'
              : `Merge ${files.length > 0 ? `${files.length} ` : ''}Image${files.length === 1 ? '' : 's'}`}
          </button>

          <OutputPanel output={output} onChainToTool={onChainToTool} compact />
        </div>
      </div>
    </div>
  );
};
