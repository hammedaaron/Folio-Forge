export type ToolCategory =
  | 'organize'
  | 'optimize'
  | 'convert-from'
  | 'convert-to'
  | 'edit'
  | 'security'
  | 'analyze';

export type ToolId =
  | 'merge-pdf'
  | 'merge-images'
  | 'split-pdf'
  | 'compress-pdf'
  | 'organize-pdf'
  | 'rotate-pdf'
  | 'crop-pdf'
  | 'page-numbers'
  | 'watermark'
  | 'pdf-to-jpg'
  | 'image-to-pdf'
  | 'jpg-to-pdf'
  | 'word-to-pdf'
  | 'excel-to-pdf'
  | 'powerpoint-to-pdf'
  | 'html-to-pdf'
  | 'zip-to-pdf'
  | 'pdf-to-word'
  | 'pdf-to-excel'
  | 'pdf-to-powerpoint'
  | 'pdf-to-markdown'
  | 'pdf-to-pdfa'
  | 'edit-pdf'
  | 'sign-pdf'
  | 'redact-pdf'
  | 'unlock-pdf'
  | 'protect-pdf'
  | 'repair-pdf'
  | 'scan-to-pdf'
  | 'ocr-pdf'
  | 'compare-pdf'
  | 'pdf-forms'
  | 'summarizer'
  | 'translate-pdf';

export interface ToolDefinition {
  id: ToolId;
  name: string;
  shortDesc: string;
  category: ToolCategory;
  accepts: string;
  multiFile?: boolean;
  iconName: string;
  keywords: string[];
  badge?: string;
}

export interface WorkspaceFile {
  id: string;
  name: string;
  size: number;
  type: string;
  bytes: Uint8Array;
  pageCount?: number;
  createdAt: number;
}

export interface ToolOutput {
  id: string;
  blob: Blob;
  fileName: string;
  mimeType: string;
  bytesLength: number;
  pageCount?: number;
  summary?: string;
  canChainToPdfTools: boolean;
}

export interface ProgressInfo {
  current: number;
  total: number;
  label: string;
}
