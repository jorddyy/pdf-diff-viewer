import type { CommentResolution } from './resolve';

/**
 * The original Markdown with each resolved reference annotated with its place
 * in the target version, e.g. `L19 [v1.1: L26, changed]` or
 * `Figure 39 [v1.1: Figure 55, renumbered]`.
 */
export function annotateMarkdown(md: string, resolutions: CommentResolution[], targetLabel: string): string {
  const inserts: { at: number; text: string }[] = [];
  for (const res of resolutions) {
    for (const r of res.refs) {
      if (r.status === 'unresolved' || r.ref.now) continue;
      const where = r.target?.label ?? '';
      const what = r.status === 'unchanged' ? '' : r.status;
      const extra = r.note && r.note !== what && !r.note.startsWith('removed') ? r.note : '';
      const parts = [where, what, extra].filter(Boolean).join(', ');
      if (parts) inserts.push({ at: r.ref.end, text: ` [${targetLabel}: ${parts}]` });
    }
  }
  inserts.sort((a, b) => b.at - a.at);
  let out = md;
  for (const ins of inserts) out = out.slice(0, ins.at) + ins.text + out.slice(ins.at);
  return out;
}
