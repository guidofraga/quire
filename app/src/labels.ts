// The words around numbers: "Figure {n} –" on captions, "Section 2.1" in references.
// A document can set its own (Document ▸ Numbering, or double-click a caption's label);
// otherwise they follow the document's language.
import { state } from "./store";

type Kind = "figure" | "table" | "section";

const DEFAULTS: Record<string, Record<Kind, string>> = {
  en: { figure: "Figure {n} –", table: "Table {n} –", section: "Section {n}" },
  pt: { figure: "Figura {n} –", table: "Tabela {n} –", section: "Seção {n}" },
  "pt-PT": { figure: "Figura {n} –", table: "Tabela {n} –", section: "Secção {n}" },
  es: { figure: "Figura {n} –", table: "Tabla {n} –", section: "Sección {n}" },
  fr: { figure: "Figure {n} –", table: "Tableau {n} –", section: "Section {n}" },
  de: { figure: "Abbildung {n} –", table: "Tabelle {n} –", section: "Abschnitt {n}" },
  it: { figure: "Figura {n} –", table: "Tabella {n} –", section: "Sezione {n}" },
};

/** The language's default, e.g. "Figura {n} –" for a Portuguese document. */
export function defaultLabel(kind: Kind): string {
  const lang = (state.doc.meta?.lang as string | undefined) ?? "en";
  return (DEFAULTS[lang] ?? DEFAULTS[lang.split("-")[0]] ?? DEFAULTS.en)[kind];
}

const KEY: Record<Kind, "figures" | "tables" | "sections"> = { figure: "figures", table: "tables", section: "sections" };

/** The pattern in use: the document's own, else the language's default. */
export function labelPattern(kind: Kind): string {
  const own = (state.doc.styles?.numbering as Record<string, string | undefined> | undefined)?.[KEY[kind]];
  return own || defaultLabel(kind);
}

/** "Figure 3 –" for a caption. */
export const captionLabel = (kind: "figure" | "table", n: string) => labelPattern(kind).replace("{n}", n);

/** "Figure 3", "Section 2.1" for a reference: the pattern without trailing punctuation. */
export const refLabel = (kind: Kind, n: string) =>
  labelPattern(kind)
    .replace("{n}", n)
    .replace(/[\s–—:.-]+$/u, "");

/** Where a kind's pattern is stored in the document. */
export const labelKey = (kind: Kind) => KEY[kind];
