import React, { useEffect, useRef, useState } from 'react';
import {
  Circle,
  Eraser,
  Highlighter,
  ImagePlus,
  MousePointer,
  PenLine,
  Search,
  Square,
  Trash2,
  Type,
  Undo2,
} from 'lucide-react';
import { ProgressInfo, ToolId, ToolOutput, WorkspaceFile } from '../../types/tools';
import {
  applyRedactions,
  bakeOverlaysToPdf,
  findTextRedactionBoxes,
  PdfOverlayItem,
  RedactionBox,
} from '../../utils/pdfEngines';
import { canvasToUint8Array, stripExt } from '../../utils/pdfRuntime';
import { expandFileListForAccept, withZipAccept } from '../../utils/zipExpand';
import { FileDropZone } from '../FileDropZone';
import { OutputPanel } from '../OutputPanel';
import { InteractivePageCanvas, usePdfJsDocument } from '../VirtualPageGrid';

interface EditSignRedactToolProps {
  toolId: 'edit-pdf' | 'sign-pdf' | 'redact-pdf';
  files: WorkspaceFile[];
  setFiles: React.Dispatch<React.SetStateAction<WorkspaceFile[]>>;
  sessionFiles: WorkspaceFile[];
  onOutputCreated: (output: ToolOutput) => void;
  output: ToolOutput | null;
  onChainToTool: (targetTool: ToolId, output: ToolOutput) => void;
}

type EditMode = 'select' | 'text' | 'pen' | 'highlight' | 'rect' | 'ellipse' | 'image';

export const EditSignRedactTool: React.FC<EditSignRedactToolProps> = ({
  toolId,
  files,
  setFiles,
  sessionFiles,
  onOutputCreated,
  output,
  onChainToTool,
}) => {
  const file = files[0];
  const { doc: pdfDoc, numPages } = usePdfJsDocument(file?.bytes);
  const [pageNumber, setPageNumber] = useState(1);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<ProgressInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Overlays for Edit & Sign (stored with ObjectURLs for image preview, Uint8Array for export)
  const [overlays, setOverlays] = useState<PdfOverlayItem[]>([]);
  const [imgUrlMap, setImgUrlMap] = useState<Map<Uint8Array, string>>(new Map());
  const [editMode, setEditMode] = useState<EditMode>(toolId === 'sign-pdf' ? 'image' : 'text');
  const [textDraft, setTextDraft] = useState('Added note');
  const [fontSize, setFontSize] = useState(16);
  const [colorHex, setColorHex] = useState('#1E293B');
  const [strokeWidth, setStrokeWidth] = useState(2.5);
  const [boldText, setBoldText] = useState(false);

  // Active drawing state
  const stageRef = useRef<HTMLDivElement>(null);
  const [drawingShape, setDrawingShape] = useState<{
    startX: number;
    startY: number;
    currX: number;
    currY: number;
  } | null>(null);
  const [activeStroke, setActiveStroke] = useState<{ xNorm: number; yNorm: number }[] | null>(null);

  // Sign PDF studio state
  const sigCanvasRef = useRef<HTMLCanvasElement>(null);
  const [sigTab, setSigTab] = useState<'draw' | 'type' | 'upload'>('draw');
  const [sigDrawing, setSigDrawing] = useState(false);
  const [typedSig, setTypedSig] = useState('Jane Doe');
  const [activeSigBytes, setActiveSigBytes] = useState<{ bytes: Uint8Array; mime: string } | null>(null);
  const [sigScaleW, setSigScaleW] = useState(0.26);

  // Redact PDF state
  const [redactSearch, setRedactSearch] = useState('');
  const [redactRegex, setRedactRegex] = useState(false);
  const [redactions, setRedactions] = useState<RedactionBox[]>([]);
  const [redactColor, setRedactColor] = useState('#000000');

  useEffect(() => {
    setPageNumber(1);
    setOverlays([]);
    setRedactions([]);
  }, [file?.id, toolId]);

  // Register ObjectURL for any image Uint8Array without base64
  const getImgPreviewUrl = (bytes: Uint8Array, mime: string): string => {
    const existing = imgUrlMap.get(bytes);
    if (existing) return existing;
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const url = URL.createObjectURL(new Blob([copy], { type: mime }));
    setImgUrlMap((prev) => new Map(prev).set(bytes, url));
    return url;
  };

  useEffect(() => {
    return () => {
      imgUrlMap.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [imgUrlMap]);

  const getNorm = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return { xNorm: 0, yNorm: 0 };
    return {
      xNorm: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      yNorm: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  };

  const handleStageMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const { xNorm, yNorm } = getNorm(e);

    if (toolId === 'redact-pdf') {
      setDrawingShape({ startX: xNorm, startY: yNorm, currX: xNorm, currY: yNorm });
      return;
    }

    if (toolId === 'sign-pdf') {
      if (!activeSigBytes) {
        setError('Create or upload your signature on the right panel first, then click the page to place it.');
        return;
      }
      setError(null);
      setOverlays((prev) => [
        ...prev,
        {
          id: `sig_${Date.now()}`,
          kind: 'image',
          pageNumber,
          xNorm: Math.max(0, Math.min(1 - sigScaleW, xNorm - sigScaleW / 2)),
          yNorm: Math.max(0, Math.min(0.9, yNorm - 0.04)),
          wNorm: sigScaleW,
          hNorm: sigScaleW * 0.42,
          imageBytes: activeSigBytes.bytes,
          imageMime: activeSigBytes.mime,
        },
      ]);
      return;
    }

    // Edit PDF
    if (editMode === 'text') {
      if (!textDraft.trim()) return;
      setOverlays((prev) => [
        ...prev,
        {
          id: `txt_${Date.now()}`,
          kind: 'text',
          pageNumber,
          xNorm,
          yNorm,
          text: textDraft,
          fontSize,
          colorHex,
          bold: boldText,
        },
      ]);
    } else if (editMode === 'pen' || editMode === 'highlight') {
      setActiveStroke([{ xNorm, yNorm }]);
    } else if (editMode === 'rect' || editMode === 'ellipse') {
      setDrawingShape({ startX: xNorm, startY: yNorm, currX: xNorm, currY: yNorm });
    }
  };

  const handleStageMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const { xNorm, yNorm } = getNorm(e);
    if (activeStroke) {
      setActiveStroke((prev) => (prev ? [...prev, { xNorm, yNorm }] : null));
    } else if (drawingShape) {
      setDrawingShape((prev) => (prev ? { ...prev, currX: xNorm, currY: yNorm } : null));
    }
  };

  const handleStageMouseUp = () => {
    if (activeStroke && activeStroke.length > 1) {
      setOverlays((prev) => [
        ...prev,
        {
          id: `stk_${Date.now()}`,
          kind: 'stroke',
          pageNumber,
          points: activeStroke,
          colorHex: editMode === 'highlight' ? '#FACC15' : colorHex,
          strokeWidth: editMode === 'highlight' ? 14 : strokeWidth,
          opacity: editMode === 'highlight' ? 0.38 : 1,
        },
      ]);
    }
    setActiveStroke(null);

    if (drawingShape) {
      const xNorm = Math.min(drawingShape.startX, drawingShape.currX);
      const yNorm = Math.min(drawingShape.startY, drawingShape.currY);
      const wNorm = Math.abs(drawingShape.currX - drawingShape.startX);
      const hNorm = Math.abs(drawingShape.currY - drawingShape.startY);
      if (wNorm > 0.015 && hNorm > 0.015) {
        if (toolId === 'redact-pdf') {
          setRedactions((prev) => [...prev, { pageNumber, xNorm, yNorm, wNorm, hNorm }]);
        } else if (editMode === 'rect' || editMode === 'ellipse') {
          setOverlays((prev) => [
            ...prev,
            {
              id: `shp_${Date.now()}`,
              kind: editMode,
              pageNumber,
              xNorm,
              yNorm,
              wNorm,
              hNorm,
              colorHex,
              strokeWidth,
            },
          ]);
        }
      }
    }
    setDrawingShape(null);
  };

  // Signature drawing pad handlers
  const captureDrawnSignature = async () => {
    const c = sigCanvasRef.current;
    if (!c) return;
    const bytes = await canvasToUint8Array(c, 'image/png', 1);
    setActiveSigBytes({ bytes, mime: 'image/png' });
    setError(null);
  };

  const generateTypedSignature = async () => {
    const c = document.createElement('canvas');
    c.width = 480;
    c.height = 160;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = colorHex;
    ctx.font = 'italic 54px Georgia, "Times New Roman", serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(typedSig || 'Signature', 24, 85);
    const bytes = await canvasToUint8Array(c, 'image/png', 1);
    setActiveSigBytes({ bytes, mime: 'image/png' });
    setError(null);
  };

  const handleFindRedactMatches = async (presetPattern?: string) => {
    if (!file) return;
    const query = presetPattern ?? redactSearch;
    if (!query.trim()) return;
    setProcessing(true);
    try {
      const found = await findTextRedactionBoxes(
        file,
        query.split(','),
        presetPattern ? true : redactRegex
      );
      setRedactions((prev) => [...prev, ...found]);
      if (found.length === 0) setError('No matching text found in document.');
      else setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setProcessing(false);
    }
  };

  const handleSave = async () => {
    if (!file) return;
    setProcessing(true);
    setError(null);
    try {
      const base = stripExt(file.name);
      if (toolId === 'redact-pdf') {
        if (redactions.length === 0) throw new Error('Add at least one redaction box first.');
        const res = await applyRedactions(file, redactions, redactColor, setProgress);
        onOutputCreated({
          id: `${Date.now()}`,
          blob: res.blob,
          fileName: `${base}_redacted.pdf`,
          mimeType: 'application/pdf',
          bytesLength: res.blob.size,
          summary: `Permanently redacted ${res.boxCount} region(s) across ${res.redactedPages} page(s)`,
          canChainToPdfTools: true,
        });
      } else {
        if (overlays.length === 0) throw new Error('Place at least one annotation or signature on the document.');
        const res = await bakeOverlaysToPdf(file, overlays, setProgress);
        onOutputCreated({
          id: `${Date.now()}`,
          blob: res.blob,
          fileName: `${base}_${toolId === 'sign-pdf' ? 'signed' : 'edited'}.pdf`,
          mimeType: 'application/pdf',
          bytesLength: res.blob.size,
          pageCount: res.pageCount,
          summary: `Applied ${overlays.length} element(s)`,
          canChainToPdfTools: true,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setProcessing(false);
      setProgress(null);
    }
  };

  if (!file) {
    return (
      <div className="space-y-6">
        <OutputPanel output={output} onChainToTool={onChainToTool} />
        <FileDropZone
          accept=".pdf,application/pdf"
          label={
            toolId === 'sign-pdf'
              ? 'Drop a PDF to sign electronically'
              : toolId === 'redact-pdf'
                ? 'Drop a PDF to permanently redact sensitive information'
                : 'Drop a PDF to add text, shapes, freehand ink, or images'
          }
          onFilesAdded={(added) => setFiles([added[0]])}
          existingLibrary={sessionFiles}
        />
      </div>
    );
  }

  const pageOverlays = overlays.filter((o) => o.pageNumber === pageNumber);
  const pageRedactions = redactions.filter((r) => r.pageNumber === pageNumber);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Interactive Canvas Stage */}
        <div className="lg:col-span-8 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-950 p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                disabled={pageNumber <= 1}
                onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
                className="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 disabled:opacity-40 cursor-pointer"
              >
                Prev
              </button>
              <span className="font-mono tabular-nums font-medium">
                Page {pageNumber} / {numPages || 1}
              </span>
              <button
                type="button"
                disabled={pageNumber >= numPages}
                onClick={() => setPageNumber((p) => Math.min(numPages, p + 1))}
                className="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 disabled:opacity-40 cursor-pointer"
              >
                Next
              </button>
            </div>

            <div className="flex items-center gap-2">
              {toolId !== 'redact-pdf' ? (
                <button
                  type="button"
                  onClick={() => setOverlays((prev) => prev.slice(0, -1))}
                  disabled={overlays.length === 0}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1 text-xs disabled:opacity-40 cursor-pointer"
                >
                  <Undo2 className="w-3.5 h-3.5" />
                  Undo
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setRedactions((prev) => prev.slice(0, -1))}
                  disabled={redactions.length === 0}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1 text-xs disabled:opacity-40 cursor-pointer"
                >
                  <Undo2 className="w-3.5 h-3.5" />
                  Undo Box
                </button>
              )}
              <button
                type="button"
                onClick={() => setFiles([])}
                className="text-xs text-slate-500 hover:text-red-600 cursor-pointer"
              >
                Change PDF
              </button>
            </div>
          </div>

          <div className="flex justify-center overflow-auto">
            <div
              ref={stageRef}
              onMouseDown={handleStageMouseDown}
              onMouseMove={handleStageMouseMove}
              onMouseUp={handleStageMouseUp}
              className="relative inline-block cursor-crosshair select-none"
            >
              <InteractivePageCanvas pdfDoc={pdfDoc} pageNumber={pageNumber} scale={1.25} />

              {/* SVG layer for live strokes */}
              <svg
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                className="pointer-events-none absolute inset-0 w-full h-full"
              >
                {pageOverlays
                  .filter((o): o is Extract<PdfOverlayItem, { kind: 'stroke' }> => o.kind === 'stroke')
                  .map((stk) => (
                    <polyline
                      key={stk.id}
                      fill="none"
                      stroke={stk.colorHex}
                      strokeOpacity={stk.opacity}
                      strokeWidth={stk.strokeWidth * 0.22}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      points={stk.points.map((pt) => `${pt.xNorm * 100},${pt.yNorm * 100}`).join(' ')}
                    />
                  ))}
                {activeStroke && (
                  <polyline
                    fill="none"
                    stroke={editMode === 'highlight' ? '#FACC15' : colorHex}
                    strokeOpacity={editMode === 'highlight' ? 0.38 : 1}
                    strokeWidth={(editMode === 'highlight' ? 14 : strokeWidth) * 0.22}
                    strokeLinecap="round"
                    points={activeStroke.map((pt) => `${pt.xNorm * 100},${pt.yNorm * 100}`).join(' ')}
                  />
                )}
              </svg>

              {/* HTML overlay items */}
              {pageOverlays.map((item) => {
                if (item.kind === 'text') {
                  return (
                    <div
                      key={item.id}
                      style={{
                        left: `${item.xNorm * 100}%`,
                        top: `${item.yNorm * 100}%`,
                        color: item.colorHex,
                        fontSize: `${item.fontSize * 1.1}px`,
                        fontWeight: item.bold ? 700 : 400,
                      }}
                      className="absolute leading-tight whitespace-pre bg-white/40 px-0.5 rounded border border-dashed border-slate-400/50"
                    >
                      {item.text}
                    </div>
                  );
                }
                if (item.kind === 'rect' || item.kind === 'ellipse') {
                  return (
                    <div
                      key={item.id}
                      style={{
                        left: `${item.xNorm * 100}%`,
                        top: `${item.yNorm * 100}%`,
                        width: `${item.wNorm * 100}%`,
                        height: `${item.hNorm * 100}%`,
                        borderColor: item.colorHex,
                        borderWidth: `${item.strokeWidth}px`,
                        borderRadius: item.kind === 'ellipse' ? '9999px' : '2px',
                      }}
                      className="absolute pointer-events-none"
                    />
                  );
                }
                if (item.kind === 'image') {
                  return (
                    <img
                      key={item.id}
                      src={getImgPreviewUrl(item.imageBytes, item.imageMime)}
                      alt="Placed stamp"
                      style={{
                        left: `${item.xNorm * 100}%`,
                        top: `${item.yNorm * 100}%`,
                        width: `${item.wNorm * 100}%`,
                        height: `${item.hNorm * 100}%`,
                      }}
                      className="absolute object-contain pointer-events-none border border-dashed border-red-400/60"
                    />
                  );
                }
                return null;
              })}

              {/* Redaction boxes */}
              {pageRedactions.map((b, idx) => (
                <div
                  key={idx}
                  style={{
                    left: `${b.xNorm * 100}%`,
                    top: `${b.yNorm * 100}%`,
                    width: `${b.wNorm * 100}%`,
                    height: `${b.hNorm * 100}%`,
                    backgroundColor: redactColor,
                  }}
                  className="absolute opacity-85 border border-red-500"
                />
              ))}

              {/* Active drag shape preview */}
              {drawingShape && (
                <div
                  style={{
                    left: `${Math.min(drawingShape.startX, drawingShape.currX) * 100}%`,
                    top: `${Math.min(drawingShape.startY, drawingShape.currY) * 100}%`,
                    width: `${Math.abs(drawingShape.currX - drawingShape.startX) * 100}%`,
                    height: `${Math.abs(drawingShape.currY - drawingShape.startY) * 100}%`,
                    borderColor: toolId === 'redact-pdf' ? '#DC2626' : colorHex,
                    backgroundColor: toolId === 'redact-pdf' ? 'rgba(0,0,0,0.45)' : 'transparent',
                    borderWidth: '2px',
                    borderRadius: editMode === 'ellipse' ? '9999px' : '2px',
                  }}
                  className="absolute pointer-events-none"
                />
              )}
            </div>
          </div>
        </div>

        {/* Right Controls Inspector */}
        <div className="lg:col-span-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-5">
          {toolId === 'edit-pdf' && (
            <>
              <h2 className="font-display text-sm font-semibold border-b border-slate-100 dark:border-slate-800 pb-3">
                Annotation Tools
              </h2>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    { id: 'text', label: 'Text', Icon: Type },
                    { id: 'pen', label: 'Freehand', Icon: PenLine },
                    { id: 'highlight', label: 'Highlight', Icon: Highlighter },
                    { id: 'rect', label: 'Rectangle', Icon: Square },
                    { id: 'ellipse', label: 'Circle', Icon: Circle },
                    { id: 'select', label: 'Inspect', Icon: MousePointer },
                  ] as const
                ).map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setEditMode(id)}
                    className={`flex flex-col items-center gap-1 rounded-lg border py-2 text-xs font-medium cursor-pointer ${
                      editMode === id
                        ? 'border-red-600 bg-red-600 text-white'
                        : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    {label}
                  </button>
                ))}
              </div>

              {editMode === 'text' && (
                <div className="space-y-2.5">
                  <label className="block text-xs font-medium">Text Content (click page to stamp)</label>
                  <textarea
                    rows={2}
                    value={textDraft}
                    onChange={(e) => setTextDraft(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs mb-1">Font Size</label>
                      <input
                        type="number"
                        min={8}
                        max={72}
                        value={fontSize}
                        onChange={(e) => setFontSize(Number(e.target.value))}
                        className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1.5 text-xs font-mono"
                      />
                    </div>
                    <div className="flex items-end pb-1.5">
                      <label className="flex items-center gap-2 text-xs cursor-pointer">
                        <input
                          type="checkbox"
                          checked={boldText}
                          onChange={(e) => setBoldText(e.target.checked)}
                        />
                        Bold Text
                      </label>
                    </div>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs mb-1">Ink / Stroke Color</label>
                  <input
                    type="color"
                    value={colorHex}
                    onChange={(e) => setColorHex(e.target.value)}
                    className="h-9 w-full rounded border border-slate-200 dark:border-slate-700 cursor-pointer"
                  />
                </div>
                <div>
                  <label className="block text-xs mb-1">Stroke Width ({strokeWidth}px)</label>
                  <input
                    type="range"
                    min={1}
                    max={10}
                    step={0.5}
                    value={strokeWidth}
                    onChange={(e) => setStrokeWidth(Number(e.target.value))}
                    className="w-full mt-2"
                  />
                </div>
              </div>

              <label className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 py-2.5 text-xs font-medium hover:border-red-500 cursor-pointer">
                <ImagePlus className="w-4 h-4 text-red-600" />
                Insert Image onto Center of Page
                <input
                  type="file"
                  accept={withZipAccept('image/png,image/jpeg')}
                  className="hidden"
                  onChange={async (e) => {
                    if (!e.target.files?.length) return;
                    const res = await expandFileListForAccept(e.target.files, 'image/png,image/jpeg');
                    const wf = res.matched[0];
                    if (wf) {
                      setOverlays((prev) => [
                        ...prev,
                        {
                          id: `img_${Date.now()}`,
                          kind: 'image',
                          pageNumber,
                          xNorm: 0.3,
                          yNorm: 0.3,
                          wNorm: 0.35,
                          hNorm: 0.25,
                          imageBytes: wf.bytes,
                          imageMime: wf.type || 'image/png',
                        },
                      ]);
                    }
                    e.target.value = '';
                  }}
                />
              </label>
            </>
          )}

          {toolId === 'sign-pdf' && (
            <>
              <h2 className="font-display text-sm font-semibold border-b border-slate-100 dark:border-slate-800 pb-3">
                Signature Studio
              </h2>
              <div className="grid grid-cols-3 gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-lg">
                {(['draw', 'type', 'upload'] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setSigTab(tab)}
                    className={`py-1.5 rounded-md text-xs font-medium capitalize cursor-pointer ${
                      sigTab === tab
                        ? 'bg-white dark:bg-slate-900 shadow-sm text-slate-900 dark:text-white'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>

              {sigTab === 'draw' && (
                <div className="space-y-2">
                  <canvas
                    ref={sigCanvasRef}
                    width={360}
                    height={140}
                    onMouseDown={(e) => {
                      const c = sigCanvasRef.current;
                      const ctx = c?.getContext('2d');
                      if (!c || !ctx) return;
                      const r = c.getBoundingClientRect();
                      ctx.strokeStyle = colorHex;
                      ctx.lineWidth = 3;
                      ctx.lineCap = 'round';
                      ctx.beginPath();
                      ctx.moveTo(((e.clientX - r.left) / r.width) * c.width, ((e.clientY - r.top) / r.height) * c.height);
                      setSigDrawing(true);
                    }}
                    onMouseMove={(e) => {
                      if (!sigDrawing) return;
                      const c = sigCanvasRef.current;
                      const ctx = c?.getContext('2d');
                      if (!c || !ctx) return;
                      const r = c.getBoundingClientRect();
                      ctx.lineTo(((e.clientX - r.left) / r.width) * c.width, ((e.clientY - r.top) / r.height) * c.height);
                      ctx.stroke();
                    }}
                    onMouseUp={() => {
                      setSigDrawing(false);
                      void captureDrawnSignature();
                    }}
                    className="w-full h-32 rounded-lg border border-slate-200 dark:border-slate-700 bg-white cursor-crosshair"
                  />
                  <div className="flex justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const c = sigCanvasRef.current;
                        c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
                        setActiveSigBytes(null);
                      }}
                      className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-red-600 cursor-pointer"
                    >
                      <Eraser className="w-3.5 h-3.5" />
                      Clear Pad
                    </button>
                    <button
                      type="button"
                      onClick={captureDrawnSignature}
                      className="rounded-md bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-3 py-1 text-xs font-medium cursor-pointer"
                    >
                      Use Drawn Signature
                    </button>
                  </div>
                </div>
              )}

              {sigTab === 'type' && (
                <div className="space-y-2.5">
                  <input
                    type="text"
                    value={typedSig}
                    onChange={(e) => setTypedSig(e.target.value)}
                    placeholder="Type full name"
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-base italic font-serif"
                  />
                  <button
                    type="button"
                    onClick={generateTypedSignature}
                    className="w-full rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 py-2 text-xs font-medium cursor-pointer"
                  >
                    Prepare Typed Signature
                  </button>
                </div>
              )}

              {sigTab === 'upload' && (
                <label className="block rounded-lg border border-dashed border-slate-300 dark:border-slate-700 p-4 text-center text-xs cursor-pointer hover:border-red-500">
                  Upload transparent PNG or JPG signature
                  <input
                    type="file"
                    accept={withZipAccept('image/png,image/jpeg')}
                    className="hidden"
                    onChange={async (e) => {
                      if (!e.target.files?.length) return;
                      const res = await expandFileListForAccept(e.target.files, 'image/png,image/jpeg');
                      const wf = res.matched[0];
                      if (wf) {
                        setActiveSigBytes({ bytes: wf.bytes, mime: wf.type || 'image/png' });
                      }
                      e.target.value = '';
                    }}
                  />
                </label>
              )}

              <div className="space-y-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                <div className="flex items-center justify-between text-xs">
                  <span>Signature Width ({Math.round(sigScaleW * 100)}%)</span>
                  <input
                    type="color"
                    value={colorHex}
                    onChange={(e) => setColorHex(e.target.value)}
                    className="h-6 w-10 rounded cursor-pointer"
                  />
                </div>
                <input
                  type="range"
                  min={0.12}
                  max={0.5}
                  step={0.02}
                  value={sigScaleW}
                  onChange={(e) => setSigScaleW(Number(e.target.value))}
                  className="w-full"
                />
                <button
                  type="button"
                  onClick={() =>
                    setOverlays((prev) => [
                      ...prev,
                      {
                        id: `date_${Date.now()}`,
                        kind: 'text',
                        pageNumber,
                        xNorm: 0.65,
                        yNorm: 0.85,
                        text: new Date().toLocaleDateString(),
                        fontSize: 12,
                        colorHex: '#1E293B',
                      },
                    ])
                  }
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 py-1.5 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                >
                  Stamp Today's Date on Page
                </button>
                <p className="text-xs text-slate-500">
                  {activeSigBytes
                    ? 'Signature ready — click anywhere on the PDF page to place it.'
                    : 'Prepare a signature above, then click the document.'}
                </p>
              </div>
            </>
          )}

          {toolId === 'redact-pdf' && (
            <>
              <h2 className="font-display text-sm font-semibold border-b border-slate-100 dark:border-slate-800 pb-3">
                Permanent Redaction
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Drag rectangles directly on any page OR auto-mark matching text across all pages. Redacted pages are burned permanently so hidden text cannot be copied.
              </p>

              <div className="space-y-2">
                <label className="block text-xs font-medium">Search & Mark Terms (comma-separated)</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={redactSearch}
                    onChange={(e) => setRedactSearch(e.target.value)}
                    placeholder="e.g. Confidential, John Doe"
                    className="flex-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => handleFindRedactMatches()}
                    className="inline-flex items-center gap-1 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-3 py-1.5 text-xs font-medium cursor-pointer"
                  >
                    <Search className="w-3.5 h-3.5" />
                    Mark
                  </button>
                </div>
                <label className="flex items-center gap-2 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={redactRegex}
                    onChange={(e) => setRedactRegex(e.target.checked)}
                  />
                  Use Regular Expression
                </label>
              </div>

              <div className="space-y-1.5">
                <span className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Quick PII Pattern Redaction:
                </span>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleFindRedactMatches('[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}')}
                    className="rounded border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-xs hover:border-red-500 cursor-pointer"
                  >
                    Emails
                  </button>
                  <button
                    type="button"
                    onClick={() => handleFindRedactMatches('\\b\\d{3}[-.]?\\d{2}[-.]?\\d{4}\\b')}
                    className="rounded border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-xs hover:border-red-500 cursor-pointer"
                  >
                    SSN / IDs
                  </button>
                  <button
                    type="button"
                    onClick={() => handleFindRedactMatches('(\\+?\\d[\\d\\s().-]{7,}\\d)')}
                    className="rounded border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-xs hover:border-red-500 cursor-pointer"
                  >
                    Phone Numbers
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between text-xs pt-2 border-t border-slate-100 dark:border-slate-800">
                <span>Box Fill Color</span>
                <input
                  type="color"
                  value={redactColor}
                  onChange={(e) => setRedactColor(e.target.value)}
                  className="h-7 w-12 rounded cursor-pointer"
                />
              </div>

              <div className="flex items-center justify-between text-xs">
                <span className="font-mono tabular-nums">{redactions.length} redaction box(es) queued</span>
                {redactions.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setRedactions([])}
                    className="inline-flex items-center gap-1 text-red-600 hover:underline cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Clear All
                  </button>
                )}
              </div>
            </>
          )}

          {progress && (
            <div className="text-xs text-slate-600 dark:text-slate-300 font-mono">
              {progress.label} ({progress.current}/{progress.total})
            </div>
          )}
          {error && (
            <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-2.5 text-xs text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          <button
            type="button"
            onClick={handleSave}
            disabled={processing}
            className="w-full rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 py-2.5 text-sm font-semibold text-white transition-colors cursor-pointer"
          >
            {processing
              ? 'Applying...'
              : toolId === 'redact-pdf'
                ? 'Burn Permanent Redactions'
                : toolId === 'sign-pdf'
                  ? 'Save Signed PDF'
                  : 'Save Edited PDF'}
          </button>

          <OutputPanel output={output} onChainToTool={onChainToTool} compact />
        </div>
      </div>
    </div>
  );
};
