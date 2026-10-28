// Help ▸ Quire Help: a one-page quick reference.
import { createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { isMac } from "./api";

export const [helpOpen, setHelpOpen] = createSignal(false);

const mod = isMac ? "⌘" : "Ctrl+";
const shift = isMac ? "⇧" : "Shift+";
const alt = isMac ? "⌥" : "Alt+";

type Row = [string, string];

const WRITING: Row[] = [
  ["Click anywhere and type", "starts a math region at the red cross"],
  ["A word and a space", "turns it into text (The span…)"],
  ["\"", "starts a text region straight away"],
  [`$t = $ or ${shift}${mod}M in text`, "live math inside a sentence, with its result"],
  ["Return", "ends the region; the next one goes below"],
  ["Tab / ⇧Tab", "moves between the ? slots of a template"],
  ["Ctrl+G", "turns the letter before the caret into Greek (a → α)"],
  ["\\alpha, \\sqrt, \\int…", "LaTeX names convert on space"],
];

const SYNTAX: Row[] = [
  ["L : 6 m", "definition, shown as L ≔ 6 m (: types :=)"],
  ["g ~ 9.81 m/s^2", "global definition, shown as ≡ and visible everywhere"],
  ["M =", "shows the result"],
  ["M = kN*m", "shows it in that unit; typing = lists the units that fit"],
  ["click a result's unit", "pick another unit, or Automatic"],
  ["A_net, L.span", "subscripts in names"],
  ["f(x) := x^2", "function; f(5) = gives 25"],
  ["[1, 2; 3, 4]", "matrix (; starts a row); v[2], M[1, 2] index"],
  ["1..10, range(0, 1, 0.1)", "ranges"],
  ["a == b, a <= b", "comparisons (1 is true, 0 false)"],
  ["if(σ <= f, \"OK\", \"NO\")", "a choice"],
];

const UNITS: Row[] = [
  ["2 m + 30 cm", "units need no marker; your own variables win"],
  ["500 g, m*g", "g is grams after a number, gravity elsewhere"],
  ["kN, MPa, kgf, tonnef, psi, ksi, ft, in, °C", "SI with prefixes, technical and US units"],
  ["Inspector ▸ Results", "units as written (54 kN·m) or plain SI (54000 J)"],
];

const FUNCTIONS: Row[] = [
  ["sqrt, root(x, n), exp, ln, log, abs, sign", "basics"],
  ["sin, cos, tan, asin…, sinh…, atan2", "trigonometry (30 deg works)"],
  ["round(x, n), floor, ceil, trunc, mod, min, max", "rounding and limits"],
  ["sum(e, i, 1, n), prod(…), int(f, x, a, b), diff(f, x)", "calculus"],
  ["solve(k*x == F, x, a, b), solve(e, x)", "a root in a range, or near x"],
  ["lsolve(A, b), linterp(xs, ys, x)", "linear systems, table interpolation"],
  ["det, inverse, transpose, identity, rows, cols", "matrices"],
  ["mean, sort, norm, dot, cross, length, stack, augment", "vectors"],
];

const TABLES: Row[] = [
  ["12 kN, 1,5, 15%, Dead", "values with units, decimal commas, percentages, text"],
  ["=B2*C2, =SUM(D2:D4)", "formulas: A1 references and ranges"],
  ["=IF(B5<=C5, \"OK\", \"FAIL\")", "= and <> compare, & joins text"],
  ["SUMIF, COUNTIF, VLOOKUP, INDEX, MATCH", "and ROUND, MIN, MAX, AVERAGE, AND, OR…"],
  ["=σ, =B2 + 5 kN", "variables above and units work in formulas"],
  ["Inspector ▸ Name: loads", "math below uses loads[4, 4]; tables use loads!B2"],
];

const KEYS: Row[] = [
  [`${mod}K`, "command palette: commands, variables, symbols"],
  ["Tab / ⇧Tab", "next / previous region (editing: once the ? slots are filled)"],
  [`${alt}Arrows`, "select the nearest region that way; Enter edits, Esc leaves"],
  [`${mod}click a name`, "go to its definition; the caret on a name highlights its uses"],
  [`${mod}F / ${alt}${mod}F`, "find / find and replace"],
  [isMac ? "⌘G / ⇧⌘G" : "F3 / Shift+F3", "next / previous match"],
  [`${mod}'`, "next error"],
  [`${mod}D`, "duplicate; in a table, fill down"],
  [`${alt}${mod}T`, "insert a table; paste cells from a spreadsheet"],
  [`${alt}${mod}P`, "insert a plot; with a function selected, plots it"],
  [`${shift}${mod}R in text`, "cross-reference to a heading, figure or table; renumbers itself"],
  ["Enter / F2, Esc", "edit a table cell / leave the table"],
  [`${shift}${mod}N`, "new from template"],
  [`${shift}${mod}M / ${shift}${mod}T`, "insert math / text"],
  [`${shift}${mod}P`, "pages ⇄ canvas"],
  [`${alt}${mod}I`, "inspector"],
  [`${mod}E`, "export as PDF"],
  ["Arrows, ⇧Arrows", "move the selection or the red cross"],
  ["Space + drag", "pan; pinch or " + `${mod}scroll to zoom`],
  [`Hold ${mod} while dragging`, "move freely, without guides"],
];

function Table(props: { rows: Row[]; code?: boolean }) {
  return (
    <table class="help-table">
      <tbody>
        <For each={props.rows}>
          {([k, v]) => (
            <tr>
              <td>{props.code ? <code>{k}</code> : <kbd>{k}</kbd>}</td>
              <td>{v}</td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  );
}

function Part(props: { title: string; children: JSX.Element }) {
  return (
    <section class="help-part">
      <h3>{props.title}</h3>
      {props.children}
    </section>
  );
}

export function HelpDialog() {
  return (
    <Show when={helpOpen()}>
      <Dialog />
    </Show>
  );
}

function Dialog() {
  const close = () => setHelpOpen(false);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    }
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));
  return (
    <div class="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="settings help" role="dialog" aria-label="Quire Help">
        <header>
          <h2>Quick reference</h2>
          <button class="settings-close" onClick={close} aria-label="Close">
            ✕
          </button>
        </header>
        <div class="settings-body help-body">
          <Part title="Writing">
            <Table rows={WRITING} />
          </Part>
          <Part title="Math">
            <Table rows={SYNTAX} code />
          </Part>
          <Part title="Units">
            <Table rows={UNITS} code />
          </Part>
          <Part title="Functions">
            <Table rows={FUNCTIONS} code />
          </Part>
          <Part title="Tables">
            <Table rows={TABLES} code />
          </Part>
          <Part title="Keyboard">
            <Table rows={KEYS} />
          </Part>
        </div>
      </div>
    </div>
  );
}
