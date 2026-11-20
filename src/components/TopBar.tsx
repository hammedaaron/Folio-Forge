import React from 'react';
import { ToolCategory } from '../types/tools';

interface TopBarProps {
  onGoHome: (filter?: ToolCategory | 'all') => void;
  onOpenCommandPalette: () => void;
  activeNav: string;
}

export const TopBar: React.FC<TopBarProps> = ({
  onGoHome,
  onOpenCommandPalette,
  activeNav,
}) => {
  const navItems: { id: ToolCategory | 'all'; label: string }[] = [
    { id: 'all', label: 'All Tools' },
    { id: 'organize', label: 'Organize' },
    { id: 'convert-from', label: 'Convert' },
    { id: 'edit', label: 'Edit & Sign' },
    { id: 'security', label: 'Security' },
  ];

  return (
    <header className="sticky top-0 z-30 h-14 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-950/95 backdrop-blur-sm">
      <div className="mx-auto flex h-full max-w-[1440px] items-center justify-between gap-8 px-4 sm:px-6">
        {/* Zone 1: Single text wordmark */}
        <button
          type="button"
          onClick={() => onGoHome('all')}
          className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-white whitespace-nowrap shrink-0 cursor-pointer hover:text-red-600 dark:hover:text-red-400 transition-colors"
        >
          FolioForge
        </button>

        {/* Zone 2: 5 concise single-line navigation links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600 dark:text-slate-300">
          {navItems.map((item) => {
            const isActive = activeNav === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onGoHome(item.id)}
                className={`whitespace-nowrap shrink-0 py-1 transition-colors cursor-pointer border-b-2 ${
                  isActive
                    ? 'border-red-600 text-slate-900 dark:text-white'
                    : 'border-transparent hover:text-slate-900 dark:hover:text-white hover:border-slate-300 dark:hover:border-slate-700'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: Single primary action */}
        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={onOpenCommandPalette}
            className="rounded-lg bg-slate-900 dark:bg-white px-4 py-2 text-xs font-medium text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Find Tool (Ctrl+K)
          </button>
        </div>
      </div>
    </header>
  );
};
