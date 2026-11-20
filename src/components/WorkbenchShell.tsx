import React, { useMemo, useState } from 'react';
import {
  ArrowLeft,
  Menu,
  Moon,
  Search,
  Sun,
  X,
} from 'lucide-react';
import { CATEGORY_LABELS, getToolById, TOOL_CATALOG } from '../data/toolCatalog';
import { ToolCategory, ToolId, ToolOutput, WorkspaceFile } from '../types/tools';
import { PWAInstallButton } from './PWAControls';
import { ToolIcon } from './ToolIcon';
import { CompareTool } from './tools/CompareTool';
import { EditSignRedactTool } from './tools/EditSignRedactTool';
import { FormsTool } from './tools/FormsTool';
import { MergeImagesTool } from './tools/MergeImagesTool';
import { OcrScanTool } from './tools/OcrScanTool';
import { OfficeHtmlTool } from './tools/OfficeHtmlTool';
import { OrganizeCropTool } from './tools/OrganizeCropTool';
import { StandardBatchTool } from './tools/StandardBatchTool';
import { SummarizerTranslateTool } from './tools/SummarizerTranslateTool';
import { ZipToPdfTool } from './tools/ZipToPdfTool';

interface WorkbenchShellProps {
  activeToolId: ToolId;
  onSelectTool: (id: ToolId) => void;
  onBackHome: () => void;
  toolFiles: WorkspaceFile[];
  setToolFiles: React.Dispatch<React.SetStateAction<WorkspaceFile[]>>;
  sessionFiles: WorkspaceFile[];
  output: ToolOutput | null;
  onOutputCreated: (output: ToolOutput) => void;
  onChainToTool: (targetTool: ToolId, output: ToolOutput) => void;
  darkMode: boolean;
  onToggleDarkMode: () => void;
}

const ORDERED_CATEGORIES: ToolCategory[] = [
  'organize',
  'optimize',
  'convert-from',
  'convert-to',
  'edit',
  'security',
  'analyze',
];

export const WorkbenchShell: React.FC<WorkbenchShellProps> = ({
  activeToolId,
  onSelectTool,
  onBackHome,
  toolFiles,
  setToolFiles,
  sessionFiles,
  output,
  onOutputCreated,
  onChainToTool,
  darkMode,
  onToggleDarkMode,
}) => {
  const [railFilter, setRailFilter] = useState('');
  const [mobileRailOpen, setMobileRailOpen] = useState(false);
  const activeTool = getToolById(activeToolId);

  const groupedTools = useMemo(() => {
    const q = railFilter.trim().toLowerCase();
    return ORDERED_CATEGORIES.map((cat) => ({
      category: cat,
      label: CATEGORY_LABELS[cat],
      tools: TOOL_CATALOG.filter(
        (t) =>
          t.category === cat &&
          (!q ||
            t.name.toLowerCase().includes(q) ||
            t.keywords.some((k) => k.includes(q)))
      ),
    })).filter((g) => g.tools.length > 0);
  }, [railFilter]);

  const renderRailContent = () => (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-slate-200 dark:border-slate-800 space-y-2.5">
        <button
          type="button"
          onClick={onBackHome}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          All {TOOL_CATALOG.length} Tools Directory
        </button>
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={railFilter}
            onChange={(e) => setRailFilter(e.target.value)}
            placeholder="Switch tool..."
            className="w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 pl-8 pr-2.5 py-1.5 text-xs focus:outline-none focus:border-red-500"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {groupedTools.map((group) => (
          <div key={group.category} className="space-y-1">
            <p className="px-2 text-[11px] font-semibold text-slate-400 dark:text-slate-500">
              {group.label}
            </p>
            {group.tools.map((t) => {
              const isActive = t.id === activeToolId;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    onSelectTool(t.id);
                    setMobileRailOpen(false);
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors cursor-pointer ${
                    isActive
                      ? 'bg-red-600 text-white'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  <ToolIcon
                    name={t.iconName}
                    className={`w-3.5 h-3.5 shrink-0 ${isActive ? 'text-white' : 'text-slate-500 dark:text-slate-400'}`}
                  />
                  <span className="truncate">{t.name}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );

  const renderActiveStudio = () => {
    if (activeToolId === 'merge-images') {
      return (
        <MergeImagesTool
          files={toolFiles}
          setFiles={setToolFiles}
          sessionFiles={sessionFiles}
          onOutputCreated={onOutputCreated}
          output={output}
          onChainToTool={onChainToTool}
        />
      );
    }

    if (activeToolId === 'organize-pdf' || activeToolId === 'crop-pdf') {
      return (
        <OrganizeCropTool
          toolId={activeToolId}
          files={toolFiles}
          setFiles={setToolFiles}
          sessionFiles={sessionFiles}
          onOutputCreated={onOutputCreated}
          output={output}
          onChainToTool={onChainToTool}
        />
      );
    }

    if (
      activeToolId === 'edit-pdf' ||
      activeToolId === 'sign-pdf' ||
      activeToolId === 'redact-pdf'
    ) {
      return (
        <EditSignRedactTool
          toolId={activeToolId}
          files={toolFiles}
          setFiles={setToolFiles}
          sessionFiles={sessionFiles}
          onOutputCreated={onOutputCreated}
          output={output}
          onChainToTool={onChainToTool}
        />
      );
    }

    if (activeToolId === 'pdf-forms') {
      return (
        <FormsTool
          files={toolFiles}
          setFiles={setToolFiles}
          sessionFiles={sessionFiles}
          onOutputCreated={onOutputCreated}
          output={output}
          onChainToTool={onChainToTool}
        />
      );
    }

    if (
      activeToolId === 'pdf-to-word' ||
      activeToolId === 'pdf-to-powerpoint' ||
      activeToolId === 'pdf-to-excel' ||
      activeToolId === 'pdf-to-markdown' ||
      activeToolId === 'word-to-pdf' ||
      activeToolId === 'powerpoint-to-pdf' ||
      activeToolId === 'excel-to-pdf' ||
      activeToolId === 'html-to-pdf'
    ) {
      return (
        <OfficeHtmlTool
          toolId={activeToolId}
          files={toolFiles}
          setFiles={setToolFiles}
          sessionFiles={sessionFiles}
          onOutputCreated={onOutputCreated}
          output={output}
          onChainToTool={onChainToTool}
        />
      );
    }

    if (activeToolId === 'zip-to-pdf') {
      return (
        <ZipToPdfTool
          files={toolFiles}
          setFiles={setToolFiles}
          sessionFiles={sessionFiles}
          onOutputCreated={onOutputCreated}
          output={output}
          onChainToTool={onChainToTool}
        />
      );
    }

    if (activeToolId === 'compare-pdf') {
      return (
        <CompareTool
          files={toolFiles}
          setFiles={setToolFiles}
          sessionFiles={sessionFiles}
        />
      );
    }

    if (activeToolId === 'ocr-pdf' || activeToolId === 'scan-to-pdf') {
      return (
        <OcrScanTool
          toolId={activeToolId}
          files={toolFiles}
          setFiles={setToolFiles}
          sessionFiles={sessionFiles}
          onOutputCreated={onOutputCreated}
          output={output}
          onChainToTool={onChainToTool}
        />
      );
    }

    if (activeToolId === 'summarizer' || activeToolId === 'translate-pdf') {
      return (
        <SummarizerTranslateTool
          toolId={activeToolId}
          files={toolFiles}
          setFiles={setToolFiles}
          sessionFiles={sessionFiles}
          onOutputCreated={onOutputCreated}
          output={output}
          onChainToTool={onChainToTool}
        />
      );
    }

    return (
      <StandardBatchTool
        toolId={activeToolId}
        files={toolFiles}
        setFiles={setToolFiles}
        sessionFiles={sessionFiles}
        onOutputCreated={onOutputCreated}
        output={output}
        onChainToTool={onChainToTool}
      />
    );
  };

  return (
    <div className="mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-[1440px]">
      {/* Desktop Collapsible Tool-Switcher Sidebar */}
      <aside className="hidden lg:block w-64 shrink-0 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        {renderRailContent()}
      </aside>

      {/* Mobile Slide-Over Tool Rail */}
      {mobileRailOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div
            className="fixed inset-0 bg-slate-950/60"
            onClick={() => setMobileRailOpen(false)}
          />
          <aside className="relative z-10 w-72 max-w-[85vw] bg-white dark:bg-slate-900 h-full border-r border-slate-200 dark:border-slate-800">
            <button
              type="button"
              onClick={() => setMobileRailOpen(false)}
              className="absolute right-3 top-3 p-1 text-slate-400 hover:text-slate-800 cursor-pointer"
              aria-label="Close menu"
            >
              <X className="w-4 h-4" />
            </button>
            {renderRailContent()}
          </aside>
        </div>
      )}

      {/* Main Tool Studio Area */}
      <div className="flex-1 min-w-0 p-4 sm:p-6 space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-4">
          <div className="flex items-start gap-3">
            <button
              type="button"
              onClick={() => setMobileRailOpen(true)}
              className="lg:hidden mt-0.5 rounded-lg border border-slate-200 dark:border-slate-700 p-2 text-slate-700 dark:text-slate-200 cursor-pointer"
              aria-label="Open tool switcher"
            >
              <Menu className="w-4 h-4" />
            </button>
            <div>
              <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                <button
                  type="button"
                  onClick={onBackHome}
                  className="hover:text-slate-900 dark:hover:text-white cursor-pointer"
                >
                  All Tools
                </button>
                <span aria-hidden="true">/</span>
                <span>{CATEGORY_LABELS[activeTool.category]}</span>
                <span aria-hidden="true">/</span>
                <span className="text-slate-900 dark:text-slate-100 font-medium">
                  {activeTool.name}
                </span>
              </div>
              <h1 className="font-display text-2xl font-bold tracking-tight text-slate-900 dark:text-white mt-1">
                {activeTool.name}
              </h1>
              <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400 mt-0.5">
                {activeTool.shortDesc}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <PWAInstallButton />
            <button
              type="button"
              onClick={onToggleDarkMode}
              aria-label={darkMode ? 'Switch to light theme' : 'Switch to dark theme'}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
            >
              {darkMode ? <Sun className="w-3.5 h-3.5 text-amber-400" /> : <Moon className="w-3.5 h-3.5" />}
              <span>{darkMode ? 'Light' : 'Dark'}</span>
            </button>
          </div>
        </div>

        {renderActiveStudio()}
      </div>
    </div>
  );
};
