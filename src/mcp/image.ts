/**
 * Photos from WhatsApp are usually 100–500 KB, more than a tool result can
 * carry (about 96 KB of image). They are scaled down and re-encoded as JPEG
 * until they fit, so Claude can still look at a flat's photos or a screenshot.
 * sharp is the image library Baileys itself requires (for thumbnails).
 */
import sharp from 'sharp';
import { MAX_IMAGE_BYTES } from './extract/readable.js';

const STEPS: { side: number; quality: number }[] = [
  { side: 1600, quality: 80 },
  { side: 1280, quality: 75 },
  { side: 1024, quality: 70 },
  { side: 800, quality: 65 },
  { side: 640, quality: 60 },
  { side: 480, quality: 50 },
  { side: 360, quality: 45 },
];

/** A JPEG small enough to show, or undefined when the image cannot be decoded. */
export async function shrinkImage(data: Buffer, maxBytes = MAX_IMAGE_BYTES): Promise<{ data: Buffer; width: number; height: number } | undefined> {
  try {
    for (const step of STEPS) {
      const { data: out, info } = await sharp(data, { failOn: 'none', limitInputPixels: 100_000_000 })
        .rotate()
        .resize(step.side, step.side, { fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: step.quality, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      if (out.length <= maxBytes) return { data: out, width: info.width, height: info.height };
    }
  } catch {
    return undefined;
  }
  return undefined;
}
