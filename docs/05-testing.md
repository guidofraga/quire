# 05 — Testing

What is tested where, how to run it, and what a good test looks like. CI (`.github/workflows/ci.yml`) runs everything here except the PDF export test on every push and pull request.

## 1. The layers

| Layer | Where | Run | Tests what |
|---|---|---|---|
| Engine unit tests | `#[cfg(test)] mod tests` next to the code; `quire-eval/src/symbolic/tests.rs` | `cargo test --workspace --exclude quire-app` | Parsing, units, evaluation, tables, symbolic math, notebooks, file I/O |
| Worksheet fixtures | `crates/quire-cli/tests/fixtures/*.quire` with `results.json`, checked by `tests/check.rs` | the same `cargo test` | Whole documents against results worked out independently |
| UI logic | `app/src/*.test.ts` (Vitest, jsdom) | `npm --prefix app test` (`run test:watch` while you work) | Store and undo, clipboard, CSV, LaTeX, speech, pages, notebook paths |
| End to end | `app/e2e/*.spec.ts` (Playwright, WebKit) | `npm --prefix app run e2e` | The UI against `quire serve`, typed as a user would; `web.spec.ts` runs the web version with its WebAssembly engine (project `web`) |
| Accessibility | `app/e2e/a11y.spec.ts`, plus axe in `notebook.spec.ts` | part of `e2e` | axe in light and dark; keyboard flows |
| PDF export | `app/src-tauri/tests/` (macOS, by hand) | `npm --prefix app run build`, then `cargo test -p quire-app --features tauri/custom-protocol -- --ignored` | Exports `fixtures/report.quire` headlessly and checks the PDF's details, bookmarks and links; also shows the app and its menu start |

Run the PDF test when you change printing, `export.ts`, `print.rs` or `pdf.rs`; CI has no macOS desktop.

## 2. Writing tests

- **Say what a user typed and what they should see.** `M := q*L^2/8 =` with `q := 12 kN/m` and `L := 6 m` shows `54 kN·m`: that test documents behaviour and catches regressions in parsing, units and display at once.
- **Test with units.** Most engine bugs hide in dimensions: a fit of kN against m, an ODE with t in seconds.
- **For symbolic results, check by numbers too.** `symbolic/tests.rs` puts values into both sides, and differentiates what `int` gives, so a correct but differently written answer still passes.
- **One behaviour per test**, named as a sentence: `moves_between_sections_but_not_into_themselves`, `"search finds a note by its content, ignoring accents"`.
- **A bug fix starts with a failing test.**
- Tests that touch the disk work in a fresh temporary folder and check what lands there, not only what the screen shows (`notebook.spec.ts`).

## 3. End-to-end tests

`npm run e2e` starts `quire serve` and the Vite dev server (or reuses ones already running), then drives WebKit, the engine of the macOS app. Once per machine: `npx --prefix app playwright install webkit`.

- `QUIRE_UI_PORT` and `QUIRE_API_PORT` move both servers, so several checkouts can run side by side. The web version runs on `QUIRE_WEB_PORT` (the UI port + 1), and needs the WebAssembly target once: `rustup target add wasm32-unknown-unknown`.
- `--project web` runs only the web version's tests; `--project webkit` only the desktop UI's.
- `npx playwright test e2e/notebook.spec.ts -g "keyboard"` runs one test; `--headed` or `--debug` shows the browser.
- On failure, traces are kept in `app/test-results/` (CI uploads them as `playwright-traces`); open one with `npx playwright show-trace <zip>`.
- Find elements the way a user would: by role and name (`getByRole("button", { name: "New section" })`), not by CSS class. A selector that can't be written by role is often an accessibility bug.
- Wait for state, never for time: `await expect(...).toBeVisible()`, `expect.poll(() => existsSync(...))`. A fixed `waitForTimeout` is a last resort with a comment saying why.
- The test browser reports itself as a Mac, so shortcuts are written with `ControlOrMeta` or `Meta`, wherever the tests run (CI is Linux).

### Flaky tests

A test that fails sometimes is a bug, in the test or in the app. Reproduce it with `--repeat-each 20` before changing anything. Known causes so far:

- typing before a field has focus (wait for `toBeFocused()` first, as the `name()` helper in `notebook.spec.ts` does);
- measuring colours mid-animation (the axe tests emulate `reducedMotion: "reduce"`);
- CI's Linux WebKit reporting text colours mid-update right after a document opens (the `audit()` helper in `e2e/axe.ts` re-measures before failing, so only problems that persist fail).

## 4. Results that must not change

`crates/quire-cli/tests/check.rs` evaluates each bundle in `tests/fixtures` and compares every result with its `results.json`, whose values were worked out by hand or in another program. When a change alters what an existing worksheet shows, the test fails; if the new result is right, say so and why in the commit, and update `results.json`.

Documents you can't share (client reports, SMath files) can be checked locally:

```bash
QUIRE_CORPUS="../private/reports:../private/one.quire" cargo test -p quire-cli --test check
```

`QUIRE_CORPUS` takes `.quire` bundles or folders of them, separated by `:`, each with a `results.json`. `quire check <doc>` compares a single document and prints the differences. An SMath file converted with `tools/sm2quire.py` carries SMath's own cached results, so it can be checked the same way (`QUIRE_SMATH_REFERENCE`, see `tests/reference_results.rs`).

## 5. Before you push

```bash
cargo fmt --all --check
cargo clippy --workspace --exclude quire-app --all-targets -- -D warnings
cargo test --workspace --exclude quire-app
cd app && npx tsc --noEmit && npm test && npm run e2e
```

And try UI changes by hand, in the browser setup or `npm --prefix app run tauri dev`, in light and dark and in a narrow window.
