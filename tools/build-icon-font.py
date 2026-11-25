"""
Builds the glyphs of media/gemini.woff, the icon font of the status bar item:

  U+E900             the Gemini mark, drawn from the SVG path in gemini_mark()
  U+E902 to U+E904   a ring with a dot in green, amber and red, for after the text
  U+E905 to U+E907   a thin vertical bar in green, amber and red, for in front of the mark

  uv run --no-project --with fonttools python -I tools/build-icon-font.py

Safe to run again: the script starts from the font that is already there (its tables and metrics), rebuilds the mark and the six
level glyphs from the definitions below, and drops any other glyph. Run on an unchanged checkout it writes the same bytes.

The six level glyphs are colour glyphs (an OpenType COLR v0 layer each), so the editor draws them in their own colour while the mark and the text
keep following the status bar's text colour. A status bar item has only one text colour, which is why the level used to be an item
of its own. The colours below are fixed: they do not follow the editor theme.

How the editor lays an icon out matters for the numbers here. In the status bar an icon is a 14 px inline-block with `line-height: 1`
in the codicon font (ascent 1.0 em, descent 0), and the glyph is drawn by a pseudo-element in this font (ascent 0.85 em, descent
0.15 em). The block takes the taller of the two sides, so its baseline sits 14 px below its top and the block is 16.1 px high, and it is
then centred in the 22 px item. That puts a glyph's own middle (y = 350) 1.05 px below the middle of the digits next to it, hence LIFT.
"""
import math
from pathlib import Path

from fontTools.colorLib.builder import buildCOLR, buildCPAL
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

FONT = Path(__file__).resolve().parent.parent / 'media' / 'gemini.woff'

# Units are 1/1000 em. The status bar draws icons at 14 px, so 1 px is about 71 units.
MARK = 'gemini'
LIFT = 75                 # how far above the em box's middle (350) the shapes are centred, so they sit on the middle of the digits
MIDDLE = 350 + LIFT

RING_OUTER = 332          # outer radius of the ring: 9.3 px across, as tall as the digits
RING_INNER = 232          # inner edge: a ring 1.4 px thick
RING_DOT = 136            # radius of the dot in the middle: 3.8 px across
RING_GAP = 320            # space in front of the ring, so it does not touch the percentage: about 4.5 px
RING_TRAIL = 40

BAR_WIDTH = 214           # 3 px
BAR_REACH = 860           # how far the bar runs above and below its middle: 24 px in all, more than the 22 px item, which clips it flush
BAR_GAP = 431             # space after the bar, before the mark: about 6 px

LEVELS = [('ok', '#3CB35C'), ('warning', '#E89A00'), ('critical', '#E64242')]
RING_CODEPOINTS = [0xE902, 0xE903, 0xE904]
BAR_CODEPOINTS = [0xE905, 0xE906, 0xE907]


def rgba(hex_colour):
    return tuple(int(hex_colour[i:i + 2], 16) / 255 for i in (1, 3, 5)) + (1.0,)


def circle(pen, cx, radius, counter_clockwise=True, segments=8):
    """A circle from quadratic curves whose control points are all off the curve. Opposite directions make a hole."""
    k = radius / math.cos(math.pi / segments)
    points = [
        (round(cx + k * math.cos((2 * i + 1) * math.pi / segments)), round(MIDDLE + k * math.sin((2 * i + 1) * math.pi / segments)))
        for i in range(segments)
    ]
    pen.qCurveTo(*(points if counter_clockwise else points[::-1]), None)
    pen.closePath()


def ring_and_dot():
    cx = RING_GAP + RING_OUTER
    pen = TTGlyphPen(None)
    circle(pen, cx, RING_OUTER)
    circle(pen, cx, RING_INNER, counter_clockwise=False)
    circle(pen, cx, RING_DOT)
    return pen.glyph(), RING_GAP + 2 * RING_OUTER + RING_TRAIL


def bar():
    pen = TTGlyphPen(None)
    pen.moveTo((0, MIDDLE - BAR_REACH))
    pen.lineTo((0, MIDDLE + BAR_REACH))
    pen.lineTo((BAR_WIDTH, MIDDLE + BAR_REACH))
    pen.lineTo((BAR_WIDTH, MIDDLE - BAR_REACH))
    pen.closePath()
    return pen.glyph(), BAR_WIDTH + BAR_GAP


def gemini_mark():
    from fontTools.svgLib.path import parse_path
    from fontTools.pens.recordingPen import RecordingPen
    from fontTools.pens.transformPen import TransformPen
    from fontTools.pens.cu2quPen import Cu2QuPen
    from fontTools.misc.transform import Transform

    path_str = 'M141.201 4.886c2.282-6.17 11.042-6.071 13.184.148l5.985 17.37a184.004 184.004 0 0 0 111.257 113.049l19.304 6.997c6.143 2.227 6.156 10.91.02 13.155l-19.35 7.082a184.001 184.001 0 0 0-109.495 109.385l-7.573 20.629c-2.241 6.105-10.869 6.121-13.133.025l-7.908-21.296a184 184 0 0 0-109.02-108.658l-19.698-7.239c-6.102-2.243-6.118-10.867-.025-13.132l20.083-7.467A183.998 183.998 0 0 0 133.291 26.28l7.91-21.394Z'
    rec = RecordingPen()
    parse_path(path_str, rec)

    scale = 2.45
    x_offset = 60
    y_offset = MIDDLE + 149 * scale
    t = Transform(scale, 0, 0, -scale, x_offset, y_offset)

    pen = TTGlyphPen(None)
    cu2qu = Cu2QuPen(pen, max_err=1.0)
    rec.replay(TransformPen(cu2qu, t))
    return pen.glyph(), 880


def main():
    if not FONT.exists():
        raise SystemExit(f'{FONT} is missing: this script edits the existing font and cannot create one')
    font = TTFont(FONT, recalcTimestamp=False)   # keep the file byte-for-byte the same when nothing else changes
    glyf, hmtx = font['glyf'], font['hmtx']

    g, adv = gemini_mark()
    glyf[MARK] = g
    g.recalcBounds(glyf)
    hmtx[MARK] = (adv, g.xMin)

    for name in [n for n in glyf.glyphOrder if n not in ('.notdef', MARK)]:
        del glyf.glyphs[name]
        glyf.glyphOrder.remove(name)
        del hmtx.metrics[name]

    layers, codepoints = {}, {}
    for kind, shape, points in (('ring', ring_and_dot, RING_CODEPOINTS), ('bar', bar, BAR_CODEPOINTS)):
        for index, ((level, _), codepoint) in enumerate(zip(LEVELS, points)):
            base, layer = f'{kind}_{level}', f'{kind}_{level}_layer'
            for glyph_name in (base, layer):
                glyph, advance = shape()
                glyf[glyph_name] = glyph
                glyph.recalcBounds(glyf)
                # The left side bearing must equal xMin, or the renderer moves every layer by itself and they no longer line up.
                hmtx[glyph_name] = (advance, glyph.xMin)
            layers[base] = [(layer, index)]
            codepoints[codepoint] = base

    font.setGlyphOrder(list(glyf.glyphOrder))
    for table in font['cmap'].tables:
        for codepoint in [cp for cp in table.cmap if cp > 0xE900]:
            del table.cmap[codepoint]
        table.cmap.update(codepoints)
    font['COLR'] = buildCOLR(layers, version=0)
    font['CPAL'] = buildCPAL([[rgba(colour) for _, colour in LEVELS]])
    for r in font['name'].names:
        if r.nameID == 1:
            r.string = 'agy-gemini'.encode('utf-16be' if r.platformID == 3 else 'latin1')
    font['maxp'].numGlyphs = len(glyf.glyphOrder)
    font.flavor = 'woff'
    font.save(FONT)
    print(f'{FONT.name}: {len(glyf.glyphOrder)} glyphs, colour tables {sorted(set(TTFont(FONT).keys()) & {"COLR", "CPAL"})}')


main()
