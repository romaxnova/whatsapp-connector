/**
 * PDF text extraction, isolated in a worker thread.
 *
 * pdf.js inflates compressed streams in memory with no limit of its own, and a
 * PDF can stack compression filters: a file of a few kilobytes can expand to
 * gigabytes. Each PDF is therefore read in a fresh worker thread (see
 * pdf-text.ts for the reading itself) that is stopped when the process grows
 * by more than a memory budget or the reading takes too long. Decoded streams
 * live outside the JavaScript heap, so the process size is what is watched; the
 * heap has its own cap. PDFs are read one at a time, so each gets the whole
 * budget, and the main thread keeps serving requests meanwhile.
 */
import { Worker } from 'node:worker_threads';
import { PdfError, type PdfText } from './pdf-text.js';

export { PdfError, type PdfText } from './pdf-text.js';

export const DEFAULT_MAX_PAGES = 100;

export interface PdfOptions {
  maxPages?: number;
  /** Most the process may grow while one PDF is read (default 768 MB). */
  maxMemoryBytes?: number;
  /** Default 30 s. */
  timeoutMs?: number;
}

const MiB = 1024 * 1024;
const DEFAULT_MAX_MEMORY_BYTES = 768 * MiB;
const DEFAULT_TIMEOUT_MS = 30_000;
/** How often the process size is checked: at the few hundred MB/s pdf.js inflates at, a few MB of overshoot at most. */
const WATCH_INTERVAL_MS = 20;

type WorkerMessage = { type: 'ready' } | { type: 'done'; result: PdfText } | { type: 'failed'; message: string };

let queue: Promise<unknown> = Promise.resolve();

/** Text of a PDF, page by page. Throws PdfError when the file cannot be read (damaged, password-protected, too large once decoded, too slow). */
export function extractPdfText(data: Uint8Array, opts: PdfOptions = {}): Promise<PdfText> {
  const run = queue.then(() => readInWorker(data, opts));
  queue = run.catch(() => undefined);
  return run;
}

function readInWorker(data: Uint8Array, opts: PdfOptions): Promise<PdfText> {
  const maxMemory = opts.maxMemoryBytes ?? DEFAULT_MAX_MEMORY_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    // The worker gets its own copy, moved rather than cloned.
    const copy = new Uint8Array(data);
    const worker = new Worker(new URL('./pdf-worker.js', import.meta.url), {
      workerData: { data: copy, maxPages: opts.maxPages ?? DEFAULT_MAX_PAGES },
      transferList: [copy.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    let baseline: number | undefined;
    let settled = false;
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(watch);
      clearTimeout(timer);
      void worker.terminate();
      outcome();
    };
    const fail = (message: string) => settle(() => reject(new PdfError(message)));
    // Loading pdf.js itself costs memory; the budget applies from the moment the worker starts on the file.
    const watch = setInterval(() => {
      if (baseline !== undefined && process.memoryUsage.rss() - baseline > maxMemory) {
        fail('This PDF expands to far more data than it contains (it is malformed or built to exhaust memory), so it was not read.');
      }
    }, WATCH_INTERVAL_MS);
    const timer = setTimeout(() => fail(`Reading this PDF took longer than ${timeoutMs / 1000} s, so it was stopped.`), timeoutMs);
    worker.on('message', (message: WorkerMessage) => {
      if (message.type === 'ready') baseline = process.memoryUsage.rss();
      else if (message.type === 'done') settle(() => resolve(message.result));
      else fail(message.message);
    });
    worker.on('error', (err: Error & { code?: string }) =>
      fail(err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'This PDF needs too much memory to read, so it was not read.' : `The file could not be read as a PDF (${err.message}).`),
    );
    worker.on('exit', (code) => fail(`The PDF reader stopped unexpectedly (exit code ${code}).`));
  });
}
