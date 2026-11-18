/**
 * Minimal structured logger (one JSON object per line on stdout).
 *
 * Rule for the whole codebase: log metadata only. Never log tokens, secrets,
 * email bodies, subjects, file contents, event details or anything that came
 * out of a Google API. Aliases, tool names, status codes and durations are fine.
 */
import type { LogLevel } from './config.js';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export function createLogger(level: LogLevel = 'info', base: LogFields = {}, write: (line: string) => void = (l) => process.stdout.write(l + '\n')): Logger {
  const threshold = LEVELS[level];
  const emit = (lvl: LogLevel, msg: string, fields?: LogFields) => {
    if (LEVELS[lvl] < threshold) return;
    const record: Record<string, unknown> = { time: new Date().toISOString(), level: lvl, msg, ...base, ...fields };
    for (const k of Object.keys(record)) if (record[k] === undefined) delete record[k];
    write(JSON.stringify(record));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger(level, { ...base, ...fields }, write),
  };
}

export const silentLogger: Logger = createLogger('error', {}, () => {});

/** Safe description of an unknown error for logs: class name and message only, never a stack with request data. */
export function errorSummary(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 300);
  return String(err).slice(0, 300);
}
