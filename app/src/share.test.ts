import { describe, expect, it } from "vitest";
import { decodeDoc, docInHash, encodeDoc, fromBase64Url, hasImages, linkFor, toBase64Url } from "./share";
import type { Doc } from "./types";

const doc: Doc = {
  format: "1",
  meta: { title: "Cálculo — viga" },
  regions: [
    { id: "a", kind: "math", at: [0, 0], expr: "q:=12 kN/m" },
    { id: "b", kind: "text", at: [0, 40], text: "σ ≤ f_y, see Figure 1" },
  ],
};

describe("documents in links", () => {
  it("round-trip, accents and symbols included", async () => {
    expect(await decodeDoc(await encodeDoc(doc))).toEqual(doc);
  });

  it("use only characters that survive in a URL", async () => {
    expect(await encodeDoc(doc)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("go after #doc= on the page they are made on, replacing any earlier one", async () => {
    const link = await linkFor(doc, "https://example.org/quire/?open=x#doc=old");
    expect(link.startsWith("https://example.org/quire/?open=x#doc=")).toBe(true);
    expect(await decodeDoc(docInHash(new URL(link).hash)!)).toEqual(doc);
    expect(docInHash("#section-2")).toBeNull();
  });

  it("say so when a link was cut short", async () => {
    const encoded = await encodeDoc(doc);
    await expect(decodeDoc(encoded.slice(0, encoded.length / 2))).rejects.toThrow(/incomplete or damaged/);
  });

  it("leave images out, and know when a document has any", () => {
    expect(hasImages(doc)).toBe(false);
    expect(
      hasImages({ ...doc, regions: [...doc.regions, { id: "i", kind: "image", at: [0, 0], src: "assets/x.png" }] }),
    ).toBe(true);
    expect(hasImages({ ...doc, page: { backgrounds: [{ pages: "1", src: "assets/y.png" }] } })).toBe(true);
  });
});

describe("base64url", () => {
  it("round-trips every byte value", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
  });
});
