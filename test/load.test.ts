import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ports: [] as { terminate: ReturnType<typeof vi.fn> }[],
  workers: [] as { destroy: ReturnType<typeof vi.fn> }[],
  tasks: [] as { destroy: ReturnType<typeof vi.fn>; promise: Promise<any> }[],
  failOpen: false,
  failPage: false,
  extract: vi.fn(),
}));

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?worker&inline', () => ({
  default: class {
    terminate = vi.fn();
    constructor() { mocks.ports.push(this); }
  },
}));
vi.mock('pdfjs-dist', () => ({
  PDFWorker: class {
    destroy = vi.fn();
    constructor() { mocks.workers.push(this); }
  },
  OPS: {},
  getDocument: () => {
    const task = { destroy: vi.fn().mockResolvedValue(undefined), promise: Promise.resolve<any>(null) };
    task.promise = mocks.failOpen
      ? Promise.reject(new Error('invalid PDF'))
      : Promise.resolve({
        numPages: 1, loadingTask: task,
        getPage: async () => {
          if (mocks.failPage) throw new Error('invalid page');
          return { getViewport: () => ({ width: 600, height: 800 }) };
        },
      });
    mocks.tasks.push(task);
    return task;
  },
}));
vi.mock('../src/extract/document', () => ({ extractDocument: mocks.extract }));

beforeEach(() => {
  vi.stubGlobal('location', { protocol: 'http:', search: '?workers=2' });
  vi.stubGlobal('document', { baseURI: 'http://localhost/' });
  vi.stubGlobal('navigator', { hardwareConcurrency: 4 });
  mocks.ports.length = mocks.workers.length = mocks.tasks.length = 0;
  mocks.failOpen = mocks.failPage = false;
  mocks.extract.mockReset().mockResolvedValue({ numPages: 1 });
});
afterEach(() => vi.unstubAllGlobals());

function expectReleased(count: number) {
  expect(mocks.ports).toHaveLength(count);
  for (const port of mocks.ports) expect(port.terminate).toHaveBeenCalledTimes(1);
  for (const worker of mocks.workers) expect(worker.destroy).toHaveBeenCalledTimes(1);
}

describe('PDF worker ownership', () => {
  it('releases the supplied worker and port when a displayed PDF closes', async () => {
    const { openForDisplay } = await import('../src/pdf/load');
    const { pdf, sizes } = await openForDisplay(new ArrayBuffer(0));
    expect(sizes).toEqual([{ width: 600, height: 800 }]);
    expect(mocks.ports[0].terminate).not.toHaveBeenCalled();
    await pdf.loadingTask.destroy();
    await pdf.loadingTask.destroy();
    expectReleased(1);
  });

  it('releases all extraction workers when opening fails', async () => {
    const { extractInBrowser } = await import('../src/pdf/load');
    mocks.failOpen = true;
    await expect(extractInBrowser(new ArrayBuffer(0), 'synthetic.pdf')).rejects.toThrow('invalid PDF');
    expectReleased(2);
  });

  it('releases a display worker if reading page sizes fails', async () => {
    const { openForDisplay } = await import('../src/pdf/load');
    mocks.failPage = true;
    await expect(openForDisplay(new ArrayBuffer(0))).rejects.toThrow('invalid page');
    expectReleased(1);
  });

  it('releases a comparison worker if opening fails', async () => {
    const { openForCompare } = await import('../src/pdf/load');
    mocks.failOpen = true;
    await expect(openForCompare(new ArrayBuffer(0))).rejects.toThrow('invalid PDF');
    expectReleased(1);
  });

  it('caps the worker override and cleans up after extraction errors', async () => {
    const { extractInBrowser } = await import('../src/pdf/load');
    location.search = '?workers=999';
    mocks.extract.mockRejectedValue(new Error('extraction failed'));
    await expect(extractInBrowser(new ArrayBuffer(0), 'synthetic.pdf')).rejects.toThrow('extraction failed');
    expectReleased(4);
  });
});
