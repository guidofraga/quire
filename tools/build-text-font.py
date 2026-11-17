#!/usr/bin/env python3
"""Build app/src/fonts/QuireText-*.woff from STIX Two Text (SIL Open Font License 1.1).

    python3 tools/build-text-font.py path/to/STIXTwoText.ttf path/to/STIXTwoText-Italic.ttf

The two files are STIX Two Text's variable fonts (a weight axis, 400 to 700), version 2.13 as
STIX Two Math, from https://github.com/stipub/stixfonts (macOS ships the same files in
/System/Library/Fonts/Supplemental). STIX Two Text is the text face designed with the math
font: the same x-height (473/1000) and cap height (657/1000), so text and math set at one size
line up, letter for letter.

Each is cut into static Regular and Bold instances (PDF writers embed static outlines; a
variable font is a larger and less predictable embed), subset to the characters a report uses
and renamed "Quire Text", as the OFL asks of modified versions. The outlines are TrueType
already, so they subset to a few KB in an exported PDF.

Needs fontTools (pip install fonttools).
"""

import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

# Latin (with Extended-A and the common Extended-B letters), Greek, Cyrillic, punctuation,
# currency, letterlike symbols, number forms, arrows and the math operators prose quotes.
UNICODES = (
    "U+0020-007E,U+00A0-024F,U+02B0-02FF,U+0300-036F,U+0370-03FF,U+0400-045F,U+0490-0491,"
    "U+1E00-1EFF,U+2000-206F,U+2070-209F,U+20A0-20CF,U+2100-214F,U+2150-218F,U+2190-21FF,"
    "U+2200-22FF,U+25A0-25FF,U+FB00-FB06"
)
FAMILY = "Quire Text"
WEIGHTS = {"Regular": 400, "Bold": 700}


def rename(font: TTFont, style: str) -> None:
    """Family "Quire Text" with the four RIBBI styles, so CSS and PDF readers agree on them."""
    names = font["name"]
    postscript = f"QuireText-{style.replace(' ', '')}"
    for rec in list(names.names):
        if rec.nameID in (16, 17, 21, 22, 25) or rec.nameID >= 256:
            names.removeNames(nameID=rec.nameID)
    for rec in list(names.names):
        if rec.nameID == 1:
            names.setName(FAMILY, 1, rec.platformID, rec.platEncID, rec.langID)
        elif rec.nameID == 2:
            names.setName(style, 2, rec.platformID, rec.platEncID, rec.langID)
        elif rec.nameID == 3:
            names.setName(f"{FAMILY} {style} (from STIX Two Text)", 3, rec.platformID, rec.platEncID, rec.langID)
        elif rec.nameID == 4:
            names.setName(f"{FAMILY} {style}", 4, rec.platformID, rec.platEncID, rec.langID)
        elif rec.nameID == 6:
            names.setName(postscript, 6, rec.platformID, rec.platEncID, rec.langID)
    bold = "Bold" in style
    italic = "Italic" in style
    os2 = font["OS/2"]
    os2.usWeightClass = 700 if bold else 400
    os2.fsSelection = (os2.fsSelection & ~0b1100001) | (1 if italic else 0) | (0b100000 if bold else 0)
    if not (bold or italic):
        os2.fsSelection |= 0b1000000
    font["head"].macStyle = (1 if bold else 0) | (2 if italic else 0)


def build(source: str, italic: bool, out_dir: Path) -> None:
    for weight_name, weight in WEIGHTS.items():
        font = TTFont(source)
        font = instancer.instantiateVariableFont(font, {"wght": weight})
        for table in ("STAT", "DSIG"):
            if table in font:
                del font[table]
        options = subset.Options()
        # the features browsers apply by themselves, and the figure styles CSS can ask for; small
        # caps and stylistic sets would double the size
        options.layout_features = subset.Options().layout_features + [
            "case", "frac", "numr", "dnom", "sups", "subs", "onum", "pnum", "tnum", "lnum",
        ]
        options.name_IDs = ["*"]
        options.notdef_outline = True
        options.glyph_names = False
        options.hinting = False
        sub = subset.Subsetter(options)
        sub.populate(unicodes=subset.parse_unicodes(UNICODES))
        sub.subset(font)
        style = weight_name if not italic else ("Italic" if weight_name == "Regular" else "Bold Italic")
        rename(font, style)
        out = out_dir / f"QuireText-{style.replace(' ', '')}.woff"
        font.flavor = "woff"
        font.save(out)
        print(f"{out} ({out.stat().st_size // 1024} KB, {len(font.getGlyphOrder())} glyphs)")


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    out_dir = Path(__file__).resolve().parent.parent / "app" / "src" / "fonts"
    out_dir.mkdir(parents=True, exist_ok=True)
    build(sys.argv[1], False, out_dir)
    build(sys.argv[2], True, out_dir)


if __name__ == "__main__":
    main()
