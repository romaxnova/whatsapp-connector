/**
 * Worker thread entry for PDF text extraction (started by pdf.ts). Loads
 * pdf.js, says so (from then on the parent watches memory), reads the one PDF
 * it was given and posts the result.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { loadPdfJs, readPdf } from './pdf-text.js';

const port = parentPort;
if (!port) throw new Error('pdf-worker must run as a worker thread');
const { data, maxPages } = workerData as { data: Uint8Array; maxPages: number };

try {
  await loadPdfJs();
  port.postMessage({ type: 'ready' });
  port.postMessage({ type: 'done', result: await readPdf(data, maxPages) });
} catch (err) {
  port.postMessage({ type: 'failed', message: err instanceof Error ? err.message : String(err) });
}
