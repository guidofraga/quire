# Contributing to Quire

Thanks for helping. This page covers how the project is laid out, how to build and test it, and what a good change looks like. If something here is unclear or out of date, fixing this page is a welcome first contribution.

## Where things are

| Path | What it is |
|---|---|
| `crates/quire-ast` | Linear math syntax: lexer, parser, canonical printer |
| `crates/quire-units` | Dimensions and the unit table |
| `crates/quire-eval` | The engine: evaluation, worksheets, spreadsheet tables, plots, symbolic math |
| `crates/quire-doc` | Loading `.quire` bundles |
| `crates/quire-service` | What the app asks the engine for; built-in templates |
| `crates/quire-cli` | The `quire` command, and `quire serve` for UI work in a browser |
| `app/` | The desktop app: SolidJS front end in `app/src`, Tauri shell in `app/src-tauri` |
| `docs/` | Architecture and the file format |
| `schema/` | JSON Schema for `document.json` |
| `tools/` | The SMath importer and the math-font build script |

## Getting set up

You need Rust (1.90 or newer, edition 2024) and Node 22. For the desktop app, also the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your system.

```bash
npm --prefix app ci
```

Day to day:

| To | Run |
|---|---|
| Test the engine | `cargo test --workspace --exclude quire-app` |
| Test the UI's logic | `npm --prefix app test` (Vitest; `run test:watch` while you work) |
| Try the UI end to end | `npm --prefix app run e2e` (Playwright in WebKit; starts `quire serve` and the dev server, or reuses running ones; once: `npx --prefix app playwright install webkit`) |
| Check PDF export end to end (macOS) | `npm --prefix app run build`, then `cargo test -p quire-app --features tauri/custom-protocol -- --ignored`: exports `app/src-tauri/tests/fixtures/report.quire` headlessly and checks the PDF's details, bookmarks and links. Not run in CI, which has no macOS desktop; run it when you change printing or `pdf.rs` |
| Work on the UI in a browser | `cargo run -p quire-cli -- serve` in one terminal, `npm --prefix app run dev` in another, then open http://localhost:5173 |
| Run the desktop app while developing | `npm --prefix app run tauri dev` |
| Build `Quire.app` / the installers | `npm --prefix app run tauri build` (add `-- --bundles app` for just the macOS app) |
| Try one expression | `cargo run -q -p quire-cli -- calc "2 m + 30 cm" --in mm` |

A local release build signs update packages and so needs the updater's private key. Without it, add `--config '{"bundle":{"createUpdaterArtifacts":false}}'` to the build command.

## Before you open a pull request

CI runs these on every push; run them first:

```bash
cargo fmt --all --check
cargo clippy --workspace --exclude quire-app --all-targets -- -D warnings
cargo test --workspace --exclude quire-app
cd app && npx tsc --noEmit && npm test && npm run e2e
```

And:

- **Engine changes come with tests**, next to the code they test (`#[cfg(test)] mod tests`). A test that shows what a user typed and what they should see is the most useful kind.
- **UI logic comes with tests** too: a `*.test.ts` next to the module (`src/pages.test.ts`). Behaviour a user sees end to end belongs in `app/e2e/smoke.spec.ts`.
- **UI changes are also tried by hand**, in the browser setup above or the desktop app. Say in the pull request what you tried, and add a screenshot when something looks different.
- **File-format changes** update `docs/02-file-format.md` and `schema/quire-1.schema.json` in the same change. Documents written by earlier versions must keep opening unchanged.
- **Results must not change by accident.** If a change alters what an existing worksheet shows, say so and why. `cargo test` checks the worksheets in `crates/quire-cli/tests/fixtures` against results worked out independently; set `QUIRE_CORPUS` to more `.quire` bundles (or folders of them) with a `results.json` to check those too, e.g. SMath reports you can't share.

## Writing code

- Match the code around you: naming, comment density, file layout. Comments explain *why*, not what the next line does.
- Rust is formatted by `rustfmt` (`rustfmt.toml`); TypeScript uses two-space indentation and the existing style. There is no Prettier step; don't reformat files you aren't otherwise changing.
- Keep the engine free of UI concerns, and the app free of maths: the app asks `quire-service`, which asks the engine.
- Add a dependency only when it earns its place. **Engine crates may only depend on code compatible with MIT/Apache-2.0**: never on GPL code. The app may use GPL-compatible code.
- Words the user sees are plain and specific: "cannot add a length (m) and a force (N)", not "dimension mismatch".

## Commits

- One change per commit: a fix, a feature or a refactor, not all three.
- The subject line says what the commit does, as a command, in 72 characters or fewer, with no full stop: `Print spreadsheet tables in PDFs`.
- Add a body when the reason isn't obvious from the diff: what was wrong, why this fixes it, what else it affects.
- Don't add generated footers or tool trailers.

## Branches and pull requests

- Branch from `main` with a short descriptive name (`fix/table-print`, `plot-zoom`) and keep the branch focused on one thing.
- Rebase on `main` rather than merging `main` into your branch.
- The pull request says what changed, why, and how you tested it. Link the issue it closes.
- CI must be green before merging. Changes to `main` go through pull requests.

## Reporting bugs and ideas

Open an issue with:

- what you did, what you expected and what happened instead;
- the Quire version (*Quire ▸ About Quire*) and your system;
- if a document is involved, the smallest `.quire` file that shows the problem.

**Don't attach confidential documents** (client calculations, reports) to issues or pull requests: they are public. Cut the document down to the part that shows the problem, with made-up numbers.

## Licensing of contributions

- The engine crates, the file-format spec and the schema are **MIT OR Apache-2.0**.
- The desktop app (`app/`) is **GPL-3.0-or-later**.

By contributing, you agree that your contribution is licensed under the terms of the part of the project it changes, and confirm that you have the right to contribute it. Don't copy code, unit tables or documents from other programs (SMath Studio included) unless their license allows it.

## Releases (maintainers)

1. Bump the version in `Cargo.toml`, `app/package.json` and `app/src-tauri/tauri.conf.json`, then refresh the lockfiles (`npm --prefix app install --package-lock-only` and `cargo check`).
2. Commit as `Version X.Y.Z`, tag `vX.Y.Z` and push the branch and the tag.
3. The **Release** workflow builds the installers and signed update packages into a draft release.
4. Write the notes (What's new, Improvements, Fixes, Downloads, first-launch steps) and publish the draft. Publishing is what makes the in-app updater offer the new version.

The updater's private key lives with the maintainer (`~/.tauri/quire.key`, password in the Keychain) and in the repository's secrets. Never commit it. Back it up: without it, installed copies can't receive updates.

## Be kind

Assume good intent, keep discussions about the work, and help newcomers find their way. Harassment or personal attacks aren't welcome here.
