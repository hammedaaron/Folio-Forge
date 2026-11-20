import React, { useState } from 'react';
import { BookOpen, Copy, Check, Download, Languages, Upload } from 'lucide-react';
import { ProgressInfo, ToolId, ToolOutput, WorkspaceFile } from '../../types/tools';
import {
  exportTranslatedPdf,
  ExtractiveSummaryResult,
  extractTranslatableBlocks,
  summarizePdfExtractive,
  TargetLang,
  TranslatableBlock,
  translateStringWithGlossary,
} from '../../utils/analysisEngines';
import { downloadBlob, formatBytes, stripExt } from '../../utils/pdfRuntime';
import { FileDropZone } from '../FileDropZone';
import { OutputPanel } from '../OutputPanel';

interface SummarizerTranslateToolProps {
  toolId: 'summarizer' | 'translate-pdf';
  files: WorkspaceFile[];
  setFiles: React.Dispatch<React.SetStateAction<WorkspaceFile[]>>;
  sessionFiles: WorkspaceFile[];
  onOutputCreated: (output: ToolOutput) => void;
  output: ToolOutput | null;
  onChainToTool: (targetTool: ToolId, output: ToolOutput) => void;
}

export const SummarizerTranslateTool: React.FC<SummarizerTranslateToolProps> = ({
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

  // Summarizer state
  const [sentenceLimit, setSentenceLimit] = useState(8);
  const [summaryResult, setSummaryResult] = useState<ExtractiveSummaryResult | null>(null);
  const [copiedSummary, setCopiedSummary] = useState(false);

  // Translate state
  const [targetLang, setTargetLang] = useState<TargetLang>('es');
  const [customGlossary, setCustomGlossary] = useState<Record<string, string>>({});
  const [blocks, setBlocks] = useState<TranslatableBlock[]>([]);

  const handleSummarize = async () => {
    if (!file) return;
    setProcessing(true);
    setError(null);
    try {
      const res = await summarizePdfExtractive(file, sentenceLimit, setProgress);
      setSummaryResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Summarization failed');
    } finally {
      setProcessing(false);
      setProgress(null);
    }
  };

  const handleLoadTranslationBlocks = async () => {
    if (!file) return;
    setProcessing(true);
    setError(null);
    try {
      const extracted = await extractTranslatableBlocks(file, targetLang, customGlossary);
      setBlocks(extracted);
      if (extracted.length === 0) {
        setError('No selectable text blocks found. Run OCR PDF first if this is a scanned document.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Extraction failed');
    } finally {
      setProcessing(false);
    }
  };

  const handleImportGlossary = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const gf = e.target.files?.[0];
    if (!gf) return;
    const text = await gf.text();
    const next: Record<string, string> = { ...customGlossary };
    if (gf.name.toLowerCase().endsWith('.json')) {
      try {
        const parsed = JSON.parse(text) as Record<string, string>;
        Object.entries(parsed).forEach(([k, v]) => {
          if (typeof v === 'string') next[k] = v;
        });
      } catch {
        setError('Invalid JSON glossary file.');
      }
    } else {
      text.split(/\r?\n/).forEach((line) => {
        const parts = line.split(/[,\t;]/);
        if (parts.length >= 2 && parts[0].trim()) {
          next[parts[0].trim()] = parts[1].trim();
        }
      });
    }
    setCustomGlossary(next);
    if (blocks.length > 0) {
      setBlocks((prev) =>
        prev.map((b) => ({
          ...b,
          translated: translateStringWithGlossary(b.original, targetLang, next),
        }))
      );
    }
    e.target.value = '';
  };

  const handleExportTranslated = async () => {
    if (!file || blocks.length === 0) return;
    setProcessing(true);
    setError(null);
    try {
      const res = await exportTranslatedPdf(file, blocks, setProgress);
      onOutputCreated({
        id: `${Date.now()}`,
        blob: res.blob,
        fileName: `${stripExt(file.name)}_${targetLang}.pdf`,
        mimeType: 'application/pdf',
        bytesLength: res.blob.size,
        pageCount: res.pageCount,
        summary: `Exported layout-preserved PDF (${blocks.length} text spans)`,
        canChainToPdfTools: true,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
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
            toolId === 'summarizer'
              ? 'Drop any PDF to extract TextRank key points, keywords & outline offline'
              : 'Drop a PDF to translate text blocks with layout preservation (100% offline)'
          }
          onFilesAdded={(added) => setFiles([added[0]])}
          existingLibrary={sessionFiles}
        />
      </div>
    );
  }

  if (toolId === 'summarizer') {
    const markdownSummary = summaryResult
      ? `# Summary: ${file.name}\n\n- Pages: ${summaryResult.stats.pageCount}\n- Words: ${summaryResult.stats.wordCount}\n- Reading time: ~${summaryResult.stats.readingMinutes} min\n\n## Key Points\n${summaryResult.keySentences
          .map((s) => `- [Page ${s.pageNumber}] ${s.sentence}`)
          .join('\n')}\n\n## Top Keywords\n${summaryResult.keywords
          .map((k) => `${k.term} (${k.count})`)
          .join(', ')}\n`
      : '';

    return (
      <div className="space-y-6">
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
                  setSummaryResult(null);
                }}
                className="text-xs text-slate-500 hover:text-red-600 cursor-pointer"
              >
                Change File
              </button>
            </div>

            {summaryResult && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    { label: 'Pages', value: summaryResult.stats.pageCount },
                    { label: 'Words', value: summaryResult.stats.wordCount.toLocaleString() },
                    { label: 'Sentences', value: summaryResult.stats.sentenceCount.toLocaleString() },
                    { label: 'Read Time', value: `${summaryResult.stats.readingMinutes} min` },
                  ].map((m) => (
                    <div
                      key={m.label}
                      className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3"
                    >
                      <p className="text-xs text-slate-500">{m.label}</p>
                      <p className="text-lg font-bold font-mono tabular-nums mt-0.5">{m.value}</p>
                    </div>
                  ))}
                </div>

                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-display text-sm font-semibold flex items-center gap-2">
                      <BookOpen className="w-4 h-4 text-red-600" />
                      Extracted Key Sentences (TextRank)
                    </h3>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(markdownSummary);
                          setCopiedSummary(true);
                          setTimeout(() => setCopiedSummary(false), 1800);
                        }}
                        className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 dark:text-slate-300 cursor-pointer"
                      >
                        {copiedSummary ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                        {copiedSummary ? 'Copied' : 'Copy'}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          downloadBlob(
                            new Blob([markdownSummary], { type: 'text/markdown' }),
                            `${stripExt(file.name)}_summary.md`
                          )
                        }
                        className="inline-flex items-center gap-1 text-xs font-medium text-red-600 hover:underline cursor-pointer"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Export .md
                      </button>
                    </div>
                  </div>
                  <ul className="space-y-2.5 divide-y divide-slate-100 dark:divide-slate-800">
                    {summaryResult.keySentences.map((s, idx) => (
                      <li key={idx} className="pt-2.5 first:pt-0 text-sm text-slate-700 dark:text-slate-200 leading-relaxed">
                        <span className="font-mono text-xs text-red-600 mr-2">P.{s.pageNumber}</span>
                        {s.sentence}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
                    <h4 className="text-xs font-semibold mb-2">Top TF-IDF Terms</h4>
                    <div className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                      {summaryResult.keywords.map((k, idx) => (
                        <span key={k.term}>
                          {idx > 0 ? ' · ' : ''}
                          <strong className="text-slate-900 dark:text-white">{k.term}</strong> ({k.count})
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
                    <h4 className="text-xs font-semibold mb-2">Detected Outline Headings</h4>
                    {summaryResult.headings.length === 0 ? (
                      <p className="text-xs text-slate-400">No distinct large-font headings found.</p>
                    ) : (
                      <ul className="space-y-1 max-h-40 overflow-y-auto text-xs">
                        {summaryResult.headings.map((h, i) => (
                          <li key={i} className="flex justify-between gap-2">
                            <span className="truncate">{h.title}</span>
                            <span className="font-mono text-slate-400 shrink-0">P.{h.pageNumber}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="lg:col-span-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
            <h2 className="font-display text-sm font-semibold border-b border-slate-100 dark:border-slate-800 pb-3">
              Extractive Algorithm
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              Uses deterministic TextRank graph centrality and TF-IDF scoring directly in your browser. Works 100% offline with zero AI APIs.
            </p>
            <div>
              <label className="block text-xs font-medium mb-1">
                Key Sentences ({sentenceLimit})
              </label>
              <input
                type="range"
                min={3}
                max={20}
                value={sentenceLimit}
                onChange={(e) => setSentenceLimit(Number(e.target.value))}
                className="w-full"
              />
            </div>

            {progress && (
              <div className="text-xs font-mono text-slate-500">
                {progress.label} ({progress.current}/{progress.total})
              </div>
            )}
            {error && <p className="text-xs text-red-600">{error}</p>}

            <button
              type="button"
              onClick={handleSummarize}
              disabled={processing}
              className="w-full rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 py-2.5 text-sm font-semibold text-white cursor-pointer"
            >
              {processing ? 'Scoring Sentences...' : 'Generate Extractive Summary'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // TRANSLATE PDF WORKBENCH (Offline Lexicon + Glossary + Layout Preservation)
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-8 space-y-4">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Languages className="w-4 h-4 text-red-600" />
              <span className="text-sm font-semibold truncate">{file.name}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setFiles([]);
                setBlocks([]);
              }}
              className="text-xs text-slate-500 hover:text-red-600 cursor-pointer"
            >
              Change File
            </button>
          </div>

          {blocks.length > 0 && (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold">
                  Bilingual Layout Blocks ({blocks.length}) — Edit any translation below
                </h3>
              </div>
              <div className="max-h-[520px] overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 pr-1">
                {blocks.slice(0, 250).map((b) => (
                  <div key={b.id} className="py-2.5 grid grid-cols-1 sm:grid-cols-2 gap-2 items-center">
                    <div className="text-xs text-slate-600 dark:text-slate-400">
                      <span className="font-mono text-[10px] text-slate-400 mr-1.5">P.{b.pageNumber}</span>
                      {b.original}
                    </div>
                    <input
                      type="text"
                      value={b.translated}
                      onChange={(e) =>
                        setBlocks((prev) =>
                          prev.map((x) => (x.id === b.id ? { ...x, translated: e.target.value } : x))
                        )
                      }
                      className="rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1.5 text-xs text-slate-900 dark:text-white"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="lg:col-span-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
          <h2 className="font-display text-sm font-semibold border-b border-slate-100 dark:border-slate-800 pb-3">
            Offline Layout Translator
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            Translates document text offline using a built-in dictionary and optional CSV/JSON glossary, then renders translated text back into the exact original PDF coordinates.
          </p>

          <div>
            <label className="block text-xs font-medium mb-1">Target Language Lexicon</label>
            <select
              value={targetLang}
              onChange={(e) => setTargetLang(e.target.value as TargetLang)}
              className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
            >
              <option value="es">Spanish (Español)</option>
              <option value="fr">French (Français)</option>
              <option value="de">German (Deutsch)</option>
              <option value="pt">Portuguese (Português)</option>
              <option value="it">Italian (Italiano)</option>
            </select>
          </div>

          <label className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 py-2 text-xs font-medium hover:border-red-500 cursor-pointer">
            <Upload className="w-3.5 h-3.5 text-red-600" />
            Import Custom CSV / JSON Glossary ({Object.keys(customGlossary).length} terms)
            <input
              type="file"
              accept=".csv,.txt,.json"
              className="hidden"
              onChange={handleImportGlossary}
            />
          </label>

          <button
            type="button"
            onClick={handleLoadTranslationBlocks}
            disabled={processing}
            className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 py-2 text-xs font-semibold hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer"
          >
            {blocks.length > 0 ? 'Re-Apply Lexicon to Blocks' : 'Extract & Auto-Translate Blocks'}
          </button>

          {progress && (
            <div className="text-xs font-mono text-slate-500">
              {progress.label}
            </div>
          )}
          {error && <p className="text-xs text-red-600">{error}</p>}

          <button
            type="button"
            onClick={handleExportTranslated}
            disabled={processing || blocks.length === 0}
            className="w-full rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 py-2.5 text-sm font-semibold text-white cursor-pointer"
          >
            {processing ? 'Rendering PDF...' : 'Export Layout-Preserved PDF'}
          </button>

          <OutputPanel output={output} onChainToTool={onChainToTool} compact />
        </div>
      </div>
    </div>
  );
};
