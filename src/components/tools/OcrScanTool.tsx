import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpDown,
  Camera,
  Check,
  Copy,
  RotateCw,
  Trash2,
  Video,
  VideoOff,
} from 'lucide-react';
import { ProgressInfo, ToolId, ToolOutput, WorkspaceFile } from '../../types/tools';
import { ocrPdfOffline } from '../../utils/analysisEngines';
import { imagesToPdf } from '../../utils/pdfEngines';
import { canvasToUint8Array, downloadBlob, formatBytes, stripExt } from '../../utils/pdfRuntime';
import { FileDropZone } from '../FileDropZone';
import { OutputPanel } from '../OutputPanel';

interface OcrScanToolProps {
  toolId: 'ocr-pdf' | 'scan-to-pdf';
  files: WorkspaceFile[];
  setFiles: React.Dispatch<React.SetStateAction<WorkspaceFile[]>>;
  sessionFiles: WorkspaceFile[];
  onOutputCreated: (output: ToolOutput) => void;
  output: ToolOutput | null;
  onChainToTool: (targetTool: ToolId, output: ToolOutput) => void;
}

interface ScannedPage {
  id: string;
  rawBytes: Uint8Array;
  rawMime: string;
  previewUrl: string;
  filter: 'original' | 'enhance' | 'grayscale' | 'bw';
  rotation: number;
}

export const OcrScanTool: React.FC<OcrScanToolProps> = ({
  toolId,
  files,
  setFiles,
  sessionFiles,
  onOutputCreated,
  output,
  onChainToTool,
}) => {
  // OCR state
  const file = files[0];
  const [ocrLang, setOcrLang] = useState('eng');
  const [ocrRange, setOcrRange] = useState('all');
  const [ocrText, setOcrText] = useState('');
  const [copied, setCopied] = useState(false);

  // Scan state
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [scans, setScans] = useState<ScannedPage[]>([]);
  const [scanFilter, setScanFilter] = useState<'original' | 'enhance' | 'grayscale' | 'bw'>('enhance');
  const [scanBorderless, setScanBorderless] = useState(true);
  const [scanCropToFill, setScanCropToFill] = useState(true);

  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<ProgressInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragScanIdx, setDragScanIdx] = useState<number | null>(null);
  const scansRef = useRef<ScannedPage[]>([]);
  scansRef.current = scans;

  const reorderScan = (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx || toIdx < 0 || toIdx >= scans.length) return;
    setScans((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  };

  useEffect(() => {
    return () => {
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, [stream]);

  useEffect(() => {
    return () => {
      scansRef.current.forEach((sc) => URL.revokeObjectURL(sc.previewUrl));
    };
  }, []);

  const startCamera = async () => {
    setError(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      setStream(s);
      if (videoRef.current) {
        videoRef.current.srcObject = s;
        await videoRef.current.play();
      }
    } catch {
      setError('Camera unavailable or permission denied. You can still upload scanned photos below.');
    }
  };

  const stopCamera = () => {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      setStream(null);
    }
  };

  const applyFilterToBytes = async (
    bytes: Uint8Array,
    mime: string,
    filter: ScannedPage['filter'],
    rotation: number
  ): Promise<Uint8Array> => {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const bitmap = await createImageBitmap(new Blob([copy], { type: mime }));
    const swap = rotation === 90 || rotation === 270;
    const c = document.createElement('canvas');
    c.width = swap ? bitmap.height : bitmap.width;
    c.height = swap ? bitmap.width : bitmap.height;
    const ctx = c.getContext('2d')!;
    ctx.save();
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    ctx.restore();
    bitmap.close();

    if (filter !== 'original') {
      const imgData = ctx.getImageData(0, 0, c.width, c.height);
      const d = imgData.data;
      for (let i = 0; i < d.length; i += 4) {
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (filter === 'grayscale') {
          d[i] = d[i + 1] = d[i + 2] = lum;
        } else if (filter === 'bw') {
          const v = lum > 142 ? 255 : 0;
          d[i] = d[i + 1] = d[i + 2] = v;
        } else if (filter === 'enhance') {
          const boost = Math.min(255, Math.max(0, (lum - 128) * 1.35 + 140));
          d[i] = Math.min(255, Math.max(0, (d[i] - 128) * 1.25 + 135));
          d[i + 1] = Math.min(255, Math.max(0, (d[i + 1] - 128) * 1.25 + 135));
          d[i + 2] = Math.min(255, Math.max(0, (d[i + 2] - 128) * 1.25 + 135));
          void boost;
        }
      }
      ctx.putImageData(imgData, 0, 0);
    }

    const out = await canvasToUint8Array(c, 'image/jpeg', 0.9);
    c.width = 0;
    c.height = 0;
    return out;
  };

  const captureFromCamera = async () => {
    const v = videoRef.current;
    if (!v || v.videoWidth === 0) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')?.drawImage(v, 0, 0);
    const bytes = await canvasToUint8Array(c, 'image/jpeg', 0.92);
    c.width = 0;
    c.height = 0;
    const previewUrl = URL.createObjectURL(new Blob([bytes.slice()], { type: 'image/jpeg' }));
    setScans((prev) => [
      ...prev,
      {
        id: `scan_${Date.now()}`,
        rawBytes: bytes,
        rawMime: 'image/jpeg',
        previewUrl,
        filter: scanFilter,
        rotation: 0,
      },
    ]);
  };

  const handleCompileScans = async () => {
    if (scans.length === 0) return;
    setProcessing(true);
    setError(null);
    try {
      const processedFiles: WorkspaceFile[] = [];
      for (let i = 0; i < scans.length; i++) {
        setProgress({ current: i + 1, total: scans.length, label: `Processing scan ${i + 1}` });
        const sc = scans[i];
        const filteredBytes = await applyFilterToBytes(sc.rawBytes, sc.rawMime, sc.filter, sc.rotation);
        processedFiles.push({
          id: sc.id,
          name: `scan_${i + 1}.jpg`,
          size: filteredBytes.byteLength,
          type: 'image/jpeg',
          bytes: filteredBytes,
          createdAt: Date.now(),
        });
      }
      const res = await imagesToPdf(
        processedFiles,
        {
          pageSize: 'a4',
          orientation: 'auto',
          marginPt: scanBorderless ? 0 : 18,
          cropEdgesToFill: scanCropToFill,
        },
        setProgress
      );
      onOutputCreated({
        id: `${Date.now()}`,
        blob: res.blob,
        fileName: `scanned_document_${scans.length}p.pdf`,
        mimeType: 'application/pdf',
        bytesLength: res.blob.size,
        pageCount: res.pageCount,
        summary: `Compiled ${scans.length} enhanced scan(s)`,
        canChainToPdfTools: true,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan export failed');
    } finally {
      setProcessing(false);
      setProgress(null);
    }
  };

  const handleRunOcr = async () => {
    if (!file) return;
    setProcessing(true);
    setError(null);
    try {
      const res = await ocrPdfOffline(
        file,
        { language: ocrLang, pageRange: ocrRange },
        setProgress
      );
      setOcrText(res.extractedText);
      onOutputCreated({
        id: `${Date.now()}`,
        blob: res.pdfBlob,
        fileName: `${stripExt(file.name)}_searchable_ocr.pdf`,
        mimeType: 'application/pdf',
        bytesLength: res.pdfBlob.size,
        pageCount: res.pageCount,
        summary: `Embedded ${res.wordCount} searchable OCR words`,
        canChainToPdfTools: true,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'OCR failed (ensure language data is cached or online once)');
    } finally {
      setProcessing(false);
      setProgress(null);
    }
  };

  if (toolId === 'scan-to-pdf') {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-7 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-sm font-semibold">Camera & Photo Capture</h2>
              <div className="flex items-center gap-2">
                {!stream ? (
                  <button
                    type="button"
                    onClick={startCamera}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-3 py-1.5 text-xs font-medium cursor-pointer"
                  >
                    <Video className="w-3.5 h-3.5" />
                    Enable Camera
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={captureFromCamera}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 text-white px-3 py-1.5 text-xs font-semibold cursor-pointer"
                    >
                      <Camera className="w-3.5 h-3.5" />
                      Capture Page
                    </button>
                    <button
                      type="button"
                      onClick={stopCamera}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs cursor-pointer"
                    >
                      <VideoOff className="w-3.5 h-3.5" />
                      Stop
                    </button>
                  </>
                )}
              </div>
            </div>

            {stream && (
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="w-full rounded-lg bg-slate-950 max-h-80 object-contain"
              />
            )}

            <FileDropZone
              compact
              accept="image/*"
              multiple
              label="Or drop / import photos from phone or scanner"
              onFilesAdded={(added) => {
                const newScans = added.map((wf) => ({
                  id: wf.id,
                  rawBytes: wf.bytes,
                  rawMime: wf.type || 'image/jpeg',
                  previewUrl: URL.createObjectURL(new Blob([wf.bytes.slice()], { type: wf.type || 'image/jpeg' })),
                  filter: scanFilter,
                  rotation: 0,
                }));
                setScans((prev) => [...prev, ...newScans]);
              }}
            />
          </div>

          <div className="lg:col-span-5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-800 pb-3">
              <div>
                <h2 className="font-display text-sm font-semibold">
                  Scanned Pages ({scans.length})
                </h2>
                {scans.length > 1 && (
                  <p className="text-[11px] text-slate-500">Drag cards or use arrows to reorder</p>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                {scans.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setScans((prev) => [...prev].reverse())}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2 py-1 text-xs hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                    title="Reverse order"
                  >
                    <ArrowUpDown className="w-3 h-3" />
                    Reverse
                  </button>
                )}
                <select
                  value={scanFilter}
                  onChange={(e) =>
                    setScanFilter(e.target.value as 'original' | 'enhance' | 'grayscale' | 'bw')
                  }
                  className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1 text-xs"
                >
                  <option value="enhance">Document Boost</option>
                  <option value="bw">High-Contrast B&W</option>
                  <option value="grayscale">Grayscale</option>
                  <option value="original">Original Color</option>
                </select>
              </div>
            </div>

            {scans.length === 0 ? (
              <p className="py-8 text-center text-xs text-slate-400">
                No captured pages yet. Capture via camera or import photos.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-3 max-h-80 overflow-y-auto">
                {scans.map((sc, idx) => (
                  <div
                    key={sc.id}
                    draggable
                    onDragStart={() => setDragScanIdx(idx)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragScanIdx !== null) reorderScan(dragScanIdx, idx);
                      setDragScanIdx(null);
                    }}
                    onDragEnd={() => setDragScanIdx(null)}
                    className={`rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden cursor-grab ${
                      dragScanIdx === idx ? 'opacity-45' : ''
                    }`}
                  >
                    <img
                      src={sc.previewUrl}
                      alt={`Scan ${idx + 1}`}
                      style={{
                        transform: `rotate(${sc.rotation}deg)`,
                        filter:
                          sc.filter === 'bw'
                            ? 'grayscale(1) contrast(2.2)'
                            : sc.filter === 'grayscale'
                              ? 'grayscale(1)'
                              : sc.filter === 'enhance'
                                ? 'contrast(1.25) brightness(1.06)'
                                : 'none',
                      }}
                      className="w-full h-32 object-cover bg-slate-100"
                    />
                    <div className="flex items-center justify-between px-2 py-1.5 text-xs bg-slate-50 dark:bg-slate-800">
                      <span className="font-mono tabular-nums">#{idx + 1}</span>
                      <div className="flex items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => reorderScan(idx, idx - 1)}
                          disabled={idx === 0}
                          className="p-1 hover:text-red-600 disabled:opacity-30 cursor-pointer"
                          title="Move earlier"
                          aria-label="Move scan earlier"
                        >
                          <ArrowLeft className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => reorderScan(idx, idx + 1)}
                          disabled={idx === scans.length - 1}
                          className="p-1 hover:text-red-600 disabled:opacity-30 cursor-pointer"
                          title="Move later"
                          aria-label="Move scan later"
                        >
                          <ArrowRight className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setScans((prev) =>
                              prev.map((x) =>
                                x.id === sc.id ? { ...x, rotation: (x.rotation + 90) % 360 } : x
                              )
                            )
                          }
                          className="p-1 hover:text-red-600 cursor-pointer"
                          title="Rotate"
                        >
                          <RotateCw className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            URL.revokeObjectURL(sc.previewUrl);
                            setScans((prev) => prev.filter((x) => x.id !== sc.id));
                          }}
                          className="p-1 hover:text-red-600 cursor-pointer"
                          title="Remove"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-2 pt-1">
              <label className="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={scanBorderless}
                  onChange={(e) => setScanBorderless(e.target.checked)}
                  className="mt-0.5 accent-red-600"
                />
                <span>Borderless scan images (no edge margins)</span>
              </label>
              <label className="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={scanCropToFill}
                  onChange={(e) => setScanCropToFill(e.target.checked)}
                  className="mt-0.5 accent-red-600"
                />
                <span>Crop page margins to fit full scan (never crops image)</span>
              </label>
            </div>

            {error && <p className="text-xs text-red-600">{error}</p>}
            <button
              type="button"
              onClick={handleCompileScans}
              disabled={processing || scans.length === 0}
              className="w-full rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 py-2.5 text-sm font-semibold text-white cursor-pointer"
            >
              {processing ? 'Building Scan PDF...' : 'Compile Scans to PDF'}
            </button>
            <OutputPanel output={output} onChainToTool={onChainToTool} compact />
          </div>
        </div>
      </div>
    );
  }

  // OCR PDF WORKBENCH
  return (
    <div className="space-y-6">
      {!file ? (
        <>
          <OutputPanel output={output} onChainToTool={onChainToTool} />
          <FileDropZone
            accept=".pdf,application/pdf"
            label="Drop a scanned PDF to make it searchable & selectable via offline OCR"
            onFilesAdded={(added) => setFiles([added[0]])}
            existingLibrary={sessionFiles}
          />
        </>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-8 space-y-4">
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold">{file.name}</p>
                <p className="text-xs text-slate-500 font-mono tabular-nums">
                  {formatBytes(file.size)} · {file.pageCount || '?'} pages
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setFiles([]);
                  setOcrText('');
                }}
                className="text-xs text-slate-500 hover:text-red-600 cursor-pointer"
              >
                Change File
              </button>
            </div>

            {ocrText && (
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold">Extracted OCR Text</h3>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(ocrText);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1800);
                      }}
                      className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 dark:text-slate-300 cursor-pointer"
                    >
                      {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                      {copied ? 'Copied' : 'Copy Text'}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        downloadBlob(
                          new Blob([ocrText], { type: 'text/plain;charset=utf-8' }),
                          `${stripExt(file.name)}_ocr.txt`
                        )
                      }
                      className="text-xs font-medium text-red-600 hover:underline cursor-pointer"
                    >
                      Download .txt
                    </button>
                  </div>
                </div>
                <pre className="max-h-96 overflow-auto rounded-lg bg-slate-50 dark:bg-slate-950 p-3 text-xs font-mono whitespace-pre-wrap">
                  {ocrText}
                </pre>
              </div>
            )}
          </div>

          <div className="lg:col-span-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
            <h2 className="font-display text-sm font-semibold border-b border-slate-100 dark:border-slate-800 pb-3">
              Tesseract WASM OCR
            </h2>
            <div>
              <label className="block text-xs font-medium mb-1">Document Language</label>
              <select
                value={ocrLang}
                onChange={(e) => setOcrLang(e.target.value)}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
              >
                <option value="eng">English (eng)</option>
                <option value="spa">Spanish (spa)</option>
                <option value="fra">French (fra)</option>
                <option value="deu">German (deu)</option>
                <option value="por">Portuguese (por)</option>
                <option value="ita">Italian (ita)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Pages to OCR</label>
              <input
                type="text"
                value={ocrRange}
                onChange={(e) => setOcrRange(e.target.value)}
                placeholder="all or 1-5"
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-xs font-mono"
              />
            </div>

            {progress && (
              <div className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="truncate">{progress.label}</span>
                  <span className="font-mono tabular-nums">
                    {progress.current}/{progress.total}
                  </span>
                </div>
                <div className="h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-red-600 transition-all"
                    style={{
                      width: `${Math.min(100, Math.round((progress.current / Math.max(1, progress.total)) * 100))}%`,
                    }}
                  />
                </div>
              </div>
            )}
            {error && <p className="text-xs text-red-600">{error}</p>}

            <button
              type="button"
              onClick={handleRunOcr}
              disabled={processing}
              className="w-full rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 py-2.5 text-sm font-semibold text-white cursor-pointer"
            >
              {processing ? 'Running OCR...' : 'Recognize & Embed Text Layer'}
            </button>

            <OutputPanel output={output} onChainToTool={onChainToTool} compact />
          </div>
        </div>
      )}
    </div>
  );
};
