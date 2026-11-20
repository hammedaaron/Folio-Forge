import React, { useRef, useState } from 'react';
import { Archive, FilePlus2, FolderOpen, Upload } from 'lucide-react';
import { WorkspaceFile } from '../types/tools';
import { formatBytes } from '../utils/pdfRuntime';
import {
  expandFileListForAccept,
  expandWorkspaceFilesForAccept,
  isZipFile,
  withZipAccept,
} from '../utils/zipExpand';

interface FileDropZoneProps {
  accept: string;
  multiple?: boolean;
  label?: string;
  sublabel?: string;
  onFilesAdded: (files: WorkspaceFile[]) => void;
  existingLibrary?: WorkspaceFile[];
  compact?: boolean;
}

export const FileDropZone: React.FC<FileDropZoneProps> = ({
  accept,
  multiple = false,
  label = 'Drop files here or browse from device',
  sublabel = '100% local processing · Unlimited pages · Opens .zip archives',
  onFilesAdded,
  existingLibrary = [],
  compact = false,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);
  const [archiveCandidates, setArchiveCandidates] = useState<WorkspaceFile[]>([]);

  const deliverExpanded = (matched: WorkspaceFile[], zipCount: number, totalInsideZip: number) => {
    setZipError(null);
    if (matched.length === 0) {
      setArchiveCandidates([]);
      if (zipCount > 0) {
        setZipError(
          totalInsideZip === 0
            ? 'The selected ZIP archive is empty.'
            : `Unpacked ${totalInsideZip} file${totalInsideZip === 1 ? '' : 's'} from ZIP, but none matched this tool's expected format. Try ZIP to PDF or a matching converter.`
        );
      }
      return;
    }

    if (!multiple && matched.length > 1) {
      // Single-file tool opened a ZIP with multiple matching files: let user pick which one
      setArchiveCandidates(matched);
      return;
    }

    setArchiveCandidates([]);
    onFilesAdded(multiple ? matched : [matched[0]]);
  };

  const handleFileList = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setLoading(true);
    setZipError(null);
    try {
      const arr = multiple ? Array.from(list) : [list[0]];
      const res = await expandFileListForAccept(arr, accept);
      deliverExpanded(res.matched, res.zipCount, res.totalInsideZip);
    } catch (err) {
      setZipError(err instanceof Error ? err.message : 'Failed to read file or ZIP archive.');
    } finally {
      setLoading(false);
    }
  };

  const handlePickSessionFile = async (rf: WorkspaceFile) => {
    if (isZipFile(rf.name, rf.type, rf.bytes) && !accept.toLowerCase().includes('.zip')) {
      setLoading(true);
      setZipError(null);
      try {
        const res = await expandWorkspaceFilesForAccept([rf], accept);
        deliverExpanded(res.matched, res.zipCount, res.totalInsideZip);
      } catch (err) {
        setZipError(err instanceof Error ? err.message : 'Failed to unpack session ZIP.');
      } finally {
        setLoading(false);
      }
    } else {
      setArchiveCandidates([]);
      setZipError(null);
      onFilesAdded([rf]);
    }
  };

  const compatibleRecent = existingLibrary.filter((f) => {
    if (isZipFile(f.name, f.type, f.bytes)) return true;
    const ext = `.${f.name.split('.').pop()?.toLowerCase() || ''}`;
    if (accept === 'image/*') {
      return f.type.startsWith('image/') || /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(f.name);
    }
    if (accept.includes('.pdf')) return ext === '.pdf' || f.type === 'application/pdf';
    return accept.toLowerCase().includes(ext);
  });

  const acceptWithZip = withZipAccept(accept);
  const displaySublabel =
    sublabel.toLowerCase().includes('zip') ? sublabel : `${sublabel} · Accepts .zip archives`;

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void handleFileList(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        className={`group relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed transition-colors cursor-pointer ${
          compact ? 'px-4 py-5' : 'px-6 py-10'
        } ${
          dragging
            ? 'border-red-600 bg-red-50/70 dark:bg-red-950/30'
            : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900/70 hover:border-red-500/70 hover:bg-slate-50 dark:hover:bg-slate-900'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={acceptWithZip}
          multiple={multiple}
          className="hidden"
          onChange={(e) => {
            void handleFileList(e.target.files);
            e.target.value = '';
          }}
        />
        <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 group-hover:bg-red-600 group-hover:text-white transition-colors">
          {loading ? (
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
          ) : multiple ? (
            <FilePlus2 className="h-5 w-5" />
          ) : (
            <Upload className="h-5 w-5" />
          )}
        </div>
        <p className="mt-3 text-sm font-medium text-slate-900 dark:text-slate-100 text-center">
          {loading ? 'Reading file binary & unpacking ZIP...' : label}
        </p>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 text-center">
          {displaySublabel}
        </p>
      </div>

      {zipError && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 p-3 text-xs text-amber-800 dark:text-amber-300">
          {zipError}
        </div>
      )}

      {archiveCandidates.length > 0 && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3.5 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-800 dark:text-slate-100">
              <Archive className="w-4 h-4 text-red-600" />
              <span>
                Select a file extracted from ZIP ({archiveCandidates.length} compatible found)
              </span>
            </div>
            <button
              type="button"
              onClick={() => setArchiveCandidates([])}
              className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-60 overflow-y-auto">
            {archiveCandidates.map((cand) => (
              <button
                key={cand.id}
                type="button"
                onClick={() => {
                  setArchiveCandidates([]);
                  onFilesAdded([cand]);
                }}
                className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2 text-left text-xs hover:border-red-500 transition-colors cursor-pointer"
              >
                <span className="truncate font-medium text-slate-800 dark:text-slate-100">
                  {cand.name}
                </span>
                <span className="shrink-0 font-mono tabular-nums text-[11px] text-slate-500">
                  {formatBytes(cand.size)}
                  {cand.pageCount ? ` · ${cand.pageCount}p` : ''}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {compatibleRecent.length > 0 && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 p-3">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-400 mb-2">
            <FolderOpen className="w-3.5 h-3.5" />
            <span>Load from current session files</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {compatibleRecent.slice(0, 6).map((rf) => (
              <button
                key={rf.id}
                type="button"
                onClick={() => void handlePickSessionFile(rf)}
                className="inline-flex items-center gap-2 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs text-slate-700 dark:text-slate-200 hover:border-red-500 transition-colors cursor-pointer"
              >
                <span className="max-w-[160px] truncate font-medium">{rf.name}</span>
                <span className="text-slate-400 font-mono tabular-nums">{formatBytes(rf.size)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
