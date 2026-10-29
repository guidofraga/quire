<p align="center">
  <img src="app/app-icon.svg" width="112" height="112" alt="Quire's icon: a stack of paper sheets on a blue tile">
</p>

<h1 align="center">Quire</h1>

<p align="center">
  <b>Calculations you can read: live maths with units, on paper you can print.</b>
</p>

<p align="center">
  Write maths the way you would on paper, and Quire works out every result as you type, units
  included. For engineers writing calculation reports, and for students and teachers keeping
  course notes. It opens SMath Studio worksheets, runs on macOS, Windows and Linux, and in the browser.
</p>

<p align="center">
  <a href="https://github.com/guidofraga/quire/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/guidofraga/quire/ci.yml?branch=main&style=flat-square&label=CI"></a>
  <a href="https://github.com/guidofraga/quire/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/guidofraga/quire?style=flat-square&label=release&color=3a5f9f"></a>
  <a href="#license"><img alt="License: engine MIT or Apache-2.0, app GPL-3.0" src="https://img.shields.io/badge/license-MIT%20%2F%20Apache--2.0%20%C2%B7%20GPL--3.0-3a5f9f?style=flat-square"></a>
  <img alt="Runs on macOS, Windows, Linux and the web" src="https://img.shields.io/badge/runs%20on-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux%20%C2%B7%20Web-3a5f9f?style=flat-square">
  <img alt="Written in Rust" src="https://img.shields.io/badge/written%20in-Rust-3a5f9f?style=flat-square&logo=rust&logoColor=white">
</p>

<p align="center">
  <a href="https://guidofraga.github.io/quire/"><img alt="Try Quire in your browser" src="https://img.shields.io/badge/Try%20Quire%20in%20your%20browser-3a5f9f?style=for-the-badge" height="40"></a>
</p>

<p align="center">
  <a href="#a-tour">A tour</a> ·
  <a href="#why-quire">Why Quire</a> ·
  <a href="#what-it-does">What it does</a> ·
  <a href="#download">Download</a> ·
  <a href="#build-from-source">Build from source</a> ·
  <a href="#contributing">Contributing</a> ·
  <a href="#license">License</a>
</p>

<br>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/hero-dark.png">
    <img src="docs/images/hero.png" alt="Quire showing a calculation report for a simply supported steel beam on an A4 page: the span, modulus and section properties with their units, a table of loads whose design column is worked out by formulas, the design moment M_d = 47.587 kN·m as a typeset fraction, and the top of a plot of the bending moment. The toolbar reads 2 checks." width="100%">
  </picture>
  <br><sub><b>Simply supported beam</b>, one of Quire's templates. <a href="https://guidofraga.github.io/quire/?open=https://raw.githubusercontent.com/guidofraga/quire/main/crates/quire-service/templates/beam.json">Open it in your browser</a> and change the span.</sub>
</p>

## A tour

Every picture is a real document, photographed by the app's own test setup (`npm --prefix app run screenshots`). The links open the same document in your browser, ready to edit.

<table>
<tr>
<td width="50%" valign="top"><img src="docs/images/units.png" alt="A physics note on projectile motion: the time of flight 3.28 s, range 62.76 m and highest point 13.17 m worked out from a launch speed in m/s and an angle in degrees, the path as a function y(x), and a plot of the ball's path with its highest point marked" width="100%"><p align="center"><sub><b>Units everywhere.</b> Results come out in the units you work in, and adding a length to a force is an error that says so. <a href="https://guidofraga.github.io/quire/?open=https://raw.githubusercontent.com/guidofraga/quire/main/docs/examples/projectile.quire/document.json">Open it</a></sub></p></td>
<td width="50%" valign="top"><img src="docs/images/symbolic.png" alt="A calculus note: the derivative of x³ − 3x worked out symbolically as 3x² − 3, the stationary points −1 and 1, a definite integral, a limit and a Taylor series, and a plot of the cubic and its derivative" width="100%"><p align="center"><sub><b>Symbolic maths.</b> Derivatives, integrals, equations, limits and series with →, written as on paper. <a href="https://guidofraga.github.io/quire/?open=https://raw.githubusercontent.com/guidofraga/quire/main/docs/examples/calculus.quire/document.json">Open it</a></sub></p></td>
</tr>
<tr>
<td width="50%" valign="top"><img src="docs/images/tables.png" alt="A load combinations sheet: a table of characteristic actions in kN, and a table of partial factors whose design column and governing combination are worked out by spreadsheet formulas, read back into the maths below" width="100%"><p align="center"><sub><b>Spreadsheet tables.</b> Cells hold values with units and formulas like <code>=SUM(B2:B4)</code>, and the maths reads them back. <a href="https://guidofraga.github.io/quire/?open=https://raw.githubusercontent.com/guidofraga/quire/main/crates/quire-service/templates/combinations.json">Open it</a></sub></p></td>
<td width="50%" valign="top"><img src="docs/images/notebooks.png" alt="A notebook called Physics 101 in the sidebar, with coloured sections for Mechanics, Statics, Maths review and Lab reports; the note Projectile motion is open, and the title bar reads Mechanics › Projectile motion" width="100%"><p align="center"><sub><b>Notebooks.</b> A course's notes in sections that save themselves, as in OneNote or Obsidian. A notebook is just a folder. (Desktop app)</sub></p></td>
</tr>
</table>

## Why Quire

- **Units everywhere.** Type `12 kN/m` and `6 m`, and the moment comes out in kN·m. A wrong unit is an error, not a wrong answer.
- **Results you can trust.** Every change re-evaluates the whole document in well under a millisecond, and the test suite checks real reports against results worked out independently.
- **It reads like paper.** Fractions, roots and matrices are typeset as you type, next to text, tables and plots, on pages that print and export to PDF with bookmarks and links.
- **Your files.** Documents are readable JSON that diffs well in Git; a notebook is an ordinary folder. Nothing is locked in, and every document opens in later versions.
- **Opens SMath Studio worksheets.** `.sm` files open as Quire documents and compute the same results.
- **Share a link.** **Share** puts a whole document in a link that opens, live and editable, in anyone's browser. Nothing is uploaded: the document travels inside the link.
- **Free and open.** The engine is MIT or Apache-2.0, the app GPL-3.0.

## What it does

| Area | Highlights |
|---|---|
| **Maths** | Units without markers, functions, matrices, `sum`, `int`, `diff`, `solve` (roots, systems), ODEs (`rkfixed`), fitting and statistics, built-in constants, errors that say what is wrong |
| **Symbolic** | `→` for derivatives, integrals (substitution, by parts, partial fractions), `solve` up to degree four, limits, series, `factor`, `expand`, `simplify` |
| **Documents** | Rich text with live maths in sentences, spreadsheet tables, 2D plots, images, numbered headings and captions, cross-references, contents lists, summary of checks |
| **Pages** | A free canvas or A4/Letter pages with headers and footers, PDF export with bookmarks and links, templates |
| **Notes** | Notebooks of sections and notes, search across notes, autosave (desktop app) |
| **Sharing** | The web version, documents in links, copy and paste to Word and Google Docs as equations, LaTeX, CSV |
| **Accessibility** | The whole app works from the keyboard and with VoiceOver; maths is read as words |

Every feature in detail: [docs/features.md](docs/features.md).

## Download

Installers for Windows (`.msi`, `.exe`), macOS (`.dmg`, Apple silicon and Intel) and Linux (`.AppImage`, `.deb`, `.rpm`) are on the [latest release](https://github.com/guidofraga/quire/releases/latest). Quire then updates itself in one click (with the `.deb` or `.rpm`, through your package manager).

The installers aren't code-signed yet, so the first launch shows a warning:

- **macOS:** open Quire once and dismiss the message, then choose **System Settings ▸ Privacy & Security ▸ Open Anyway** and confirm.
- **Windows:** in the SmartScreen dialog, choose **More info ▸ Run anyway**.
- **Linux:** make the AppImage executable first (`chmod +x Quire_*.AppImage`), or install the `.deb` or `.rpm`.

Or skip the download: [Quire runs in your browser](https://guidofraga.github.io/quire/).

## Build from source

You need Rust (`rustup` installs it) and Node 22; [CONTRIBUTING.md](CONTRIBUTING.md) has the details.

```bash
npm --prefix app ci
```

```bash
npm --prefix app run tauri dev
```

The engine also works on the command line:

```bash
cargo run -q -p quire-cli -- calc "2 m + 30 cm" --in mm
```

`quire eval <doc>` prints a document's calculations, `quire check <doc>` compares them with known results, and `quire import file.sm out.quire` converts an SMath worksheet.

| Crate | What it does |
|---|---|
| [quire-ast](crates/quire-ast) | Linear maths syntax: lexer, parser, canonical printer |
| [quire-units](crates/quire-units) | Dimensions and the unit table |
| [quire-eval](crates/quire-eval) | The engine: evaluation, worksheets, spreadsheet tables, plots, symbolic maths |
| [quire-doc](crates/quire-doc) | Loading `.quire` and `.quirez` documents |
| [quire-smath](crates/quire-smath) | Importing SMath Studio worksheets |
| [quire-service](crates/quire-service) | What the app asks the engine for; templates; notebooks |
| [quire-web](crates/quire-web) | The engine as WebAssembly, for the web version |
| [quire-cli](crates/quire-cli) | The `quire` command, and `quire serve` for UI work in a browser |

How it all fits together: [docs/03-code-map.md](docs/03-code-map.md).

## Contributing

Contributions are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup, the checks to run and how pull requests work, and [docs/](docs/README.md) has the architecture, file format, guidelines, testing and releasing.

## License

- The engine crates, the file-format spec and the schema: **MIT OR Apache-2.0** ([LICENSE-MIT](LICENSE-MIT), [LICENSE-APACHE](LICENSE-APACHE)). They never depend on GPL code, so they can be used anywhere.
- The desktop app (`app/`): **GPL-3.0-or-later** ([app/LICENSE](app/LICENSE)).
