// Reading a downloaded Word file back: its ZIP entries, from the central directory.
import { inflateRawSync } from "node:zlib";
import { expect, type Page } from "@playwright/test";

/** Every file in a ZIP package, by name. */
export function unzip(zip: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  // the end-of-central-directory record: the last 22 bytes, unless there is a comment
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("not a ZIP file");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLen);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Run Export as Word… from the command palette and read what it downloads. */
export async function exportWord(page: Page): Promise<{ name: string; files: Map<string, Buffer> }> {
  const download = page.waitForEvent("download");
  // ⌘K: the test browser reports itself as a Mac
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Export as Word");
  await page.keyboard.press("Enter");
  const file = await download;
  const path = await file.path();
  expect(path).toBeTruthy();
  const { readFileSync } = await import("node:fs");
  return { name: file.suggestedFilename(), files: unzip(readFileSync(path!)) };
}

/** A PNG's width and height in pixels. */
export const pngSize = (png: Buffer): [number, number] => [png.readUInt32BE(16), png.readUInt32BE(20)];
