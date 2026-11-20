import { useCallback, useEffect, useState } from 'react';
import { CommandSearchModal } from './components/CommandSearchModal';
import { OfflineIndicator } from './components/PWAControls';
import { ToolDirectory } from './components/ToolDirectory';
import { TopBar } from './components/TopBar';
import { WorkbenchShell } from './components/WorkbenchShell';
import { ToolCategory, ToolId, ToolOutput, WorkspaceFile } from './types/tools';
import { blobToWorkspaceFile } from './utils/pdfRuntime';

export default function App() {
  const [activeToolId, setActiveToolId] = useState<ToolId | null>(null);
  const [activeCategory, setActiveCategory] = useState<ToolCategory | 'all'>('all');
  const [toolFiles, setToolFiles] = useState<WorkspaceFile[]>([]);
  const [sessionFiles, setSessionFiles] = useState<WorkspaceFile[]>([]);
  const [lastOutput, setLastOutput] = useState<ToolOutput | null>(null);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(false);

  // Sync Tailwind .dark class on <html>
  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  // Global Ctrl+K / Cmd+K shortcut for instant tool switching
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const addToSession = useCallback((incoming: WorkspaceFile[]) => {
    if (incoming.length === 0) return;
    setSessionFiles((prev) => {
      const existingIds = new Set(prev.map((x) => x.id));
      const unique = incoming.filter((x) => !existingIds.has(x.id));
      return [...unique, ...prev].slice(0, 20);
    });
  }, []);

  const handleSetToolFiles: React.Dispatch<React.SetStateAction<WorkspaceFile[]>> = useCallback(
    (updater) => {
      setToolFiles((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        addToSession(next);
        return next;
      });
    },
    [addToSession]
  );

  const handleOpenTool = useCallback(
    (toolId: ToolId, initialFiles?: WorkspaceFile[]) => {
      setActiveToolId(toolId);
      setLastOutput(null);
      if (initialFiles && initialFiles.length > 0) {
        setToolFiles(initialFiles);
        addToSession(initialFiles);
      } else {
        setToolFiles([]);
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [addToSession]
  );

  const handleOutputCreated = useCallback(
    async (output: ToolOutput) => {
      setLastOutput(output);
      if (output.mimeType === 'application/pdf') {
        const wf = await blobToWorkspaceFile(output.blob, output.fileName, output.pageCount);
        addToSession([wf]);
      }
    },
    [addToSession]
  );

  const handleChainToTool = useCallback(
    async (targetTool: ToolId, output: ToolOutput) => {
      const wf = await blobToWorkspaceFile(output.blob, output.fileName, output.pageCount);
      handleOpenTool(targetTool, [wf]);
    },
    [handleOpenTool]
  );

  const handleGoHome = useCallback((cat?: ToolCategory | 'all') => {
    setActiveToolId(null);
    if (cat) setActiveCategory(cat);
    setLastOutput(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <TopBar
        onGoHome={handleGoHome}
        onOpenCommandPalette={() => setCmdOpen(true)}
        activeNav={activeToolId ? '' : activeCategory}
      />

      {activeToolId === null ? (
        <ToolDirectory
          activeCategory={activeCategory}
          onCategoryChange={setActiveCategory}
          onOpenTool={handleOpenTool}
          sessionFiles={sessionFiles}
          onClearSessionFiles={() => setSessionFiles([])}
          darkMode={darkMode}
          onToggleDarkMode={() => setDarkMode((d) => !d)}
        />
      ) : (
        <WorkbenchShell
          activeToolId={activeToolId}
          onSelectTool={(id) => handleOpenTool(id)}
          onBackHome={() => handleGoHome()}
          toolFiles={toolFiles}
          setToolFiles={handleSetToolFiles}
          sessionFiles={sessionFiles}
          output={lastOutput}
          onOutputCreated={handleOutputCreated}
          onChainToTool={handleChainToTool}
          darkMode={darkMode}
          onToggleDarkMode={() => setDarkMode((d) => !d)}
        />
      )}

      <CommandSearchModal
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        onSelectTool={(id) => handleOpenTool(id)}
      />

      <OfflineIndicator />
    </div>
  );
}
