import React, { useEffect, useState } from 'react';
import { GitCompare } from 'lucide-react';
import { ToolId, ToolOutput, WorkspaceFile } from '../../types/tools';
import { comparePdfPage, PageCompareResult } from '../../utils/analysisEngines';
import { FileDropZone } from '../FileDropZone';

interface CompareToolProps {
  files: WorkspaceFile[];
  setFiles: React.Dispatch<React.SetStateAction<WorkspaceFile[]>>;
  sessionFiles: WorkspaceFile[];
  onOutputCreated?: (output: ToolOutput) => void;
  onChainToTool?: (targetTool: ToolId, output: ToolOutput) => void;
}

export const CompareTool: React.FC<CompareToolProps> = ({
  files,
  setFiles,
  sessionFiles,
}) => {
  const fileA = files[0];
  const fileB = files[1];
  const [pageNumber, setPageNumber] = useState(1);
  const [viewMode, setViewMode] = useState<'side-by-side' | 'overlay'>('side-by-side');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PageCompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const maxPages = Math.max(fileA?.pageCount || 1, fileB?.pageCount || 1);

  useEffect(() => {
    if (!fileA || !fileB) {
      setResult(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    comparePdfPage(fileA, fileB, pageNumber)
      .then((res) => {
        if (cancelled) {
          URL.revokeObjectURL(res.leftBlobUrl);
          URL.revokeObjectURL(res.rightBlobUrl);
          URL.revokeObjectURL(res.diffBlobUrl);
          return;
        }
        setResult((prev) => {
          if (prev) {
            URL.revokeObjectURL(prev.leftBlobUrl);
            URL.revokeObjectURL(prev.rightBlobUrl);
            URL.revokeObjectURL(prev.diffBlobUrl);
          }
          return res;
        });
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Comparison failed');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [fileA, fileB, pageNumber]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
              Original Document (A)
            </span>
            {fileA && (
              <button
                type="button"
                onClick={() => setFiles((prev) => prev.filter((_, i) => i !== 0))}
                className="text-xs text-red-600 hover:underline cursor-pointer"
              >
                Replace
              </button>
            )}
          </div>
          {fileA ? (
            <p className="text-sm font-medium truncate">
              {fileA.name} ({fileA.pageCount || '?'} pages)
            </p>
          ) : (
            <FileDropZone
              compact
              accept=".pdf,application/pdf"
              label="Drop Original PDF (A)"
              onFilesAdded={(added) =>
                setFiles((prev) => (prev[1] ? [added[0], prev[1]] : [added[0]]))
              }
              existingLibrary={sessionFiles}
            />
          )}
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
              Modified Document (B)
            </span>
            {fileB && (
              <button
                type="button"
                onClick={() => setFiles((prev) => prev.filter((_, i) => i !== 1))}
                className="text-xs text-red-600 hover:underline cursor-pointer"
              >
                Replace
              </button>
            )}
          </div>
          {fileB ? (
            <p className="text-sm font-medium truncate">
              {fileB.name} ({fileB.pageCount || '?'} pages)
            </p>
          ) : (
            <FileDropZone
              compact
              accept=".pdf,application/pdf"
              label="Drop Revised PDF (B)"
              onFilesAdded={(added) =>
                setFiles((prev) => (prev[0] ? [prev[0], added[0]] : [added[0]]))
              }
              existingLibrary={sessionFiles}
            />
          )}
        </div>
      </div>

      {fileA && fileB && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
            <div className="flex items-center gap-2">
              <GitCompare className="w-4 h-4 text-red-600" />
              <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-lg">
                <button
                  type="button"
                  onClick={() => setViewMode('side-by-side')}
                  className={`px-3 py-1 rounded-md text-xs font-medium cursor-pointer ${
                    viewMode === 'side-by-side'
                      ? 'bg-white dark:bg-slate-900 shadow-sm'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  Side-by-Side
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('overlay')}
                  className={`px-3 py-1 rounded-md text-xs font-medium cursor-pointer ${
                    viewMode === 'overlay'
                      ? 'bg-white dark:bg-slate-900 shadow-sm'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  Visual Pixel Diff
                </button>
              </div>
              {result && (
                <span className="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-300 ml-2">
                  Pixel delta: {result.pixelDiffPercent}% · +{result.addedCount} / -{result.removedCount} words
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 text-xs font-mono">
              <button
                type="button"
                disabled={pageNumber <= 1}
                onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
                className="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 disabled:opacity-40 cursor-pointer"
              >
                Prev
              </button>
              <span>
                Page {pageNumber} / {maxPages}
              </span>
              <button
                type="button"
                disabled={pageNumber >= maxPages}
                onClick={() => setPageNumber((p) => Math.min(maxPages, p + 1))}
                className="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 disabled:opacity-40 cursor-pointer"
              >
                Next
              </button>
            </div>
          </div>

          {error && <p className="text-xs text-red-600">{error}</p>}
          {loading && (
            <div className="p-8 text-center text-xs text-slate-500">
              Rendering visual pixel diff and computing word LCS...
            </div>
          )}

          {result && !loading && (
            <div className="space-y-4">
              {viewMode === 'side-by-side' ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
                    <p className="text-xs font-medium text-slate-500 mb-2">Version A</p>
                    <img src={result.leftBlobUrl} alt="Version A" className="w-full border border-slate-200" />
                  </div>
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3">
                    <p className="text-xs font-medium text-slate-500 mb-2">Version B</p>
                    <img src={result.rightBlobUrl} alt="Version B" className="w-full border border-slate-200" />
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex flex-col items-center">
                  <p className="text-xs text-slate-500 mb-2">
                    Red highlights indicate pixels changed between Version A and Version B
                  </p>
                  <img
                    src={result.diffBlobUrl}
                    alt="Pixel diff overlay"
                    className="max-w-2xl w-full border border-slate-200"
                  />
                </div>
              )}

              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
                <h3 className="text-xs font-semibold mb-2">Word-Level Text Diff (Page {pageNumber})</h3>
                <div className="max-h-60 overflow-y-auto text-xs leading-relaxed">
                  {result.wordDiffs.length === 0 ? (
                    <span className="text-slate-400">No extractable text on this page.</span>
                  ) : (
                    result.wordDiffs.map((tok, i) => (
                      <span
                        key={i}
                        className={
                          tok.kind === 'added'
                            ? 'bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300 px-0.5 rounded mx-0.5'
                            : tok.kind === 'removed'
                              ? 'bg-red-100 dark:bg-red-950 text-red-800 dark:text-red-300 line-through px-0.5 rounded mx-0.5'
                              : 'text-slate-700 dark:text-slate-300 mx-0.5'
                        }
                      >
                        {tok.text}
                      </span>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
