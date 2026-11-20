/**
 * libsignal (WhatsApp's end-to-end encryption, used by Baileys) prints whole
 * session records with console.info/warn, private keys included, every time a
 * session opens or closes. Those keys must not end up in the hosting logs:
 * keep the one-line notice and drop the record.
 */
const NOISY = /^(Closing session|Opening session|Removing old closed session|Session already closed|Migrating session|Unhandled bucket type)/;

export function hideSignalSessionDumps(target: Pick<Console, 'info' | 'warn' | 'log'> = console): void {
  for (const level of ['info', 'warn', 'log'] as const) {
    const original = target[level].bind(target);
    target[level] = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && NOISY.test(args[0]) && args.length > 1) {
        original(args[0].replace(/:?\s*$/, ''));
        return;
      }
      original(...args);
    };
  }
}
