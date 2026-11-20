import React, { useState } from 'react';
import {
  ArrowDown,
  ArrowDownAZ,
  ArrowUp,
  ArrowUpDown,
  Check,
  Copy,
  FileText,
  GripVertical,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { ProgressInfo, ToolId, ToolOutput, WorkspaceFile } from '../../types/tools';
import {
  ConvertibleEntry,
  convertOrderedItemsToPdf,
  excelToPdf,
  htmlToPdf,
  pdfToExcel,
  pdfToMarkdown,
  pdfToPowerPoint,
  pdfToWord,
  powerPointToPdf,
  wordToPdf,
} from '../../utils/officeEngines';
import { formatBytes, stripExt } from '../../utils/pdfRuntime';
import { expandFileListForAccept, withZipAccept } from '../../utils/zipExpand';
import { FileDropZone } from '../FileDropZone';
import { OutputPanel } from '../OutputPanel';

interface OfficeHtmlToolProps {
  toolId:
    | 'pdf-to-word'
    | 'pdf-to-powerpoint'
    | 'pdf-to-excel'
    | 'pdf-to-markdown'
    | 'word-to-pdf'
    | 'powerpoint-to-pdf'
    | 'excel-to-pdf'
    | 'html-to-pdf';
  files: WorkspaceFile[];
  setFiles: React.Dispatch<React.SetStateAction<WorkspaceFile[]>>;
  sessionFiles: WorkspaceFile[];
  onOutputCreated: (output: ToolOutput) => void;
  output: ToolOutput | null;
  onChainToTool: (targetTool: ToolId, output: ToolOutput) => void;
}

export const OfficeHtmlTool: React.FC<OfficeHtmlToolProps> = ({
  toolId,
  files,
  setFiles,
  sessionFiles,
  onOutputCreated,
  output,
  onChainToTool,
}) => {
  const file = files[0];
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<ProgressInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Drag-and-drop reorder state for convert-to-pdf queues
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  // Specific tool options
  const [combineExcelSheets, setCombineExcelSheets] = useState(false);
  const [excelPreviewSheets, setExcelPreviewSheets] = useState<{ name: string; rows: string[][] }[]>([]);
  const [pptAccentRule, setPptAccentRule] = useState(true);
  const [mdDividers, setMdDividers] = useState(true);
  const [mdPreview, setMdPreview] = useState('');
  const [copiedMd, setCopiedMd] = useState(false);

  const [docPageSize, setDocPageSize] = useState<'a4' | 'letter'>('a4');
  const [excelOrient, setExcelOrient] = useState<'landscape' | 'portrait'>('landscape');
  const [cropEdgesToFill, setCropEdgesToFill] = useState(true);

  // HTML to PDF inputs
  const [htmlInput, setHtmlInput] = useState(
    `<h1>Quarterly Operations Brief</h1>\n<p>Prepared offline with FolioForge HTML-to-PDF engine.</p>\n<ul>\n  <li>Zero cloud uploads</li>\n  <li>Vector text and tables preserved</li>\n</ul>\n<table>\n  <tr><th>Department</th><th>Status</th><th>Budget</th></tr>\n  <tr><td>Engineering</td><td>On Track</td><td>$42,000</td></tr>\n  <tr><td>Logistics</td><td>Completed</td><td>$18,500</td></tr>\n</table>`
  );
  const [urlInput, setUrlInput] = useState('');

  const isFromPdf = toolId.startsWith('pdf-to-');
  const isToPdfMulti = !isFromPdf;

  const acceptMap: Record<typeof toolId, string> = {
    'pdf-to-word': '.pdf,application/pdf',
    'pdf-to-powerpoint': '.pdf,application/pdf',
    'pdf-to-excel': '.pdf,application/pdf',
    'pdf-to-markdown': '.pdf,application/pdf',
    'word-to-pdf': '.docx,.txt,.md,.rtf',
    'powerpoint-to-pdf': '.pptx',
    'excel-to-pdf': '.xlsx,.xls,.csv,.ods',
    'html-to-pdf': '.html,.htm,text/html',
  };

  const moveFile = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= files.length) return;
    setFiles((prev) => {
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };

  const reorderFile = (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx || toIdx < 0 || toIdx >= files.length) return;
    setFiles((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  };

  const handleFetchUrl = async () => {
    if (!urlInput.trim()) return;
    setError(null);
    try {
      const resp = await fetch(urlInput.trim());
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      setHtmlInput(text);
    } catch {
      setError(
        'Direct browser fetch was blocked by target site CORS or offline state. Paste the page HTML source or upload saved .html file(s) below — both work 100% offline.'
      );
    }
  };

  const handleConvert = async () => {
    setProcessing(true);
    setError(null);
    setProgress({ current: 0, total: 1, label: 'Converting...' });

    try {
      if (toolId === 'html-to-pdf') {
        if (files.length > 1) {
          const items: ConvertibleEntry[] = files.map((f) => ({
            id: f.id,
            path: f.name,
            name: f.name,
            kind: 'html',
            mime: 'text/html',
            bytes: f.bytes,
            size: f.size,
            include: true,
          }));
          const res = await convertOrderedItemsToPdf(
            items,
            {
              pageSize: docPageSize,
              imageOrientation: 'auto',
              excelOrientation: 'landscape',
              marginPt: 0,
              addFileDividers: false,
              cropEdgesToFill,
            },
            setProgress
          );
          onOutputCreated({
            id: `${Date.now()}`,
            blob: res.blob,
            fileName: `${stripExt(files[0].name)}_merged.pdf`,
            mimeType: 'application/pdf',
            bytesLength: res.blob.size,
            pageCount: res.pageCount,
            summary: `Merged ${res.convertedCount} HTML file(s) into ${res.pageCount} PDF pages`,
            canChainToPdfTools: true,
          });
          return;
        }

        const sourceHtml = file ? new TextDecoder('utf-8').decode(file.bytes) : htmlInput;
        const res = await htmlToPdf(sourceHtml, docPageSize, { cropEdgesToFill });
        onOutputCreated({
          id: `${Date.now()}`,
          blob: res.blob,
          fileName: `${file ? stripExt(file.name) : 'webpage'}.pdf`,
          mimeType: 'application/pdf',
          bytesLength: res.blob.size,
          pageCount: res.pageCount,
          summary: `Converted HTML to ${res.pageCount} PDF page(s)`,
          canChainToPdfTools: true,
        });
        return;
      }

      if (!file) throw new Error('Please load a file first.');
      const base = stripExt(file.name);

      if (toolId === 'pdf-to-word') {
        const res = await pdfToWord(file, setProgress, cropEdgesToFill);
        onOutputCreated({
          id: `${Date.now()}`,
          blob: res.blob,
          fileName: res.fileName,
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          bytesLength: res.blob.size,
          pageCount: res.pageCount,
          summary: `Exported editable DOCX (${res.pageCount} pages)`,
          canChainToPdfTools: false,
        });
      } else if (toolId === 'pdf-to-powerpoint') {
        const res = await pdfToPowerPoint(file, pptAccentRule, setProgress, cropEdgesToFill);
        onOutputCreated({
          id: `${Date.now()}`,
          blob: res.blob,
          fileName: res.fileName,
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          bytesLength: res.blob.size,
          summary: `Built ${res.slideCount} editable PPTX slides`,
          canChainToPdfTools: false,
        });
      } else if (toolId === 'pdf-to-excel') {
        const res = await pdfToExcel(file, combineExcelSheets, setProgress, cropEdgesToFill);
        setExcelPreviewSheets(res.sheets);
        onOutputCreated({
          id: `${Date.now()}`,
          blob: res.blob,
          fileName: res.fileName,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          bytesLength: res.blob.size,
          summary: `Extracted ${res.sheets.length} table sheet(s)`,
          canChainToPdfTools: false,
        });
      } else if (toolId === 'pdf-to-markdown') {
        const res = await pdfToMarkdown(file, mdDividers, setProgress, cropEdgesToFill);
        setMdPreview(res.markdown);
        onOutputCreated({
          id: `${Date.now()}`,
          blob: res.blob,
          fileName: res.fileName,
          mimeType: 'text/markdown',
          bytesLength: res.blob.size,
          pageCount: res.pageCount,
          summary: `Generated clean Markdown (${res.pageCount} pages)`,
          canChainToPdfTools: false,
        });
      } else if (toolId === 'word-to-pdf' || toolId === 'excel-to-pdf' || toolId === 'powerpoint-to-pdf') {
        if (files.length > 1) {
          const kind =
            toolId === 'word-to-pdf'
              ? 'word'
              : toolId === 'excel-to-pdf'
                ? 'excel'
                : 'powerpoint';
          const items: ConvertibleEntry[] = files.map((f) => ({
            id: f.id,
            path: f.name,
            name: f.name,
            kind,
            mime: f.type,
            bytes: f.bytes,
            size: f.size,
            include: true,
          }));
          const res = await convertOrderedItemsToPdf(
            items,
            {
              pageSize: docPageSize,
              imageOrientation: 'auto',
              excelOrientation: excelOrient,
              marginPt: 0,
              addFileDividers: false,
              cropEdgesToFill,
            },
            setProgress
          );
          onOutputCreated({
            id: `${Date.now()}`,
            blob: res.blob,
            fileName: `${base}_merged.pdf`,
            mimeType: 'application/pdf',
            bytesLength: res.blob.size,
            pageCount: res.pageCount,
            summary: `Converted & merged ${res.convertedCount} file(s) into ${res.pageCount} PDF pages`,
            canChainToPdfTools: true,
          });
          return;
        }

        if (toolId === 'word-to-pdf') {
          const res = await wordToPdf(file, docPageSize, { cropEdgesToFill });
          onOutputCreated({
            id: `${Date.now()}`,
            blob: res.blob,
            fileName: `${base}.pdf`,
            mimeType: 'application/pdf',
            bytesLength: res.blob.size,
            pageCount: res.pageCount,
            summary: `Converted to ${res.pageCount} PDF page(s)`,
            canChainToPdfTools: true,
          });
        } else if (toolId === 'excel-to-pdf') {
          const res = await excelToPdf(file, { orientation: excelOrient, cropEdgesToFill });
          onOutputCreated({
            id: `${Date.now()}`,
            blob: res.blob,
            fileName: `${base}.pdf`,
            mimeType: 'application/pdf',
            bytesLength: res.blob.size,
            pageCount: res.pageCount,
            summary: `Rendered ${res.sheetNames.length} sheet(s) across ${res.pageCount} PDF pages`,
            canChainToPdfTools: true,
          });
        } else if (toolId === 'powerpoint-to-pdf') {
          const res = await powerPointToPdf(file, setProgress, { cropEdgesToFill });
          onOutputCreated({
            id: `${Date.now()}`,
            blob: res.blob,
            fileName: `${base}.pdf`,
            mimeType: 'application/pdf',
            bytesLength: res.blob.size,
            pageCount: res.pageCount,
            summary: `Converted ${res.pageCount} slide(s) to PDF`,
            canChainToPdfTools: true,
          });
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Conversion failed');
    } finally {
      setProcessing(false);
      setProgress(null);
    }
  };

  const renderReorderableQueue = () => (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
            Files to Convert ({files.length})
          </h2>
          {files.length > 1 && (
            <p className="text-xs text-slate-500">
              Drag rows or use arrows to reorder files in the merged PDF
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {files.length > 1 && (
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
          <label className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer">
            <Plus className="w-3.5 h-3.5" />
            Add More
            <input
              type="file"
              multiple
              accept={withZipAccept(acceptMap[toolId])}
              className="hidden"
              onChange={async (e) => {
                if (!e.target.files) return;
                const res = await expandFileListForAccept(e.target.files, acceptMap[toolId]);
                if (res.matched.length > 0) {
                  setError(null);
                  setFiles((prev) => [...prev, ...res.matched]);
                } else if (res.zipCount > 0) {
                  setError(
                    `ZIP unpacked (${res.totalInsideZip} files), none matched this tool's expected file type.`
                  );
                }
                e.target.value = '';
              }}
            />
          </label>
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
          const isDragging = dragIdx === idx;
          const isOver = overIdx === idx && dragIdx !== idx;
          return (
            <div
              key={f.id}
              draggable
              onDragStart={() => setDragIdx(idx)}
              onDragOver={(e) => {
                e.preventDefault();
                if (overIdx !== idx) setOverIdx(idx);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIdx !== null) reorderFile(dragIdx, idx);
                setDragIdx(null);
                setOverIdx(null);
              }}
              onDragEnd={() => {
                setDragIdx(null);
                setOverIdx(null);
              }}
              className={`flex items-center justify-between gap-3 py-2.5 px-1.5 rounded-lg transition-colors ${
                isDragging ? 'opacity-45 bg-slate-100 dark:bg-slate-800' : ''
              } ${isOver ? 'border-t-2 border-red-600 bg-red-50/40 dark:bg-red-950/20' : ''}`}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <GripVertical className="w-4 h-4 text-slate-400 cursor-grab shrink-0" />
                <span className="text-xs font-mono tabular-nums text-slate-400 w-6 shrink-0">
                  #{idx + 1}
                </span>
                <FileText className="w-4 h-4 text-red-600 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate max-w-[300px]">
                    {f.name}
                  </p>
                  <p className="text-xs text-slate-500 font-mono tabular-nums">
                    {formatBytes(f.size)}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0">
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
  );

  return (
    <div className="space-y-6">
      {toolId === 'html-to-pdf' ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-8 space-y-4">
            {files.length > 0 && renderReorderableQueue()}

            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
              {files.length === 0 && (
                <>
                  <div className="flex flex-wrap gap-2">
                    <input
                      type="url"
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      placeholder="Optional URL (when online & CORS-enabled)"
                      className="flex-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2 text-xs"
                    />
                    <button
                      type="button"
                      onClick={handleFetchUrl}
                      className="rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
                    >
                      Fetch URL
                    </button>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-xs font-medium text-slate-700 dark:text-slate-300">
                        HTML Source Code (100% offline)
                      </label>
                    </div>
                    <textarea
                      rows={10}
                      value={htmlInput}
                      onChange={(e) => setHtmlInput(e.target.value)}
                      className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 p-3 text-xs font-mono"
                    />
                  </div>
                </>
              )}

              {files.length === 1 && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    HTML Preview ({files[0].name})
                  </label>
                  <textarea
                    rows={10}
                    value={new TextDecoder('utf-8').decode(files[0].bytes)}
                    onChange={(e) => {
                      const updatedBytes = new TextEncoder().encode(e.target.value);
                      setFiles((prev) =>
                        prev.map((x, idx) =>
                          idx === 0 ? { ...x, bytes: updatedBytes, size: updatedBytes.byteLength } : x
                        )
                      );
                    }}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 p-3 text-xs font-mono"
                  />
                </div>
              )}

              <FileDropZone
                compact
                multiple
                accept=".html,.htm,text/html"
                label="Drop one or more local .html / .htm files here"
                onFilesAdded={(added) => setFiles((prev) => [...prev, ...added])}
              />
            </div>
          </div>

          <div className="lg:col-span-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
            <h2 className="font-display text-sm font-semibold border-b border-slate-100 dark:border-slate-800 pb-3">
              HTML Page Settings
            </h2>
            <div>
              <label className="block text-xs font-medium mb-1">Page Size</label>
              <select
                value={docPageSize}
                onChange={(e) => setDocPageSize(e.target.value as 'a4' | 'letter')}
                className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
              >
                <option value="a4">A4</option>
                <option value="letter">US Letter</option>
              </select>
            </div>
            <label className="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={cropEdgesToFill}
                onChange={(e) => setCropEdgesToFill(e.target.checked)}
                className="mt-0.5 accent-red-600"
              />
              <span>Crop outer page margins to fit content (never crops content)</span>
            </label>
            {progress && (
              <div className="text-xs text-slate-600 dark:text-slate-300 font-mono">
                {progress.label} ({progress.current}/{progress.total})
              </div>
            )}
            {error && <p className="text-xs text-red-600">{error}</p>}
            <button
              type="button"
              onClick={handleConvert}
              disabled={processing}
              className="w-full rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 py-2.5 text-sm font-semibold text-white cursor-pointer"
            >
              {processing
                ? 'Generating PDF...'
                : files.length > 1
                  ? `Convert & Merge ${files.length} HTML Files`
                  : 'Convert HTML to PDF'}
            </button>
            <OutputPanel output={output} onChainToTool={onChainToTool} compact />
          </div>
        </div>
      ) : !file ? (
        <>
          <OutputPanel output={output} onChainToTool={onChainToTool} />
          <FileDropZone
            accept={acceptMap[toolId]}
            multiple={isToPdfMulti}
            label={
              isFromPdf
                ? 'Drop a PDF file here to convert'
                : `Drop one or more ${toolId.split('-')[0].toUpperCase()} files here to convert & merge`
            }
            onFilesAdded={(added) => setFiles(isToPdfMulti ? added : [added[0]])}
            existingLibrary={isFromPdf ? sessionFiles : []}
          />
        </>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-8 space-y-4">
            {isToPdfMulti ? (
              renderReorderableQueue()
            ) : (
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <FileText className="w-5 h-5 text-red-600 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">{file.name}</p>
                    <p className="text-xs text-slate-500 font-mono tabular-nums">
                      {formatBytes(file.size)}
                      {file.pageCount ? ` · ${file.pageCount} pages` : ''}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setFiles([]);
                    setMdPreview('');
                    setExcelPreviewSheets([]);
                  }}
                  className="text-xs text-slate-500 hover:text-red-600 cursor-pointer"
                >
                  Change File
                </button>
              </div>
            )}

            {mdPreview && (
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold">Extracted Markdown Preview</h3>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(mdPreview);
                      setCopiedMd(true);
                      setTimeout(() => setCopiedMd(false), 1800);
                    }}
                    className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 dark:text-slate-300 cursor-pointer"
                  >
                    {copiedMd ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedMd ? 'Copied' : 'Copy Markdown'}
                  </button>
                </div>
                <pre className="max-h-96 overflow-auto rounded-lg bg-slate-50 dark:bg-slate-950 p-3 text-xs font-mono whitespace-pre-wrap">
                  {mdPreview}
                </pre>
              </div>
            )}

            {excelPreviewSheets.length > 0 && (
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
                <h3 className="text-xs font-semibold">
                  Extracted Table Preview ({excelPreviewSheets[0].name})
                </h3>
                <div className="max-h-80 overflow-auto border border-slate-200 dark:border-slate-800 rounded-lg">
                  <table className="w-full text-xs text-left border-collapse">
                    <tbody>
                      {excelPreviewSheets[0].rows.slice(0, 40).map((row, ri) => (
                        <tr
                          key={ri}
                          className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50"
                        >
                          {row.map((cell, ci) => (
                            <td key={ci} className="px-2.5 py-1.5 border-r border-slate-100 dark:border-slate-800">
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          <div className="lg:col-span-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
            <h2 className="font-display text-sm font-semibold border-b border-slate-100 dark:border-slate-800 pb-3">
              Conversion Options
            </h2>

            {toolId === 'pdf-to-excel' && (
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={combineExcelSheets}
                  onChange={(e) => setCombineExcelSheets(e.target.checked)}
                />
                Combine all pages into a single Excel sheet
              </label>
            )}

            {toolId === 'pdf-to-powerpoint' && (
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={pptAccentRule}
                  onChange={(e) => setPptAccentRule(e.target.checked)}
                />
                Add clean top header accent line on slides
              </label>
            )}

            {toolId === 'pdf-to-markdown' && (
              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={mdDividers}
                  onChange={(e) => setMdDividers(e.target.checked)}
                />
                Include page break comments & dividers
              </label>
            )}

            {toolId === 'word-to-pdf' && (
              <div>
                <label className="block text-xs font-medium mb-1">Output Page Size</label>
                <select
                  value={docPageSize}
                  onChange={(e) => setDocPageSize(e.target.value as 'a4' | 'letter')}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
                >
                  <option value="a4">A4</option>
                  <option value="letter">US Letter</option>
                </select>
              </div>
            )}

            {toolId === 'excel-to-pdf' && (
              <div>
                <label className="block text-xs font-medium mb-1">Sheet Orientation</label>
                <select
                  value={excelOrient}
                  onChange={(e) => setExcelOrient(e.target.value as 'landscape' | 'portrait')}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
                >
                  <option value="landscape">Landscape (Recommended for wide sheets)</option>
                  <option value="portrait">Portrait</option>
                </select>
              </div>
            )}

            <label className="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={cropEdgesToFill}
                onChange={(e) => setCropEdgesToFill(e.target.checked)}
                className="mt-0.5 accent-red-600"
              />
              <span>
                {isFromPdf
                  ? 'Trim outer margin header/footer edges'
                  : 'Crop outer page margins to fit content (never crops content)'}
              </span>
            </label>

            {progress && (
              <div className="text-xs text-slate-600 dark:text-slate-300 font-mono">
                {progress.label} ({progress.current}/{progress.total})
              </div>
            )}
            {error && <p className="text-xs text-red-600">{error}</p>}

            <button
              type="button"
              onClick={handleConvert}
              disabled={processing}
              className="w-full rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 py-2.5 text-sm font-semibold text-white cursor-pointer"
            >
              {processing
                ? 'Converting locally...'
                : isToPdfMulti && files.length > 1
                  ? `Convert & Merge ${files.length} Files`
                  : 'Convert Now'}
            </button>

            <OutputPanel output={output} onChainToTool={onChainToTool} compact />
          </div>
        </div>
      )}
    </div>
  );
};
