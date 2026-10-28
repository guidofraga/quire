# Quire — a modern successor to SMath Studio

| | |
|---|---|
| [docs/01-architecture.md](docs/01-architecture.md) | Platform choice (Tauri 2 + Rust core), CAS/units/evaluation engine, rendering engine, crate layout, roadmap |
| [docs/02-file-format.md](docs/02-file-format.md) | The `.quire` document format: bundle layout, schema, linear math syntax, canonical serialization |
| [schema/quire-1.schema.json](schema/quire-1.schema.json) | JSON Schema (draft 2020-12) for `document.json` |
| [tools/sm2quire.py](tools/sm2quire.py) | SMath `.sm` → `.quire` importer (stdlib Python; the reference mapping) |

## Desktop app

[app/](app) is the Tauri 2 desktop editor (GPL-3.0-or-later): a free-form canvas with live evaluation.

**Writing**
- **Click anywhere and type.** Math is the default: `L:=2 m` defines L as 2 metres (units need no marker). Right after a number a unit name is always the unit, so `10 m` stays metres even if you defined `m := 25 kg`; anywhere else your variable wins (`m*g`, `10*m`), and a note under the line offers the other reading. `:` becomes `:=`, a trailing `=` shows the result, Ctrl+G turns the letter before the cursor into Greek.
- **A word followed by a space becomes text** (`The span…`); typing `:` or `=` right after a single word turns it back into a definition.
- Text regions are rich text: paragraph styles (Title, Heading 1–3), bold, italic, underline, strikethrough, super/subscript, colour, size, alignment and justification, bulleted and numbered lists, and **live math inside sentences** (⇧⌘M, `\math`, or `$t = $`).
- **LaTeX shortcuts, Word-style:** `\Delta`, `\varepsilon`, `\therefore`, `\sqrt`, `\int`… convert on space or punctuation, with a completion list as you type. They work in math and in text. Structures insert templates; Tab and ⇧Tab move between their `?` slots.
- **Equation ribbon:** a Structures gallery (fractions, scripts, radicals, integrals, large operators, calculus, matrices, functions, with typeset previews) and a Symbols library (Greek, operators, arrows, logic and sets, constants, units). Click to insert at the caret.
- **Results in the units you work in:** with `q := 12 kN/m` and `L := 6 m`, `M := q*L^2/8 =` shows `54 kN·m`, not `54000 J`; stresses come out in MPa once you use MPa, areas in cm² when the dimensions are in cm. Type a unit after `=` to choose it (`M = kgf*m`), as in SMath: typing `=` lists the units that fit with the result in each, and clicking the unit of any result switches it. A unit of another kind keeps the rest in SI (a force shown in `kg` reads `kg·m/s²`). Inspector ▸ Results switches a document back to coherent SI.
- **Functions and solving:** `f(x) := x^2`, `f(5) =`, `int(f(x), x, 0, 1) =`, `f(a) =` shows the body in terms of `a`. `solve(k*x == F, x, 0 m, 1 m)` finds a root in a range (or near the current value with `solve(…, x)`), `lsolve(A, b)` solves linear systems, `linterp(xs, ys, x)` interpolates tables; `mean`, `sort`, `norm`, `dot`, `cross` work on vectors.
- **Symbolic math** with `→` (type `->` or Ctrl+. at the end of a line, as in SMath): `diff(M(x), x) →` gives `q·(L − 2x)/2`, `int(M(x), x, 0, L) →` gives `L³·q/12`, `solve(a*x^2 + b*x + c == 0, x) →` gives both roots, and `expand` and `simplify` tidy expressions. Names stay symbols and your own functions are expanded into their formulas.
- **Spreadsheet tables** (Insert ▸ Table, ⌥⌘T, or paste cells copied from Excel):
  - Cells hold text, values with units (`4.5 kN/m`, `1,5`, `15%`) or formulas like `=B2*C2`, `=SUM(D2:D4)` and `=IF(B5<=C5, "OK", "FAIL")`.
  - About 50 spreadsheet functions: `IF`, `SUMIF`, `VLOOKUP`, `INDEX`/`MATCH`, `ROUND`… Formulas also read the worksheet's variables (`=σ`) and units (`=B2 + 5 kN`).
  - Editing works like a spreadsheet: click a cell while typing a formula to insert its reference, ⌘D fills down, rows and columns are inserted from the right-click menu, and copy and paste use tab-separated cells.
  - A named table is a matrix for the math below it (`loads[4, 4]`); other tables read its cells as `loads!B2`.
- **2D plots** (Insert ▸ Plot, ⌥⌘P): functions over a range (`M(x)` for `x` from `0 m` to `L`) and data vectors, several series on one plot, axes in the units you work in (m, kN·m), hover to read values, maximum and minimum marked on request. Plots update with the worksheet and print as vector graphics; select a function first and Insert ▸ Plot plots it over a sensible range.
- **Errors that help:** `cannot add a length (m) and a force (N)`; `x is defined further down` when a definition sits below its use; `did you mean A_net?` for a near miss and `did you mean the unit kN?` for `KN`.
- **Built-in constants** (π, e, g, c, G, h, ħ, k_B, N_A, R, …). Units are blue and constants purple; hover a name to see what it means. When a name is ambiguous (`g`: gravity or gram), position decides (`500 g` is grams, `m*g` is gravity) and a note under the editor offers the other reading.
- **Find and replace** (⌘F, ⌥⌘F) across math, text, notes, captions and area titles, with match case and whole names; Replace All is one undo step.
- Right-click a math region to **Copy Result** (`800 cm²`) or **Copy as LaTeX** for papers and Word's equation editor.
- `~` types a global definition `≡`, as in SMath. **Help ▸ Quire Help** (⇧⌘/, F1) is a one-page quick reference.
- Click a selected box again (or double-click it) to edit with the caret where you clicked. With a text box selected but not being edited, the ribbon formats the whole box.

**Layout**
- Drag to move (9 px grid, **smart guides** to other regions' edges and centres; hold ⌘ for free movement), drag handles to resize text width or images.
- Select several (Shift-click or drag a frame) and **align** left/centre/right/top/middle/bottom or **distribute** them — format bar, Arrange menu or right-click.
- Copy, cut, paste and duplicate regions (⌘C/⌘X/⌘V/⌘D); paste or drop images straight onto the page.
- When a result grows (a fraction, a matrix, an error note), what is below it moves down instead of being covered.

**Document**
- **Pages** view (⇧⌘P): paper sheets with backgrounds, headers and footers with `{page}`, `{pages}`, `{date}`, `{time}`, `{file}`, `{title}`, `{author}`, `{company}` fields, regions kept whole across page breaks. Pages stay centred and in view, with "Page 2 of 5" while you scroll. The document ends where its content ends: content that runs past a page starts the next one, and **+ New page** under the last page adds a blank one with the insertion point at its top. **Canvas** is the free, endless sheet: it shows the printable width and where pages will break (exactly as in the page view and the PDF), has a dots, grid, ruled or plain background (Settings ▸ Appearance), and offers a way back when you scroll off into empty space. Switching views keeps your place; click the zoom percentage for common sizes, Fit Page Width and Fit Whole Page.
- Auto-numbered headings, figure and table captions, and always-current **Table of Contents, List of Figures, List of Tables** (with page numbers) from the Insert menu.
- **Cross-references** (Insert ▸ Cross-Reference…, ⇧⌘R, while writing text): "see Figure 2", "Table 1", "Section 2.1" or "page 4", renumbered as the document changes; click one to go there.
- **Inspector** (⌥⌘I): region properties (result unit, decimals, notes, captions, sizes), document properties (title, authors, language, number formatting, caption labels) and page setup (paper, orientation, margins, headers/footers, first page, backgrounds).
- **File ▸ Export as PDF…** (⌘E) writes exactly the page view with selectable text; on Windows and Linux it opens the system print dialog, where you choose Save as PDF / Print to File. Images are embedded at the resolution set in Settings ▸ PDF export. **Print…** (⌘P) opens the print dialog.
- **Templates:** File ▸ New from Template… (⇧⌘N) starts from a calculation report, a beam check or a load-combination sheet, or from your own: File ▸ Save as Template… keeps page setup, headers, styles, regions and images.
- **Files:** a document is a `.quire` folder (shown as a single file in the Finder) or a `.quirez` single file, which is what Windows and Linux save and what to send by email. Both open by double-click; **File ▸ Open Recent** lists the last ten; unsaved work is kept aside and offered back if Quire quits unexpectedly.
- Every change re-evaluates the whole worksheet in Rust (well under a millisecond for typical documents). Math is drawn as MathML for now; a dedicated Rust typesetter comes later.

Run it during development:

```bash
npm --prefix app install
```

```bash
npm --prefix app run tauri dev
```

Build `Quire.app` (in `target/release/bundle/macos/`):

```bash
npm --prefix app run tauri build -- --bundles app
```

To work on the UI in a browser, run `quire serve` (the same backend over localhost) and `npm --prefix app run dev`, then open `http://localhost:5173/?open=<path to a .quire>`.

## Engine

| Crate | What it does |
|---|---|
| [quire-ast](crates/quire-ast) | Linear math syntax: lexer, parser, canonical printer |
| [quire-units](crates/quire-units) | Dimensions (rational exponents), unit table with SI prefixes, kgf/tonnef/psi/°C… |
| [quire-eval](crates/quire-eval) | Numeric kernel, built-in functions, `sum`/`int`/`diff`/`for`/`if`, worksheet semantics, spreadsheet tables, plot sampling and symbolic math (`→`) |
| [quire-doc](crates/quire-doc) | Loads `.quire` bundles |
| [quire-service](crates/quire-service) | What the app asks the engine: evaluated views of a document, rendered text, templates |
| [quire-cli](crates/quire-cli) | The `quire` command, and `quire serve` for working on the UI in a browser |

Installers for Windows (.msi/.exe), Linux (.AppImage/.deb/.rpm) and macOS (.dmg) are built by the **Release** GitHub Actions workflow: push a tag such as `v0.1.0`, or run it from the Actions tab, and it attaches them to a draft release. They aren't code-signed yet, so the first launch shows a warning:

- **macOS:** open Quire once and dismiss the "can't be verified" message, then choose **System Settings ▸ Privacy & Security ▸ Open Anyway** and confirm. Since macOS Sequoia (15), right-click ▸ Open no longer skips the check.
- **Windows:** in the SmartScreen dialog, choose **More info ▸ Run anyway**.
- **Linux:** no warning. Make the AppImage executable first (`chmod +x Quire_*.AppImage`), or install the `.deb` or `.rpm`.

From 0.1.8 on, Quire tells you when a new version is out and updates itself in one click (or choose Quire ▸ Check for Updates…). Updates are signed and checked before they install. With the `.deb` or `.rpm`, update through your package manager instead.

Build and try it (needs Rust; `rustup` installs it):

```bash
cargo build --release
```

```bash
./target/release/quire calc "2 'm + 30 'cm" --in mm
```

Other commands: `quire eval <doc>` prints the full calculation listing; `quire fmt --check <path>` verifies that every expression round-trips. Run the test suite with `cargo test`.

Convert any SMath file:

```bash
python3 -I tools/sm2quire.py "path/to/file.sm" out.quire
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md): setup, the checks to run, commit and pull-request conventions, and how releases are made.

## Licensing

- Engine crates and the file-format spec and schema: **MIT OR Apache-2.0** (`LICENSE-MIT`, `LICENSE-APACHE`).
- Desktop app (`app/`: the Tauri shell, canvas and editor): **GPL-3.0-or-later** (`app/LICENSE`).
- Engine crates never depend on GPL code, so they can be used anywhere.
