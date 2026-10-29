// Documents in links: the whole document.json, deflated and base64url-encoded after `#doc=`.
// What follows `#` never leaves the browser, so a shared document is not sent to any server,
// GitHub's included. Images stay out (they would make links too long to send); a document
// with images travels as a .quirez file instead.

import type { Doc } from "./types";

/** Where the web version lives; links made in the desktop app open there. */
export const WEB_URL = "https://guidofraga.github.io/quire/";

const PREFIX = "#doc=";

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const input = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
  const out = input.pipeThrough(stream as TransformStream<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** The text after `#doc=` for a document. */
export async function encodeDoc(doc: Doc): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(doc));
  return toBase64Url(await pipe(json, new CompressionStream("deflate-raw")));
}

export async function decodeDoc(text: string): Promise<Doc> {
  let json: string;
  try {
    json = new TextDecoder().decode(await pipe(fromBase64Url(text), new DecompressionStream("deflate-raw")));
  } catch {
    throw new Error("the link is incomplete or damaged: ask for it again, or for the .quirez file");
  }
  return JSON.parse(json) as Doc;
}

/** The document a URL's hash carries, if any (`#doc=…`). */
export function docInHash(hash: string): string | null {
  return hash.startsWith(PREFIX) ? hash.slice(PREFIX.length) : null;
}

/** A link that opens `doc`, on `base` (this page in a browser, the web version from the app). */
export async function linkFor(doc: Doc, base: string): Promise<string> {
  return `${base.replace(/#.*$/, "")}${PREFIX}${await encodeDoc(doc)}`;
}

/** Whether a document uses images (page backgrounds included), which links leave out. */
export function hasImages(doc: Doc): boolean {
  const backgrounds = (doc.page?.backgrounds as { src?: string }[] | undefined) ?? [];
  return doc.regions.some((r) => r.kind === "image") || backgrounds.some((b) => !!b.src);
}
