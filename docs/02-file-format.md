# 02 — The `.quire` Document Format (v1)

> Replaces SMath's `.sm` XML. Machine schema: [`schema/quire-1.schema.json`](../schema/quire-1.schema.json).
> Reference importer: [`tools/sm2quire.py`](../tools/sm2quire.py).

## 1. Design goals, measured against a real SMath file

| Goal | SMath `.sm` (a real report) | `.quire` (same document, converted) |
|---|---|---|
| **Readable math** | RPN tokens: `<e>L.span</e><e>5.1</e><e style="unit">m</e><e>*</e><e>:</e>` | `"expr": "L.span := 5.1 'm"` |
| **Small text source** | 1.09 MB single file (≈90 % base64) | `document.json` 40 KB + content-addressed `assets/` |
| **Quiet diffs** | `<revision>` bumps every save; computed `width`/`height` of every math region change when results change | No counters, timestamps, computed sizes or results in the source |
| **Stable identity** | Some regions have GUID ids, most have none | Every region has a short permanent `id` |
| **Real document features** | Footer right-aligned with ~200 spaces; "1. ASSUMPTIONS" and "Figure 1 –" typed by hand | 3-slot headers/footers; auto-numbered headings, figures and tables with captions |
| **Real containers** | Areas = start marker + `terminator` region elsewhere | `area` region with `regions: [...]` children |
| **Lossless import** | — | Anything not understood becomes a `legacy` region that keeps the original XML |

## 2. Physical layout

```
Report.quire/                 ← a directory; on macOS registered as a document *package*
├── document.json             ← the source of truth (canonical JSON, §5)
├── results.json              ← OPTIONAL cached results (§6)
└── assets/
    ├── 3a41c07be2d95f18.png  ← name = first 16 hex chars of SHA-256 of the bytes
    └── e027afbe9d4229fa.png
```

- **`.quire/` directory** is the default for disk and Git. On macOS, `Info.plist` declares the UTI as conforming to `com.apple.package`, so Finder, Quick Look, double-click and AirDrop treat it as **one file**. Git sees ordinary text files.
- **`.quirez`** is the same tree in a ZIP (stored, not deflated, for images), for email and web upload. The app opens and saves both; *Export as single file* converts.
- Assets are **content-addressed**: no duplicates, renaming never breaks references, and a changed image is a new file instead of a rewritten blob. A suggested `.gitattributes` line, `*.quire/assets/** filter=lfs diff=lfs merge=lfs -text`, puts them in Git LFS.

**Why JSON and not YAML?** YAML reads nicer, but it has implicit typing (`no` → `false`, `1.10` → `1.1`, `NO` the country code becomes a boolean), and the Rust YAML ecosystem is in flux (`serde_yaml` is archived). We get the readability back through (a) math stored as linear text, (b) text stored as Djot, and (c) a canonical formatter that keeps short values on one line (§5). JSON then gives us `serde_json`, JSON Schema validation, and `jq`/`git diff` tooling for free.

## 3. Top-level structure

```jsonc
{
  "format": "quire/1",                 // required; major version gates readers
  "meta": {
    "title": "Calculation Report",     // or { "pt": "...", "en": "..." }
    "authors": ["A. Engineer"],
    "company": "Example Engineering", // feeds {company} in headers/footers
    "id": "6f1c2b0e-3d4a-4b8e-9a51-2c7d8e0f4a13",
    "lang": "pt-BR"                    // BCP-47; drives decimal separator, caption words
  },
  "settings": {
    "display": { "decimals": 4, "exponentialThreshold": 5, "approxEqualDigits": 3,
                 "trailingZeros": false, "fractions": "decimal", "decimalSeparator": "auto",
                 "resultUnits": "working" },  // results in the units you typed; "si" (default) for coherent SI
    "calc":    { "angle": "rad", "precision": "double" },
    "units":   { "system": "SI",
                 "prefer": { "force": "kN", "stress": "MPa", "moment": "kN*m" } }
  },
  "units":  { "tf": "1000 'kgf", "crane_load": "1.4 'tonnef" },   // custom unit definitions
  "styles": {
    "body": { "font": "Arial", "size": 8 },
    "math": { "font": "STIX Two Math", "size": 8 },
    "h1":   { "size": 10, "bold": true },
    "numbering": { "headings": "1.1", "figures": "Figura {n} –", "tables": "Tabela {n} –" }
  },
  "page": {
    "view": "pages",                   // "pages" (paginated) | "canvas" (infinite)
    "paper": "A4",                     // or ["210mm", "297mm"]
    "orientation": "portrait",
    "margins": { "top": "25.4mm", "right": "18.8mm", "bottom": "25.4mm", "left": "18.8mm" },
    "header": { "center": "{date} {time} - {file}", "color": "#a9a9a9" },
    "footer": { "left": "{author} | {company}", "right": "{page} / {pages}", "color": "#a9a9a9" },
    "firstPage": { "header": false },  // different first page
    "backgrounds": [{ "pages": "1", "src": "assets/0a1b2c3d4e5f6071.png", "fit": "margins" }],
    "pageNumber": { "start": 1, "style": "arabic" }
  },
  "requires": ["plot3d"],              // capabilities beyond core; readers warn if missing
  "regions": [ /* §4, sorted by (y, x) */ ]
}
```

Header/footer fields: `{page} {pages} {date} {time} {file} {title} {author} {company} {section}`.
Lengths: bare numbers are **layout px (1/96 in)**, which is identical to SMath's coordinates so imports are exact. Strings may carry `mm`, `cm`, `in` or `pt`.

## 4. Regions

### 4.1 Common fields

| Field | Type | Notes |
|---|---|---|
| `id` | string, 6 chars `[a-z2-9]` | Assigned once, never renumbered. Used by `results.json`, cross-references and comments. |
| `kind` | enum | `math` `text` `image` `table` `plot2d` `plot3d` `data` `area` `pagebreak` `legacy` |
| `at` | `[x, y]` | Top-left in px. **Relative to the parent area** when nested. |
| `size` / `width` | `[w, h]` / `w` | Only where the *user* sets it (images, plots, tables, fixed-width text). **Auto-sized content never stores its size.** |
| `style` | object | Overrides of the named style (`{ "font": "Arial Black", "size": 12 }`) or `{ "ref": "h1" }` |
| `keep` | bool | Don't split across a page break (SMath `isBreakable=false`) |
| `disabled` | bool | Excluded from evaluation |
| `color`, `background`, `border` | | Defaults omitted |

**Evaluation order = array order = reading order `(y, x)`.** The writer always sorts, so the file order is meaningful and a moved region shows up in a diff as a moved line block.

### 4.2 `math`

```json
{
  "id": "if8pkw",
  "kind": "math",
  "at": [0, 1818],
  "expr": "A.net := b*h - A.hole",
  "show": "value",
  "display": { "decimals": 2 },
  "note": "Net section area"
}
```
(A region with a forced result unit, SMath's "contract", carries `"display": { "unit": "kgf" }`.)

| Field | Meaning |
|---|---|
| `expr` | The expression in **Quire linear syntax** (§4.3). This is the *only* math content stored. |
| `show` | `"value"` renders `= result` (numeric), `"symbolic"` renders `→ result`. Omitted means no result shown. |
| `display` | `unit` (SMath's "contract": force the result unit), `decimals`, `notation` (`auto`/`sci`/`eng`) |
| `mode` | `"numeric"` / `"symbolic"`: per-region optimization override |
| `note` | Side description (Djot); `notePosition`: `right` (default) or `below` |
| `hideInput` | Show only the result |

### 4.3 Quire linear math syntax (summary; full grammar in P1)

Designed so that **(1)** a human can read and edit it in a diff, **(2)** it round-trips losslessly with the 2D editor AST, and **(3)** every SMath construct maps onto it (verified on 1,335 regions, §8).

| Construct | Syntax | Renders as |
|---|---|---|
| Definition / global definition | `x := 2`, `g ≡ 9.81 'm/'s^2` (`::=` is the ASCII alias for `≡`) | x := 2 |
| Function | `f(x, y) := x^2 + y` | |
| Literal subscript | `A.net`, `L.span.max` | A with subscript ÁREA |
| Units | plain names: `5.1 m`, `64 kgf*m`, `9.81 m/s^2`. A name means a unit unless a variable of that name is defined at that point (Mathcad's rule). The `'` prefix (`'m`) always means the unit, and the importer writes it | 5.1 m |
| Constants | built in: `π` `e` `∞` `g` `c` `G` `h` `ħ` `k.B` `N.A` `R` `q.e` `m.e` `m.p` `ε.0` `μ.0` `σ.SB` `ρ.w` `p.atm` (SI values, CODATA 2018) | purple |
| Implicit multiplication | a number followed by a name, unit or call: `25.5 m^2`, `2 x`, `2 sin(x)`. It binds tighter than `*` `/` and looser than `^` | |
| Strings | `"OK"` | |
| Comparison (boolean) | `==` `≠` `<` `≤` `>` `≥`; chains allowed: `a < c < b` | bold = |
| Logic | `and` `or` `not` | |
| Index | `v[i]`, `M[i, j]` | subscript index |
| Matrix | `[1, 2; 3, 4]`; multi-line allowed | 2D matrix |
| Range | `1..10`, or `range(0, 1, 0.1)` for a step | |
| Empty slot | `?` (an unfinished expression; evaluating it is an error) | placeholder box |
| Calculus | `diff(f(x), x)`, `diff(f, x, 2)`, `int(f, x)`, `int(f, x, a, b)`, `sum(e, i, 1, n)`, `prod(...)`, `lim(e, x, a)` | 2D operators |
| Roots / abs | `sqrt(x)`, `root(x, n)`, `abs(x)` | √x, ⁿ√x, \|x\| |
| Programming | `if(c, a, b)`, `block(...)`, `for(i, range, body)`, `while(c, body)` | SMath program blocks |

**Name resolution.** One name can mean a variable, a constant and a unit (`g`: your variable, standard gravity, the gram). The engine resolves each occurrence as follows:

1. A variable defined at that point always wins.
2. In *unit position* a unit wins. Unit position is the right side of implicit multiplication (`500 g`, `3 h`) or of `/` after a quantity (`100 km/h`).
3. Anywhere else a constant wins over a unit (`m*g` is gravity, `c*1 s` is a distance).
4. `'g` always means the unit.

The report tells the editor how each name was resolved, and which variables hide a constant. The editor colours units blue and constants purple, explains a name on hover, and offers a one-click "use the unit" fix while you type.

Canonical function names are English (`tan`, `sinh`, `atan`, `log10`). The importer maps SMath's `tg`, `sh`, `arctg`, `nthroot` and so on.

### 4.4 `text` (Djot)

```json
{
  "id": "zyi2gp",
  "kind": "text",
  "at": [0, 1548],
  "text": "[Dead load:]{.underline} self-weight of the deck and its finishes…"
}
```

The text is **[Djot](https://djot.net)**: a strict, unambiguous light markup by the author of CommonMark/Pandoc, with a Rust parser (`jotdown`, MIT). Unlike Markdown it has attributes, which is what rich formatting needs:
- `*bold*`, `_italic_`, `[x]{.underline}`, `[x]{color=#c00}`, `{.center}` on a paragraph, a trailing `\` for a hard line break.
- `# Assumptions` is an **auto-numbered heading** (rendered "1. Assumptions" per `styles.numbering.headings`).
- Inline live math: `` The net area is $`A.net =` `` renders the *current* value inside the sentence.
- Cross-reference: `[](#scheme)` renders "Figure 1".
- Multilingual (SMath supports per-language text): `"text": { "pt": "…", "en": "…" }`.

### 4.5 `image`

```json
{
  "id": "scheme",
  "kind": "image",
  "at": [60, 108],
  "size": [480, 165],
  "src": "assets/e027afbe9d4229fa.png",
  "caption": { "text": "Static scheme and design load", "position": "below" }
}
```
`caption` automatically gets "Figura N –" and enters the figure list. The importer turned the hand-typed `Figura 1 – …` text region into exactly this.

### 4.6 `table`

Two modes:
```jsonc
// bound: displays a matrix variable live (the SMath Table Region model)
{ "id": "…", "kind": "table", "at": [54, 7866], "size": [551, 177],
  "source": "SUMMARY", "header": { "row": true, "column": true },
  "display": { "decimals": 2 }, "caption": { "text": "Summary of checks", "position": "above" } }

// spreadsheet: each cell is text, a value with units, or a formula starting with "="
{ "kind": "table", "name": "loads", "header": { "row": true },
  "columns": [{ "width": 110 }, { "align": "right" }, {}, { "unit": "kN/m", "decimals": 2 }],
  "rows": [["Load", "Characteristic", "γ", "Design"],
           ["Dead", "4.5 kN/m", "1.35", "=B2*C2"],
           ["Live", "3 kN/m", "1.5", "=B3*C3"],
           ["Total", "=SUM(B2:B3)", "", "=SUM(D2:D3)"]] }
```

A spreadsheet table runs in reading order with the math regions:

- **Cells** are text (`Dead`), values (`12`, `1,5`, `15%`, `4.5 kN/m`) or formulas (`=B2*C2`).
- **Formulas** use spreadsheet syntax:
  - A1 references and ranges (`$A$1`, `B2:D4`).
  - `=` and `<>` compare; `&` joins text; `,` or `;` separates arguments; function names in any case.
  - Functions: `IF`, `IFS`, `IFERROR`, `AND`, `OR`, `NOT`, `SUM`, `AVERAGE`, `MIN`, `MAX`, `MEDIAN`, `COUNT`, `COUNTA`, `SUMIF`, `COUNTIF`, `SUMPRODUCT`, `ROUND`, `CEILING`, `MOD`, `VLOOKUP`, `HLOOKUP`, `INDEX`, `MATCH`, `CHOOSE`, `CONCAT` and others.
  - Formulas also reach the worksheet: variables defined above (`=M.max`), units (`=B2 + 5 kN`), your functions and Quire's built-ins.
- **References:** an uppercase letters-and-digits name inside the table's bounds is a cell; outside them it is a variable (`F1`). Another table's cells are `name!B2`.
- **`name`** makes the table a matrix variable for the math below it: `loads[4, 4]`, 1-based, header row included.
- **Display:** numbers are shown in the units the table and the variables it reads are written in, or in the column's `unit`.

> 💡 SMath summary tables are often matrices of **hand-copied numbers**, not references to the computed variables. A table with `=σ` and `=IF(B2<=C2, "OK", "FAIL")` cells fixes that whole class of stale-report errors.

### 4.7 `plot2d` / `plot3d`

```json
{
  "id": "…",
  "kind": "plot2d",
  "at": [9, 2430],
  "size": [556, 233],
  "series": [
    { "y": "M(x)", "x": "x", "range": "0 'm..L.B", "label": "Momento", "style": { "color": "#0a6", "width": 1.5 } }
  ],
  "axes": { "x": { "unit": "m", "label": "x" }, "y": { "unit": "kN*m" } },
  "grid": true,
  "legend": "top-right"
}
```
`plot3d` adds `surface: "f(x, y)"` (or `parametric: [x(u,v), y(u,v), z(u,v)]`), `x`/`y` ranges and a `camera: { "azimuth": 30, "elevation": 25, "distance": 3 }` that is saved when the user stops orbiting.

### 4.8 `data` (CSV / JSON import)

```json
{ "id": "…", "kind": "data", "at": [0, 4000], "name": "loads",
  "src": "assets/1c0ffee5e1a5b2d3.csv", "format": "csv", "header": true,
  "columns": [{ "name": "x", "unit": "m" }, { "name": "F", "unit": "kN" }] }
```
This defines the matrix variable `loads` (with per-column units). Small datasets may use `"inline": [[…], […]]` instead of `src`. Export goes the other way: right-click any matrix result and choose *Export CSV/JSON*, or *Copy as TSV*.

### 4.9 `toc` (contents lists)

```json
{ "id": "…", "kind": "toc", "at": [0, 54], "of": "headings", "title": "Contents" }
```
`of` is `headings` (table of contents), `figures` or `tables`. The entries, numbers and page numbers are computed when the document is drawn and never stored. A heading styled **Title** (`{.title}` before `#`) is neither numbered nor listed.

### 4.10 `area`, `pagebreak`, `legacy`

```jsonc
{ "id": "a9tiey", "kind": "area", "at": [0, 6660], "height": 1008,
  "title": "Verificação", "collapsed": true, "locked": false,
  "regions": [ /* children, at relative to the area */ ] }

{ "id": "…", "kind": "pagebreak", "at": [0, 5000] }

{ "id": "…", "kind": "legacy", "at": [..], "size": [..],
  "legacy": { "format": "smath:plot", "src": "assets/<sha>.xml" } }   // lossless fallback
```

## 5. Canonical serialization (what makes it Git-friendly)

Every writer (the app, the CLI, the importer) **must** produce byte-identical output for the same model:

1. UTF-8 without BOM, `\n` line endings, 2-space indent, trailing newline.
2. **Key order is fixed**: `format, meta, settings, units, styles, page, requires, regions` at the top. In a region: `id, kind, at, size, width, height, style, keep, disabled, locked, collapsed, title, expr, show, mode, hideInput, display, note, …, regions`. Nested objects keep their schema-defined order.
3. Top-level sections and **each region are always expanded**, one key per line. Any other value is written on one line if it fits in 100 columns, otherwise expanded. The result is that changing an expression, moving a region, or toggling `collapsed` changes **exactly one line**.
4. **Defaults are omitted** (`color` black, `show` none, `keep` false, …).
5. **No derived data**: no computed sizes, no results, no save counters, no timestamps, no undo history.
6. Regions sorted by `(y, x)`. IDs are never reused.
7. Numbers in shortest round-trip form (Ryū); math numerals are kept **as typed** (`5.0` stays `5.0`).

The importer already obeys these rules. Converting the same `.sm` twice gives byte-identical output (verified).

## 6. `results.json` (optional)

```json
{
  "format": "quire-results/1",
  "producer": "quire 0.1.0",
  "results": {
    "if8pkw": "25.5 'm^2",
    "7rcaxq": "1800 'kgf"
  }
}
```
- Keyed by region `id`. Values are in linear syntax, in the region's display unit.
- **Commit it when you want calculation review in pull requests.** A diff that shows `"FU.diag": "0.83"` → `"0.91"` is exactly what a checking engineer wants to see. Add it to `.gitignore` for quieter history.
- Lets a viewer (web, Quick Look, CLI `quire show`) display a document without running the engine.
- The importer fills it from SMath's own cached results, which makes imported reports a regression oracle: the Quire engine must reproduce them.

## 7. Versioning & compatibility

- `format: "quire/<major>"`. **Minor additions don't bump the major**: readers must **ignore and preserve** unknown keys (round-trip safety), and writers never drop them.
- A breaking change bumps the major and ships a migration in `quire-doc::migrate`, which always runs on load. Old files are never rewritten silently: the app asks before upgrading.
- `requires` lists optional capabilities (`plot3d`, `cas.giac`, plugin ids). A reader missing one still opens the file and shows those regions as placeholders.

## 8. Import validation (SMath → Quire)

`tools/sm2quire.py` ran against a real-world report and all 58 worksheets bundled with SMath 1.5 (both the current namespaced schema and the 0.55-era bare schema):

| Region type | Converted | Fallback to `legacy` |
|---|---|---|
| math | 604 | 0 |
| text | 631 (15 became auto-numbered headings, 2 became captions) | 0 |
| area | 84 | 0 |
| picture | 5 (+1 page background) | 0 |
| plot | 8 | 0 |
| table | 1 (bound to a summary matrix) | 0 |

Two SMath conventions the importer handles:
- **Math embedded in text** (`\[REGION[id]]\` markers) becomes inline math `` $`expr` ``. It is evaluated in reading order with id `<text region id>:m<n>`.
- **Page margins** are stored in hundredths of an inch, but SMath applies them at 72 dpi against 96-px coordinates. The importer therefore uses ¾ of the nominal value. Only that reading makes real reports' text width and cover forms line up.

Known gaps for P1: plot axis ranges and styles, table cell styling, and SMath `description` positions other than right are only partly carried over. The text→heading and text→caption heuristics are tuned for Portuguese/English report conventions.
