import React, { useEffect, useRef, useState } from 'react';
import { pdfjsLib, canvasToBlob, destroyPdfJs, openPdfJs } from '../utils/pdfRuntime';

/**
 * Hook that holds a single shared PDFDocumentProxy for fast, zero-limit virtualized page rendering.
 */
export function usePdfJsDocument(bytes?: Uint8Array) {
  const [doc, setDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bytes) {
      setDoc(null);
      setNumPages(0);
      return;
    }
    let cancelled = false;
    let loaded: pdfjsLib.PDFDocumentProxy | null = null;
    setError(null);

    openPdfJs(bytes)
      .then((proxy) => {
        if (cancelled) {
          void destroyPdfJs(proxy);
          return;
        }
        loaded = proxy;
        setDoc(proxy);
        setNumPages(proxy.numPages);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to preview PDF');
      });

    return () => {
      cancelled = true;
      if (loaded) void destroyPdfJs(loaded);
    };
  }, [bytes]);

  return { doc, numPages, error };
}

interface VirtualPageThumbProps {
  pdfDoc: pdfjsLib.PDFDocumentProxy | null;
  pageNumber: number;
  rotation?: number;
  width?: number;
  className?: string;
}

/**
 * Renders PDF page thumbnail lazily only when scrolled into view via IntersectionObserver,
 * encoding to an ephemeral Blob ObjectURL (never base64!) and revoking it on unmount.
 */
export const VirtualPageThumb: React.FC<VirtualPageThumbProps> = ({
  pdfDoc,
  pageNumber,
  rotation = 0,
  width = 180,
  className = '',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisible(true);
        }
      },
      { rootMargin: '320px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !pdfDoc || pageNumber < 1 || pageNumber > pdfDoc.numPages) return;
    let cancelled = false;
    let createdUrl: string | null = null;

    (async () => {
      try {
        const page = await pdfDoc.getPage(pageNumber);
        const baseVp = page.getViewport({ scale: 1, rotation: (page.rotate + rotation) % 360 });
        const scale = Math.max(0.25, width / baseVp.width);
        const vp = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(vp.width));
        canvas.height = Math.max(1, Math.floor(vp.height));
        const ctx = canvas.getContext('2d', { alpha: false });
        if (ctx) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
          const blob = await canvasToBlob(canvas, 'image/jpeg', 0.8);
          canvas.width = 0;
          canvas.height = 0;
          if (!cancelled) {
            createdUrl = URL.createObjectURL(blob);
            setBlobUrl((prev) => {
              if (prev) URL.revokeObjectURL(prev);
              return createdUrl;
            });
          }
        }
        page.cleanup();
      } catch {
        // Ignore transient cancellation errors
      }
    })();

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [visible, pdfDoc, pageNumber, rotation, width]);

  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  return (
    <div
      ref={containerRef}
      className={`relative flex items-center justify-center bg-white dark:bg-slate-900 overflow-hidden ${className}`}
    >
      {blobUrl ? (
        <img
          src={blobUrl}
          alt={`Page ${pageNumber}`}
          className="w-full h-full object-contain select-none"
          draggable={false}
        />
      ) : (
        <div className="flex flex-col items-center justify-center gap-1.5 py-10 text-slate-400">
          <div className="w-7 h-9 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 animate-pulse" />
          <span className="text-[11px] font-mono tabular-nums">P.{pageNumber}</span>
        </div>
      )}
    </div>
  );
};

interface InteractivePageCanvasProps {
  pdfDoc: pdfjsLib.PDFDocumentProxy | null;
  pageNumber: number;
  scale?: number;
  rotation?: number;
  onPageMetrics?: (w: number, h: number) => void;
}

export const InteractivePageCanvas: React.FC<InteractivePageCanvasProps> = ({
  pdfDoc,
  pageNumber,
  scale = 1.4,
  rotation = 0,
  onPageMetrics,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!pdfDoc || !canvasRef.current || pageNumber < 1 || pageNumber > pdfDoc.numPages) return;
    let cancelled = false;
    let activeTask: { cancel?: () => void; promise: Promise<void> } | null = null;

    (async () => {
      try {
        const page = await pdfDoc.getPage(pageNumber);
        if (cancelled) return;
        const vp = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = Math.max(1, Math.floor(vp.width));
        canvas.height = Math.max(1, Math.floor(vp.height));
        onPageMetrics?.(canvas.width, canvas.height);
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) return;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        activeTask = page.render({ canvasContext: ctx, viewport: vp, canvas });
        await activeTask.promise;
        page.cleanup();
      } catch {
        // Ignore cancelled renders
      }
    })();

    return () => {
      cancelled = true;
      try {
        activeTask?.cancel?.();
      } catch {
        // Ignore
      }
    };
  }, [pdfDoc, pageNumber, scale, rotation, onPageMetrics]);

  return (
    <canvas
      ref={canvasRef}
      className="block max-w-full h-auto shadow-sm border border-slate-200 dark:border-slate-700 bg-white"
    />
  );
};
