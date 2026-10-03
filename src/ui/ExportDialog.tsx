import { useEffect, useState } from 'preact/hooks';

export type ExportFormat = 'side' | 'annotated';

export interface ExportOptions {
  format: ExportFormat;
  /** Also renumbering and table-of-contents changes. */
  minor: boolean;
  /** Include the review comments (they may contain notes to self). */
  comments: boolean;
}

interface Props {
  aLabel: string;
  bLabel: string;
  hasComments: boolean;
  onExport: (o: ExportOptions) => Promise<void>;
  onClose: () => void;
}

export function ExportDialog({ aLabel, bLabel, hasComments, onExport, onClose }: Props) {
  const [opts, setOpts] = useState<ExportOptions>({ format: 'side', minor: false, comments: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);
  return (
    <div class="modal-back" onClick={() => !busy && onClose()}>
      <div class="modal export" role="dialog" aria-label="Export" onClick={(e) => e.stopPropagation()}>
        <div class="modal-head">
          <strong>
            Export {aLabel} → {bLabel} as PDF
          </strong>
          <button class="btn icon" title="Close (Esc)" disabled={busy} onClick={onClose}>
            ×
          </button>
        </div>
        <div class="modal-body">
          <label class="choice">
            <input type="radio" name="fmt" checked={opts.format === 'side'} onChange={() => setOpts({ ...opts, format: 'side' })} />
            <span>
              <strong>Side-by-side diff</strong>
              <span class="small">
                Every sheet shows the old page next to the matching new page with the changes highlighted, after a list of all changes with links. Shows removed text too.
              </span>
            </span>
          </label>
          <label class="choice">
            <input type="radio" name="fmt" checked={opts.format === 'annotated'} onChange={() => setOpts({ ...opts, format: 'annotated' })} />
            <span>
              <strong>Annotated {bLabel}</strong>
              <span class="small">The new version itself with PDF annotations: highlights with “was: …” notes, marks where text was removed, boxes around changed figures.</span>
            </span>
          </label>
          <label class="check">
            <input type="checkbox" checked={opts.minor} onChange={(e) => setOpts({ ...opts, minor: e.currentTarget.checked })} /> Include renumbering and table-of-contents changes
          </label>
          {hasComments && (
            <label class="check">
              <input type="checkbox" checked={opts.comments} onChange={(e) => setOpts({ ...opts, comments: e.currentTarget.checked })} /> Include my review comments (check
              that no notes to self are left)
            </label>
          )}
          {error && <p class="warn">{error}</p>}
          <div class="row">
            <button
              class="btn primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await onExport(opts);
                  onClose();
                } catch (e) {
                  setError(`Export failed: ${(e as Error)?.message ?? e}`);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Building PDF…' : 'Download PDF'}
            </button>
            <span class="small">Built in this browser; nothing is uploaded.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
