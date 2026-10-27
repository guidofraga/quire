// PDF export helpers: images are embedded at the resolution they are printed at, not
// at whatever resolution they were pasted in.

import { isMac } from "./api";

/** macOS writes the PDF itself; elsewhere the system print dialog saves it ("Save as PDF"). */
export const directPdf = isMac;

async function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function opaque(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const data = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return false;
  return true;
}

async function resample(img: HTMLImageElement, w: number, h: number): Promise<string | null> {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  const png = await encode(canvas, "image/png");
  // photos compress far better as JPEG; drawings and text stay lossless
  const jpeg = opaque(ctx, w, h) ? await encode(canvas, "image/jpeg", 0.9) : null;
  const best = jpeg && (!png || jpeg.size < png.size * 0.6) ? jpeg : png;
  if (!best) return null;
  // the app's content security policy allows data: images, not blob:
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(best);
  });
}

/**
 * Swap every printed image for a copy at `dpi` (0 keeps the originals).
 * Returns a function that puts the originals back.
 */
export async function shrinkImages(dpi: number): Promise<() => void> {
  const restore: [HTMLImageElement, string][] = [];
  if (dpi > 0) {
    for (const img of document.querySelectorAll<HTMLImageElement>(".sheet img")) {
      await img.decode().catch(() => {});
      // CSS pixels are 1/96 in
      const w = Math.ceil((img.clientWidth * dpi) / 96);
      const h = Math.ceil((img.clientHeight * dpi) / 96);
      if (!w || !h || img.naturalWidth <= w * 1.25) continue;
      const url = await resample(img, w, h);
      if (!url) continue;
      restore.push([img, img.src]);
      img.src = url;
      await img.decode().catch(() => {});
    }
  }
  return () => {
    for (const [img, src] of restore) img.src = src;
  };
}
