# 01 — Architecture & Engine Selection

> Working name: **Quire** (a *quire* is a gathering of paper sheets — a notebook). Placeholder; rename freely.
> Status: Phase 1 decision record. Audience: the engineers who will build it.

## 0. What we learned from the real SMath file

Before choosing anything, I dissected a real-world SMath structural calculation report (about 1 MB, 171 regions) and the examples bundled with SMath. Such a file is a typical SMath document:

| Observation | Consequence for us |
|---|---|
| 87 math regions, **all numeric + units** (`:=`, `*`, `/`, `^`, `sqrt`, `max`, `if`, `mat`, `<`). Zero symbolic calculus. | The **numeric + units hot path** is what users live in. It must be instant and rock-solid. Symbolic is important but secondary. |
| Units used: `kgf`, `tonnef`, `MPa`, `GPa`, `m`, `mm`, `cm`, and the dimensionless `1 ''` trick. | Gravitational/engineering units (kgf, tonnef) are first-class, not an afterthought. |
| Math is stored as **RPN token streams** (`L.span 5.1 m * :`). | Unreadable in diffs. We store **linear infix text** instead. |
| ~90 % of the bytes are **base64 PNGs** (page-1 letterhead background, 6 figures). | Binary assets must live **outside** the text document. |
| Headings are typed by hand (`1. ASSUMPTIONS`), captions too (`Figura 1 – …`, `Tabela 1 – …`). Footer right-alignment is done with **~200 spaces**. | Auto-numbered headings/figures/tables, cross-refs, and 3-slot (left/center/right) headers/footers. |
| A file-level `<revision>3315</revision>` counter changes on every save. | No save counters or timestamps in the source file → no noise commits. |
| Collapsible “areas” are encoded as a start marker region and a `terminator` region at another `top`. | Areas become real containers with children. |
| Text regions can hold several translations (`lang="rus"` / `lang="eng"`) and can embed math regions. | Multilingual text and inline live math are kept as features, in a cleaner form. |
| Table Region plugin binds variables to cells; formatting is ~20 attributes of border trivia. | Tables bind to expressions; styling comes from named styles. |

## 1. Platform decision: **Option B (Tauri 2 + Rust core)**, built so a native SwiftUI shell stays possible

**Recommendation: Tauri 2 + a Rust core**, but with the rendering split described in §3 (DOM for structure and text, custom Rust math layout, GPU only for plots). Not a "draw everything in one big `<canvas>`" design.

### Why not Option A (Swift/SwiftUI + Metal)
SwiftUI gives the most native feel, but:
1. **The hard parts aren't UI.** The CAS, units, evaluation graph, math typesetting and PDF export make up about 70 % of the effort. Writing them in Swift locks them to Apple. You'd end up writing them in Rust/C++ anyway and bridging, which leaves you with two stacks.
2. **Free-form canvases with hundreds of independently editable rich-text views** hit known SwiftUI pain points (identity/diffing cost, `TextEditor` limitations, focus management). In practice you drop to AppKit (`NSTextView`/TextKit 2) per region, which brings back the complexity you wanted to avoid.
3. Linux/Windows reach goes to zero.

### Why Tauri wins here
- **macOS-first is still possible.** Tauri uses the system **WKWebView** on macOS: there's no bundled Chromium, binaries are about 10–15 MB, memory use is low, Safari's text engine (IME, spellcheck, dictation, VoiceOver) works, native menus come through Tauri's menu API, native file dialogs, vibrancy via `window-vibrancy`, and document packages and UTIs come through `Info.plist`.
- **Text editing comes free.** Rich-text regions are the most labor-intensive thing to build on a raw canvas (selection, IME, bidi, spellcheck, accessibility). The DOM gives all of it to us.
- **The Rust core is UI-agnostic.** It's exposed through a narrow command API (§4). The same crates can later be wrapped with **UniFFI** for a native SwiftUI/AppKit shell, or compiled to **WASM** for a web viewer. That's the hedge if the WebView ever turns out to be the bottleneck.

### Risks and mitigations
| Risk | Mitigation |
|---|---|
| WebKitGTK on Linux is the weakest webview. | macOS-first anyway; Linux is "works", not "flagship". Keep rendering on boring, well-supported primitives (absolutely positioned DOM, Canvas2D, WebGL2). |
| WebView feels "webby". | No web-style scrollbars or hover effects. Use SF Pro / system font, native menus, native context menus (Tauri `Menu::popup`), ⌘-shortcuts registered on the native side, respect `prefers-reduced-motion` and accent color. |
| IPC overhead per keystroke. | Math editing state lives in the frontend. Only *committed* edits cross IPC, as small patches. Layout results come back as compact binary (MessagePack) glyph lists. |

## 2. Computation engine

### 2.1 Layered design (not one monolithic CAS)

```
┌───────────────────────────────────────────────────────────────┐
│ quire-eval   Reactive worksheet evaluator (dependency DAG,     │
│              document-order semantics, cancellation, caching)  │
├──────────────┬────────────────────────────┬───────────────────┤
│ quire-num    │ quire-sym                  │ quire-units        │
│ numeric      │ symbolic front: own AST    │ dimension algebra, │
│ kernel (f64, │ rewrites (simplify, diff,  │ unit DB, display-  │
│ complex,     │ substitute) + CasBackend   │ unit selection     │
│ matrices)    │ trait → SymEngine (FFI)    │                    │
│              │        → Giac / SymPy      │                    │
│              │          (out-of-process,  │                    │
│              │           optional plugin) │                    │
├──────────────┴────────────────────────────┴───────────────────┤
│ quire-ast    One expression AST shared by parser, editor,      │
│              evaluator, layout, serializer                     │
└───────────────────────────────────────────────────────────────┘
```

**a) The AST is ours (custom Rust).** Every other component speaks it: the structural editor, the linear-text serializer, the units checker, the typesetter. External CAS libraries are *backends* we translate to and from at the boundary. We never let a third-party expression type leak into the document model. That's what makes swapping or adding backends cheap.

**b) The numeric path is native Rust and needs no CAS.** Around 95 % of real worksheets (see §0) are assignments, arithmetic, `if`, matrices, built-in functions and units. That path runs as a tree-walking (later bytecode-compiled) evaluator over `Value = Scalar(f64|Complex) × Dimension | Matrix | String | Bool | Function`.
- Linear algebra: **faer** (pure Rust, MIT, very fast for dense LU/QR/SVD/eig), with `nalgebra` only for small fixed-size cases.
- Numerics library: adaptive Gauss–Kronrod integration, Brent/Newton root finding, Levenberg–Marquardt `solve`/`minerr`, RK45/BDF ODE solvers (`diffsol` crate or our own), splines/interpolation.
- Optional arbitrary precision via **dashu** (MIT/Apache). Avoid `rug`/GMP to keep licensing clean.

**c) Symbolic path: own rewrite core + pluggable heavy backend.**
- In Rust ourselves: canonicalization, basic simplification, expand/collect, differentiation, substitution, symbolic matrix ops, limits of rational functions. These are well understood, and owning them makes `→` (symbolic eval) fast and deterministic for the common cases.
- **Default heavy backend: SymEngine** (C++, MIT/BSD, very fast, used by SymPy as a core) via a thin C FFI. It covers series, polynomial factoring, rational simplification, symbolic linear algebra and number theory.
- **For symbolic integration, `solve` for transcendental systems and ODEs**, SymEngine is weak. These go through a `CasBackend` trait implemented by an **out-of-process plugin**:
  - **Giac** (the Xcas engine): the strongest integrator of the embeddable options, and fast, but **GPL-3**. Shipping it in-process forces the whole app to be GPL.
  - **SymPy in a sandboxed Python sidecar**: BSD and very capable, but slow to start (~1 s) and heavy (~40 MB with a bundled Python).
  - Running them as **separate processes over a JSON-RPC pipe** keeps licensing clean and crash isolation free. A Giac crash or a 30-second integral never freezes the UI.
- ❌ Rejected: **GiNaC** (GPL, C++, no integration either). **Symbolica** (excellent Rust CAS, but its license is source-available/commercial for non-hobby use; re-evaluate if licensing fits). **Pyodide in the WebView** (startup time and memory are too high for a lightweight app).

> ✅ **Licensing:** engine crates are MIT OR Apache-2.0; the desktop app is GPL-3.0-or-later, so a `giac` backend crate can link Giac in-process **in the app tier only**. See README.
>
> **Status (0.1.7):** symbolic math (`→`) ships as a small built-in rewrite engine in `quire-eval` (simplify, expand, `diff`, `int` for common integrands, `solve` up to degree two). SymEngine and the out-of-process backends above remain the plan for heavier work (series, harder integrals, systems).

### 2.2 Units & dimensional analysis (`quire-units`)
Generic unit crates (`uom`, `dimensioned`) check units at Rust *compile time*, which is useless for a notebook where users type units at runtime. We build our own:
- `Dimension` = 9 exponents as small **rationals** (`i8/i8`): L, M, T, I, Θ, N, J (SI) plus **angle** and **information** as opt-in pseudo-dimensions. Rationals allow `sqrt(m^2)`, `Hz^0.5` in noise densities, and so on.
- `Quantity { value: f64 (always SI-coherent), dim: Dimension }`. Every operator checks dimensions: `+`, `-`, comparisons, and `if` branches need equal dimensions; `^` needs a dimensionless exponent; `sin`/`exp`/`ln` need dimensionless (or angle) arguments. Errors point at the offending AST node, so the UI can underline it.
- **Unit database** as data (TOML) compiled into the binary: SI + prefixes, US customary, Imperial, engineering gravitational (`kgf`, `tonnef`, `lbf`, `kip`, `ksi`), pressure, energy, angle, temperature. Sources: NIST SP 811 and UCUM. (Don't copy SMath's `Units.xml`: their EULA applies.)
- **Affine units** (°C, °F) handled explicitly: as an *absolute* value they convert with an offset, as a *difference* (`Δ°C`) they don't. This is the most common correctness bug in other tools.
- **Display-unit selection** for results, in order: (1) the region's explicit display unit (SMath's "contract", e.g. `F = 1800 kgf`); (2) the document's preferred-unit system for that dimension (e.g. "stress → MPa, force → kN"); (3) a heuristic that picks the derived SI unit with the fewest symbols (`kg·m·s⁻²` → `N`).
- Custom units per document: `units: { tf: "1000 kgf" }` (see the file schema).

### 2.3 Evaluation model (`quire-eval`)
Keeps SMath/Mathcad semantics users know, with a modern implementation:
- **Document order** is reading order: regions sort by `(y, x)` within flow. A definition is visible to regions *after* it. **Global definitions** (`≡`) are visible everywhere and evaluated first.
- **Incremental and reactive:** each math region compiles to (defines, uses). The evaluator keeps a DAG. An edit invalidates only downstream regions. Results stream back to the UI as they finish, so the first screen updates in milliseconds even if region #400 runs a slow ODE.
- Runs on a **worker thread pool** with **cooperative cancellation** (generation counter checked inside loops and solvers). Typing never waits for compute.
- Redefinition is allowed (SMath style) but shown with a subtle marker. Use-before-define gets a clear error with a jump-to-definition.
- Every result is cached by a hash of (expression AST, input values), so reopening a document and scrolling cost nothing.

## 3. Rendering engine

### 3.1 Decision: **hybrid retained scene = DOM structure + Rust math typesetting + GPU only where it pays**

| Layer | Technology | Why |
|---|---|---|
| Page/canvas container, region frames, selection, drag, snapping | **Absolutely positioned DOM nodes** inside one transformed container (`transform: translate/scale` for pan/zoom), driven by **SolidJS** (fine-grained reactivity, no virtual-DOM diffing of hundreds of nodes). | Hundreds of nodes is *small* for the DOM if we avoid layout thrash: regions have fixed boxes from the model (`contain: strict`), and pan/zoom is a compositor-only transform. |
| Rich text regions | **ProseMirror** (per region, mounted lazily on focus; static HTML when not focused). | Mature: IME, spellcheck, undo, collaboration-ready schema. |
| **Math regions** | **Our own TeX-style box layout in Rust** (`quire-layout`), using OpenType **MATH** tables (STIX Two Math default, Latin Modern Math / New Computer Modern Math optional) shaped with `rustybuzz`. Output: a positioned glyph-and-rule list, drawn in the frontend as an **SVG** per region (crisp at any zoom, real text selection for copy). | MathML Core differs between WebKit, Blink and WebKitGTK, and doesn't give us caret geometry for a structural editor. Owning layout gives **identical rendering on every OS, in PDF export, and in the editor**, plus exact caret/selection hit-testing. |
| 2D plots | **Canvas2D**, with **uPlot**-style decimation for large series; SVG for export. | Fast and simple; vector export for reports. |
| 3D plots | **WebGL2** (raw or via `regl`): surfaces, wireframes, parametric curves, with orbit controls. | Hardware accelerated on WKWebView/Metal. Doesn't need WebGPU, whose cross-webview support is still uneven. |
| PDF/print | Rendered **in Rust** from the same layout tree (`krilla` crate: PDF/A, font subsetting). | What you print is exactly what you see. No dependence on WebView print quirks. |

### 3.2 Staying smooth with hundreds (and thousands) of regions on Retina
1. **Viewport virtualization:** only regions that intersect the viewport plus one screen of margin get mounted. The rest exist only as model data with known boxes. A spatial index (an R-tree, `rstar` in Rust and mirrored in TS) answers hit tests and visibility.
2. **Layout is cached in the model.** Each region's measured box is stored. Re-layout happens only when its content or style changes, never on scroll.
3. **Pan/zoom = a single CSS transform** on the scene root (compositor thread, 120 Hz ProMotion). During a pinch, math SVGs scale as vectors. After the gesture ends, nothing needs re-rasterizing because they're SVG.
4. **Canvas DPR handling:** plot canvases size their backing store to `devicePixelRatio × zoom` (clamped) and redraw on a debounced zoom-end.
5. **Pages** (in page view) are separate DOM layers, so a 60-page report is 60 cheap containers, and only visible pages hold children.
6. **Budget:** under 4 ms main-thread work per frame during pan/zoom; under 16 ms from keystroke to math re-layout; evaluation is asynchronous and never on the input path.

### 3.3 The math editor
A **structural (template) editor**, like SMath/Mathcad. The AST *is* the editing model, not a text box that's reparsed:
- Typing `/` wraps the left operand into a fraction, `^` opens a superscript, `.` after an identifier starts a literal subscript (SMath's `A.net`), `[` an index, `Ctrl+M` a matrix template, `Ctrl+=`/`:` gives `:=`, `'` starts a unit.
- Each AST node has a stable ID. The layout output maps glyph boxes to node IDs and child slots. That's how caret movement, selection, and red-squiggle error placement work.
- Paste accepts linear text (`(a+b)/2 'm`), LaTeX, MathML, and SMath/Mathcad clipboard XML where feasible.

## 4. Process & crate layout

```
quire/
├─ crates/              (✅ = exists after P1)
│  ├─ quire-ast     ✅ AST, linear-syntax parser/printer (round-trip tested)
│  ├─ quire-units   ✅ dimensions, built-in unit table + prefixes, custom units
│  ├─ quire-eval    ✅ numeric kernel, built-in functions, worksheet evaluator
│  │                   (split out quire-num once the library grows; DAG/caching in P2)
│  ├─ quire-sym        rewrite engine + CasBackend trait (+ symengine-sys)
│  ├─ quire-layout     math typesetting (OpenType MATH), text measurement
│  ├─ quire-doc     ✅ document model, .quire loading (save + migrations next)
│  ├─ quire-export     PDF (krilla), HTML, LaTeX, Markdown
│  └─ quire-cli     ✅ headless: `quire eval | check | fmt --check | calc`
├─ app/                Tauri 2 shell (Rust side: commands, menus, file assoc.)
│  └─ ui/              SolidJS + TypeScript frontend
├─ plugins/            out-of-process CAS backends (giac-worker, sympy-worker)
└─ docs/               ← you are here
```

**Frontend ↔ core contract** (Tauri commands and events, MessagePack payloads):
- `doc.apply(patch[])` → `{ rev, invalidated: RegionId[] }`. Patches are small model operations (move, set expression, set text). They also drive undo/redo and, later, CRDT collaboration.
- `layout.math(regionId)` → glyph list plus slot map.
- event `eval.result { regionId, rev, value | error, displayed }`, streamed.
- `export.pdf(opts)` / `import.sm(path)`.

The **`quire-cli`** is a first-class deliverable: it lets CI pipelines re-run engineering calcs on every commit, fail the build if a check reads `FALHA`, and attach the PDF. SMath can't do any of this, and it's a big part of why the file format should be Git-friendly in the first place.

## 5. Phased roadmap (after this design phase)

| Phase | Deliverable | Exit criterion |
|---|---|---|
| **P1 Core** ✅ | `quire-ast` + `quire-units` + `quire-eval` (numeric kernel included) + `quire-doc` + `quire-cli` + SMath importer | **Met:** `quire check` reproduces all 44 SMath results of a real-world report exactly; 689/689 corpus expressions round-trip |
| **P2 Canvas MVP** ✅ | Tauri shell, free-form canvas, math editor, text regions, images, live evaluation | **Met:** a real report opens, renders, edits, re-evaluates and saves byte-identically. Interim choices: linear-text math input with live 2D preview, MathML rendering (Rust typesetter and structural editor still to come) |
| **P3 Document** ✅ | Page view, headers/footers, auto numbering, captions, cross-refs, tables, PDF export | **Met:** a real report exports to a 7-page A4 PDF with its cover form, live header/footer fields and keep-together pagination. Interim choice: PDF comes from WebKit's print engine rendering the page view (vector text, selectable), not yet from the Rust typesetter + krilla. Cross-references followed in 0.1.7. On macOS the app then finishes the file with lopdf (`app/src-tauri/src/pdf.rs`): the front end sends what only the page view knows (document details, each heading's page and position, where every link target and contents-list row landed), and the PDF gets its info dictionary and language, nested bookmarks, page labels, and internal links in place of WebKit's links back into the app; photos are re-encoded as JPEG in the same pass. Windows and Linux print through the system dialog and get none of this yet |
| **P3.5 Editor polish** ✅ | Units without markers, implicit multiplication, word→text typing, rich text (ProseMirror ↔ Djot), format bar, inspector, align/distribute, smart guides, resize, contents lists, clipboard and images | Verified end to end in the browser and through PDF export |
| **P3.6 Writing math** ✅ | Ribbon v2 (Text / Paragraph / Equation / Arrange), structures and symbols galleries, LaTeX shortcuts with completion, built-in constants, positional unit/constant/variable resolution with hover glossary and disambiguation notes, click-to-edit at the pointer | Verified in the browser, through PDF export and 44/44 SMath results unchanged |
| **P4 Visualization & data** (in progress) | 2D/3D plots, CSV/JSON/clipboard import/export, data regions | 2D plots done (0.1.7): functions and data, units on the axes, editing on the page, vector PDF. CSV import/export for tables. Still to do: 3D plots, JSON and other file formats, data regions |
| **P4.5 Numeric tools** ✅ | ODEs, nonlinear systems, regression, splines, statistics | `rkfixed`/`Rkadapt`, `solve` with a vector of unknowns, `slope`/`intercept`/`line`/`corr`/`polyfit`/`linfit`, `cspline`/`pspline`/`lspline` + `interp`, `median`/`var`/`stdev`/`percentile`, `Ceil`/`Floor`/`Round`/`Trunc` to a multiple, all unit-aware; checked against `numeric-tools.quire`, worked out with numpy/scipy |
| **P5 Symbolic** (started) | `→`, diff/int/solve/series via SymEngine and the CAS plugin | `→` with simplify, expand, diff, int and solve (degree ≤ 2) built in (0.1.7). Still to do: series, harder integrals, SymEngine/CAS backends |
| **P6 Ecosystem** | Plugin API (WASM-sandboxed functions/units), web viewer (core → WASM) | — |
