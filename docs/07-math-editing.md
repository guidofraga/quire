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

- **Keys:** characters as typed; `␣` is Space; `{←}` `{→}` `{↑}` `{↓}` arrows, `{⇧←}` with Shift, `{⌥←}` `{⌥→}` the word jumps (Ctrl+← Ctrl+→ on Windows and Linux), `{⌫}` Backspace, `{⌦}` Delete, `{Home}` `{End}` `{Tab}` `{Enter}` `{Ctrl+.}` `{Ctrl+G}`. A row starts from an empty formula, or from `⟦text⟧`: that formula opened, the caret put at its end by hand.
- **Tree:** `\frac{num}{den}`, `x^{exp}`, `A_{sub}` (literal subscript), `M_[i]` (index), `(…)` brackets and `(…⦆` brackets whose `)` is faint, `\mat{a, b; c, d}`, `\sqrt{x}`, `\root{index}{x}`, `|x|`, `\int{…}` and `\sum{…}` with their slots in the order → walks them, `'{kN}` a quoted unit, `#{G}` a constant, `"…"` a string, `\{name}` a `\` shortcut being typed; programs as `\if{cond}{value}\elif{cond}{value}\else{value}`, `\block{line⏎line}`, `\for{i}{range}{body}`, `\while{cond}{body}`. `·` is `*`, `≔` is `:=`, `=` in a tree is `==`, `␣` a gap between two names. `□` is an empty slot, `‸` the caret, `«…»` the selection, then ` = unit` or ` →` when the result is shown. `⟶ leave up` means the key would move out of the formula that way (phase 2 decides where); `⟶ finish` that it ends the edit, as Enter does outside a program.
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

`sqrt`, `abs` and `root` become their shapes as soon as `(` is typed after the name (their argument count never varies). `sum`, `prod`, `int`, `diff` and `lim` become theirs when their `)` is typed with the arguments that shape has (`int` with 4 or 2, `diff` with 2 or 3, `sum` with 4…); until then they are a call, drawn as typed. So do the programs, `if` (2 or 3), `for` (3 or 4), `while` (2) and `block` (any): see § Programs. The other functions stay calls while edited.

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

## Word jumps

⌥← and ⌥→ (Ctrl+← and Ctrl+→ on Windows and Linux) move by whole things on the caret's row, as in a line of text: over the operators, then over one name with its subscript, one number, or one structure with the scripts, index or brackets of a call after it (`x²`, `M[i]`, `sin(x)`). At the edge of a slot they step out as ← → do, so they never trap the caret either. With Shift they select so, growing to the whole structure at the edge of a slot, as ⇧← ⇧→ do.

| Keys | Tree | Text | Why |
|---|---|---|---|
| `⟦q*L^2/8 + x.net⟧{⌥←}` | `\frac{q·L^{2}}{8}+‸x_{net}` | `q*L^2/8 + x.net` | A name with its subscript is one word. |
| `⟦q*L^2/8 + x.net⟧{⌥←}{⌥←}` | `‸\frac{q·L^{2}}{8}+x_{net}` | `q*L^2/8 + x.net` | Over the operator, then the whole fraction. |
| `⟦q*L^2/8 + x.net⟧{Home}{⌥→}` | `\frac{q·L^{2}}{8}‸+x_{net}` | `q*L^2/8 + x.net` |  |
| `⟦M := 12.5*L⟧{Home}{⌥→}{⌥→}` | `M≔12.5‸·L` | `M := 12.5*L` | A number with its decimal point is one word. |
| `⟦M := 12.5*L⟧{Home}{⌥→}{⌥→}{⌥→}` | `M≔12.5·L‸` | `M := 12.5*L` |  |
| `⟦sin(x)^2 + 1⟧{Home}{⌥→}` | `sin(x)^{2}‸+1` | `sin(x)^2 + 1` | A call with its brackets and its power. |
| `⟦a + M[i]⟧{⌥←}` | `a+‸M_[i]` | `a + M[i]` | A name with its index. |
| `⟦a/b⟧{⌥←}{⌥←}` | `‸\frac{a}{b} ⟶ leave left` | `a/b` | At the edge, as ←. |
| `⟦a + b⟧{⌥→}` | `a+b‸ ⟶ leave right` | `a + b` |  |
| `⟦if(x > 0, 1, -1)⟧{Home}{→}{⌥→}` | `\if{x‸>0}{1}\else{-1}` | `if(x > 0, 1, -1)` | In a slot, by the words of that slot… |
| `⟦if(x > 0, 1, -1)⟧{Home}{→}{⌥→}{⌥→}` | `\if{x>0‸}{1}\else{-1}` | `if(x > 0, 1, -1)` |  |
| `⟦if(x > 0, 1, -1)⟧{Home}{⌥→}` | `\if{x>0}{1}\else{-1}‸` | `if(x > 0, 1, -1)` | …and on the line, a program is one structure. |
| `⟦a + bc⟧{⇧⌥←}` | `a+«bc»` | `a + bc` | With Shift, the selection grows by words. |
| `⟦a + bc⟧{⇧⌥←}{⇧⌥←}` | `«a+bc»` | `a + bc` |  |

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

Also as today, outside the model: ⌥Enter cycles a name's meaning, Ctrl+Space (⌥Space on a Mac) lists names or units, Ctrl+Shift+T makes the region text (`toLinear` gives the text it starts from), a fresh region that reads as words becomes text on Space (`plainWords()` gives the words), Enter (outside a program, see § Programs) and Esc end the edit, a constraint line in a solve block types `==` for `=` (`fromExpr(…, { equation: true })`).

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

## Programs: `if`, `else if`, `for`, `while`, `block`

SMath's programs (#175) are structures with a row for each line: an `if` has a condition and a value for each branch (`if`, then each `else if`), and the else's value; a block has its statements; a loop its header and its body. The text stays the call SMath and the engine read, a chain nested in the else: `if(x ≥ 90, "A", if(x ≥ 80, "B", "C"))` is drawn `if x ≥ 90` / `"A"` / `else if x ≥ 80` / `"B"` / `else` / `"C"`, and that is the text stored, so files, SMath import, Word and PDF are unchanged.

**How an `if` is drawn, edited or not (for everyone, not only with this editor).** On rows when it is a chain (its else is itself an `if`), when a branch holds a program (an assignment, a block, a loop, an `if` on rows), and as a statement of a block or a loop's body. A single `if(c, a, b)` with plain values keeps its one line, `if(x > 0, 1, -1)`: short, and read as typed. The rule is mathLinear's `ifInRows`, shared by the page and the editor.

**Every program looks alike.** A block, an `if` on rows, a `for` and a `while` each have a rule down the left of their lines, as in Mathcad; a program inside another has its own, one step in. A program is centred on the line it sits in, so `f(x) :=` before it, and `= result` after it, sit at its middle, whatever its kind (a table's own alignment in MathML; nothing sets it). Word export (`omml.rs`) draws the same: an equation array centred on the line (`m:baseJc center`), with a `│` rule down its left.

**Enter.** Outside a program Enter ends the edit, as always. Inside one it adds a line, as in Mathcad Prime: after a statement (taking what is after the caret, so Enter in the middle of a line splits it and Backspace joins it again), and in a branch or a loop's body, which then holds a block of statements. In a condition or a loop's header it goes on to the next slot (the branch; the range, then the body). **To leave, press Enter on the empty last line** (as in a list in a word processor, or an outliner): the line goes, and the caret goes **one level out**: to the next branch; or, out of an `if` or a loop that is a branch's or a body's value, to a new line in that branch or body; or a new line after the program in the block around it; or, at the outside, the edit ends. Repeated Enter on empty lines climbs out of nested programs one level at a time. So a program typed line by line ends with two Enters, and there is no key to learn. ⌘Enter (Ctrl+Enter) ends the edit from anywhere, and Esc or a click away end it as always. Shift+Enter is the same as Enter: a separate key for a new line would be one more thing to learn, and is easy to hit by accident while typing capitals.

**Typing.** Programs are typed as they are written, with keywords and Enter, or as their text; § Typing programs below has the keys. `if(`, `for(`, `while(` and `block(` typed as text take their shape when their `)` is typed with their number of arguments (so typing the stored text builds the program it stores, and pasting it too). In a program `,` goes to the next slot (a new else after the last branch, a new statement in a block) and `)` steps out, as in the text. `else if ` typed at the start of an else (with the space after `if`) adds a branch before it: its condition, where the caret goes, and its value; the else keeps what it held. Structures ▸ Programming inserts `if / else`, `if / else if / else`, `for`, `while` and `block`, also as `\if`, `\elseif`, `\for`, `\while`, `\block`.

**Moving.** ← → walk the lines in reading order, as everything else. ↑ ↓ go from line to line (from a loop's body up to the slot of its header nearest the caret, from a branch into a block's first or last line), and leave the formula above the first line or below the last. An `if` drawn on one line is walked as a call, and ↑ ↓ leave it.

**Backspace and Delete** take a program apart line by line, never leaving a stray comma or bracket in the text: an empty statement, an empty else, an empty `else if` branch goes with one press; a block left with one statement in a branch goes too (the inverse of Enter there); at the start of a statement Backspace joins it to the one before; an `else if` with no condition, last and with no else, becomes the else. At the start of a program's first slot, an empty program goes and a filled one is selected, as an integral is.

| Keys | Tree | Text | Why |
|---|---|---|---|
| `if(x>0,1,-1)` | `\if{x>0}{1}\else{-1}‸` | `if(x > 0, 1, -1)` | `)` typed with two or three arguments: an `if` (drawn on one line, as the view draws a plain one). |
| `f(x):=if(x≥90,"A",if(x≥80,"B","C"))` | `f(x)≔\if{x≥90}{"A"}\elif{x≥80}{"B"}\else{"C"}‸` | `f(x) := if(x ≥ 90, "A", if(x ≥ 80, "B", "C"))` | An `if` in the else is the chain's next branch: one structure, drawn on rows. |
| `if(a,1,2,3)` | `if(a,1,2,3)‸` | `if(a, 1, 2, 3)` | Not an `if`'s arguments: a call, as typed. |
| `if(a,1` | `if(a,1‸⦆` | `if(a, 1)` | Until its `)`, a call. |
| `block(x:=1,x+1)` | `\block{x≔1⏎x+1}‸` | `block(x := 1, x + 1)` |  |
| `for(i,1..n,s:=s+i)` | `\for{i}{1..n}{s≔s+i}‸` | `for(i, 1..n, s := s + i)` |  |
| `for(i:=1,i<n,i:=i+1,s:=s+i)` | `\for{i≔1}{i<n}{i≔i+1}{s≔s+i}‸` | `for(i := 1, i < n, i := i + 1, s := s + i)` |  |
| `while(k<n,k:=k+1)` | `\while{k<n}{k≔k+1}‸` | `while(k < n, k := k + 1)` |  |
| `\if␣` | `\if{‸}{□}\else{□}` | `if(?, ?, ?)` | Structures ▸ Programming, also as shortcuts. |
| `\elseif␣` | `\if{‸}{□}\elif{□}{□}\else{□}` | `if(?, ?, if(?, ?, ?))` |  |
| `\for␣` | `\for{‸}{□}{□}` | `for(?, ?, ?)` |  |
| `\while␣` | `\while{‸}{□}` | `while(?, ?)` |  |
| `\block␣` | `\block{‸⏎□}` | `block(?, ?)` |  |
| `\elseif␣x≥90{Tab}"A{Tab}x≥80{Tab}"B{Tab}"C` | `\if{x≥90}{"A⦆}\elif{x≥80}{"B⦆}\else{"C‸⦆}` | `if(x ≥ 90, "A", if(x ≥ 80, "B", "C"))` | Tab from slot to slot. |
| `⟦if(a, 1, 2)⟧{Home}{→}` | `\if{‸a}{1}\else{2}` | `if(a, 1, 2)` | → walks the lines in reading order. |
| `⟦if(a, 1, if(b, 2, 3))⟧{Home}{→}{→}{→}` | `\if{a}{‸1}\elif{b}{2}\else{3}` | `if(a, 1, if(b, 2, 3))` |  |
| `⟦if(a, 1)⟧{←}{→}` | `\if{a}{1}‸` | `if(a, 1)` |  |
| `⟦if(a, 1, if(b, 2, 3))⟧{Home}{→}{↓}` | `\if{a}{‸1}\elif{b}{2}\else{3}` | `if(a, 1, if(b, 2, 3))` | ↓ to the line below… |
| `⟦if(a, 1, if(b, 2, 3))⟧{Home}{→}{↓}{↓}` | `\if{a}{1}\elif{‸b}{2}\else{3}` | `if(a, 1, if(b, 2, 3))` |  |
| `⟦if(a, 1, if(b, 2, 3))⟧{←}{↑}{↑}` | `\if{a}{1}\elif{b‸}{2}\else{3}` | `if(a, 1, if(b, 2, 3))` | …↑ to the line above. |
| `⟦if(a, 1, if(b, 2, 3))⟧{Home}{→}{↑}` | `\if{‸a}{1}\elif{b}{2}\else{3} ⟶ leave up` | `if(a, 1, if(b, 2, 3))` | Above the first line: out of the formula. |
| `⟦if(a, 1, 2)⟧{Home}{→}{↓}` | `\if{‸a}{1}\else{2} ⟶ leave down` | `if(a, 1, 2)` | An `if` on one line has no lines to go to. |
| `⟦block(a, b)⟧{←}{↑}` | `\block{a‸⏎b}` | `block(a, b)` |  |
| `⟦block(a, b)⟧{Home}{→}{↓}{↓}` | `\block{a⏎‸b} ⟶ leave down` | `block(a, b)` |  |
| `⟦for(i, 1..n, s)⟧{Home}{→}{↓}` | `\for{i}{1..n}{‸s}` | `for(i, 1..n, s)` | From the header to the body… |
| `⟦for(i, 1..n, s)⟧{←}{↑}` | `\for{i‸}{1..n}{s}` | `for(i, 1..n, s)` | …and back, to the slot of the header nearest the caret (here, with no geometry, the first). |
| `⟦while(k < n, k := k + 1)⟧{←}{↑}` | `\while{k<n‸}{k≔k+1}` | `while(k < n, k := k + 1)` |  |
| `⟦if(a, block(x, y), 2)⟧{Home}{→}{→}{↓}` | `\if{a}{\block{x‸⏎y}}\else{2}` | `if(a, block(x, y), 2)` | Into a block below: its first line… |
| `⟦if(a, block(x, y), 2)⟧{←}{↑}` | `\if{a}{\block{x⏎y‸}}\else{2}` | `if(a, block(x, y), 2)` | …and from below, its last. |
| `⟦f(x) := block(a, b)⟧{Home}{→}{→}{→}{→}{→}{→}` | `f(x)≔\block{‸a⏎b}` | `f(x) := block(a, b)` |  |
| `⟦block(a, b)⟧{←}{Enter}` | `\block{a⏎b⏎‸}` | `block(a, b, ?)` | Enter at the end of a statement: a new line after it. |
| `⟦block(a, b)⟧{←}{Enter}{Enter}` | `\block{a⏎b}‸ ⟶ finish` | `block(a, b)` | Enter on the empty last line: it goes, and the edit ends. |
| `⟦block(ab, c)⟧{Home}{→}{→}{Enter}` | `\block{a⏎‸b⏎c}` | `block(a, b, c)` | In the middle, the line splits. |
| `⟦block(a, b)⟧{Home}{→}{Enter}` | `\block{□⏎‸a⏎b}` | `block(?, a, b)` | At its start, a new line above. |
| `⟦if(a, 1, 2)⟧{←}{Enter}` | `\if{a}{1}\else{\block{2⏎‸}}` | `if(a, 1, block(2, ?))` | In a branch, a second line: the branch holds a block. |
| `⟦if(a, 1, 2)⟧{←}{Enter}y{Enter}{Enter}` | `\if{a}{1}\else{\block{2⏎y}}‸ ⟶ finish` | `if(a, 1, block(2, y))` |  |
| `⟦if(a, 1, 2)⟧{←}{Enter}{Enter}` | `\if{a}{1}\else{2}‸ ⟶ finish` | `if(a, 1, 2)` | The block left with one line goes: Enter twice changed nothing. |
| `⟦if(a, block(x, y), 2)⟧{Home}{→}{→}{→}{→}{→}{→}{→}{Enter}{Enter}` | `\if{a}{\block{x⏎y}}\else{‸2}` | `if(a, block(x, y), 2)` | Leaving a branch's block: on to the next branch. |
| `⟦block(for(i, 1..n, s), t)⟧{Home}{→}{→}{→}{→}{→}{→}{→}{→}{→}{Enter}{Enter}` | `\block{\for{i}{1..n}{s}⏎‸⏎t}` | `block(for(i, 1..n, s), ?, t)` | Leaving a loop's body: a new line after the loop, in the block around it. |
| `⟦for(i, 1..n, s := s + i)⟧{←}{Enter}` | `\for{i}{1..n}{\block{s≔s+i⏎‸}}` | `for(i, 1..n, block(s := s + i, ?))` |  |
| `⟦if(a, 1, 2)⟧{Home}{→}{→}{Enter}` | `\if{a}{‸1}\else{2}` | `if(a, 1, 2)` | In a condition, Enter goes to its branch. |
| `⟦for(i, 1..n, ?)⟧{Home}{→}{→}{Enter}` | `\for{i}{‸1..n}{□}` | `for(i, 1..n, ?)` | In a loop's header, to the next slot: the range, then the body. |
| `⟦for(i, 1..n, if(a, b))⟧{←}{←}{Enter}{Enter}` | `\for{i}{1..n}{\block{\if{a}{b}⏎‸}}` | `for(i, 1..n, block(if(a, b), ?))` | Out of an `if` that is a loop's body: a new line in that body, one level out… |
| `⟦for(i, 1..n, if(a, b))⟧{←}{←}{Enter}{Enter}{Enter}` | `\for{i}{1..n}{\if{a}{b}}‸ ⟶ finish` | `for(i, 1..n, if(a, b))` | …and the next empty Enter one more, here out of the formula. |
| `\if␣{Enter}` | `\if{□}{‸}\else{□}` | `if(?, ?, ?)` |  |
| `⟦if(a, 1, 2)⟧{Enter}` | `\if{a}{1}\else{2}‸ ⟶ finish` | `if(a, 1, 2)` | After the program, on the formula's line: the edit ends, as always. |
| `x:=1{Enter}` | `x≔1‸ ⟶ finish` | `x := 1` |  |
| `⟦if(a, 1)⟧{←},` | `\if{a}{1}\else{‸}` | `if(a, 1, ?)` | `,` after the last branch: an else, as in the text. |
| `⟦if(a, 1, 2)⟧{Home}{→}{→},` | `\if{a}{‸1}\else{2}` | `if(a, 1, 2)` | `,` goes to the next slot. |
| `⟦block(a, b)⟧{Home}{→}{→},` | `\block{a⏎‸⏎b}` | `block(a, ?, b)` | In a block, a new statement. |
| `⟦if(a, 1, 2)⟧{←})` | `\if{a}{1}\else{2}‸` | `if(a, 1, 2)` | `)` steps out. |
| `⟦if(a, 1, 2)⟧{Home}{→}{→}{→}{→}{→}else␣if␣` | `\if{a}{1}\elif{‸}{□}\else{2}` | `if(a, 1, if(?, ?, 2))` | `else if ` at the start of the else: a new branch before it, the caret in its condition. |
| `⟦if(a, 1, "C")⟧{Home}{→}{→}{→}{→}{→}else␣if␣b` | `\if{a}{1}\elif{b‸}{□}\else{"C"}` | `if(a, 1, if(b, ?, "C"))` | The else keeps what it held. |
| `\if␣x>0{Tab}1{Tab}else␣if␣x<0` | `\if{x>0}{1}\elif{x<0‸}{□}\else{□}` | `if(x > 0, 1, if(x < 0, ?, ?))` |  |
| `⟦if(a, 1, if(b, 2, 3))⟧{←}{⌫}{⌫}` | `\if{a}{1}\elif{b}{2‸}` | `if(a, 1, if(b, 2))` | An empty else goes, its comma with it. |
| `⟦if(a, 1, if(?, ?, 2))⟧{Home}{→}{→}{→}{→}{→}{⌫}` | `\if{a}{1‸}\else{2}` | `if(a, 1, 2)` | An empty `else if` branch goes with one Backspace: the inverse of typing `else if `. |
| `⟦if(a, 1, if(?, 2))⟧{Home}{→}{→}{→}{→}{→}{⌫}` | `\if{a}{1}\else{‸2}` | `if(a, 1, 2)` | An `else if` with no condition, last, is an else. |
| `⟦if(a, 1, 2)⟧{Home}{→}{→}{→}{→}{→}{⌫}` | `\if{a}{1‸}\else{2}` | `if(a, 1, 2)` | At the start of a filled line: to the end of the one before. |
| `⟦block(a, b)⟧{←}{Enter}{⌫}` | `\block{a⏎b‸}` | `block(a, b)` | An empty statement goes. |
| `⟦if(a, 1, 2)⟧{←}{Enter}{⌫}` | `\if{a}{1}\else{2‸}` | `if(a, 1, 2)` | …and with it the block it made. |
| `⟦block(a, b)⟧{←}{←}{⌫}` | `\block{a‸b}` | `block(ab)` | At the start of a statement, it joins the one before (the inverse of Enter in its middle). |
| `⟦block(a, b)⟧{Home}{→}{→}{⌦}` | `\block{a‸b}` | `block(ab)` | Delete at the end of one: the same. |
| `⟦if(a, 1, if(b, 2, 3))⟧{Home}{→}{→}{→}{→}{⌦}` | `\if{a}{1}\elif{‸b}{2}\else{3}` | `if(a, 1, if(b, 2, 3))` | Delete at the end of a filled line goes on to the next. |
| `⟦if(a, 1, 2)⟧{Home}{→}{→}{→}{→}{⌦}{⌦}` | `\if{a}{1}\else{‸}` | `if(a, 1, ?)` |  |
| `⟦for(i, 1..n, ?)⟧{←}{⌫}` | `\for{i}{1..n‸}{□}` | `for(i, 1..n, ?)` | In a loop, back to the slot before. |
| `⟦for(?, ?, s)⟧{←}{←}{⌫}` | `‸s` | `s` | Only one slot filled: the loop comes apart, its content stays. |
| `\if␣{⌫}` | `‸` | `` | An empty program goes. |
| `⟦if(a, 1, 2)⟧{Home}{→}{⌫}` | `«\if{a}{1}\else{2}»` | `if(a, 1, 2)` | A filled one is selected… |
| `⟦if(a, 1, 2)⟧{Home}{→}{⌫}{⌫}` | `‸` | `` | …and goes with the next Backspace. |

## Typing programs

A program is typed as it is written, nested any way, with no menu: a keyword and a space start it, Enter goes from its header into its body and from line to line, and Enter on an empty line climbs one level out (§ Programs).

- **`if `, `for `, `while `** (the word and a space) where a statement or a value starts start that program, the caret in its first slot (the condition, the loop variable). "Where a statement or a value starts" is the start of a line or of a slot, or right after `:=` or `≡`. Not in a condition or a loop's header, and never inside a name (`iffy`, `x.for`, `a if`), a subscript, a unit or a string: there the letters stay letters.
- **`if(`, `for(`, `while(`, `block(`** stay the text's calls until their `)`, as in § Programs, so the stored text typed or pasted builds exactly the program it stores (and a call that isn't a program, `if(a, 1, 2, 3)`, stays as typed). The keyword and a space is the way in that doesn't need the text's commas.
- **After a condition**, Enter or Tab goes into the branch. `:` doesn't (as some languages have it): `:` types `:=`, and is typed by habit.
- **`for i in `** goes on to the range, as do `for i ∈` and `for i =` (SMath's and Mathcad's ways of writing it); the range is typed as text (`1..n`). Enter or Tab after it goes into the body.
- **On a new line right after a branch**, `else` and Space or Enter starts the else, the caret in it; `else if ` adds a branch after that one, the caret in its condition. The same on the line after an `if` that is a statement of a block. The new line goes; a block it leaves with one line goes too, so the stored text is the nested calls. `else` then `if ` is `else if` too: an `if` started at the start of an else joins the chain (`chains()`).
- **`else` attaches to the `if` whose branch the new line is in**: on the line after a nested `if`'s branch it is that `if`'s; one Enter further out it is the outer `if`'s.
- **Anywhere else `else` stays a name**, as does `in` outside a `for`'s variable. The engine reserves none of `if`, `for`, `while`, `else`: they are names unless a call uses them. A variable called `for` or `else` is typed without the space after it (`for:=2`), or the conversion is undone with ⌘Z, which takes the keyword's space back as one step.
- **A definition's body as lines:** `f(x) :=` and Enter makes the body a block, the caret on its first line. Without it, a definition's body is one program, and climbing out of it ends the edit.
- The one thing with no keyword form: an else whose lines start with an `if` (`else` then `if ` is `else if`). It is typed as its text, `block(if(…), …)`.

| Keys | Tree | Text | Why |
|---|---|---|---|
| `if␣` | `\if{‸}{□}` | `if(?, ?)` | The keyword and a space: the program, the caret in its condition. |
| `if␣x>0{Enter}` | `\if{x>0}{‸}` | `if(x > 0, ?)` | Enter after the condition: into the branch. |
| `if␣x>0{Tab}1` | `\if{x>0}{1‸}` | `if(x > 0, 1)` | Tab too. |
| `if␣x>0{Enter}1{Enter}` | `\if{x>0}{\block{1⏎‸}}` | `if(x > 0, block(1, ?))` | A new line after the branch… |
| `if␣x>0{Enter}1{Enter}else␣` | `\if{x>0}{1}\else{‸}` | `if(x > 0, 1, ?)` | …where `else` and Space starts the else; the new line goes. |
| `if␣x>0{Enter}1{Enter}else{Enter}-1` | `\if{x>0}{1}\else{-1‸}` | `if(x > 0, 1, -1)` | Or `else` and Enter. |
| `if␣x>0{Enter}1{Enter}else␣if␣` | `\if{x>0}{1}\elif{‸}{□}` | `if(x > 0, 1, if(?, ?))` | `else if `: a branch, the caret in its condition. |
| `if␣x>0{Enter}1{Enter}else␣if␣x<0{Enter}-1{Enter}else{Enter}0{Enter}{Enter}` | `\if{x>0}{1}\elif{x<0}{-1}\else{0}‸ ⟶ finish` | `if(x > 0, 1, if(x < 0, -1, 0))` | Two Enters at the end: out of the else, then out of the formula. |
| `grade(x):=if␣x>=90{Enter}"A"{Enter}else␣if␣x>=80{Enter}"B"{Enter}else{Enter}"C"{Enter}{Enter}` | `grade(x)≔\if{x≥90}{"A"}\elif{x≥80}{"B"}\else{"C"}‸ ⟶ finish` | `grade(x) := if(x ≥ 90, "A", if(x ≥ 80, "B", "C"))` | #175's example, typed as written: stored as the nested `if`. |
| `y:=␣if␣b` | `y≔\if{b‸}{□}` | `y := if(b, ?)` | After `:=`, a value starts. |
| `⟦if(a, 1, if(b, 2, 3))⟧{Home}{→}{→}{→}{→}{Enter}else␣if␣` | `\if{a}{1}\elif{‸}{□}\elif{b}{2}\else{3}` | `if(a, 1, if(?, ?, if(b, 2, 3)))` | `else if ` after a branch in the middle: a branch after that one. |
| `⟦if(a, 1, 2)⟧{←}{Enter}else␣` | `\if{a}{1}\else{\block{2⏎else‸}}` | `if(a, 1, block(2, else))` | After the else, `else` has no `if` to attach to: a name. |
| `⟦block(if(a, 1), x)⟧{Home}{→}{→}{→}{→}{→}{Enter}{Enter}else␣` | `\block{\if{a}{1}\else{‸}⏎x}` | `block(if(a, 1, ?), x)` | On the line after an `if` statement of a block, too. |
| `if␣a{Enter}if␣b{Enter}1{Enter}else{Enter}2{Enter}{Enter}else{Enter}3` | `\if{a}{\if{b}{1}\else{2}}\else{3‸}` | `if(a, if(b, 1, 2), 3)` | One Enter out of the inner `if`'s else, and `else` is the outer `if`'s. |
| `iffy␣` | `iffy‸` | `iffy` | Never inside a name… |
| `x.for␣` | `x_{for}‸` | `x.for` | …a subscript… |
| `a␣if␣` | `a·if‸` | `a*if` | …or where no value starts. |
| `for:=2` | `for≔2‸` | `for := 2` | A variable called `for`: no space after it. |
| `else␣` | `else‸` | `else` | `else` with no `if` before it: a name. |
| `for␣` | `\for{‸}{□}{□}` | `for(?, ?, ?)` |  |
| `for␣i␣in␣1..n{Enter}s:=s+i` | `\for{i}{1..n}{s≔s+i‸}` | `for(i, 1..n, s := s + i)` | `in` goes on to the range, Enter into the body. |
| `for␣i∈1..n` | `\for{i}{1..n‸}{□}` | `for(i, 1..n, ?)` | `∈`… |
| `for␣i=1..n` | `\for{i}{1..n‸}{□}` | `for(i, 1..n, ?)` | …or `=`, as SMath writes it. |
| `for␣i{Enter}` | `\for{i}{‸}{□}` | `for(i, ?, ?)` |  |
| `while␣k<n{Enter}k:=k+1` | `\while{k<n}{k≔k+1‸}` | `while(k < n, k := k + 1)` |  |
| `for␣x␣in␣v{Enter}while␣x>0{Enter}x:=x-1` | `\for{x}{v}{\while{x>0}{x≔x-1‸}}` | `for(x, v, while(x > 0, x := x - 1))` | Nested, straight through. |
| `if␣a{Enter}while␣b{Enter}c` | `\if{a}{\while{b}{c‸}}` | `if(a, while(b, c))` |  |
| `total(n):={Enter}` | `total(n)≔\block{‸}` | `total(n) := block(?)` | Enter after `:=`: the body is a block of lines. |
| `x:={Enter}{Enter}` | `x≔‸ ⟶ finish` | `x := ?` | Its only line empty, Enter takes it away again. |
| `total(n):={Enter}s:=0{Enter}for␣i␣in␣1..n{Enter}s:=s+i{Enter}{Enter}s{Enter}{Enter}` | `total(n)≔\block{s≔0⏎\for{i}{1..n}{s≔s+i}⏎s}‸ ⟶ finish` | `total(n) := block(s := 0, for(i, 1..n, s := s + i), s)` | A function typed line by line: two Enters out of the loop's body, two out of the function. |
| `f(n):={Enter}c:=0{Enter}for␣i␣in␣1..n{Enter}if␣mod(i,2)==0{Enter}c:=c+1{Enter}{Enter}` | `f(n)≔\block{c≔0⏎\for{i}{1..n}{\block{\if{mod(i,2)=0}{c≔c+1}⏎‸}}}` | `f(n) := block(c := 0, for(i, 1..n, block(if(mod(i, 2) == 0, c := c + 1), ?)))` | Out of the `if`: a new line in the loop's body… |
| `f(n):={Enter}c:=0{Enter}for␣i␣in␣1..n{Enter}if␣mod(i,2)==0{Enter}c:=c+1{Enter}{Enter}{Enter}c` | `f(n)≔\block{c≔0⏎\for{i}{1..n}{\if{mod(i,2)=0}{c≔c+1}}⏎c‸}` | `f(n) := block(c := 0, for(i, 1..n, if(mod(i, 2) == 0, c := c + 1)), c)` | …then out of the loop, a new line of the function. |
| `f(n):={Enter}c:=0{Enter}for␣i␣in␣1..n{Enter}if␣i>2{Enter}c:=1{Enter}{Enter}{Enter}if␣c>0{Enter}c{Enter}else{Enter}0` | `f(n)≔\block{c≔0⏎\for{i}{1..n}{\if{i>2}{c≔1}}⏎\if{c>0}{c}\else{0‸}}` | `f(n) := block(c := 0, for(i, 1..n, if(i > 2, c := 1)), if(c > 0, c, 0))` |  |

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
9. **Programs typed as written:** for every program in the repository and 600 random ones (chains, loops, blocks nested any way), typing it with keywords and Enter (§ Typing programs) stores exactly its text and builds the tree typing its text builds; the invariants 1–4 hold for random keys in programs, keywords included.

## Tests

- `app/src/mathTree.test.ts`: the tables of this page, row by row, and invariants 1–4, undo, clipboard, templates, hints.
- `app/src/mathTree.engine.test.ts`: invariants 5–8 against the engine itself, `crates/quire-web` as WebAssembly, through a `parse` command that returns the strict tree, its canonical text and the forgiving preview. It needs `app/web-public/quire_web.wasm` (`npm run wasm`); without it the file is skipped, except on CI, where it fails. CI builds the web version before the unit tests for this.
- A new row for these tables: list its keys in a file, one per line, and run `MATHTREE_DUMP=<file> npx vitest run src/mathTree.test.ts -t dump`; `<file>.out` has the rows as the model gives them, to check by eye before they go here with their reason.
- `QUIRE_ROUNDTRIP_CORPUS=<folder>` runs the round trip over every `.quire`, `.quirez` and `.sm` file in a folder as well (SMath files converted as the app converts them).

## For phase 2

`hints(state)` is what to draw besides the tree: the caret and the selection, the slots to draw as □ (`empty`), operands not typed yet (`missing`, as `M ≔ □`), faint `)` (`ghosts`), fractions the text puts in brackets (`bracketed`, so `c·(a/b)` is drawn with them while editing as after), exponents with no base (`noBase`), and the slots open for typing (`open`). Every row and structure has a stable id, kept across keys, for `data-*` attributes on the MathML.

What phase 2 must take care of:

- **Draw the tree as the view draws the stored formula,** or the formula will jump when the edit ends: brackets that are a slot's own (`kept`, or around a whole numerator, denominator, exponent, radicand) are not drawn; an index is a subscript; `A.b^2` is one msubsup; flat units (`80 km/h`) if that setting is on; programs (`if`, `for`, `block`) on rows (phase 3a: they are structures of the tree, § Programs).
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

## Phase 3a: programs, word jumps, a screen reader

- **Programs are structures of the tree** (`if`, `block`, `for`, `while` kinds in mathTree.ts), drawn by math.ts's own program code, so they stand on the rows the view draws (§ Programs). A chain is one `if` node whose slots run condition, value, …, else; `chains()` keeps it one node whatever is typed, and mathLinear `ifCall` writes it back as the nested calls the text stores. A block drawn from a definition's header (`f(x) :=` level with its first line) marks its statements' cells `data-part`, from which the editor takes the block's box.
- **If-chains are drawn as rows for everyone** (#175), with the setting off too, and in Word export (§ Programs).
- **Word jumps** ⌥← ⌥→ (§ Word jumps).
- **A screen reader** hears where the caret is when it goes to another slot, in a polite live region (mathPlace.ts, in the words of speech.ts): "in the denominator of q times L squared over 8", "in the exponent", "in the else branch", "on line 2 of 3 of the block"; and what a key deleted: "deleted 8", "removed the fraction", "removed line 2", "removed the else branch". Nothing is said for a character typed into the same slot. `effect.deleted` is what the model deleted.
- **Nothing moves when the edit ends**, a line with an error included: the view draws `= □` (and the unit typed after it) for a line that asks for a result it has none for, as the editor draws it while it is typed (math.ts `mathml(…, pending)`).

**Phase 3a, second part.** Programs typed as written (§ Typing programs); the rule down every program's lines and every program centred on its line (§ Programs). Invariant 9 below: typing a program's text or typing it as written builds the same tree (`naturalKeys.ts` types any program the second way, for the tests).

Left for phase 3b: inline math in text (`richtext.ts`, the `$…$` node view), then making in-place editing the default (and retiring the linear box behind it).
