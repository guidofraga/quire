#!/usr/bin/env python3
"""Build app/src/fonts/QuireMath.woff from STIX Two Math (SIL Open Font License 1.1).

    python3 tools/build-math-font.py path/to/STIXTwoMath-Regular.otf

STIX Two Math ships with CFF outlines. PDF writers embed a CFF subset together with every
shared subroutine of the font (~75 KB per subset, even for a handful of glyphs), so the
font is converted to TrueType outlines, which subset to a few KB. It is also subset to the
characters a worksheet uses and renamed "Quire Math", as the OFL asks of modified versions.
The app bundles it so equations look the same on macOS, Windows and Linux.

Needs fontTools (pip install fonttools).
"""

import sys
from pathlib import Path

from fontTools import subset
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont, newTable

# Basic Latin, Latin-1, Greek, punctuation, letterlike, arrows, math operators, technical,
# shapes, supplemental arrows/operators and the math alphanumerics MathML uses for italics.
UNICODES = (
    "U+0020-007E,U+00A0-00FF,U+0131,U+0237,U+0300-036F,U+0391-03C9,U+03D0-03F6,"
    "U+2000-206F,U+20D0-20F0,U+2100-214F,U+2190-21FF,U+2200-22FF,U+2300-23FF,"
    "U+25A0-25FF,U+27C0-27EF,U+27F0-27FF,U+2900-297F,U+2980-29FF,U+2A00-2AFF,"
    "U+1D400-1D7FF"
)
FAMILY = "Quire Math"
MAX_ERR = 1.0  # font units, for the cubic → quadratic conversion


def to_truetype(font: TTFont) -> None:
    glyph_set = font.getGlyphSet()
    glyf = newTable("glyf")
    glyf.glyphOrder = font.getGlyphOrder()
    glyf.glyphs = {}
    for name in glyf.glyphOrder:
        pen = TTGlyphPen(glyph_set)
        glyph_set[name].draw(Cu2QuPen(pen, MAX_ERR, reverse_direction=True))
        glyf.glyphs[name] = pen.glyph()
    font["glyf"] = glyf
    font["loca"] = newTable("loca")
    del font["CFF "]
    if "VORG" in font:
        del font["VORG"]
    maxp = font["maxp"]
    maxp.tableVersion = 0x00010000
    for field in (
        "maxZones", "maxTwilightPoints", "maxStorage", "maxFunctionDefs", "maxInstructionDefs",
        "maxStackElements", "maxSizeOfInstructions", "maxComponentElements",
    ):
        setattr(maxp, field, 0)
    maxp.maxZones = 1
    font["head"].glyphDataFormat = 0
    post = font["post"]
    post.formatType = 2.0
    post.extraNames = []
    post.mapping = {}
    font.sfntVersion = "\x00\x01\x00\x00"


def rename(font: TTFont) -> None:
    names = font["name"]
    for rec in list(names.names):
        if rec.nameID in (1, 4, 16, 21):
            names.setName(FAMILY, rec.nameID, rec.platformID, rec.platEncID, rec.langID)
        elif rec.nameID == 6:
            names.setName("QuireMath-Regular", 6, rec.platformID, rec.platEncID, rec.langID)
        elif rec.nameID == 3:
            names.setName(f"{FAMILY} (from STIX Two Math)", 3, rec.platformID, rec.platEncID, rec.langID)


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    font = TTFont(sys.argv[1])
    options = subset.Options()
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    options.glyph_names = False
    sub = subset.Subsetter(options)
    sub.populate(unicodes=subset.parse_unicodes(UNICODES))
    sub.subset(font)
    to_truetype(font)
    rename(font)
    if "DSIG" in font:
        del font["DSIG"]
    out = Path(__file__).resolve().parent.parent / "app" / "src" / "fonts" / "QuireMath.woff"
    out.parent.mkdir(parents=True, exist_ok=True)
    font.flavor = "woff"
    font.save(out)
    print(f"{out} ({out.stat().st_size // 1024} KB, {len(font.getGlyphOrder())} glyphs)")


if __name__ == "__main__":
    main()
