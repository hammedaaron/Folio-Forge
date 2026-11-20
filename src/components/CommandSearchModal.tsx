import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { CATEGORY_LABELS, TOOL_CATALOG } from '../data/toolCatalog';
import { ToolId } from '../types/tools';
import { ToolIcon } from './ToolIcon';

interface CommandSearchModalProps {
  open: boolean;
  onClose: () => void;
  onSelectTool: (id: ToolId) => void;
}

export const CommandSearchModal: React.FC<CommandSearchModalProps> = ({
  open,
  onClose,
  onSelectTool,
}) => {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIdx(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return TOOL_CATALOG;
    return TOOL_CATALOG.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.shortDesc.toLowerCase().includes(q) ||
        t.keywords.some((k) => k.includes(q)) ||
        CATEGORY_LABELS[t.category].toLowerCase().includes(q)
    );
  }, [query]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/60 backdrop-blur-[2px] pt-20 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-slate-200 dark:border-slate-800 px-4 py-3">
          <Search className="w-4 h-4 text-slate-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedIdx((i) => Math.min(matches.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedIdx((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter' && matches[selectedIdx]) {
                onSelectTool(matches[selectedIdx].id);
                onClose();
              }
            }}
            placeholder="Jump to any of the 32 PDF tools (e.g. merge, ocr, redact, forms)..."
            className="w-full bg-transparent text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 cursor-pointer"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="max-h-96 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/70">
          {matches.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">
              No matching tools found for "{query}".
            </div>
          ) : (
            matches.map((tool, idx) => (
              <button
                key={tool.id}
                type="button"
                onClick={() => {
                  onSelectTool(tool.id);
                  onClose();
                }}
                className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors cursor-pointer ${
                  idx === selectedIdx
                    ? 'bg-red-50 dark:bg-red-950/40'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-800/60'
                }`}
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-red-600 dark:text-red-400">
                  <ToolIcon name={tool.iconName} className="w-4 h-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {tool.name}
                    </span>
                    <span className="text-xs text-slate-400 whitespace-nowrap">
                      {CATEGORY_LABELS[tool.category]}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">
                    {tool.shortDesc}
                  </p>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
