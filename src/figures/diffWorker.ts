// Difference images for the compare dialog, off the main thread: the
// registration search takes about half a second per panel at dialog size.
import { diffImage, type Raster } from './compare';

self.onmessage = (e: MessageEvent<{ id: number; a: Raster; b: Raster }>) => {
  const { id, a, b } = e.data;
  try {
    const d = diffImage(a, b);
    self.postMessage({ id, data: d.data, width: d.width, height: d.height }, { transfer: [d.data.buffer] });
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
