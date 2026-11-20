import React, { useEffect, useRef } from 'react';
import { ArrowRight, CheckCircle2, Download } from 'lucide-react';
import { ToolId, ToolOutput } from '../types/tools';
import { downloadBlob, formatBytes } from '../utils/pdfRuntime';

interface OutputPanelProps {
  output: ToolOutput | null;
  onChainToTool: (toolId: ToolId, output: ToolOutput) => void;
  compact?: boolean;
}

const CHAIN_TARGETS: { id: ToolId; label: string }[] = [
  { id: 'compress-pdf', label: 'Compress' },
  { id: 'protect-pdf', label: 'Protect' },
  { id: 'page-numbers', label: 'Page Numbers' },
  { id: 'watermark', label: 'Watermark' },
  { id: 'split-pdf', label: 'Split' },
  { id: 'sign-pdf', label: 'Sign' },
  { id: 'pdf-to-pdfa', label: 'PDF/A' },
];

export const OutputPanel: React.FC<OutputPanelProps> = ({
  output,
  onChainToTool,
  compact = false,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (output && containerRef.current) {
      containerRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [output?.id]);

  if (!output) return null;

  return (
    <div
      ref={containerRef}
      className="rounded-xl border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/80 dark:bg-emerald-950/35 p-4 space-y-3"
    >
      <div
        className={
          compact
            ? 'flex flex-col gap-3'
            : 'flex flex-wrap items-center justify-between gap-3'
        }
      >
        <div className="flex items-start gap-2.5 min-w-0">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
              {output.fileName}
            </p>
            <p className="text-xs text-slate-600 dark:text-slate-300 font-mono tabular-nums mt-0.5">
              {formatBytes(output.bytesLength)}
              {output.pageCount ? ` · ${output.pageCount} pages` : ''}
              {output.summary ? ` · ${output.summary}` : ''}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => downloadBlob(output.blob, output.fileName)}
          className={`inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
            compact ? 'w-full' : ''
          }`}
        >
          <Download className="w-4 h-4" />
          Download File
        </button>
      </div>

      {output.canChainToPdfTools && (
        <div className="pt-2.5 border-t border-emerald-200/70 dark:border-emerald-900/50 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium text-slate-600 dark:text-slate-400 mr-1">
            Continue in:
          </span>
          {CHAIN_TARGETS.map((target) => (
            <button
              key={target.id}
              type="button"
              onClick={() => onChainToTool(target.id, output)}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-[11px] font-medium text-slate-700 dark:text-slate-200 hover:border-red-500 hover:text-red-600 dark:hover:text-red-400 transition-colors cursor-pointer"
            >
              <span>{target.label}</span>
              <ArrowRight className="w-3 h-3" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
