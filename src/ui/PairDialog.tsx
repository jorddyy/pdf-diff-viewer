import { useEffect, useRef, useState } from 'preact/hooks';
import { captionSimilarity, type PairOverride } from '../align/objects';
import type { DocObject, ObjectKind } from '../extract/types';

const NAME: Record<ObjectKind, string> = { figure: 'Figure', table: 'Table', equation: 'Equation' };

export interface PairRequest {
  kind: ObjectKind;
  /** The object whose counterpart is wrong: in the old version, or in the new one when `side` is 'b'. */
  fixed: DocObject;
  side: 'a' | 'b';
  current: DocObject | null;
  /** Objects of the other version a counterpart can be chosen from. */
  pool: DocObject[];
  aLabel: string;
  bLabel: string;
}

const short = (o: DocObject) => `${NAME[o.kind]} ${o.number}: ${o.caption.replace(/^\s*(Figure|Table|Fig\.)\s*\S+\s*/i, '').replace(/\s+/g, ' ').slice(0, 80)} (p.${o.page + 1})`;

/** Choose the counterpart of one figure/table/equation when the automatic pairing got it wrong. */
export function PairDialog({ req, onApply, onClose }: { req: PairRequest; onApply: (o: PairOverride) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [choice, setChoice] = useState<string>(req.current?.number ?? '');
  useEffect(() => ref.current?.focus(), []);
  const options = req.pool
    .filter((o) => o.number)
    .map((o) => ({ o, s: captionSimilarity(req.fixed, o) }))
    .sort((x, y) => y.s - x.s || x.o.page - y.o.page);
  const [from, to] = req.side === 'a' ? [req.aLabel, req.bLabel] : [req.bLabel, req.aLabel];
  return (
    <div class="modal-back" onClick={onClose}>
      <div
        class="modal pair"
        role="dialog"
        aria-label="Change pairing"
        tabIndex={-1}
        ref={ref}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <div class="modal-head">
          <strong>Which one in {to} belongs to this?</strong>
          <button class="btn icon" title="Close (Esc)" onClick={onClose}>
            ×
          </button>
        </div>
        <div class="modal-body">
          <div class="pair-fixed">
            <span class="small">{from}</span>
            <div>{short(req.fixed)}</div>
          </div>
          <select value={choice} onChange={(e) => setChoice(e.currentTarget.value)} aria-label={`Counterpart in ${to}`}>
            <option value="">None: it was {req.side === 'a' ? 'removed' : 'added'}</option>
            {options.map(({ o }) => (
              <option key={o.id} value={o.number}>
                {short(o)}
              </option>
            ))}
          </select>
          <p class="small">The text of the captions stays as compared; this changes which graphics are compared and how renumbering is reported.</p>
          <div class="pair-actions">
            <button class="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              class="btn primary"
              onClick={() => {
                const num = choice || null;
                onApply({ kind: req.kind, a: req.side === 'a' ? req.fixed.number : num, b: req.side === 'a' ? num : req.fixed.number });
              }}
            >
              Use this pairing
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
