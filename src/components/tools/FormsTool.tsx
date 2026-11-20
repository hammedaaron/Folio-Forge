import React, { useEffect, useRef, useState } from 'react';
import { CheckSquare, ChevronDown, CircleDot, Plus, Trash2, Type } from 'lucide-react';
import { ToolId, ToolOutput, WorkspaceFile } from '../../types/tools';
import {
  DetectedFormField,
  detectAcroFormFields,
  NewFormFieldSpec,
  saveFormChanges,
} from '../../utils/analysisEngines';
import { stripExt } from '../../utils/pdfRuntime';
import { FileDropZone } from '../FileDropZone';
import { OutputPanel } from '../OutputPanel';
import { InteractivePageCanvas, usePdfJsDocument } from '../VirtualPageGrid';

interface FormsToolProps {
  files: WorkspaceFile[];
  setFiles: React.Dispatch<React.SetStateAction<WorkspaceFile[]>>;
  sessionFiles: WorkspaceFile[];
  onOutputCreated: (output: ToolOutput) => void;
  output: ToolOutput | null;
  onChainToTool: (targetTool: ToolId, output: ToolOutput) => void;
}

export const FormsTool: React.FC<FormsToolProps> = ({
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
  const [mode, setMode] = useState<'fill' | 'create'>('fill');
  const [detected, setDetected] = useState<DetectedFormField[]>([]);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [newFields, setNewFields] = useState<NewFormFieldSpec[]>([]);
  const [activeCreateType, setActiveCreateType] = useState<'text' | 'checkbox' | 'radio' | 'dropdown'>('text');
  const [newFieldName, setNewFieldName] = useState('full_name');
  const [newFieldOptions, setNewFieldOptions] = useState('Option A, Option B, Option C');
  const [flatten, setFlatten] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!file) {
      setDetected([]);
      setValues({});
      setNewFields([]);
      return;
    }
    setPageNumber(1);
    detectAcroFormFields(file)
      .then((fields) => {
        setDetected(fields);
        const init: Record<string, string | boolean> = {};
        fields.forEach((f) => {
          init[f.name] = f.value;
        });
        setValues(init);
        setMode(fields.length > 0 ? 'fill' : 'create');
      })
      .catch(() => {
        setDetected([]);
        setMode('create');
      });
  }, [file]);

  const handleStageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (mode !== 'create') return;
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const xNorm = Math.max(0, Math.min(0.85, (e.clientX - rect.left) / rect.width));
    const yNorm = Math.max(0, Math.min(0.92, (e.clientY - rect.top) / rect.height));
    const id = `nf_${Date.now()}`;
    const opts = newFieldOptions
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    setNewFields((prev) => [
      ...prev,
      {
        id,
        name: `${newFieldName || 'field'}_${prev.length + 1}`,
        kind: activeCreateType,
        pageNumber,
        xNorm,
        yNorm,
        wNorm: activeCreateType === 'checkbox' ? 0.035 : 0.28,
        hNorm: activeCreateType === 'checkbox' ? 0.03 : 0.045,
        options: opts,
        fontSize: 11,
      },
    ]);
  };

  const handleExport = async () => {
    if (!file) return;
    setProcessing(true);
    setError(null);
    try {
      const res = await saveFormChanges(file, values, newFields, flatten);
      onOutputCreated({
        id: `${Date.now()}`,
        blob: res.blob,
        fileName: `${stripExt(file.name)}_${flatten ? 'filled' : 'fillable'}.pdf`,
        mimeType: 'application/pdf',
        bytesLength: res.blob.size,
        pageCount: res.pageCount,
        summary: `${detected.length} filled, ${newFields.length} added${flatten ? ' (flattened)' : ''}`,
        canChainToPdfTools: true,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to export PDF form');
    } finally {
      setProcessing(false);
    }
  };

  if (!file) {
    return (
      <div className="space-y-6">
        <OutputPanel output={output} onChainToTool={onChainToTool} />
        <FileDropZone
          accept=".pdf,application/pdf"
          label="Drop a PDF to detect/fill form fields or add new interactive fields"
          onFilesAdded={(added) => setFiles([added[0]])}
          existingLibrary={sessionFiles}
        />
      </div>
    );
  }

  const pageDetected = detected.filter((f) => (f.pageNumber || 1) === pageNumber);
  const pageNew = newFields.filter((f) => f.pageNumber === pageNumber);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-8 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-950 p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-slate-600 dark:text-slate-300">
              {mode === 'create'
                ? 'Click anywhere on the page to place an interactive form field'
                : `Detected ${detected.length} AcroForm field(s) — fill directly on page or in sidebar`}
            </span>
            <div className="flex items-center gap-2 text-xs font-mono">
              <button
                type="button"
                disabled={pageNumber <= 1}
                onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
                className="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 disabled:opacity-40 cursor-pointer"
              >
                Prev
              </button>
              <span>
                {pageNumber} / {numPages || 1}
              </span>
              <button
                type="button"
                disabled={pageNumber >= numPages}
                onClick={() => setPageNumber((p) => Math.min(numPages, p + 1))}
                className="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 disabled:opacity-40 cursor-pointer"
              >
                Next
              </button>
              <button
                type="button"
                onClick={() => setFiles([])}
                className="ml-2 text-slate-500 hover:text-red-600 font-sans cursor-pointer"
              >
                Change PDF
              </button>
            </div>
          </div>

          <div className="flex justify-center overflow-auto">
            <div
              ref={stageRef}
              onClick={handleStageClick}
              className={`relative inline-block ${mode === 'create' ? 'cursor-crosshair' : ''}`}
            >
              <InteractivePageCanvas pdfDoc={pdfDoc} pageNumber={pageNumber} scale={1.2} />

              {/* Existing interactive field overlays */}
              {pageDetected.map((f) => {
                if (f.xNorm === undefined || f.yNorm === undefined) return null;
                return (
                  <div
                    key={f.name}
                    style={{
                      left: `${f.xNorm * 100}%`,
                      top: `${f.yNorm * 100}%`,
                      width: `${Math.max(4, (f.wNorm || 0.2) * 100)}%`,
                      height: `${Math.max(3, (f.hNorm || 0.04) * 100)}%`,
                    }}
                    className="absolute"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {f.kind === 'checkbox' ? (
                      <input
                        type="checkbox"
                        checked={Boolean(values[f.name])}
                        onChange={(e) => setValues((p) => ({ ...p, [f.name]: e.target.checked }))}
                        className="w-full h-full accent-red-600 cursor-pointer"
                      />
                    ) : f.kind === 'dropdown' || f.kind === 'list' || f.kind === 'radio' ? (
                      <select
                        value={String(values[f.name] ?? '')}
                        onChange={(e) => setValues((p) => ({ ...p, [f.name]: e.target.value }))}
                        className="w-full h-full bg-blue-50/90 border border-blue-500 text-xs text-slate-900 px-1"
                      >
                        <option value="">--</option>
                        {f.options?.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={String(values[f.name] ?? '')}
                        onChange={(e) => setValues((p) => ({ ...p, [f.name]: e.target.value }))}
                        className="w-full h-full bg-blue-50/90 border border-blue-500 text-xs text-slate-900 px-1 focus:outline-none"
                      />
                    )}
                  </div>
                );
              })}

              {/* Newly placed form fields */}
              {pageNew.map((nf) => (
                <div
                  key={nf.id}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    left: `${nf.xNorm * 100}%`,
                    top: `${nf.yNorm * 100}%`,
                    width: `${nf.wNorm * 100}%`,
                    height: `${nf.hNorm * 100}%`,
                  }}
                  className="absolute border-2 border-red-600 bg-red-50/80 flex items-center justify-between px-1.5 text-[10px] font-mono text-red-900"
                >
                  <span className="truncate">{nf.name}</span>
                  <button
                    type="button"
                    onClick={() => setNewFields((prev) => prev.filter((x) => x.id !== nf.id))}
                    className="text-red-700 hover:text-red-900 cursor-pointer"
                    aria-label="Remove field"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right Form Builder & Inspector */}
        <div className="lg:col-span-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
          <div className="grid grid-cols-2 gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-lg">
            <button
              type="button"
              onClick={() => setMode('fill')}
              className={`py-1.5 rounded-md text-xs font-medium cursor-pointer ${
                mode === 'fill'
                  ? 'bg-white dark:bg-slate-900 shadow-sm text-slate-900 dark:text-white'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              Fill Detected ({detected.length})
            </button>
            <button
              type="button"
              onClick={() => setMode('create')}
              className={`py-1.5 rounded-md text-xs font-medium cursor-pointer ${
                mode === 'create'
                  ? 'bg-white dark:bg-slate-900 shadow-sm text-slate-900 dark:text-white'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              Add Fields ({newFields.length})
            </button>
          </div>

          {mode === 'fill' ? (
            <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
              {detected.length === 0 ? (
                <p className="text-xs text-slate-500">
                  No existing AcroForm fields detected in this PDF. Switch to "Add Fields" to make this document fillable.
                </p>
              ) : (
                detected.map((f) => (
                  <div key={f.name} className="space-y-1">
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                      {f.name} ({f.kind})
                    </label>
                    {f.kind === 'checkbox' ? (
                      <label className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={Boolean(values[f.name])}
                          onChange={(e) => setValues((p) => ({ ...p, [f.name]: e.target.checked }))}
                        />
                        Checked
                      </label>
                    ) : f.options ? (
                      <select
                        value={String(values[f.name] ?? '')}
                        onChange={(e) => setValues((p) => ({ ...p, [f.name]: e.target.value }))}
                        className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs"
                      >
                        <option value="">Select...</option>
                        {f.options.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={String(values[f.name] ?? '')}
                        onChange={(e) => setValues((p) => ({ ...p, [f.name]: e.target.value }))}
                        className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs"
                      />
                    )}
                  </div>
                ))
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    { id: 'text', label: 'Text Field', Icon: Type },
                    { id: 'checkbox', label: 'Checkbox', Icon: CheckSquare },
                    { id: 'radio', label: 'Multiple Choice', Icon: CircleDot },
                    { id: 'dropdown', label: 'Dropdown List', Icon: ChevronDown },
                  ] as const
                ).map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setActiveCreateType(id)}
                    className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs font-medium cursor-pointer ${
                      activeCreateType === id
                        ? 'border-red-600 bg-red-600 text-white'
                        : 'border-slate-200 dark:border-slate-700'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </button>
                ))}
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Field Name Prefix</label>
                <input
                  type="text"
                  value={newFieldName}
                  onChange={(e) => setNewFieldName(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-mono"
                />
              </div>
              {(activeCreateType === 'dropdown' || activeCreateType === 'radio') && (
                <div>
                  <label className="block text-xs font-medium mb-1">Options (comma-separated)</label>
                  <input
                    type="text"
                    value={newFieldOptions}
                    onChange={(e) => setNewFieldOptions(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs"
                  />
                </div>
              )}
              <div className="text-xs text-slate-500 flex items-center gap-1.5">
                <Plus className="w-3.5 h-3.5 text-red-600" />
                Click on the PDF page preview to stamp fields.
              </div>
            </div>
          )}

          <label className="flex items-center gap-2 text-xs pt-2 border-t border-slate-100 dark:border-slate-800 cursor-pointer">
            <input
              type="checkbox"
              checked={flatten}
              onChange={(e) => setFlatten(e.target.checked)}
            />
            Flatten form fields (make values non-editable)
          </label>

          {error && <p className="text-xs text-red-600">{error}</p>}

          <button
            type="button"
            onClick={handleExport}
            disabled={processing}
            className="w-full rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 py-2.5 text-sm font-semibold text-white cursor-pointer"
          >
            {processing ? 'Saving PDF Form...' : 'Export PDF Form'}
          </button>

          <OutputPanel output={output} onChainToTool={onChainToTool} compact />
        </div>
      </div>
    </div>
  );
};
