/**
 * Read-only ZIP reader, just enough for Office Open XML packages (.docx, .xlsx, .pptx).
 *
 * Supported: single-part archives whose entries are stored (method 0) or
 * deflated (method 8). Refused with a ZipError: encryption, ZIP64, split
 * archives and other compression methods. Nothing is ever written to disk.
 *
 * Layout (all integers little-endian):
 *
 *   [local header, data] … [central directory entries] [end of central directory, comment]
 *
 * The central directory at the end is authoritative: names, sizes, CRCs and
 * the offset of each local header. Local headers are used only to find where
 * an entry's data starts, because their sizes may be zero (streaming writers
 * put them in a "data descriptor" after the data instead).
 *
 * Input is untrusted (mail attachments, shared files), so every offset is
 * bounds-checked, and inflation is capped at the declared size, which is in
 * turn held to per-entry and per-archive limits. That defuses zip bombs,
 * including the kind where many entries point at the same compressed data.
 */
import { crc32, inflateRawSync } from 'node:zlib';

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipLimits {
  /** Most entries the central directory may list (default 5000). */
  maxEntries?: number;
  /** Largest uncompressed size of one entry, in bytes (default 50 MiB). */
  maxEntryBytes?: number;
  /** Most uncompressed bytes read from one archive in total (default 150 MiB). */
  maxTotalBytes?: number;
}

export interface ZipArchive {
  /** Entry names in central-directory order (directories end with "/"). */
  names(): string[];
  has(name: string): boolean;
  /** Uncompressed bytes of an entry, or undefined when there is none. Throws ZipError when it cannot be read. */
  read(name: string): Buffer | undefined;
  /** An entry as text: UTF-8, or UTF-16 when it starts with that byte-order mark; the mark is removed. */
  readText(name: string): string | undefined;
}

const MiB = 1024 * 1024;

// Record signatures ("PK\x05\x06" and so on, read as little-endian integers) and fixed lengths.
const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const END_LENGTH = 22;
const CENTRAL_LENGTH = 46;
const LOCAL_LENGTH = 30;

// General purpose flags.
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;

interface Entry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localHeader: number;
}

/** Reads the central directory; entries are inflated lazily and only once. */
export function openZip(data: Buffer, limits: ZipLimits = {}): ZipArchive {
  const maxEntries = limits.maxEntries ?? 5000;
  const maxEntryBytes = limits.maxEntryBytes ?? 50 * MiB;
  const maxTotalBytes = limits.maxTotalBytes ?? 150 * MiB;

  const end = findEndOfCentralDirectory(data);
  const disk = data.readUInt16LE(end + 4);
  const directoryDisk = data.readUInt16LE(end + 6);
  const entriesOnDisk = data.readUInt16LE(end + 8);
  const count = data.readUInt16LE(end + 10);
  const directorySize = data.readUInt32LE(end + 12);
  const directoryStart = data.readUInt32LE(end + 16);

  // ZIP64 archives put these all-ones markers here and the real values in extra records.
  if (count === 0xffff || directorySize === 0xffffffff || directoryStart === 0xffffffff) {
    throw new ZipError('ZIP64 archives are not supported.');
  }
  if (disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== count) {
    throw new ZipError('Split (multi-part) ZIP archives are not supported.');
  }
  if (count > maxEntries) throw new ZipError(`The ZIP archive has ${count} entries; the limit is ${maxEntries}.`);
  const directoryEnd = directoryStart + directorySize;
  if (directoryEnd > end) throw corrupt('the central directory lies outside the file');

  const entries = new Map<string, Entry>();
  let pos = directoryStart;
  for (let i = 0; i < count; i++) {
    if (pos + CENTRAL_LENGTH > directoryEnd || data.readUInt32LE(pos) !== CENTRAL_SIGNATURE) {
      throw corrupt('a central directory entry is damaged');
    }
    const flags = data.readUInt16LE(pos + 8);
    const nameEnd = pos + CENTRAL_LENGTH + data.readUInt16LE(pos + 28);
    if (nameEnd > directoryEnd) throw corrupt('a central directory entry is damaged');
    // Flag bit 11 marks UTF-8 names. Otherwise the name is CP437, read here as Latin-1 (the same for ASCII).
    const name = data.toString(flags & FLAG_UTF8 ? 'utf8' : 'latin1', pos + CENTRAL_LENGTH, nameEnd);
    // We never write files, but lookups should not be fooled by "a/../b" or two entries with one name.
    if (name.split(/[/\\]/).includes('..')) throw new ZipError(`ZIP entry name "${name}" contains "..".`);
    if (entries.has(name)) throw new ZipError(`The ZIP archive lists "${name}" twice.`);
    entries.set(name, {
      name,
      flags,
      method: data.readUInt16LE(pos + 10),
      crc: data.readUInt32LE(pos + 16),
      compressedSize: data.readUInt32LE(pos + 20),
      size: data.readUInt32LE(pos + 24),
      localHeader: data.readUInt32LE(pos + 42),
    });
    // The next entry follows this one's name, extra field and comment.
    pos = nameEnd + data.readUInt16LE(pos + 30) + data.readUInt16LE(pos + 32);
  }

  const cache = new Map<string, Buffer>();
  let totalBytes = 0;

  function extract(entry: Entry): Buffer {
    const label = `ZIP entry "${entry.name}"`;
    if (entry.flags & FLAG_ENCRYPTED) throw new ZipError(`${label} is encrypted.`);
    if (entry.method !== 0 && entry.method !== 8) {
      throw new ZipError(`${label} uses compression method ${entry.method}; only stored (0) and deflate (8) are supported.`);
    }
    if (entry.size === 0xffffffff || entry.compressedSize === 0xffffffff || entry.localHeader === 0xffffffff) {
      throw new ZipError(`${label} needs ZIP64, which is not supported.`);
    }
    if (entry.size > maxEntryBytes) {
      throw new ZipError(`${label} is too large (${entry.size} bytes; the limit is ${maxEntryBytes}).`);
    }
    if (totalBytes + entry.size > maxTotalBytes) {
      throw new ZipError(`The ZIP archive expands to more than ${maxTotalBytes} bytes.`);
    }

    // The local header's own name and extra field lengths decide where the data starts;
    // they can differ from the central directory's.
    const header = entry.localHeader;
    if (header + LOCAL_LENGTH > directoryStart || data.readUInt32LE(header) !== LOCAL_SIGNATURE) {
      throw corrupt(`${label} has no local header`);
    }
    const start = header + LOCAL_LENGTH + data.readUInt16LE(header + 26) + data.readUInt16LE(header + 28);
    const stop = start + entry.compressedSize;
    if (stop > directoryStart) throw corrupt(`${label} runs past the end of the data`);

    let bytes = data.subarray(start, stop);
    if (entry.method === 8) {
      try {
        // Never inflate past the declared size (checked against the limits above): zip bombs lie about it.
        bytes = inflateRawSync(bytes, { maxOutputLength: Math.max(entry.size, 1) });
      } catch (err) {
        if ((err as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') {
          throw new ZipError(`${label} expands beyond its declared size of ${entry.size} bytes.`);
        }
        throw corrupt(`${label} cannot be inflated (${(err as Error).message})`);
      }
    }
    if (bytes.length !== entry.size || crc32(bytes) !== entry.crc) {
      throw corrupt(`${label} fails its size or checksum check`);
    }
    totalBytes += bytes.length;
    return bytes;
  }

  function read(name: string): Buffer | undefined {
    const cached = cache.get(name);
    if (cached) return cached;
    const entry = entries.get(name);
    if (!entry) return undefined;
    const bytes = extract(entry);
    cache.set(name, bytes);
    return bytes;
  }

  return {
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    read,
    readText(name) {
      const bytes = read(name);
      if (bytes === undefined) return undefined;
      const encoding =
        bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
      return new TextDecoder(encoding).decode(bytes); // TextDecoder drops the byte-order mark
    },
  };
}

/**
 * The end-of-central-directory record closes the file, but an archive comment of up to 65535 bytes
 * may follow it, so it is searched for backwards. A record whose comment reaches exactly the end of
 * the file wins (a comment can contain the signature bytes); failing that, the last record whose
 * comment fits (the file has stray bytes appended).
 */
function findEndOfCentralDirectory(data: Buffer): number {
  let fallback = -1;
  const lowest = Math.max(0, data.length - END_LENGTH - 0xffff);
  for (let i = data.length - END_LENGTH; i >= lowest; i--) {
    if (data.readUInt32LE(i) !== END_SIGNATURE) continue;
    const recordEnd = i + END_LENGTH + data.readUInt16LE(i + 20);
    if (recordEnd === data.length) return i;
    if (recordEnd < data.length && fallback === -1) fallback = i;
  }
  if (fallback !== -1) return fallback;
  throw new ZipError('Not a ZIP archive (no end of central directory record).');
}

function corrupt(detail: string): ZipError {
  return new ZipError(`Corrupt ZIP archive: ${detail}.`);
}
