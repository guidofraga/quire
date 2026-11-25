# 07 — Editing math in 2D

What every key does when a formula is edited in place, typeset (#165): the rules, why each one, and what must always hold. Read it before changing the structural editor. It is a spec in the sense of [02 — File format](02-file-format.md): the tables below are run as tests (`app/src/mathTree.test.ts` reads this page), so a change to a rule changes this page in the same commit.

**Where things are.** The model is pure TypeScript with no DOM: `app/src/mathTree.ts` (the tree, the caret, every key) and `app/src/mathLinear.ts` (a tree back to Quire's linear syntax, by a port of the engine's parser and printer). Phase 1 of #165 is this model and its tests; the editor on the page (caret, hit-testing, wiring into `MathEditor`) is phase 2. Storage does not change: a region's `expr` is still linear text (`"M := q*L^2/8"`).

**Why a page of its own, numbered 07.** It describes behaviour a contributor must keep, across two phases and two files, the way 02 describes the file format; it is too long to be a section of 01 (architecture) or 03 (code map), which link here. 05 is taken by testing.

## The rule behind every key

**Typing the linear text of a formula builds the formula the engine reads from that text.** `q*L^2/8` typed here is the fraction (q·L²)/8, exactly as when it is typed in the linear box today; `x^2+1` is x² + 1; `a/b+c` is a/b + c. An engineer typing fast, from habit or from a formula on paper, never gets a different formula than the text says, and pasting text gives what typing it would. This is what Word's equation editor does (linear format, built up as you type), and it is what the round-trip tests check on every formula in the repository (§ Tests).

**Where the caret was put by hand, what you type goes where the caret is.** A slot opened by typing (`/`, `^`, `.`, `'`, `#`) or entered by Backspace or Delete is *open*: an operator it can't hold, typed at its end, leaves it, as the text would. Once the caret is moved by hand (arrows, Home/End, Tab, a click), no slot is open any more: click after the 8 in a denominator, type `+1`, and it goes in the denominator, because that is where the caret visibly is. Desmos, MathQuill and Mathcad keep the caret in a denominator until → (so `a/b+c` there is a/(b+c)); for a user coming from the linear box that silently changes the meaning of what they type, which is the one thing a calculation tool must not do.

**Consequences, in one line each.**

- `/` takes what a linear `/` would divide: the whole product before the caret (`q*L^2/` → (q·L²)/□), its sign included (`-a/` → (−a)/□), the group after `)`, a selection, or nothing (□/□).
- An exponent is left by any operator it can't hold (`+ - * / , = )`…), by Space, or by →; it keeps `^` (to the right), `!`, digits, a name, `(`, `[`. The same for a denominator, which also keeps a unit after a number (`a/2 m`). Fractions and exponents follow one rule: the text's.
- A subscript (`A.net`), a quoted unit (`'kN`) and a constant (`#G`) hold only a name's characters: anything else ends them.
- Every other structure (brackets, radicals, matrices, indices, sums) is left with its closer (`)` or `]`) or →.
- Backspace deletes the last thing drawn before the caret; at the start of a slot it takes the structure apart (`a/|b` → `a|b`). Delete is its mirror.
- Brackets are the #173 pairs: `(` types a faint `)`, typing `)` over it steps past, an empty pair goes together, Backspace after `)` turns it faint again.
- Brackets that fill a slot the view draws without them (a numerator, denominator, exponent, radicand) become the slot's own when the slot is left by typing; until then they are drawn, because what follows `)` may still apply to them (`sqrt((1 - a)/2)`, `/(2 n)!`, `/(m)^3`).

## How to read the tables

- **Keys:** characters as typed; `␣` is Space; `{←}` `{→}` `{↑}` `{↓}` arrows, `{⇧←}` with Shift, `{⌫}` Backspace, `{⌦}` Delete, `{Home}` `{End}` `{Tab}` `{Ctrl+.}` `{Ctrl+G}`. A row starts from an empty formula, or from `⟦text⟧`: that formula opened, the caret put at its end by hand.
- **Tree:** `\frac{num}{den}`, `x^{exp}`, `A_{sub}` (literal subscript), `M_[i]` (index), `(…)` brackets and `(…⦆` brackets whose `)` is faint, `\mat{a, b; c, d}`, `\sqrt{x}`, `\root{index}{x}`, `|x|`, `\int{…}` and `\sum{…}` with their slots in the order → walks them, `'{kN}` a quoted unit, `#{G}` a constant, `"…"` a string, `\{name}` a `\` shortcut being typed. `·` is `*`, `≔` is `:=`, `=` in a tree is `==`, `␣` a gap between two names. `□` is an empty slot, `‸` the caret, `«…»` the selection, then ` = unit` or ` →` when the result is shown. `⟶ leave up` means the key would move out of the formula that way (phase 2 decides where).
- **Text:** what the editor sends on (`setLive`), as `MathEditor` holds it today: canonical linear syntax, `?` for an empty slot.

## `/` — fractions

| Keys | Tree | Text | Why |
|---|---|---|---|
| `a+b/` | `a+\frac{b}{‸}` | `a + b/?` | The numerator is what a linear `/` divides: `+` binds looser, so only `b`. |
| `a+b/2` | `a+\frac{b}{2‸}` | `a + b/2` |  |
| `q*L^2/` | `\frac{q·L^{2}}{‸}` | `q*L^2/?` | Linear `q*L^2/8` is (q·L²)/8: the whole product goes on top, as the engine reads it. |
| `q*L^2/8` | `\frac{q·L^{2}}{8‸}` | `q*L^2/8` | Typed as in the linear box, drawn as the stored formula will be drawn. |
| `-a/` | `\frac{-a}{‸}` | `-a/?` | Linear `-a/b` is (−a)/b, and the view draws −a on top: the sign goes with it. |
| `x*-a/` | `\frac{x·-a}{‸}` | `x*-a/?` | A sign after `*` is part of the product. |
| `2␣m/` | `\frac{2m}{‸}` | `2 m/?` | A quantity is one value (`2 m/s` is (2 m)/s). |
| `12␣kN/m` | `\frac{12kN}{m‸}` | `12 kN/m` | `/` after a unit is still a fraction of the quantity; Settings ▸ flat units may draw it `12 kN/m` on one line, a drawing choice, not a structure. |
| `sin(x)/` | `\frac{sin(x)}{‸}` | `sin(x)/?` | A call is one value. |
| `x!/` | `\frac{x!}{‸}` | `x!/?` | So is a factorial. |
| `(a+b)/` | `\frac{a+b}{‸}` | `(a + b)/?` | After `)`, the group (and anything multiplied before it) goes on top; brackets around the whole numerator are the fraction bar's, so they are not drawn. |
| `(a+b)/2` | `\frac{a+b}{2‸}` | `(a + b)/2` | The text keeps the brackets the precedence needs. |
| `(a*b)/2` | `\frac{a·b}{2‸}` | `(a*b)/2` | Brackets that weren't needed are remembered (`kept`), so the text stays as typed. |
| `q*(L-x)/2` | `\frac{q·(L-x)}{2‸}` | `q*(L - x)/2` | The brackets are part of a product: they stay. |
| `a/b/` | `\frac{\frac{a}{b}}{‸}` | `a/b/?` | Linear `a/b/c` is (a/b)/c: `/` closes the denominator and takes the fraction. |
| `/` | `\frac{‸}{□}` | `?/?` | Nothing to divide: an empty fraction, caret on top. |
| `a+/` | `a+\frac{‸}{□}` | `a + ?/?` |  |
| `a+b{⇧←}{⇧←}{⇧←}/` | `\frac{a+b}{‸}` | `(a + b)/?` | `/` makes it the numerator, |
| `ab{←}/` | `\frac{a}{‸b}` | `a/b` | In the middle of a value, the value after the caret is the denominator: the exact inverse of Backspace at the start of a denominator. |
| `a/b+c` | `\frac{a}{b}+c‸` | `a/b + c` | `+` typed at the end of a denominator opened by typing leaves it, as in the text. Typing linear never builds a different formula. |
| `a/b*c` | `\frac{a}{b}·c‸` | `a/b*c` | Linear `a/b*c` is (a/b)·c. |
| `a/b␣+c` | `\frac{a}{b}+c‸` | `a/b + c` | Spaces are ignored, as in the linear box. |
| `a/b^2` | `\frac{a}{b^{2‸}}` | `a/b^2` | `^` binds tighter than `/`: it stays in the denominator. |
| `a/2␣m` | `\frac{a}{2m‸}` | `a/2 m` | Linear `a/2 m` is a/(2 m): a unit after a number stays with it. |
| `9.81␣m/s^2` | `\frac{9.81m}{s^{2‸}}` | `9.81 m/s^2` |  |
| `1/150*'mm/'kgf` | `\frac{\frac{1}{150}·'{mm}}{'{kgf‸}}` | `1/150*'mm/'kgf` |  |
| `x=kN/m` | `x = \frac{kN}{m‸}` | `x = kN/m` | In the unit after `=`, `/` makes a unit fraction (text `kN/m`). |
| `a/b{←}{→}+c` | `\frac{a}{b+c‸}` | `a/(b + c)` | The caret was put back in the denominator by hand: what is typed goes where the caret is. |
| `⟦M := q*L^2/8⟧{⌫}2+1` | `M≔\frac{q·L^{2}}{2}+1‸` | `M := q*L^2/2 + 1` | A slot entered by Backspace counts as typed into: `+` leaves it, as retyping the end of `q*L^2/8` would. |
| `c*/` | `c·\frac{‸}{□}` | `c*(?/?)` | An empty fraction after `*`: the text needs brackets (`c*(?/?)`); hints mark it `bracketed` so phase 2 draws them. |

## `^` — powers

| Keys | Tree | Text | Why |
|---|---|---|---|
| `x^2` | `x^{2‸}` | `x^2` |  |
| `x^2+1` | `x^{2}+1‸` | `x^2 + 1` | Linear `x^2+1` is x² + 1: an operator the exponent can't hold leaves it. |
| `x^2␣+1` | `x^{2}+1‸` | `x^2 + 1` | Space also leaves an exponent (linear: a space ends the exponent's value). |
| `x^2{→}+1` | `x^{2}+1‸` | `x^2 + 1` | → at the end of the exponent leaves it, too. |
| `x^2␣m` | `x^{2}m‸` | `x^2 m` | A unit after a numeric exponent multiplies the power, as the parser holds it. |
| `10^-4␣m^3` | `10^{-4}m^{3‸}` | `10^-4 m^3` |  |
| `10^-4m` | `10^{-4}m‸` | `10^-4 m` | Even without the space: in the text `4m` is a number and a unit, and the unit is the power's. |
| `e^x` | `e^{x‸}` | `e^x` |  |
| `e^-x` | `e^{-x‸}` | `e^-x` | A sign right after `^` is the exponent's. |
| `e^-x+1` | `e^{-x}+1‸` | `e^-x + 1` |  |
| `e^-x/2` | `\frac{e^{-x}}{2‸}` | `e^-x/2` | Linear `e^-x/2` is (e^−x)/2: `/` leaves the exponent too. To divide the exponent, use brackets. |
| `e^(-x/2)` | `e^{(\frac{-x}{2})‸}` | `e^(-x/2)` | Brackets that fill the exponent stay drawn while the caret is still in it, since what follows `)` may still apply to them… |
| `e^(x+1)` | `e^{(x+1)‸}` | `e^(x + 1)` |  |
| `e^(x+1)+2` | `e^{x+1}+2‸` | `e^(x + 1) + 2` | …and become the exponent's own once it is left by typing: drawn without them, as the view draws the stored formula. |
| `e^2x` | `e^{2}x‸` | `e^2 x` | Deliberately as the text reads it: `e^2x` is e²·x in linear Quire, so it is here; e^(2x) is typed `e^(2x)`. The x visibly drops to the line. |
| `x^(2)` | `x^{(2)‸}` | `x^(2)` | Brackets the text doesn't need are kept in it, as typed. |
| `x^2^3` | `x^{2^{3‸}}` | `x^2^3` | `^` groups to the right (x^(2³)), as in the parser. |
| `x^^` | `x^{‸}` | `x^?` | Nothing to raise: the second `^` does nothing. |
| `(a+b)^2` | `(a+b)^{2‸}` | `(a + b)^2` |  |
| `a/b{→}^2` | `(\frac{a}{b})^{2‸}` | `(a/b)^2` | A fraction as a base needs brackets in the text, so they are made real and drawn. |
| `^2` | `^{2‸}` | `?^2` | Nothing before it: the base is an empty slot (`noBase` hint). |
| `A.net^2` | `A_{net}^{2‸}` | `A.net^2` | A subscripted name takes a superscript (drawn as msubsup). |
| `2␣m^2` | `2m^{2‸}` | `2 m^2` | A unit's power. |

## `.` — subscripts, decimal points, ranges

| Keys | Tree | Text | Why |
|---|---|---|---|
| `A.net` | `A_{net‸}` | `A.net` | `.` after a letter starts the literal subscript, as `A.net` in the text. |
| `A.net:=5` | `A_{net}≔5‸` | `A.net := 5` | Anything not part of a name ends the subscript. |
| `A.n+1` | `A_{n}+1‸` | `A.n + 1` |  |
| `A.n␣` | `A_{n}‸` | `A.n` | Space ends it too. |
| `A.1.2` | `A_{1.2‸}` | `A.1.2` | A dot inside a subscript is a character (the view draws `1.2` as the subscript). |
| `A.{⌫}` | `A‸` | `A` | An empty subscript goes with one Backspace. |
| `A.net{←}{←}{←}{⌫}` | `A‸net` | `Anet` | Backspace at its start removes the dot: the letters join the name, as deleting `.` from `A.net`. |
| `An{←}.` | `A_{‸n}` | `A.n` | The inverse: `.` in the middle of a name makes the rest the subscript. |
| `F.y(x)` | `F_{y}(x)‸` | `F.y(x)` | `(` ends the subscript: a function with a subscripted name. |
| `1.5` | `1.5‸` | `1.5` | After a digit, `.` is a decimal point. |
| `.5` | `.5‸` | `.5` |  |
| `1..10` | `1..10‸` | `1..10` | A second `.` makes the range `..`. |
| `a..b` | `a..b‸` | `a..b` | After a name too: `a.` then `.` is the range, not a subscript. |
| `(a)..b` | `(a)..b‸` | `(a)..b` | After a value that can't take a subscript, `.` is the range at once. |

## `(` `)` — brackets, calls and shapes

`sqrt`, `abs` and `root` become their shapes as soon as `(` is typed after the name (their argument count never varies). `sum`, `prod`, `int`, `diff` and `lim` become theirs when their `)` is typed with the arguments that shape has (`int` with 4 or 2, `diff` with 2 or 3, `sum` with 4…); until then they are a call, drawn as typed. `if`, `for`, `while`, `block` and the other functions stay calls while edited.

| Keys | Tree | Text | Why |
|---|---|---|---|
| `(` | `(‸⦆` | `(?)` | Pairs type themselves (#173): the `)` is faint (`⦆`, a ghost) until typed. |
| `(a+b)` | `(a+b)‸` | `(a + b)` | Typing `)` over the ghost makes it real and steps past it. |
| `(a+b` | `(a+b‸⦆` | `(a + b)` | The text always has its `)`; the ghost is only how it is drawn. |
| `a+b{Home}(` | `(‸a+b⦆` | `(a + b)` | Before a value, the brackets take the rest of the row, their `)` faint at its end, as the preview closes an open `(` at the end of the line. |
| `(ab{←})` | `(a)‸·b` | `(a)*b` | `)` in the middle closes there; what was after it follows, with its `·`. |
| `(a+b){←})` | `(a+b)‸` | `(a + b)` | `)` at the end of brackets already closed steps past. |
| `a)` | `a‸` | `a` | Nothing to close: nothing happens (never a stray bracket). |
| `f(` | `f(‸⦆` | `f(?)` | After a name, the call's brackets. |
| `f(x,y)` | `f(x,y)‸` | `f(x, y)` | In a call, `,` separates arguments. |
| `f(){←}` | `f(‸)` | `f()` | A call closed empty has no arguments (`f()`); while open it reads `f(?)`, as the preview. |
| `2(x+1)` | `2·(x+1)‸` | `2*(x + 1)` | A value right after another that the text can't write side by side gets a visible `·`, as in Mathcad. |
| `(a)(b)` | `(a)·(b)‸` | `(a)*(b)` |  |
| `sqrt(` | `\sqrt{‸}` | `sqrt(?)` | `sqrt`, `abs`, `root` take their shape as soon as `(` is typed. |
| `sqrt(x)+1` | `\sqrt{x}+1‸` | `sqrt(x) + 1` | `)` at the end of a shape steps out of it. |
| `sqrt(x)/4` | `\frac{\sqrt{x}}{4‸}` | `sqrt(x)/4` |  |
| `abs(x)` | `\|x\|‸` | `abs(x)` |  |
| `root(8,3)` | `\root{3}{8}‸` | `root(8, 3)` | `,` goes to the next argument (the index); walked index first, as drawn. |
| `int(f(x),x,0,1)` | `\int{0}{1}{f(x)}{x}‸` | `int(f(x), x, 0, 1)` | Integrals, sums, products, derivatives and limits take their shape when their `)` is typed with the right number of arguments. |
| `sum(i^2,i,1,n)` | `\sum{i}{1}{n}{i^{2}}‸` | `sum(i^2, i, 1, n)` |  |
| `diff(f(x),x)` | `\diff{x}{f(x)}‸` | `diff(f(x), x)` |  |
| `lim(f(x),x,0)` | `\lim{x}{0}{f(x)}‸` | `lim(f(x), x, 0)` |  |
| `(1␣-␣cos(α))/2` | `\frac{1-cos(α)}{2‸}` | `(1 - cos(α))/2` | The `)` after a call's `)` closes the outer brackets. |
| `sqrt((1␣-␣cos(α))/2)` | `\sqrt{\frac{1-cos(α)}{2}}‸` | `sqrt((1 - cos(α))/2)` | Brackets that fill a radicand become its own only when it is left: here `/2` still applies to them. |
| `ln(abs((x␣-␣r)/(x␣+␣r)))` | `ln(\|\frac{x-r}{x+r}\|)‸` | `ln(abs((x - r)/(x + r)))` | Nested brackets, each `)` closing the innermost one still open. |
| `(2*n␣-␣1)!` | `(2·n-1)!‸` | `(2*n - 1)!` | A factorial after `)` applies to the brackets. |
| `x^(2*n)/(2*n)!` | `\frac{x^{2·n}}{(2·n)!‸}` | `x^(2*n)/(2*n)!` | …also when they fill a denominator: the exponent's brackets became its own when `/` left it, the denominator's are still drawn when `!` is typed. |
| `25␣kN/(m)^3` | `\frac{25kN}{(m)^{3‸}}` | `25 kN/(m)^3` | A power after `)` applies to the brackets too. |
| `sqrt((a+b))` | `\sqrt{a+b}‸` | `sqrt((a + b))` | Stepping out of the radical, its brackets become its own (kept in the text, as typed). |
| `((a+b))/2` | `\frac{(a+b)}{2‸}` | `((a + b))/2` | One pair per slot: the inner pair stays. |

## `[` `]` `,` `;` — indices and matrices

| Keys | Tree | Text | Why |
|---|---|---|---|
| `M[2]` | `M_[2]‸` | `M[2]` | `[` after a name or a bracket is an index, drawn as a subscript. |
| `M[i,␣j]` | `M_[i,j]‸` | `M[i, j]` |  |
| `v[i]^2` | `v_[i]^{2‸}` | `v[i]^2` |  |
| `[` | `\mat{‸}` | `[?]` | Anywhere else it is a matrix. |
| `[1,␣2;␣3,␣4]` | `\mat{1, 2; 3, 4}‸` | `[1, 2; 3, 4]` | `,` adds a column, `;` a row. |
| `[1,2;3` | `\mat{1, 2; 3‸, □}` | `[1, 2; 3, ?]` | Rows are kept rectangular: the cells not reached yet are empty slots. |
| `[1;2;3]` | `\mat{1; 2; 3}‸` | `[1; 2; 3]` |  |
| `2[1,2]` | `2·\mat{1, 2}‸` | `2*[1, 2]` |  |
| `[1,␣2]␣kN` | `\mat{1, 2}kN‸` | `[1, 2] kN` | A unit after a matrix applies to every element. |
| `[a/b,c]` | `\mat{\frac{a}{b}, c}‸` | `[a/b, c]` | `,` leaves an open denominator first. |
| `[1,2]{←}{←}{←},` | `\mat{1, ‸, 2}` | `[1, ?, 2]` | `,` at the end of a cell whose neighbour is filled inserts a column. |
| `[1,2;3,4]{←}{↑}` | `\mat{1, 2‸; 3, 4}` | `[1, 2; 3, 4]` | ↑ ↓ move between rows. |
| `M[2{→}` | `M_[2]‸` | `M[2]` | → leaves the index; its `]` is drawn solid all along. |

## Arrows, Home, End

← and → walk every position in reading order, into and out of every structure, one visible position per press: no position is visited twice and none is skipped (a property test walks thousands of random formulas). ↑ and ↓ move between a fraction's numerator and denominator, an exponent and its base, a root's index and radicand, a sum's or integral's limits, a matrix's rows; with nowhere to go, the key is handed back (`effect.leave`) so phase 2 can move to the region above or below.

| Keys | Tree | Text | Why |
|---|---|---|---|
| `a/b{Home}` | `‸\frac{a}{b}` | `a/b` | Home and End go to the start and end of the whole line. |
| `a/b{Home}{→}` | `\frac{‸a}{b}` | `a/b` | → enters every structure: numerator, then denominator, then out. Each step is one visible position. |
| `a/b{Home}{→}{→}` | `\frac{a‸}{b}` | `a/b` |  |
| `a/b{Home}{→}{→}{→}` | `\frac{a}{‸b}` | `a/b` |  |
| `a/b{Home}{→}{→}{→}{→}` | `\frac{a}{b‸}` | `a/b` |  |
| `a/b{Home}{→}{→}{→}{→}{→}` | `\frac{a}{b}‸` | `a/b` |  |
| `x^2{←}` | `x^{‸2}` | `x^2` |  |
| `x^2{←}{←}` | `x‸^{2}` | `x^2` | Between a base and its exponent (low, after x) is a position of its own. |
| `x^2{←}{←}{←}` | `‸x^{2}` | `x^2` |  |
| `A.b^2{Home}{→}{→}{→}` | `A_{b‸}^{2}` | `A.b^2` | Subscript and superscript stack (msubsup): the position between them would draw in the same place, so → goes straight from one to the other. |
| `A.b^2{Home}{→}{→}{→}{→}` | `A_{b}^{‸2}` | `A.b^2` |  |
| `(a){Home}{→}` | `(‸a)` | `(a)` |  |
| `[1,2;3,4]{Home}{→}{→}{→}` | `\mat{1, ‸2; 3, 4}` | `[1, 2; 3, 4]` | Matrix cells in reading order. |
| `root(8,3){Home}{→}` | `\root{‸3}{8}` | `root(8, 3)` |  |
| `sum(k,k,1,n){Home}{→}{→}{→}{→}{→}` | `\sum{k}{1}{‸n}{k}` | `sum(k, k, 1, n)` | A sum: the lower limit (variable, start), the upper limit, then the body. |
| `a/b{↑}` | `\frac{a‸}{b}` | `a/b` | ↑ ↓ between numerator and denominator. |
| `a/b{↑}{↓}` | `\frac{a}{b‸}` | `a/b` |  |
| `a/b{↑}{↑}` | `\frac{a‸}{b} ⟶ leave up` | `a/b` | Nowhere further up in the formula: the editor is told to leave it upwards (phase 2 moves to the region above, or stays). |
| `a/b{↓}` | `\frac{a}{b‸} ⟶ leave down` | `a/b` |  |
| `x^2{↓}` | `x‸^{2}` | `x^2` | From the exponent down to its base. |
| `x^2{←}{←}{↑}` | `x^{‸2}` | `x^2` | Next to an exponent, ↑ goes into it. |
| `A.b{↑}` | `A_{b}‸` | `A.b` | From a subscript up to the line. |
| `[1,2;3,4]{←}{↑}{↑}` | `\mat{1, 2‸; 3, 4} ⟶ leave up` | `[1, 2; 3, 4]` |  |
| `root(8,3){↑}` | `\root{3}{8}‸ ⟶ leave up` | `root(8, 3)` |  |
| `int(f,x,0,1){Home}{→}{↑}` | `\int{0}{‸1}{f}{x}` | `int(f, x, 0, 1)` | Between the limits. |
| `a+b{↑}` | `a+b‸ ⟶ leave up` | `a + b` |  |
| `a+b{→}` | `a+b‸ ⟶ leave right` | `a + b` |  |
| `{←}` | `‸ ⟶ leave left` | `` |  |
| `a/b{End}` | `\frac{a}{b}‸` | `a/b` |  |
| `x=kN{Home}` | `‸x = kN` | `x = kN` |  |

## Backspace and Delete

**Backspace deletes the last thing drawn before the caret; Delete the first after it.** Right after a structure, Backspace goes in and deletes its last character (Desmos), rather than selecting the structure first (MathQuill): each press then deletes exactly one visible thing, and `a/b` takes three presses to delete, as its text does. Removing a whole structure is a selection away (⇧←). The one exception is `)`: Backspace after it deletes the `)` itself, which turns faint, as in the text.

**At the start of a slot, the structure comes apart** and its content stays where it was: a fraction (from either slot), an exponent, a subscript, a radical, brackets (both at once), an index, a quoted unit. This is the exact inverse of typing `/`, `^`, `.`, `(` there, so a mistyped `/` is one Backspace. An empty structure simply goes. Where coming apart would mix several filled slots (a matrix, a root with both slots, a string), Backspace steps to the slot before, or selects the structure so the next press deletes it. Brackets the text needed come back as real brackets (`(a + b)/2` → `(a + b)2`).

| Keys | Tree | Text | Why |
|---|---|---|---|
| `ab{⌫}` | `a‸` | `a` | Backspace deletes the last thing drawn before the caret. |
| `a/b{⌫}` | `\frac{a}{‸}` | `a/?` | Right after a structure it deletes its last character, inside it (Desmos), so one press always deletes one visible thing; MathQuill's select-first would cost a press to delete a typo in a denominator. |
| `a/b{⌫}{⌫}` | `a‸` | `a` | At the start of the denominator, the fraction comes apart. |
| `a/b{⌫}{⌫}{⌫}` | `‸` | `` | Three presses for `a/b`, as in the text: never trapped, never a dead press. |
| `a/{⌫}` | `a‸` | `a` | The usual fix for a mistyped `/`. |
| `⟦a/b⟧{⌫}c+d` | `\frac{a}{c}+d‸` | `a/c + d` |  |
| `⟦a/b⟧{←}{←}{⌫}` | `a‸b` | `ab` | Backspace at the start of a denominator unwraps: the bar goes, both parts stay, the caret where the bar was (the inverse of `/` there). |
| `⟦a/b⟧{←}{⌫}` | `\frac{a}{‸}` | `a/?` |  |
| `⟦a/b⟧{Home}{→}{⌫}` | `‸ab` | `ab` | At the start of the numerator, too. |
| `⟦(a+b)/2⟧{Home}{→}{→}{→}{→}{→}{→}{⌫}` | `\frac{a+b}{‸}` | `(a + b)/?` |  |
| `⟦a/b⟧{Home}{→}{→}{⌦}` | `a‸b` | `ab` | Delete at the end of the numerator unwraps (deleting the bar). |
| `x^2{⌫}` | `x^{‸}` | `x^?` |  |
| `x^2{⌫}{⌫}` | `x‸` | `x` | An empty exponent goes. |
| `x^{⌫}` | `x‸` | `x` |  |
| `⟦x^2⟧{Home}{→}{→}{⌫}` | `x‸2` | `x2` | At the start of a filled exponent, the `^` goes: as deleting `^` from `x^2`. |
| `sqrt(x){⌫}` | `\sqrt{‸}` | `sqrt(?)` |  |
| `sqrt(x){⌫}{⌫}` | `‸` | `` | An empty radical goes. |
| `sqrt(x){Home}{→}{⌫}` | `‸x` | `x` | At its start, the radical goes and its content stays. |
| `(a+b){⌫}` | `(a+b‸⦆` | `(a + b)` | After `)`, Backspace deletes the `)`: it turns faint and the caret goes in (as in the text with #173). Typing `)` again closes it. |
| `(a+b){⌫}{⌫}` | `(a+‸⦆` | `(a + ?)` |  |
| `(a+b){Home}{→}{⌫}` | `‸a+b` | `a + b` | At the start of brackets, both go: never a stray bracket. |
| `(){⌫}{⌫}` | `‸` | `` |  |
| `(){←}{⌫}` | `‸` | `` | An empty pair goes together. |
| `⟦(a+b)⟧{Home}{⌦}` | `‸a+b` | `a + b` | Delete before `(` removes the pair. |
| `⟦a/b⟧{Home}{⌦}` | `\frac{‸}{b}` | `?/b` | Delete before a structure deletes its first character, inside. |
| `⟦x^2⟧{Home}{→}{⌦}` | `x^{‸}` | `x^?` |  |
| `⟦A.net⟧{Home}{→}{→}{⌫}` | `A‸net` | `Anet` |  |
| `⟦[1, 2; 3, 4]⟧{Home}{→}{⌫}` | `«\mat{1, 2; 3, 4}»` | `[1, 2; 3, 4]` | A matrix with several cells can't come apart: it is selected… |
| `⟦[1, 2; 3, 4]⟧{Home}{→}{⌫}{⌫}` | `‸` | `` | …and the next Backspace deletes it. |
| `⟦[1, 2]⟧{End}{⌫}` | `\mat{1, ‸}` | `[1, ?]` |  |
| `⟦[1, 2]⟧{End}{⌫}{⌫}` | `\mat{1‸}` | `[1]` | An empty column goes. |
| `⟦[1, 2]⟧{End}{⌫}{⌫}{⌫}` | `\mat{‸}` | `[?]` |  |
| `⟦root(8, 3)⟧{End}{⌫}{⌫}` | `\root{3‸}{□}` | `root(?, 3)` | In a shape with other filled slots, Backspace at a slot's start steps back to the slot before. |
| `⟦"OK"⟧{End}{⌫}` | `"O‸"` | `"O"` |  |
| `⟦"OK"⟧{Home}{→}{⌫}` | `«"OK"»` | `"OK"` | A string isn't unwrapped into math: it is selected. |
| `⟦x := 5 = kN⟧{⌫}{⌫}{⌫}` | `x≔5‸` | `x := 5` | Backspace at the start of an empty unit removes the `=`. |
| `⟦x := 5 =⟧{⌫}` | `x≔5‸` | `x := 5` |  |
| `{⌫}` | `‸` | `` |  |

## What Quire already has

Everything the linear editor does keeps working, by the same keys.

| Keys | Tree | Text | Why |
|---|---|---|---|
| `x:=5` | `x≔5‸` | `x := 5` | `:` types `:=` (drawn ≔); an `=` right after it is swallowed, as today. |
| `x:=5=` | `x≔5 = ‸` | `x := 5 =` | `=` shows the result; the caret goes to the unit after it, where the unit list opens. |
| `x::=5` | `x≡5‸` | `x ≡ 5` | `::=` is `≡`. |
| `x~5` | `x≡5‸` | `x ≡ 5` | `~` is `≡` (global definition), as today. |
| `x=` | `x = ‸` | `x =` |  |
| `x:=5=kN` | `x≔5 = kN‸` | `x := 5 = kN` |  |
| `x:=5=kN*m` | `x≔5 = kN·m‸` | `x := 5 = kN*m` |  |
| `x:=5=kN/m` | `x≔5 = \frac{kN}{m‸}` | `x := 5 = kN/m` |  |
| `x:=5={⌫}` | `x≔5‸` | `x := 5` |  |
| `a==b` | `a=b‸` | `a == b` | A second `=` right after the first makes the comparison `==` where the first was typed. |
| `a=b` | `a = b‸` | `a = b` | As in the linear box, what follows `=` is the unit to show the result in. |
| `a<=b` | `a≤b‸` | `a ≤ b` | `<=` `>=` `!=` become `≤ ≥ ≠`. |
| `a>=b` | `a≥b‸` | `a ≥ b` |  |
| `a!=b` | `a≠b‸` | `a ≠ b` |  |
| `a<b` | `a<b‸` | `a < b` |  |
| `x->` | `x →‸` | `x →` | `->` or Ctrl+. shows the result symbolically. |
| `x{Ctrl+.}` | `x →‸` | `x →` |  |
| `\alpha␣` | `α‸` | `α` | `\name` and Space (or an operator) insert the symbol, as today. |
| `\alpha+1` | `α+1‸` | `α + 1` |  |
| `\Delta␣x` | `Δx‸` | `Δx` |  |
| `\sqrt␣2` | `\sqrt{2‸}` | `sqrt(2)` | A template's structure goes in, the caret in its first slot. |
| `\frac␣` | `\frac{‸}{□}` | `(?)/(?)` |  |
| `\text␣` | `‸ ⟶ \to_text` | `` | A command is handed to the app (`effect.command`). |
| `\nope␣` | `nope‸` | `nope` | An unknown name stays as letters. |
| `a{Ctrl+G}` | `α‸` | `α` | Ctrl+G swaps the letter before the caret to Greek and back. |
| `α{Ctrl+G}` | `a‸` | `a` |  |
| `'kN` | `'{kN‸}` | `'kN` | `'` starts a quoted unit (drawn upright, without the quote). |
| `5␣'kN` | `5'{kN‸}` | `5 'kN` |  |
| `5'm^2` | `5'{m}^{2‸}` | `5 'm^2` |  |
| `T␣'°C` | `T'{°C‸}` | `T '°C` |  |
| `'{⌫}` | `‸` | `` |  |
| `#G` | `#{G‸}` | `#G` | `#` starts a built-in constant. |
| `2␣#G` | `2#{G‸}` | `2 #G` |  |
| `#k.B*T` | `#{k_{B}}·T‸` | `#k.B*T` | A constant's name takes a subscript like any name. |
| `20°C` | `20°C‸` | `20 °C` | `°` starts a name, as in the text. |
| `"OK"` | `"OK"‸` | `"OK"` | Strings take every character literally until `"`. |
| `"a+b/"` | `"a+b/"‸` | `"a+b/"` |  |
| `a␣and␣b` | `a∧b‸` | `a and b` | `and`, `or`, `not` typed as words become the operators (∧ ∨ ¬). |
| `not␣x` | `¬x‸` | `not x` |  |
| `(x␣≠␣0)␣and␣(y␣≠␣0)` | `(x≠0)∧(y≠0)‸` | `(x ≠ 0) and (y ≠ 0)` | After brackets, a space and `and` is the operator: the `·` put in before the word goes. |
| `(a)␣or␣b` | `(a)∨b‸` | `(a) or b` |  |
| `not␣(a)␣or␣b` | `¬(a)∨b‸` | `not (a) or b` |  |
| `2␣and␣b` | `2∧b‸` | `2 and b` | After a number too (the text reads `2 and b` so). |
| `A.b␣and␣c` | `A_{b}∧c‸` | `A.b and c` |  |
| `a␣b` | `a␣b‸` | `a*b` | Two names typed apart stay apart (a thin gap), so a keyword can still follow… |
| `a␣b+c` | `a·b+c‸` | `a*b + c` | …and once the second name is done and isn't one, the gap becomes `·`. |
| `1e-5` | `1e-5‸` | `1e-5` | A number's exponent stays a number. |
| `a/1e-5` | `\frac{a}{1e-5‸}` | `a/1e-5` | …even at the end of a denominator. |

Also as today, outside the model: ⌥Enter cycles a name's meaning, Ctrl+Space (⌥Space on a Mac) lists names or units, Ctrl+Shift+T makes the region text (`toLinear` gives the text it starts from), a fresh region that reads as words becomes text on Space (`plainWords()` gives the words), Enter and Esc end the edit, a constraint line in a solve block types `==` for `=` (`fromExpr(…, { equation: true })`).

## Selection

The selection is always a contiguous slice of one row: ⇧← ⇧→ grow it by one thing on that row, and at the edge of a slot to the whole structure around it, never to half of one. Typing replaces it; `/`, `^`, `(`, `[` wrap it, and `wrapIn()` wraps it in `sqrt`, `abs` or `root` (the galleries). Copy and Cut give the selection as linear text (`selectedText`, `cutSelection`); Paste types the text in (`paste`), so `a/b + c` pasted is (a/b) + c, as typed. LaTeX is turned into linear text first, as today (`latexToLinear`).

| Keys | Tree | Text | Why |
|---|---|---|---|
| `a+b{⇧←}` | `a+«b»` | `a + b` | ⇧← ⇧→ grow the selection by one thing on its row. |
| `a+b{⇧←}{⇧←}{⇧←}` | `«a+b»` | `a + b` |  |
| `a/b{⇧←}` | `\frac{a}{«b»}` | `a/b` |  |
| `a/b{⇧←}{⇧←}` | `«\frac{a}{b}»` | `a/b` | At the edge of a slot, the selection grows to the whole structure: it is always one slice of one row. |
| `a/b{⇧←}{⇧←}{⇧→}` | `\frac{a}{b}‸` | `a/b` |  |
| `x^2{⇧←}{⇧←}` | `x«^{2}»` | `x^2` |  |
| `a+b{⇧←}{⇧←}{⇧←}c` | `c‸` | `c` | Typing replaces the selection. |
| `a+b{⇧←}{⇧←}{⇧←}{⌫}` | `‸` | `` |  |
| `a+b{⇧←}{⇧←}{⇧←}/` | `\frac{a+b}{‸}` | `(a + b)/?` | `/` makes it the numerator, |
| `a+b{⇧←}{⇧←}{⇧←}^2` | `(a+b)^{2‸}` | `(a + b)^2` | `^` the base (in brackets when it needs them), |
| `x+y{⇧←}^2` | `x+y^{2‸}` | `x + y^2` |  |
| `a+b{⇧←}{⇧←}{⇧←}(` | `(«a+b»)` | `(a + b)` | `(` wraps it and keeps it selected (#173), |
| `a+b{⇧←}{⇧←}{⇧←}[` | `\mat{«a+b»}` | `[a + b]` | `[` makes a matrix of it. |
| `x{⇧←}{→}` | `x‸` | `x` | An arrow collapses the selection to that side. |
| `x{⇧←}{←}` | `‸x` | `x` |  |
| `a+b{⇧Home}` | `«a+b»` | `a + b` |  |

## Tab

| Keys | Tree | Text | Why |
|---|---|---|---|
| `/{Tab}` | `\frac{□}{‸}` | `?/?` | Tab goes to the next empty slot, |
| `/{Tab}{Tab}` | `\frac{‸}{□}` | `?/?` | round to the first, |
| `a/b{Tab}` | `\frac{a}{b‸} ⟶ leave right` | `a/b` | and with none left, on to the next line or region. |

## Typing fast

The whole point: a formula typed as a linear typist types it, spaces and all, comes out as the formula its text says.

| Keys | Tree | Text | Why |
|---|---|---|---|
| `q␣*␣L^2␣/␣8` | `\frac{q·L^{2}}{8‸}` | `q*L^2/8` | Spaced as a linear typist spaces it. |
| `M␣:=␣q*L^2/8␣=␣kN*m` | `M≔\frac{q·L^{2}}{8} = kN·m‸` | `M := q*L^2/8 = kN*m` |  |
| `M␣:=␣q*(L␣-␣x)/2` | `M≔\frac{q·(L-x)}{2‸}` | `M := q*(L - x)/2` |  |
| `g␣:=␣9.81␣m/s^2` | `g≔\frac{9.81m}{s^{2‸}}` | `g := 9.81 m/s^2` |  |
| `W␣:=␣2.5*10^-4␣m^3` | `W≔2.5·10^{-4}m^{3‸}` | `W := 2.5*10^-4 m^3` |  |
| `e^(-t/(2␣s))` | `e^{(\frac{-t}{2s})‸}` | `e^(-t/(2 s))` |  |
| `A.tank␣:=␣π*(D.base/2)^2` | `A_{tank}≔π·(\frac{D_{base}}{2})^{2‸}` | `A.tank := π*(D.base/2)^2` |  |
| `F.cr␣:=␣(0.658^(F.y/F.e))*F.y` | `F_{cr}≔(0.658^{\frac{F_{y}}{F_{e}}})·F_{y‸}` | `F.cr := (0.658^(F.y/F.e))*F.y` |  |

## Undo

As the linear editor does it (#119): every key that changes the formula is one undo step; a paste, a template or a `\` shortcut is one step; moving the caret is none, but a step remembers where the caret was. At most 500 steps. `History.record()` after each key, `undo()` and `redo()`. A step comes back with no slot open, as if the caret had been put there by hand.

## Invariants

Each is a test.

1. **No key throws, whatever came before**, and the caret is always at a position that exists (3,000 random sequences of 30 keys).
2. **Never trapped, never a dead step:** → from Home visits every position exactly once and reaches the end; ← walks the same positions backwards; ↑ repeated either moves or says to leave.
3. **Backspace from the end, or Delete from the start, empties any formula.**
4. **The selection is always one slice of one row.**
5. **The text is what the tree says:** for 1,500 random sequences (more on demand, `MATHTREE_RUNS`), whenever the tree reads as a formula, the engine parses `toLinear()` without error, and to the same formula as the model (brackets aside).
6. **Round trip:** for every formula in the repository's documents, `parse(toLinear(fromExpr(parse(s)))) == parse(s)`, the text is exactly `print(parse(s))`, and typing that text builds the same formula.
7. **Brackets anywhere:** those formulas, and a few nested on purpose (`sqrt((1 - cos(α))/2)`, `(2*n - 1)!`, `(x ≠ 0) and (y ≠ 0)`), with brackets put around random parts at every depth (sometimes twice), typed key by key, build the formula their text says (4 rounds; more with `MATHTREE_ROUNDS`, other draws with `MATHTREE_SEED`).
8. **Unfinished lines:** for every prefix of those formulas, the text of the typed tree previews as the engine previews the prefix (`parse_lenient`).

## Tests

- `app/src/mathTree.test.ts`: the tables of this page, row by row, and invariants 1–4, undo, clipboard, templates, hints.
- `app/src/mathTree.engine.test.ts`: invariants 5–8 against the engine itself, `crates/quire-web` as WebAssembly, through a `parse` command that returns the strict tree, its canonical text and the forgiving preview. It needs `app/web-public/quire_web.wasm` (`npm run wasm`); without it the file is skipped, except on CI, where it fails. CI builds the web version before the unit tests for this.
- A new row for these tables: list its keys in a file, one per line, and run `MATHTREE_DUMP=<file> npx vitest run src/mathTree.test.ts -t dump`; `<file>.out` has the rows as the model gives them, to check by eye before they go here with their reason.
- `QUIRE_ROUNDTRIP_CORPUS=<folder>` runs the round trip over every `.quire`, `.quirez` and `.sm` file in a folder as well (SMath files converted as the app converts them).

## For phase 2

`hints(state)` is what to draw besides the tree: the caret and the selection, the slots to draw as □ (`empty`), operands not typed yet (`missing`, as `M ≔ □`), faint `)` (`ghosts`), fractions the text puts in brackets (`bracketed`, so `c·(a/b)` is drawn with them while editing as after), exponents with no base (`noBase`), and the slots open for typing (`open`). Every row and structure has a stable id, kept across keys, for `data-*` attributes on the MathML.

What phase 2 must take care of:

- **Draw the tree as the view draws the stored formula,** or the formula will jump when the edit ends: brackets that are a slot's own (`kept`, or around a whole numerator, denominator, exponent, radicand) are not drawn; an index is a subscript; `A.b^2` is one msubsup; flat units (`80 km/h`) if that setting is on; programs (`if`, `for`, `block`) are drawn as calls while edited, which does jump: a later step.
- **Brackets filling a slot left by an arrow or a click** stay in the tree (and drawn) until the edit ends, so ← → stay a walk over a tree that doesn't change; the view then draws them as the slot's. Phase 2 may hide them as soon as the caret is outside that slot (`absorbAll` is the model's version of it).
- **Positions that would draw at the same place.** The model already skips the one between a subscript and the superscript stacked above it. A caret drawn between `2` and `m` in `2 m` and at the start of `m` must not look the same: the model has one position there, the renderer must not add a second.
- **↑ ↓ need geometry:** `key(…, { pick })` lets the editor choose the landing index from the caret's x; the default keeps the caret's share of the row.
- **`effect.leave`** after ← → ↑ ↓ Tab: move to the next region or line, or nothing; **`effect.command`** after a `\` shortcut (`to_text`, `insert_plot`, `insert_table`).
- **The completion lists** (`\name`, units after `=`, names) need the caret's screen position and the name at the caret; the tree gives the name (the letters of the row around the caret) and `toLinear` the text the engine is asked about.
- **IME and dead keys** (`´` + `a`): feed composed characters to `key()`, not key codes.
- **A formula that doesn't read** (`a + * b`) still has a text (`rawText`, as typed) for the engine to report on; drawing it needs nothing special.
- **Pasted text** goes through `paste()`; the clipboard's LaTeX through `latexToLinear` first.

## Phase 2: the editor on the page

Built behind Settings ▸ Editing ▸ Edit math in place (preview), off by default; off is the linear editor as before.

- **Drawn as stored.** `mathDraw.ts` reads each row with `traceRow` (the parser port, recording where each expression comes from), adds the brackets the stored text will have (`withPrintedBrackets`, which covers `bracketed`), and draws it with math.ts's own code, adding only `data-*` attributes. `mathTree.engine.test.ts` checks that every formula in the repository is drawn exactly as the view draws it when an edit starts and when it ends. Brackets filling a slot the caret is not in become the slot's at once (`settleSlots`).
- **Rows that don't read** (`a, b`) are drawn as their parts between the separators, so what is typed is always drawn where it is typed.
- **Caret and hit-testing** come from the browser's layout of the MathML: a character's box from a text range, a structure's from its element. The caret is as tall as the line of its slot's font; a click picks the slot under it first; ↑ ↓ pass `pick` from the caret's x; a click on the result goes to its unit.
- **Keys** arrive in a hidden field at the caret: characters as text (composed by the IME or a dead key), the rest as keys. Undo is the model's `History`. The document is written only when the formula's text changes, and a formula changed back keeps the text it had.
- **Solve blocks** use the same editor for their lines.

Left for phase 3: inline math in text (`richtext.ts`), programs (`if`, `for`, `block`) drawn as rows are walked as calls, VoiceOver announcements of the caret's context, and a word-wise ⌥← ⌥→.
