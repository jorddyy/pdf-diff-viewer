// Both panes share the frame budget. PDF.js already yields between operator
// batches. Schedule its continuations as well as the initial page requests.
interface PageJob {
  element: HTMLElement | null;
  next?: () => void;
}

const jobs = new Set<PageJob>();
let frame = 0;
let idleTimer = 0;
let prefetchAfter = 0;

function schedule() {
  if (!frame && jobs.size) frame = requestAnimationFrame(run);
}

function run() {
  frame = 0;
  let priority = Infinity;
  let chosen: PageJob | undefined;
  const scrolling = performance.now() < prefetchAfter;
  for (const job of jobs) {
    // Background figure comparisons and nearby pages share idle frames.
    let rank = 2;
    if (job.element) {
      const parent = job.element.closest('.pane');
      if (!parent) continue;
      const page = job.element.getBoundingClientRect();
      const pane = parent.getBoundingClientRect();
      const seen = Math.min(page.bottom, pane.bottom) - Math.max(page.top, pane.top);
      if (seen > 0) rank = seen >= Math.min(page.height, pane.height) / 4 ? 0 : 1;
    }
    if (rank === 2 && (scrolling || !job.next)) continue;
    if (rank < priority) {
      priority = rank;
      chosen = undefined;
    }
    if (rank === priority && !chosen && job.next) chosen = job;
  }
  if (!chosen) return;
  const next = chosen.next!;
  chosen.next = undefined;
  jobs.delete(chosen);
  jobs.add(chosen); // Equal-priority pages alternate turns.
  next();
  schedule();
}

export function paneScrolled() {
  prefetchAfter = performance.now() + 150;
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(schedule, 160);
  schedule();
}

export function pageJob(element: HTMLElement | null) {
  const job: PageJob = { element };
  jobs.add(job);
  return {
    enqueue(next: () => void) {
      job.next = next;
      schedule();
    },
    finish() {
      jobs.delete(job);
      schedule();
    },
  };
}

// Small completed-page bitmaps survive scroll eviction. Keys do not keep the
// PDF document alive. Eviction explicitly releases the backing store.
const previews = new Map<string, HTMLCanvasElement>();
const budget = 32 * 1024 * 1024;
let bytes = 0;

export function getPreview(key: string) {
  const preview = previews.get(key);
  if (preview) {
    previews.delete(key);
    previews.set(key, preview);
  }
  return preview;
}

export function rememberPreview(key: string, source: HTMLCanvasElement, expensive: boolean) {
  if (!source.width || !source.height) return;
  const previous = getPreview(key);
  if (previous && (!expensive || previous.width === source.width && previous.height === source.height)) return;
  // Keep expensive pages sharp if they fit, so returning at the same zoom
  // can skip the PDF drawing commands altogether.
  let preview = source;
  if (!expensive || 4 * source.width * source.height > budget / 2) {
    const ratio = Math.min(1, 512 / Math.max(source.width, source.height));
    preview = document.createElement('canvas');
    preview.width = Math.max(1, Math.round(source.width * ratio));
    preview.height = Math.max(1, Math.round(source.height * ratio));
    preview.getContext('2d')!.drawImage(source, 0, 0, preview.width, preview.height);
  }
  if (previous) releasePreview(key, previous);
  previews.set(key, preview);
  bytes += 4 * preview.width * preview.height;
  while (bytes > budget) {
    const [oldKey, old] = previews.entries().next().value!;
    releasePreview(oldKey, old);
  }
}

function releasePreview(key: string, preview: HTMLCanvasElement) {
  previews.delete(key);
  bytes -= 4 * preview.width * preview.height;
  preview.width = preview.height = 0;
}

export function releaseDocumentPreviews(docId: string) {
  for (const [key, preview] of previews) {
    if (key.startsWith(docId + '/')) releasePreview(key, preview);
  }
}
