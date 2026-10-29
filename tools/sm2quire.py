#!/usr/bin/env python3
"""Convert an SMath Studio worksheet (.sm, XML) into a Quire document bundle.

    python3 -I tools/sm2quire.py input.sm [output.quire]

Produces a directory bundle:
    output.quire/
        document.json   canonical, Git-friendly source (see docs/02-file-format.md)
        results.json    results cached by SMath, keyed by region id (regression oracle)
        assets/         content-addressed binaries (images, unmapped legacy XML)

Standard library only. Deterministic: converting the same file twice yields
byte-identical output.
"""
import base64
import csv
import hashlib
import io
import json
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter
from pathlib import Path

NS = "{http://smath.info/schemas/worksheet/1.0}"
FORMAT = "quire/1"


def tag(el):
    return el.tag.replace(NS, "")


def child(el, name):
    return el.find(NS + name)


def children(el, name):
    return el.findall(NS + name)


# ---------------------------------------------------------------------------
# Math: SMath RPN token stream -> AST -> Quire linear syntax
# ---------------------------------------------------------------------------

# precedence (higher binds tighter); assoc only matters for binary ops
BINARY = {
    # in the .sm file ≡ is SMath's boolean equal (shown as a bold =) and ≈ its
    # approximately-equal comparison: both test equality, they are not definitions
    ":": (":=", 0), "≡": ("==", 3), "≈": ("==", 3),
    "|": ("or", 1), "&": ("and", 2),
    "=": ("==", 3), "≠": ("≠", 3), "<": ("<", 3), ">": (">", 3), "≤": ("≤", 3), "≥": ("≥", 3),
    "+": ("+", 4), "-": ("-", 4), "±": ("±", 4),
    "*": ("*", 5), "/": ("/", 5), "%": ("%", 5),
    "^": ("^", 7),
}
UNARY_PREC = 6
POSTFIX_PREC = 8
ATOM_PREC = 10

# SMath (Russian-tradition) names -> canonical Quire names
RENAME = {
    "tg": "tan", "ctg": "cot", "sh": "sinh", "ch": "cosh", "th": "tanh", "cth": "coth",
    "arctg": "atan", "arcctg": "acot", "arcsin": "asin", "arccos": "acos",
    "arcsec": "asec", "arccosec": "acsc", "cosec": "csc", "lg": "log10",
    "nthroot": "root",
}


class Node:
    __slots__ = ("kind", "value", "args")

    def __init__(self, kind, value=None, args=()):
        self.kind, self.value, self.args = kind, value, list(args)


EMPTY_UNIT = Node("unit", "")


def rpn_to_ast(tokens):
    stack = []
    for e in tokens:
        typ, text = e.get("type"), (e.text or "")
        style = e.get("style")
        if typ == "operand":
            if style == "unit":
                stack.append(Node("unit", text) if text else EMPTY_UNIT)
            elif style == "string":
                stack.append(Node("str", text))
            elif re.fullmatch(r"[0-9]+(\.[0-9]*)?([eE][+-]?[0-9]+)?", text):
                stack.append(Node("num", text))
            elif text == ".":  # SMath filler dot in illustrative matrices
                stack.append(Node("id", "…"))
            else:
                stack.append(Node("id", text))
        elif typ == "bracket":
            stack.append(Node("paren", args=[stack.pop()]))
        elif typ in ("operator", "function"):
            n = int(e.get("args") or 0)
            args = stack[len(stack) - n:] if n else []
            del stack[len(stack) - n:]
            if typ == "operator":
                kind = {1: "unary", 2: "binary"}.get(n, "call")
                if kind == "unary" and text == "!":
                    kind = "postfix"
                stack.append(Node(kind, text, args))
            else:
                stack.append(Node("call", text, args))
        else:
            raise ValueError(f"unknown token type {typ!r}")
    if len(stack) != 1:
        raise ValueError(f"malformed RPN ({len(stack)} items left)")
    return stack[0]


def prec(n):
    if n.kind == "binary":
        if n.value == "*" and is_quantity(n):
            return 5
        return BINARY.get(n.value, (n.value, 5))[1]
    if n.kind == "unary":
        return UNARY_PREC
    if n.kind == "postfix":
        return POSTFIX_PREC
    if n.kind == "num" and n.value.startswith("-"):
        return UNARY_PREC
    return ATOM_PREC


def is_unit_expr(n):
    if n.kind == "unit":
        return True
    if n.kind == "binary" and n.value in ("*", "/"):
        return all(is_unit_expr(a) for a in n.args)
    if n.kind == "binary" and n.value == "^":
        return is_unit_expr(n.args[0]) and n.args[1].kind in ("num", "unary")
    return False


def is_quantity(n):
    """`5.1 'm`, `64 'kgf*'m` -> printed as juxtaposition."""
    return (n.kind == "binary" and n.value == "*" and n.args[0].kind == "num"
            and is_unit_expr(n.args[1]))


def fmt_id(name):
    # SMath names may end in primes (σ', f''); in Quire ' marks a unit, so use ′
    return name.replace("'", "′")


def fmt_str(s):
    return json.dumps(s, ensure_ascii=False)


def to_linear(n, units_bare=False):
    """Print AST as Quire linear syntax. units_bare: print `kgf` instead of `'kgf`."""
    k = n.kind
    if k == "num":
        return n.value
    if k == "id":
        return fmt_id(n.value)
    if k == "str":
        return fmt_str(n.value)
    if k == "unit":
        return n.value if units_bare else "'" + n.value
    if k == "paren":
        return "(" + to_linear(n.args[0], units_bare) + ")"
    if k == "unary":
        a = n.args[0]
        s = to_linear(a, units_bare)
        if prec(a) < UNARY_PREC:
            s = f"({s})"
        return n.value + s
    if k == "postfix":
        a = n.args[0]
        s = to_linear(a, units_bare)
        if prec(a) < POSTFIX_PREC:
            s = f"({s})"
        return s + n.value
    if k == "binary":
        a, b = n.args
        # the SMath empty unit `''` is a dimensionless marker: `1 ''` -> `1`
        if n.value == "*" and b is EMPTY_UNIT:
            return to_linear(a, units_bare)
        if n.value == "*" and a is EMPTY_UNIT:
            return to_linear(b, units_bare)
        op, p = BINARY.get(n.value, (n.value, 5))
        right_assoc = op == "^"
        sa, sb = to_linear(a, units_bare), to_linear(b, units_bare)
        if prec(a) < p or (right_assoc and prec(a) == p):
            sa = f"({sa})"
        if prec(b) < p or (not right_assoc and prec(b) == p and op not in ("*", "+")):
            sb = f"({sb})"
        if is_quantity(n):
            return f"{sa} {sb}"
        if op in ("*", "/", "^"):
            return f"{sa}{op}{sb}"
        return f"{sa} {op} {sb}"
    if k == "call":
        name, args = n.value, n.args
        if name == "mat" and len(args) >= 2 and args[-2].kind == "num" and args[-1].kind == "num":
            r, c = int(args[-2].value), int(args[-1].value)
            cells = [to_linear(a, units_bare) for a in args[:-2]]
            rows = ["  " + ", ".join(cells[i * c:(i + 1) * c]) for i in range(r)]
            if r * c <= 6:
                return "[" + "; ".join(x.strip() for x in rows) + "]"
            return "[\n" + ";\n".join(rows) + "\n]"
        if name == "el" and len(args) >= 2:
            base = to_linear(args[0], units_bare)
            if prec(args[0]) < ATOM_PREC:
                base = f"({base})"
            return base + "[" + ", ".join(to_linear(a, units_bare) for a in args[1:]) + "]"
        name = RENAME.get(name, name)
        return name + "(" + ", ".join(to_linear(a, units_bare) for a in args) + ")"
    raise ValueError(k)


# ---------------------------------------------------------------------------
# Spreadsheets read by importData: carried inside the document
# ---------------------------------------------------------------------------

XLSX_NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"


def col_index(ref):
    """`AB12` -> (11, 27), zero-based."""
    m = re.fullmatch(r"([A-Za-z]+)(\d+)", ref)
    col = 0
    for ch in m.group(1).upper():
        col = col * 26 + ord(ch) - 64
    return int(m.group(2)) - 1, col - 1


def cell_value(text):
    try:
        v = float(text)
    except (TypeError, ValueError):
        return text
    return int(v) if v.is_integer() and abs(v) < 2**53 else v


def read_xlsx(path):
    """{sheet: rows from A1} with numbers, strings and None, using only the standard library."""
    z = zipfile.ZipFile(path)
    names = set(z.namelist())
    shared = []
    if "xl/sharedStrings.xml" in names:
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", XLSX_NS):
            shared.append("".join(t.text or "" for t in si.iter(f"{{{XLSX_NS['m']}}}t")))
    rels = {}
    for rel in ET.fromstring(z.read("xl/_rels/workbook.xml.rels")):
        target = rel.get("Target").lstrip("/")
        rels[rel.get("Id")] = target if target.startswith("xl/") else "xl/" + target
    sheets = {}
    for sh in ET.fromstring(z.read("xl/workbook.xml")).find("m:sheets", XLSX_NS):
        rows = {}
        for c in ET.fromstring(z.read(rels[sh.get(REL_NS)])).iter(f"{{{XLSX_NS['m']}}}c"):
            r, col = col_index(c.get("r"))
            t, v = c.get("t"), c.find("m:v", XLSX_NS)
            if t == "s" and v is not None:
                val = shared[int(v.text)]
            elif t == "inlineStr":
                val = "".join(x.text or "" for x in c.iter(f"{{{XLSX_NS['m']}}}t"))
            elif t in ("str", "e"):
                val = v.text if v is not None else None
            elif t == "b":
                val = int(v.text) if v is not None else None
            else:
                val = cell_value(v.text) if v is not None else None
            if val is not None and val != "":
                rows.setdefault(r, {})[col] = val
        if rows:
            width = max(max(cols) for cols in rows.values()) + 1
            sheets[sh.get("name")] = [
                [rows.get(r, {}).get(c) for c in range(width)] for r in range(max(rows) + 1)
            ]
        else:
            sheets[sh.get("name")] = []
    return sheets


def read_csv(path):
    text = Path(path).read_bytes().decode("utf-8-sig", errors="replace")
    dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;	") if text.strip() else csv.excel
    rows = [[cell_value(x.replace(",", ".")) if re.fullmatch(r"-?[\d.,]+(e-?\d+)?", x.strip()) else (x or None)
             for x in row] for row in csv.reader(io.StringIO(text), dialect)]
    return {"Sheet1": rows}


def unescape_sm(s):
    r"""SMath option text: `"Classe\0020\6x19"` -> `Classe 6x19` (\hhhh\ is a character)."""
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] == '"':
        s = s[1:-1]
    return re.sub(r"\\([0-9A-Fa-f]{4})\\", lambda m: chr(int(m.group(1), 16)), s)


def math_expr(container):
    """container is an <input>/<result>/<contract> element holding <e> tokens."""
    if container is None:
        return None
    toks = children(container, "e")
    if not toks:
        return None
    return rpn_to_ast(toks)


# ---------------------------------------------------------------------------
# Text: SMath XHTML-ish paragraphs -> Djot
# ---------------------------------------------------------------------------

DJOT_ESCAPE = re.compile(r"([\\*_\[\]{}`~^$<])")


def esc(s):
    return DJOT_ESCAPE.sub(r"\\\1", s)


def css(style):
    out = {}
    for part in (style or "").split(";"):
        if ":" in part:
            k, v = part.split(":", 1)
            out[k.strip().lower()] = v.strip()
    return out


def wrap_inline(text, st):
    if not text.strip():
        return text
    lead = text[: len(text) - len(text.lstrip())]
    trail = text[len(text.rstrip()):]
    core = text.strip()
    attrs = []
    if st.get("text-decoration") == "underline":
        attrs.append(".underline")
    if st.get("text-decoration") == "line-through":
        attrs.append(".strike")
    color = st.get("color", "").lower()
    if color and color not in ("#000000", "black"):
        attrs.append(f"color={color}")
    if st.get("font-style") == "italic":
        core = f"_{core}_"
    if st.get("font-weight") == "bold":
        core = f"*{core}*"
    if attrs:
        core = f"[{core}]{{{' '.join(attrs)}}}"
    return lead + core + trail


def ws(s):
    """XML pretty-print whitespace (runs containing a newline) is not content."""
    s = s or ""
    if not s.strip() and "\n" in s:
        return ""
    return re.sub(r"\s*\n\s*", " ", s)


# SMath embeds math in text as `\\[REGION[<id>]]\\` markers; they become Djot inline
# math ($`expr`), which Quire evaluates in place. Filled per text region by Converter.text.
REGION_MARKER = re.compile(r"\\\[REGION\[([0-9A-Za-z]+)\]\]\\")
INLINE_MATH = {}
INLINE_ORDER = []


def esc_text(s):
    out, pos = [], 0
    for m in REGION_MARKER.finditer(s):
        out.append(esc(s[pos:m.start()]))
        if m.group(1) in INLINE_MATH:
            out.append(INLINE_MATH[m.group(1)])
            INLINE_ORDER.append(m.group(1))
        pos = m.end()
    out.append(esc(s[pos:]))
    return "".join(out)


def inline_djot(el):
    """Render the children of <p>/<span> as Djot inline text."""
    parts = [esc_text(ws(el.text))]
    for c in el:
        t = tag(c)
        if t == "br":
            parts.append("\\\n")
        elif t == "span":
            inner = inline_djot(c)
            parts.append(wrap_inline(inner, css(c.get("style"))))
        else:
            parts.append(inline_djot(c))
        parts.append(esc_text(ws(c.tail)))
    return "".join(parts)


HEADING_RE = re.compile(r"^\*?(\d+(?:\.\d+)*)\.?\*?\s+(.+)$")
CAPTION_RE = re.compile(r"^(Figura|Figure|Fig\.|Tabela|Table|Gráfico|Chart)\s*(\d+)\s*[–—-]\s*(.+)$", re.I)


def paragraphs(text_el):
    """-> list of (djot_paragraph, paragraph_css) for one <text> language variant."""
    holder = child(text_el, "content")
    holder = holder if holder is not None else text_el
    out = []
    for p in children(holder, "p"):
        st = css(p.get("style"))
        if p.get("bold") == "true":  # 0.55-era attribute
            st["font-weight"] = "bold"
        body = inline_djot(p).strip(" ")
        # drop leading indentation hacks and trailing hard breaks
        body = re.sub(r"^(?:\\\n)+", "", body)
        body = re.sub(r"(?:\\\n)+$", "", body).strip()
        body = re.sub(r"\n +", "\n", body)
        if st.get("font-weight") == "bold" and body and not body.startswith("*"):
            body = wrap_inline(body, {"font-weight": "bold"})
        out.append((body, st))
    return out


def para_block(body, st, region_font):
    attrs = []
    align = st.get("text-align")
    if align in ("center", "right", "justify"):
        attrs.append("." + align)
    size = st.get("font-size", "").replace("px", "").replace("pt", "")
    if size and region_font.get("size") and float(size) != float(region_font["size"]):
        attrs.append(f"size={size.rstrip('0').rstrip('.') if '.' in size else size}")
    fam = st.get("font-family")
    if fam and fam != region_font.get("family"):
        attrs.append(f'font="{fam}"')
    return ("{" + " ".join(attrs) + "}\n" if attrs else "") + body


def plain(djot):
    """Strip Djot markup for pattern matching."""
    s = re.sub(r"\{[^}]*\}", "", djot)
    s = re.sub(r"\\(.)", r"\1", s)
    return s.replace("*", "").replace("_", "").replace("[", "").replace("]", "").strip()


# ---------------------------------------------------------------------------
# Converter
# ---------------------------------------------------------------------------

LANG = {"eng": "en", "rus": "ru", "por": "pt", "deu": "de", "fra": "fr", "spa": "es", "ita": "it", "cpp": None}
PAPER = {9: "A4", 1: "Letter", 5: "Legal", 8: "A3", 11: "A5"}


class Converter:
    def __init__(self, src: Path, out: Path):
        self.src, self.out = src, out
        self.assets = {}  # sha -> filename
        self.results = {}
        self.ids = set()
        self.seq = 0
        self.stats = Counter()
        self.warnings = []
        self.math_sizes = Counter()
        self.text_fonts = Counter()

    # -- ids & assets -------------------------------------------------------
    def new_id(self, hint=""):
        alphabet = "abcdefghijkmnpqrstuvwxyz23456789"
        self.seq += 1
        h = int(hashlib.sha1(f"{self.seq}:{hint}".encode()).hexdigest(), 16)
        while True:
            rid = "".join(alphabet[(h >> (5 * i)) & 31] for i in range(6))
            if rid not in self.ids:
                self.ids.add(rid)
                return rid
            h //= 7

    def asset(self, data: bytes, ext: str):
        sha = hashlib.sha256(data).hexdigest()
        name = f"assets/{sha[:16]}.{ext}"
        if sha not in self.assets:
            self.assets[sha] = (name, data)
        return name

    # -- document -----------------------------------------------------------
    def run(self):
        global NS
        root = ET.parse(self.src).getroot()
        # SMath >= 0.96 uses a namespaced <worksheet>; 0.55-era files are bare <regions>
        NS = root.tag[: root.tag.index("}") + 1] if root.tag.startswith("{") else ""
        settings = child(root, "settings")
        doc = {"format": FORMAT}
        doc["meta"] = self.meta(settings)
        doc["settings"] = self.calc_settings(settings)
        doc["page"] = self.page(settings)

        regions_el = root if tag(root) == "regions" else child(root, "regions")
        regions = self.region_list(regions_el, (0, 0)) if regions_el is not None else []
        self.attach_captions(regions)
        doc["styles"] = self.styles()
        self.strip_default_fonts(regions, doc["styles"])
        doc["regions"] = regions
        data = self.data_files(regions)
        if data:
            doc["data"] = data
        if not doc["page"]:
            del doc["page"]
        deps = self.dependencies(settings)
        if deps:
            doc["requires"] = deps
        return doc

    def meta(self, settings):
        meta = {}
        authors, titles, langs = [], {}, []
        for m in children(settings, "metadata") if settings is not None else []:
            lang = m.get("lang")
            a = child(m, "author")
            if a is not None and a.text and a.text not in authors:
                authors.append(a.text)
            t = child(m, "title")
            if t is not None and t.text:
                titles[LANG.get(lang) or lang] = t.text
            langs.append(lang)
        if titles:
            meta["title"] = next(iter(titles.values())) if len(titles) == 1 else titles
        if authors:
            meta["authors"] = authors
        ident = child(settings, "identity") if settings is not None else None
        if ident is not None and child(ident, "id") is not None:
            meta["id"] = child(ident, "id").text
        if "por" in langs:
            meta["lang"] = "pt-BR"
        meta["source"] = {"app": "SMath Studio", "file": self.src.name}
        return meta

    def calc_settings(self, settings):
        calc = child(settings, "calculation") if settings is not None else None
        # SMath keeps a formula that reads a name defined further down
        out = {"calc": {"definitions": "smath"}}
        if calc is None:
            return out
        g = lambda n: (child(calc, n).text if child(calc, n) is not None else None)
        c = {}
        if g("precision"):
            c["decimals"] = int(g("precision"))
        if g("exponentialThreshold"):
            c["exponentialThreshold"] = int(g("exponentialThreshold"))
        if g("trailingZeros") == "true":
            c["trailingZeros"] = True
        if g("fractions") and g("fractions") != "decimal":
            c["fractions"] = g("fractions")
        if g("approximateEqualAccuracy"):
            c["approxEqualDigits"] = int(g("approximateEqualAccuracy"))
        out["display"] = c
        return out

    def page(self, settings):
        pm = child(settings, "pageModel") if settings is not None else None
        if pm is None:
            return {}
        page = {"view": "pages" if pm.get("active") == "true" else "canvas"}
        paper = child(pm, "paper")
        if paper is not None:
            pid = int(paper.get("id", 0))
            page["paper"] = PAPER.get(pid) or [f"{int(paper.get('width')) * 0.254:.1f}mm",
                                             f"{int(paper.get('height')) * 0.254:.1f}mm"]
            if paper.get("orientation", "Portrait").lower() != "portrait":
                page["orientation"] = "landscape"
        mg = child(pm, "margins")
        if mg is not None:
            # Stored in hundredths of an inch, but SMath lays pages out at 72 dpi against
            # 96-px region coordinates, so the effective margin is 3/4 of the nominal one.
            # Calibrated on a real report: its text width and letterhead form only line up
            # with 0.75 × nominal.
            mm = lambda k: f"{int(mg.get(k)) * 0.254 * 0.75:.1f}mm".replace(".0mm", "mm")
            page["margins"] = {k: mm(k) for k in ("top", "right", "bottom", "left")}
        for which in ("header", "footer"):
            h = child(pm, which)
            if h is not None and (h.text or "").strip():
                page[which] = self.header_footer(h)
        bgs = child(pm, "backgrounds")
        if bgs is not None:
            out = []
            for img in children(bgs, "image"):
                data = base64.b64decode(img.text or "")
                ext = "png" if data[:4] == b"\x89PNG" else "jpg"
                b = {"pages": img.get("page", "all"), "src": self.asset(data, ext)}
                b["fit"] = "page" if img.get("fullPage") == "true" else "margins"
                out.append(b)
                self.stats["background"] += 1
            if out:
                page["backgrounds"] = out
        return page

    def header_footer(self, h):
        fields = {"DATE": "{date}", "TIME": "{time}", "FILENAME": "{file}", "PAGENUM": "{page}",
                  "COUNT": "{pages}", "AUTHOR": "{author}", "COMPANY": "{company}", "TITLE": "{title}"}
        text = re.sub(r"&\[([A-Z]+)\]", lambda m: fields.get(m.group(1), m.group(0)), h.text)
        # SMath users right-align with runs of spaces; split them into real slots
        parts = [p.strip() for p in re.split(r" {3,}", text) if p.strip()]
        align = h.get("alignment", "Center").lower()
        if len(parts) == 1:
            out = {align: parts[0]}
        elif len(parts) == 2:
            out = {"left": parts[0], "right": parts[1]}
        else:
            out = {"left": parts[0], "center": " ".join(parts[1:-1]), "right": parts[-1]}
        if h.get("color"):
            out["color"] = h.get("color").lower()
        return out

    def dependencies(self, settings):
        deps = child(settings, "dependencies") if settings is not None else None
        out = []
        known = {"SMath Core", "MathRegion", "TextRegion", "PictureRegion", "AreaRegion"}
        for a in children(deps, "assembly") if deps is not None else []:
            if a.get("name") not in known:
                out.append(f"smath:{a.get('name')}@{a.get('version')}")
        return out

    # -- regions ------------------------------------------------------------
    def region_list(self, parent, origin):
        out = []
        for r in children(parent, "region"):
            out.extend(self.region(r, origin))
        out.sort(key=lambda r: (r["at"][1], r["at"][0]))
        return out

    def base(self, r, origin, kind):
        x = int(r.get("left", 0)) - origin[0]
        y = int(r.get("top", 0)) - origin[1]
        reg = {"id": self.new_id(r.get("id") or f"{x},{y}"), "kind": kind, "at": [x, y]}
        if r.get("isBreakable") == "false":
            reg["keep"] = True
        if r.get("enabled") == "false":
            reg["disabled"] = True
        bg = (r.get("bgColor") or "").lower()
        if bg and bg not in ("#ffffff", "white", "transparent"):
            reg["background"] = bg
        if r.get("border") == "true":
            reg["border"] = True
        color = (r.get("color") or "#000000").lower()
        if color != "#000000":
            reg["color"] = color
        return reg

    def region(self, r, origin):
        kids = [c for c in r if tag(c) != "region"]
        if not kids:
            return []
        body = kids[0]
        t = tag(body)
        self.stats[t] += 1
        try:
            if t == "math":
                return [self.math(r, body, origin)]
            if t == "text":
                return self.text(r, kids, origin)
            if t == "picture":
                return [self.picture(r, body, origin)]
            if t == "area":
                return self.area(r, body, origin)
            if t == "table":
                return [self.table(r, body, origin)]
            if t == "plot":
                return [self.plot(r, body, origin)]
            if t == "pagebreak":
                return [self.base(r, origin, "pagebreak")]
            if t == "radiobuttonlist":
                return [self.radio(r, body, origin)]
        except Exception as ex:  # never lose content: fall through to legacy
            self.warnings.append(f"region at top={r.get('top')}: {t}: {ex}")
        return [self.legacy(r, t, origin)]

    def legacy(self, r, t, origin):
        self.stats["legacy:" + t] += 1
        reg = self.base(r, origin, "legacy")
        reg["size"] = [int(r.get("width", 0)), int(r.get("height", 0))]
        raw = ET.tostring(r, encoding="utf-8")
        reg["legacy"] = {"format": f"smath:{t}", "src": self.asset(raw, "xml")}
        return reg

    def math(self, r, m, origin):
        reg = self.base(r, origin, "math")
        inp = child(m, "input")
        ast = math_expr(inp if inp is not None else m)  # 0.55-era: tokens directly under <math>
        if ast is None:
            raise ValueError("empty math")
        reg["expr"] = to_linear(ast)
        result = child(m, "result")
        fmt = {}
        contract = math_expr(child(m, "contract"))
        if contract is not None:
            fmt["unit"] = to_linear(contract, units_bare=True)
        if m.get("decimalPlaces"):
            fmt["decimals"] = int(m.get("decimalPlaces"))
        if result is not None:
            reg["show"] = "symbolic" if result.get("action") == "symbolic" else "value"
            val = math_expr(result)
            if val is not None:
                shown = to_linear(val)
                if contract is not None:
                    # `2.06*10^5 'mm^3` would read as 10^(5 mm³): only a plain number takes a space
                    sep = " " if re.fullmatch(r"-?[0-9.]+", shown) else "*"
                    shown += sep + to_linear(contract)
                self.results[reg["id"]] = shown
        if fmt:
            reg["display"] = fmt
        opt = m.get("optimize")
        if opt in ("1", "2"):
            reg["mode"] = {"1": "symbolic", "2": "numeric"}[opt]
        if r.get("showInputData", "").lower() == "false" and reg.get("show"):
            reg["hideInput"] = True
        desc = child(m, "description")
        if desc is not None and desc.get("active") == "true":
            note = "\n\n".join(b for b, _ in paragraphs(desc) if b)
            if note:
                reg["note"] = note
                if desc.get("position", "Right") != "Right":
                    reg["notePosition"] = desc.get("position").lower()
        self.math_sizes[r.get("fontSize", "10")] += 1
        return reg

    def data_files(self, regions):
        """Spreadsheets named in importData(…) and found next to the .sm, read into the document."""
        wanted = []
        def walk(rs):
            for r in rs:
                for m in re.finditer(r'importData(?:\.\w+)?\("([^"]+)"', r.get("expr", "")):
                    if m.group(1) not in wanted:
                        wanted.append(m.group(1))
                walk(r.get("regions", []))
        walk(regions)
        # the .sm's folder first, then up to two folders above it (a shared table)
        folders = []
        if wanted:
            d = self.src.resolve().parent
            for _ in range(3):
                folders.append({p.name.lower(): p for p in d.iterdir()} if d.is_dir() else {})
                d = d.parent
        data = {}
        for name in wanted:
            base = re.split(r"[\\/]", name)[-1]
            found = next(((up, f[base.lower()]) for up, f in enumerate(folders) if base.lower() in f), None)
            if found is None:
                self.warnings.append(f"importData: {base} is not next to {self.src.name}; its tables stay empty")
                continue
            up, path = found
            if up > 0:
                self.warnings.append(f"importData: {base} read from {path}")
            try:
                data[base] = read_csv(path) if path.suffix.lower() in (".csv", ".txt") else read_xlsx(path)
            except Exception as ex:  # a damaged or old .xls file: say so, keep going
                self.warnings.append(f"importData: cannot read {base}: {ex}")
        return data

    def radio(self, r, rb, origin):
        """SMath's option list, defining the variable in <input>. output="Default": the number
        of the chosen option (from 1); output="Element": the chosen row's element in column
        outputColumn of the table named by the input attribute. The options go in the note."""
        reg = self.base(r, origin, "math")
        var = math_expr(child(rb, "input"))
        if var is None or var.kind != "id":
            raise ValueError("option list without a variable")
        chosen = int(rb.get("selected") or 1)
        value = str(chosen)
        if rb.get("output") == "Element" and rb.get("input"):
            value = f"{fmt_id(rb.get('input'))}[{chosen}, {int(rb.get('outputColumn') or 1)}]"
        reg["expr"] = f"{to_linear(var)} := {value}"
        items = [unescape_sm(li.text or "") for li in children(child(rb, "ul"), "li")]
        # a Djot list, the chosen option in bold
        reg["note"] = "\n".join(
            f"- *{k} = {esc(item)}* ✓" if k == chosen else f"- {k} = {esc(item)}"
            for k, item in enumerate(items, 1)
        )
        return reg

    def text(self, r, variants, origin):
        reg = self.base(r, origin, "text")
        texts = [v for v in variants if tag(v) == "text"]
        first = texts[0]
        # embedded math regions become inline math; anything else is hoisted below
        INLINE_MATH.clear()
        cached = {}
        for v in texts:
            sub = child(v, "regions")
            for e in children(sub, "region") if sub is not None else []:
                m = child(e, "math")
                inp = child(m, "input") if m is not None else None
                ast = math_expr(inp) if inp is not None else None
                if ast is None or not e.get("id"):
                    continue
                shown = child(m, "result") is not None
                INLINE_MATH[e.get("id")] = "$`" + to_linear(ast) + (" =" if shown else "") + "`"
                val = math_expr(child(m, "result")) if shown else None
                if val is not None:
                    cached[e.get("id")] = to_linear(val)
        INLINE_ORDER.clear()
        font = {"family": first.get("fontFamily") or "Arial", "size": first.get("fontSize") or r.get("fontSize") or "10"}
        by_lang = {}
        for v in texts:
            paras = paragraphs(v)
            # promote a uniformly-sized single paragraph's font size to the region
            sizes = {p[1].get("font-size", "").replace("px", "") for p in paras} - {""}
            if len(sizes) == 1:
                font["size"] = sizes.pop()
            fams = {p[1].get("font-family") for p in paras} - {None}
            if len(fams) == 1:
                font["family"] = fams.pop()
            blocks = [para_block(b, st, font) for b, st in paras if b]
            lang = LANG.get(v.get("lang"), v.get("lang"))
            by_lang[lang or "und"] = "\n\n".join(blocks)
        if len(set(by_lang.values())) <= 1:
            reg["text"] = next(iter(by_lang.values()), "")
        else:
            reg["text"] = by_lang
        # inline math ids follow their order in the (first) text: <region id>:m<n>
        order = INLINE_ORDER[: len(INLINE_ORDER) // max(1, len(texts))]
        for n, src_id in enumerate(order):
            if src_id in cached:
                self.results[f"{reg['id']}:m{n}"] = cached[src_id]
        self.stats["inline-math"] += len(order)
        if first.get("width"):
            reg["width"] = int(first.get("width"))
        reg["font"] = font
        self.text_fonts[(font["family"], font["size"])] += 1
        # heading detection: "1. ASSUMPTIONS" / "*7. CONCLUSION*" -> auto-numbered heading
        body = re.sub(r"^\{[^}\n]*\}\n", "", reg["text"]) if isinstance(reg["text"], str) else "\n"
        if "\n" not in body:
            m = HEADING_RE.match(plain(body))
            if m and body.startswith("*") and len(m.group(2)) < 80:
                level = m.group(1).count(".") + 1
                reg["text"] = "#" * level + " " + esc(m.group(2).strip())
                self.stats["heading"] += 1
        out = [reg]
        # other regions embedded in text are hoisted to siblings at absolute positions
        for v in texts:
            sub = child(v, "regions")
            if sub is not None:
                inner_origin = (origin[0] - int(r.get("left", 0)), origin[1] - int(r.get("top", 0)))
                for e in children(sub, "region"):
                    if e.get("id") not in INLINE_MATH:
                        out.extend(self.region(e, inner_origin))
                        self.stats["hoisted"] += 1
        if not reg["text"] and len(out) > 1:
            out.pop(0)
        return out

    def picture(self, r, p, origin):
        reg = self.base(r, origin, "image")
        raw = child(p, "raw")
        data = base64.b64decode(raw.text or "")
        reg["src"] = self.asset(data, raw.get("format", "png"))
        reg["size"] = [int(r.get("width")), int(r.get("height"))]
        return reg

    def area(self, r, a, origin):
        if a.get("terminator") == "true":
            return []
        reg = self.base(r, origin, "area")
        top = int(r.get("top", 0))
        reg["at"][0] = 0
        title = child(a, "title")
        if title is not None:
            t = "\n\n".join(b for b, _ in paragraphs(title) if b)
            if t:
                reg["title"] = t
        if a.get("collapsed") == "true":
            reg["collapsed"] = True
        if a.get("locked") == "true":
            reg["locked"] = True
        inner = [c for c in children(r, "region")]
        term = [c for c in inner if child(c, "area") is not None and child(c, "area").get("terminator") == "true"]
        if term:
            reg["height"] = int(term[-1].get("top")) - top
        reg["regions"] = self.region_list(r, (int(origin[0]), top))
        return [reg]

    def table(self, r, t, origin):
        reg = self.base(r, origin, "table")
        reg["size"] = [int(r.get("width")), int(r.get("height"))]
        layout = child(t, "regions")
        body = child(layout, "body") if layout is not None else None
        bound = [e.text for e in children(child(t, "inputs"), "e") if e.get("regions") == "rows"]
        reg["source"] = bound[0] if bound else None
        if body is not None:
            # SMath tables display a matrix variable; the matrix's first row/column
            # act as headers. Cell values are recomputed live, never stored.
            first = body.find(NS + "tr")
            tds = children(first, "td") if first is not None else []
            reg["header"] = {"row": True, "column": bool(tds) and not (tds[0].text or "").strip()}
            reg["display"] = {"decimals": int((body.get("numbers") or "Default,2").split(",")[1])}
        self.stats["table-cells-dropped"] += len(body.findall(f".//{NS}td")) if body is not None else 0
        return reg

    def plot(self, r, p, origin):
        kind = "plot3d" if p.get("type") == "3d" else "plot2d"
        reg = self.base(r, origin, kind)
        reg["size"] = [int(r.get("width")), int(r.get("height"))]
        ast = math_expr(child(p, "input"))
        series = []
        if ast is not None:
            items = ast.args if ast.kind == "call" and ast.value == "sys" else [ast]
            if ast.kind == "call" and ast.value == "sys" and len(items) > 2:
                items = items[:-2]  # sys(..., rows, cols)
            # a 3D plot's input is a height: z(x, y) or a matrix (Plot3D.tsx)
            series = [{"z" if kind == "plot3d" else "y": to_linear(i)} for i in items]
        reg["series"] = series
        reg["grid"] = p.get("grid") == "true"
        reg["axes"] = p.get("axes") == "true"
        if p.get("render") and p.get("render") != "lines":
            reg["render"] = p.get("render")
        return reg

    # -- post-processing ----------------------------------------------------
    def attach_captions(self, regions):
        figures = [r for r in regions if r["kind"] in ("image", "table", "plot2d", "plot3d")]
        for tr in list(regions):
            if tr["kind"] != "text" or not isinstance(tr["text"], str):
                continue
            body = re.sub(r"^\{[^}\n]*\}\n", "", tr["text"])
            if "\n" in body:
                continue
            m = CAPTION_RE.match(plain(tr["text"]))
            if not m:
                continue
            want_table = m.group(1).lower().startswith(("tab",))
            ty = tr["at"][1]
            best = None
            for f in figures:
                if (f["kind"] == "table") != want_table or "caption" in f:
                    continue
                fy, fh = f["at"][1], f["size"][1]
                gap = min(abs(ty - (fy + fh)), abs(fy - ty - 20))
                if gap <= 60 and (best is None or gap < best[0]):
                    best = (gap, f)
            if best:
                f = best[1]
                f["caption"] = {"text": esc(m.group(3).strip()), "position": "above" if ty < f["at"][1] else "below"}
                regions.remove(tr)
                self.stats["caption"] += 1
        for r in regions:
            if r["kind"] == "area":
                self.attach_captions(r["regions"])

    def styles(self):
        (fam, size), _ = self.text_fonts.most_common(1)[0] if self.text_fonts else (("Arial", "10"), 0)
        msize = self.math_sizes.most_common(1)[0][0] if self.math_sizes else "10"
        return {
            "body": {"font": fam, "size": num(size)},
            "math": {"font": "STIX Two Math", "size": num(msize)},
            "numbering": {"headings": "1.1", "figures": "Figura {n} –", "tables": "Tabela {n} –"},
        }

    def strip_default_fonts(self, regions, styles):
        body = styles["body"]
        for r in regions:
            f = r.pop("font", None)
            if f:
                over = {}
                if f["family"] != body["font"]:
                    over["font"] = f["family"]
                if num(f["size"]) != body["size"]:
                    over["size"] = num(f["size"])
                if over:
                    r["style"] = over
            if r["kind"] == "area":
                self.strip_default_fonts(r["regions"], styles)

    # -- output -------------------------------------------------------------
    def write(self, doc):
        self.out.mkdir(parents=True, exist_ok=True)
        (self.out / "document.json").write_text(dump(doc) + "\n", encoding="utf-8")
        if self.results:
            res = {"format": "quire-results/1", "producer": "SMath Studio (imported)", "results": self.results}
            (self.out / "results.json").write_text(dump(res) + "\n", encoding="utf-8")
        for name, data in self.assets.values():
            p = self.out / name
            p.parent.mkdir(exist_ok=True)
            p.write_bytes(data)


def num(s):
    f = float(s)
    return int(f) if f.is_integer() else f


# ---------------------------------------------------------------------------
# Canonical JSON writer (docs/02-file-format.md §5)
# ---------------------------------------------------------------------------

KEY_ORDER = ["format", "meta", "settings", "units", "styles", "page", "requires",
             "id", "kind", "at", "size", "width", "height", "style", "keep", "disabled", "locked",
             "collapsed", "title", "expr", "show", "mode", "hideInput", "display", "note", "notePosition",
             "text", "src", "source", "header", "series", "grid", "axes", "render", "caption", "legacy",
             "color", "background", "border", "regions"]
RANK = {k: i for i, k in enumerate(KEY_ORDER)}
WIDTH = 100
EXPANDED = {"regions", "results", "meta", "settings", "styles", "page"}


def dump(v, indent=0, key=None):
    pad = "  " * indent
    inline = json.dumps(v, ensure_ascii=False, separators=(", ", ": "))
    force = key in EXPANDED or (isinstance(v, dict) and "kind" in v)
    if not isinstance(v, (dict, list)) or (not force and len(pad) + len(inline) <= WIDTH and "\\n" not in inline):
        return order_inline(v)
    inner = "  " * (indent + 1)
    if not v:
        return "[]" if isinstance(v, list) else "{}"
    if isinstance(v, list):
        return "[\n" + ",\n".join(inner + dump(x, indent + 1) for x in v) + "\n" + pad + "]"
    ranked = indent == 0 or "kind" in v
    items = sorted(v.items(), key=lambda kv: (RANK.get(kv[0], 999), kv[0])) if ranked else v.items()
    lines = []
    for k, x in items:
        lines.append(f"{inner}{json.dumps(k, ensure_ascii=False)}: {dump(x, indent + 1, k)}")
    return "{\n" + ",\n".join(lines) + "\n" + pad + "}"


def order_inline(v):
    if isinstance(v, dict):
        items = list(v.items())
        return "{ " + ", ".join(f"{json.dumps(k, ensure_ascii=False)}: {order_inline(x)}" for k, x in items) + " }" if items else "{}"
    if isinstance(v, list):
        return "[" + ", ".join(order_inline(x) for x in v) + "]"
    return json.dumps(v, ensure_ascii=False)


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    src = Path(argv[1])
    out = Path(argv[2]) if len(argv) > 2 else src.with_name(re.sub(r"\.sm.*$", "", src.name) + ".quire")
    conv = Converter(src, out)
    doc = conv.run()
    conv.write(doc)
    summary = ", ".join(f"{k}={v}" for k, v in sorted(conv.stats.items()))
    print(f"{src.name} -> {out}  [{summary}] assets={len(conv.assets)} results={len(conv.results)}")
    for w in conv.warnings:
        print("  warning:", w)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
