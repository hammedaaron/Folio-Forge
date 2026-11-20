import React, { useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight,
  FileText,
  Moon,
  Search,
  Sun,
  Trash2,
  Upload,
} from 'lucide-react';
import { CATEGORY_LABELS, TOOL_CATALOG } from '../data/toolCatalog';
import { ToolCategory, ToolId, WorkspaceFile } from '../types/tools';
import { fileToWorkspaceFile, formatBytes } from '../utils/pdfRuntime';
import {
  expandWorkspaceFilesForAccept,
  inspectZipArchiveSummary,
  isZipFile,
  ZipSummary,
} from '../utils/zipExpand';
import { PWAInstallButton } from './PWAControls';
import { ToolIcon } from './ToolIcon';

interface ToolDirectoryProps {
  activeCategory: ToolCategory | 'all';
  onCategoryChange: (cat: ToolCategory | 'all') => void;
  onOpenTool: (toolId: ToolId, initialFiles?: WorkspaceFile[]) => void;
  sessionFiles: WorkspaceFile[];
  onClearSessionFiles: () => void;
  darkMode: boolean;
  onToggleDarkMode: () => void;
}

function getSuggestedToolsForFile(file: WorkspaceFile, zipSummary?: ZipSummary | null): ToolId[] {
  const lower = file.name.toLowerCase();
  if (isZipFile(file.name, file.type, file.bytes)) {
    const out: ToolId[] = ['zip-to-pdf'];
    if (zipSummary) {
      const c = zipSummary.counts;
      if (c.pdf > 0) {
        out.push('merge-pdf', 'compress-pdf', 'organize-pdf', 'split-pdf', 'rotate-pdf', 'protect-pdf', 'pdf-to-word');
      }
      if (c.image > 0) {
        out.push('merge-images', 'image-to-pdf', 'jpg-to-pdf', 'scan-to-pdf');
      }
      if (c.word > 0) out.push('word-to-pdf');
      if (c.excel > 0) out.push('excel-to-pdf');
      if (c.powerpoint > 0) out.push('powerpoint-to-pdf');
      if (c.html > 0) out.push('html-to-pdf');
    } else {
      out.push('merge-pdf', 'merge-images', 'image-to-pdf', 'word-to-pdf', 'excel-to-pdf');
    }
    return Array.from(new Set(out)).slice(0, 8);
  }
  if (lower.endsWith('.pdf') || file.type === 'application/pdf') {
    return [
      'merge-pdf',
      'split-pdf',
      'compress-pdf',
      'organize-pdf',
      'edit-pdf',
      'sign-pdf',
      'pdf-to-word',
      'ocr-pdf',
    ];
  }
  if (/\.(jpe?g|png|webp|gif|bmp)$/i.test(lower) || file.type.startsWith('image/')) {
    return lower.endsWith('.jpg') || lower.endsWith('.jpeg')
      ? ['jpg-to-pdf', 'merge-images', 'image-to-pdf', 'scan-to-pdf']
      : ['image-to-pdf', 'merge-images', 'scan-to-pdf', 'jpg-to-pdf'];
  }
  if (/\.(docx|txt|md|rtf)$/i.test(lower)) return ['word-to-pdf'];
  if (/\.(xlsx|xls|csv|ods)$/i.test(lower)) return ['excel-to-pdf'];
  if (/\.pptx$/i.test(lower)) return ['powerpoint-to-pdf'];
  if (/\.(html|htm)$/i.test(lower)) return ['html-to-pdf'];
  return ['merge-pdf', 'image-to-pdf', 'zip-to-pdf'];
}

export const ToolDirectory: React.FC<ToolDirectoryProps> = ({
  activeCategory,
  onCategoryChange,
  onOpenTool,
  sessionFiles,
  onClearSessionFiles,
  darkMode,
  onToggleDarkMode,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [routedFile, setRoutedFile] = useState<WorkspaceFile | null>(null);
  const [routedZipSummary, setRoutedZipSummary] = useState<ZipSummary | null>(null);
  const [openingTool, setOpeningTool] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const filteredTools = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return TOOL_CATALOG.filter((tool) => {
      const catMatch = activeCategory === 'all' || tool.category === activeCategory;
      if (!catMatch) return false;
      if (!q) return true;
      return (
        tool.name.toLowerCase().includes(q) ||
        tool.shortDesc.toLowerCase().includes(q) ||
        tool.keywords.some((k) => k.includes(q))
      );
    });
  }, [activeCategory, searchQuery]);

  const selectFileForRouter = async (f: WorkspaceFile) => {
    setRoutedFile(f);
    if (isZipFile(f.name, f.type, f.bytes)) {
      try {
        setRoutedZipSummary(await inspectZipArchiveSummary(f));
      } catch {
        setRoutedZipSummary(null);
      }
    } else {
      setRoutedZipSummary(null);
    }
  };

  const handleOpenRoutedTool = async (tid: ToolId) => {
    if (!routedFile) return;
    if (isZipFile(routedFile.name, routedFile.type, routedFile.bytes) && tid !== 'zip-to-pdf') {
      const targetDef = TOOL_CATALOG.find((x) => x.id === tid);
      if (targetDef) {
        setOpeningTool(true);
        try {
          const res = await expandWorkspaceFilesForAccept([routedFile], targetDef.accepts);
          onOpenTool(
            tid,
            res.matched.length > 0 ? (targetDef.multiFile ? res.matched : [res.matched[0]]) : []
          );
          setRoutedFile(null);
          setRoutedZipSummary(null);
          return;
        } finally {
          setOpeningTool(false);
        }
      }
    }
    onOpenTool(tid, [routedFile]);
    setRoutedFile(null);
    setRoutedZipSummary(null);
  };

  const handleUniversalDrop = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const loaded = await Promise.all(Array.from(fileList).map((f) => fileToWorkspaceFile(f)));
    if (loaded.length > 1 && loaded.every((f) => f.name.toLowerCase().endsWith('.pdf'))) {
      onOpenTool('merge-pdf', loaded);
      return;
    }
    if (
      loaded.length > 1 &&
      loaded.every((f) => /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name) || f.type.startsWith('image/'))
    ) {
      onOpenTool('image-to-pdf', loaded);
      return;
    }
    if (loaded.length > 1 && loaded.every((f) => /\.(docx|txt|md|rtf)$/i.test(f.name))) {
      onOpenTool('word-to-pdf', loaded);
      return;
    }
    if (loaded.length > 1 && loaded.every((f) => /\.(xlsx|xls|csv|ods)$/i.test(f.name))) {
      onOpenTool('excel-to-pdf', loaded);
      return;
    }
    if (loaded.length > 1 && loaded.every((f) => /\.pptx$/i.test(f.name))) {
      onOpenTool('powerpoint-to-pdf', loaded);
      return;
    }
    if (loaded.length > 1 && loaded.every((f) => /\.(html|htm)$/i.test(f.name))) {
      onOpenTool('html-to-pdf', loaded);
      return;
    }
    if (loaded.length > 1) {
      onOpenTool('zip-to-pdf', loaded);
      return;
    }
    await selectFileForRouter(loaded[0]);
  };

  const suggestedIds = routedFile ? getSuggestedToolsForFile(routedFile, routedZipSummary) : [];

  const categories: { id: ToolCategory | 'all'; label: string }[] = [
    { id: 'all', label: `All Tools (${TOOL_CATALOG.length})` },
    { id: 'organize', label: CATEGORY_LABELS.organize },
    { id: 'optimize', label: CATEGORY_LABELS.optimize },
    { id: 'convert-from', label: CATEGORY_LABELS['convert-from'] },
    { id: 'convert-to', label: CATEGORY_LABELS['convert-to'] },
    { id: 'edit', label: CATEGORY_LABELS.edit },
    { id: 'security', label: CATEGORY_LABELS.security },
    { id: 'analyze', label: CATEGORY_LABELS.analyze },
  ];

  return (
    <main className="mx-auto max-w-[1440px] px-4 sm:px-6 py-8 space-y-8">
      {/* Studio Hero + Smart Universal File Router */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        <div className="lg:col-span-7 flex flex-col justify-between rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 sm:p-8">
          <div className="space-y-3">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Offline Workstation · Zero Page Limits · Local Binary Processing
            </p>
            <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-slate-900 dark:text-white [text-wrap:balance]">
              Every PDF, Office, OCR, and form workflow in one fast local studio.
            </h1>
            <p className="text-sm sm:text-base text-slate-600 dark:text-slate-300 max-w-2xl leading-relaxed">
              Merge, split, compress, redact, sign, OCR, compare, convert Office formats, and build fillable AcroForms directly in your browser using raw binary buffers—no server uploads, no AI keys, and no artificial page caps.
            </p>
          </div>

          <div className="mt-6 pt-5 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => onOpenTool('merge-pdf')}
              className="inline-flex items-center gap-2 rounded-lg bg-red-600 hover:bg-red-700 px-4 py-2.5 text-sm font-semibold text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Merge PDFs
              <ArrowUpRight className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => onOpenTool('edit-pdf')}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-2.5 text-sm font-medium text-slate-800 dark:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Open PDF Editor
            </button>
            <PWAInstallButton />
            <button
              type="button"
              onClick={onToggleDarkMode}
              aria-label={darkMode ? 'Switch to light theme' : 'Switch to dark theme'}
              className="ml-auto inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors cursor-pointer"
            >
              {darkMode ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4" />}
              <span>{darkMode ? 'Light' : 'Dark'}</span>
            </button>
          </div>
        </div>

        {/* Universal Drop Router */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void handleUniversalDrop(e.dataTransfer.files);
          }}
          className={`lg:col-span-5 flex flex-col justify-between rounded-2xl border-2 border-dashed p-6 transition-colors ${
            dragging
              ? 'border-red-600 bg-red-50/70 dark:bg-red-950/30'
              : 'border-slate-300 dark:border-slate-700 bg-slate-100/60 dark:bg-slate-900/50'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.zip,.jpg,.jpeg,.png,.webp,.gif,.bmp,.docx,.xlsx,.xls,.csv,.pptx,.html,.htm,.txt,.md"
            className="hidden"
            onChange={(e) => {
              void handleUniversalDrop(e.target.files);
              e.target.value = '';
            }}
          />

          {!routedFile ? (
            <div className="flex flex-col items-center justify-center text-center my-auto py-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-red-600 dark:text-red-400">
                <Upload className="w-5 h-5" />
              </div>
              <h2 className="mt-4 font-display text-base font-semibold text-slate-900 dark:text-white">
                Smart File Router
              </h2>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-400 max-w-xs">
                Drop any PDF, ZIP archive, JPG/PNG, Word, Excel, PowerPoint, or HTML file to open compatible tools immediately.
              </p>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="mt-4 rounded-lg bg-slate-900 dark:bg-white px-4 py-2 text-xs font-medium text-white dark:text-slate-900 hover:opacity-90 transition-opacity cursor-pointer"
              >
                Choose File(s)
              </button>
            </div>
          ) : (
            <div className="space-y-4 my-auto">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <FileText className="w-5 h-5 text-red-600 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-900 dark:text-white truncate">
                      {routedFile.name}
                    </p>
                    <p className="text-xs text-slate-500 font-mono tabular-nums">
                      {formatBytes(routedFile.size)}
                      {routedFile.pageCount ? ` · ${routedFile.pageCount} pages` : ''}
                      {routedZipSummary
                        ? ` · ${routedZipSummary.totalFiles} files inside`
                        : ''}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setRoutedFile(null);
                    setRoutedZipSummary(null);
                  }}
                  className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer"
                >
                  Clear
                </button>
              </div>
              <p className="text-xs font-medium text-slate-600 dark:text-slate-300">
                {openingTool ? 'Unpacking ZIP for tool...' : 'Open this file in:'}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {suggestedIds.map((tid) => {
                  const t = TOOL_CATALOG.find((x) => x.id === tid);
                  if (!t) return null;
                  return (
                    <button
                      key={tid}
                      type="button"
                      disabled={openingTool}
                      onClick={() => void handleOpenRoutedTool(tid)}
                      className="flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-left text-xs font-medium text-slate-800 dark:text-slate-100 hover:border-red-500 disabled:opacity-50 transition-colors cursor-pointer"
                    >
                      <ToolIcon name={t.iconName} className="w-3.5 h-3.5 text-red-600 shrink-0" />
                      <span className="truncate">{t.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Active Session Files Shelf */}
      {sessionFiles.length > 0 && (
        <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="flex items-center justify-between gap-4 mb-3">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              Recent Session Workspace Files ({sessionFiles.length})
            </h2>
            <button
              type="button"
              onClick={onClearSessionFiles}
              className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-red-600 transition-colors cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear Shelf
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {sessionFiles.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => void selectFileForRouter(f)}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-1.5 text-xs text-slate-700 dark:text-slate-200 hover:border-red-500 transition-colors cursor-pointer"
              >
                <FileText className="w-3.5 h-3.5 text-red-600 shrink-0" />
                <span className="max-w-[200px] truncate font-medium">{f.name}</span>
                <span className="text-slate-400 font-mono tabular-nums">
                  {formatBytes(f.size)}
                  {f.pageCount ? ` · ${f.pageCount}p` : ''}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Workspace Filter & Search Toolbar */}
      <section className="space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="relative w-full md:w-80 shrink-0">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter tools by name or format..."
              className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 pl-9 pr-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-red-500"
            />
          </div>

          <div className="flex items-center gap-1 overflow-x-auto pb-1">
            {categories.map((cat) => {
              const active = activeCategory === cat.id;
              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => onCategoryChange(cat.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                    active
                      ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900'
                      : 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {cat.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* 32-Tool Grid */}
        {filteredTools.length === 0 ? (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-12 text-center">
            <p className="text-sm text-slate-600 dark:text-slate-400">
              No tools match "{searchQuery}".
            </p>
            <button
              type="button"
              onClick={() => {
                setSearchQuery('');
                onCategoryChange('all');
              }}
              className="mt-3 text-xs font-semibold text-red-600 hover:underline cursor-pointer"
            >
              Reset filters
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filteredTools.map((tool) => (
              <button
                key={tool.id}
                type="button"
                onClick={() => onOpenTool(tool.id)}
                className="group flex flex-col justify-between rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 text-left hover:border-red-500/70 dark:hover:border-red-500/60 transition-colors cursor-pointer"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500">
                      {CATEGORY_LABELS[tool.category]}
                      {tool.badge ? ` · ${tool.badge}` : ''}
                    </span>
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 group-hover:bg-red-600 group-hover:text-white transition-colors">
                      <ToolIcon name={tool.iconName} className="w-4 h-4" />
                    </div>
                  </div>
                  <h3 className="mt-3 font-display text-base font-semibold text-slate-900 dark:text-white group-hover:text-red-600 dark:group-hover:text-red-400 transition-colors">
                    {tool.name}
                  </h3>
                  <p className="mt-1.5 text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                    {tool.shortDesc}
                  </p>
                </div>

                <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400 group-hover:text-red-600 dark:group-hover:text-red-400">
                  <span>Open workbench</span>
                  <ArrowUpRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                </div>
              </button>
            ))}
          </div>
        )}
      </section>
    </main>
  );
};
