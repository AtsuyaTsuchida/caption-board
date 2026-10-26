"""作品キャプションボードの入稿用PDFを作る。

文字はすべてアウトライン(パス)化、色はK版のみのCMYK。
寸法はA4縦(短辺210mm)を基準に決め、短辺の比で拡大縮小する。

  .venv/bin/python build.py --size A4 --orient portrait
  .venv/bin/python build.py --size B3 --orient landscape --no-marks
"""
import argparse
import json
import os
import re
from pathlib import Path

from fontTools.pens.basePen import BasePen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from reportlab.lib.colors import CMYKColor
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas

FONT_DIR = Path(os.path.expanduser("~/Library/Fonts"))
FONTS = {
    "light": FONT_DIR / "ZenKakuGothicNew-Light.ttf",
    "regular": FONT_DIR / "ZenKakuGothicNew-Regular.ttf",
}

SIZES = {  # 縦置きの (幅, 高さ) mm。B判はJIS
    "A4": (210, 297), "A3": (297, 420), "A2": (420, 594),
    "B4": (257, 364), "B3": (364, 515), "B2": (515, 728),
}

BLEED = 3      # 塗り足し mm
MARK_PAD = 15  # トンボ用の余白 mm

K100 = CMYKColor(0, 0, 0, 1.0)
K55 = CMYKColor(0, 0, 0, 0.55)
REGISTRATION = CMYKColor(1, 1, 1, 1)

# A4縦での値。sizeはpt、それ以外はmm
STYLE = {
    "margin_x": 24, "margin_top": 28, "margin_bottom": 24,
    "artist": dict(font="regular", size=15, leading=1.5, track=0.08, color=K100),
    "title": dict(font="light", size=28, leading=1.45, track=0.04, color=K100),
    "meta": dict(font="light", size=12, leading=1.8, track=0.04, color=K55),
    "body": dict(font="light", size=14, leading=1.95, track=0.0, color=K100),
    "gap_artist_title": 3.5, "gap_title_meta": 5, "gap_meta_rule": 14,
    "rule_len": 10, "rule_weight": 0.3, "gap_rule_body": 9,
    "body_max_em": 34,         # 1行の最大文字数
    "para_gap": 1.5,           # 段落間の行送り（1行送り=1）
    "landscape_meta_ratio": 0.40,
}

# 行頭禁則・行末禁則
NO_START = set("、。，．,.)）」』】〕〉》’”・:：;；?？!！ーぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ々ゝゞ〜…‥")
NO_END = set("(（「『【〔〈《‘“")
HANG = set("、。，．,.")


class ReportlabPen(BasePen):
    def __init__(self, glyphset, path):
        super().__init__(glyphset)
        self.path = path

    def _moveTo(self, p):
        self.path.moveTo(*p)

    def _lineTo(self, p):
        self.path.lineTo(*p)

    def _curveToOne(self, p1, p2, p3):
        self.path.curveTo(*p1, *p2, *p3)

    def _qCurveToOne(self, p1, p2):
        p0 = self._getCurrentPoint()
        c1 = (p0[0] + 2 / 3 * (p1[0] - p0[0]), p0[1] + 2 / 3 * (p1[1] - p0[1]))
        c2 = (p2[0] + 2 / 3 * (p1[0] - p2[0]), p2[1] + 2 / 3 * (p1[1] - p2[1]))
        self.path.curveTo(*c1, *c2, *p2)

    def _closePath(self):
        self.path.close()


class Font:
    def __init__(self, path):
        self.tt = TTFont(path)
        self.cmap = self.tt.getBestCmap()
        self.glyphs = self.tt.getGlyphSet()
        self.upm = self.tt["head"].unitsPerEm
        self.hmtx = self.tt["hmtx"]

    def glyph(self, ch):
        name = self.cmap.get(ord(ch))
        if name is None:
            raise SystemExit(f"フォントに無い文字があります: {ch!r} (U+{ord(ch):04X})")
        return name

    def advance(self, ch, size):
        return self.hmtx[self.glyph(ch)][0] / self.upm * size


class Board:
    def __init__(self, c, fonts, scale, origin):
        self.c = c
        self.fonts = fonts
        self.k = scale
        self.ox, self.oy = origin  # 仕上がり左上 (pt)

    def spec(self, name):
        s = dict(STYLE[name])
        s["size"] *= self.k
        s["font_obj"] = self.fonts[s["font"]]
        return s

    def char_w(self, ch, s):
        return s["font_obj"].advance(ch, s["size"]) + s["track"] * s["size"]

    def tokens(self, text):
        # 英数字の連続は1語として扱い、途中で改行しない
        return re.findall(r"[A-Za-z0-9#'\-/.,:]+| |.", text)

    def wrap(self, text, s, width):
        lines = []
        for para in text.split("\n"):
            if not para:
                lines.append((None, True))  # 空行＝段落間のアキ
                continue
            start = len(lines)
            line, w = [], 0.0
            for tok in self.tokens(para):
                tw = sum(self.char_w(ch, s) for ch in tok)
                if line and w + tw > width + 0.01:
                    if tok in HANG and w + tw <= width + s["size"]:
                        line.append(tok); w += tw  # ぶら下げ
                        lines.append((line, False)); line, w = [], 0.0
                        continue
                    carry = []
                    if tok[0] in NO_START and len(line) > 1:
                        carry = [line.pop()]  # 追い出し
                    while len(line) > 1 and line[-1][-1] in NO_END:
                        carry.insert(0, line.pop())
                    while line and line[-1] == " ":
                        line.pop()
                    lines.append((line, False))
                    line = carry
                    w = sum(self.char_w(ch, s) for t in line for ch in t)
                if tok == " " and not line:
                    continue
                line.append(tok); w += tw
            lines.append((line, True))  # 段落の最終行
            self.fix_widow(lines[start:])
        return lines

    def fix_widow(self, para):
        """段落の最終行が2文字以下なら、前の行から文字を送る"""
        if len(para) < 2:
            return
        prev, last = para[-2][0], para[-1][0]
        count = lambda l: sum(len(t) for t in l if t != " ")
        while count(last) <= 2 and count(prev) > 8:
            tok = prev.pop()
            if tok != " ":
                last.insert(0, tok)
            # 行頭禁則・行末禁則にかかる間は続けて送る
            while prev and count(prev) > 8 and (
                    last[0][0] in NO_START or prev[-1] == " " or prev[-1][-1] in NO_END):
                tok = prev.pop()
                if tok != " ":
                    last.insert(0, tok)
        while prev and prev[-1] == " ":
            prev.pop()

    def draw_line(self, toks, s, x, y_base, width, justify):
        chars = [ch for t in toks for ch in t]
        if not chars:
            return
        natural = sum(self.char_w(ch, s) for ch in chars) - s["track"] * s["size"]
        # 両端揃え：英単語の内側以外の字間に均等に配分
        gaps = []
        for i, t in enumerate(toks):
            n = len(t)
            gaps += [False] * (n - 1) + [i < len(toks) - 1]
        n_gaps = sum(gaps)
        extra = 0.0
        if justify and n_gaps and natural < width:
            extra = (width - natural) / n_gaps
        f = s["font_obj"]
        scale = s["size"] / f.upm
        path = self.c.beginPath()
        pen = ReportlabPen(f.glyphs, path)
        cx = x
        for ch, gap in zip(chars, gaps):
            if ch != " ":
                tp = TransformPen(pen, (scale, 0, 0, scale, cx, y_base))
                f.glyphs[f.glyph(ch)].draw(tp)
            cx += self.char_w(ch, s) + (extra if gap else 0)
        self.c.setFillColor(s["color"])
        self.c.drawPath(path, stroke=0, fill=1)

    def text_block(self, text, name, x_mm, top_mm, width_mm, justify=False):
        """仕上がり左上基準の mm 座標で文字を組む。下端(mm)を返す"""
        s = self.spec(name)
        x = self.ox + x_mm * mm
        width = width_mm * mm
        lead = s["size"] * s["leading"]
        # 1行目は仮想ボディの上端を top に合わせる（行送りの半分を上に足さない）
        y = self.oy - top_mm * mm - s["size"] * 0.88
        y0 = y
        lines = self.wrap(text, s, width)
        for i, (toks, last) in enumerate(lines):
            if toks is None:
                y -= lead * (STYLE["para_gap"] - 1)  # 次の行送りと合わせて段落アキになる
                continue
            self.draw_line(toks, s, x, y, width, justify and not last)
            if i < len(lines) - 1:
                y -= lead
        return top_mm + (s["size"] * 0.88 + (y0 - y) + s["size"] * 0.12) / mm

    def rule(self, x_mm, y_mm, len_mm):
        self.c.setStrokeColor(K100)
        self.c.setLineWidth(STYLE["rule_weight"] * self.k)
        y = self.oy - y_mm * mm
        self.c.line(self.ox + x_mm * mm, y, self.ox + (x_mm + len_mm) * mm, y)


def head_block(b, work, x, top, width):
    """作家名・タイトル・年・素材。下端を返す"""
    k = b.k
    y = b.text_block(work["artist"], "artist", x, top, width)
    y = b.text_block(work["title"], "title", x, y + STYLE["gap_artist_title"] * k, width)
    meta = "\n".join(v for v in (work.get("year"), work.get("medium")) if v)
    return b.text_block(meta, "meta", x, y + STYLE["gap_title_meta"] * k, width)


def body_width(b, avail):
    s = b.spec("body")
    em = s["size"] * (1 + s["track"]) / mm
    return min(avail, STYLE["body_max_em"] * em)


def layout(b, work, w, h, orient):
    k = b.k
    mx, mt, mb = STYLE["margin_x"] * k, STYLE["margin_top"] * k, STYLE["margin_bottom"] * k
    inner = w - 2 * mx
    if orient == "portrait":
        y = head_block(b, work, mx, mt, inner)
        y += STYLE["gap_meta_rule"] * k
        b.rule(mx, y, STYLE["rule_len"] * k)
        y += STYLE["gap_rule_body"] * k
        bottom = b.text_block(work["text"], "body", mx, y, body_width(b, inner), justify=True)
    else:
        col = inner * STYLE["landscape_meta_ratio"]
        head_block(b, work, mx, mt, col - 8 * k)
        bx = mx + col
        b.rule(bx, mt + 1.6 * k, STYLE["rule_len"] * k)
        bottom = b.text_block(work["text"], "body", bx, mt + STYLE["gap_rule_body"] * k,
                              body_width(b, inner - col), justify=True)
    if bottom > h - mb:
        print(f"  ! {work['id']}: 解説文が下余白にはみ出しています ({bottom:.1f}mm > {h - mb:.1f}mm)")


def crop_marks(c, x0, y0, w, h):
    """日本式トンボ（角トンボ二重＋センタートンボ）"""
    c.setStrokeColor(REGISTRATION)
    c.setLineWidth(0.25)
    L = 10 * mm
    b = BLEED * mm
    x1, y1 = x0 + w, y0 + h
    for cx, sx in ((x0, -1), (x1, 1)):
        for cy, sy in ((y0, -1), (y1, 1)):
            # 内トンボ（仕上がり線の延長）と外トンボ（塗り足し線の延長）
            for off in (0, b):
                c.line(cx + sx * off, cy + sy * b, cx + sx * off, cy + sy * (b + L))
                c.line(cx + sx * b, cy + sy * off, cx + sx * (b + L), cy + sy * off)
    mx, my = x0 + w / 2, y0 + h / 2
    for cy, sy in ((y0, -1), (y1, 1)):
        c.line(mx - 8 * mm, cy + sy * (b + 4 * mm), mx + 8 * mm, cy + sy * (b + 4 * mm))
        c.line(mx, cy + sy * b, mx, cy + sy * (b + L))
    for cx, sx in ((x0, -1), (x1, 1)):
        c.line(cx + sx * (b + 4 * mm), my - 8 * mm, cx + sx * (b + 4 * mm), my + 8 * mm)
        c.line(cx + sx * b, my, cx + sx * (b + L), my)


def build(work, size, orient, marks, out_dir, fonts):
    w, h = SIZES[size]
    if orient == "landscape":
        w, h = h, w
    scale = min(w, h) / 210
    pad = (MARK_PAD if marks else BLEED)
    pw, ph = (w + 2 * pad) * mm, (h + 2 * pad) * mm
    name = f"{work['id']}_{size}_{orient}.pdf"
    path = out_dir / name
    c = canvas.Canvas(str(path), pagesize=(pw, ph))
    c.setTitle(f"{work['artist']}「{work['title']}」キャプション {size}")
    tx, ty = pad * mm, pad * mm
    c.setTrimBox((tx, ty, tx + w * mm, ty + h * mm))
    c.setBleedBox((tx - BLEED * mm, ty - BLEED * mm, tx + (w + BLEED) * mm, ty + (h + BLEED) * mm))
    if marks:
        crop_marks(c, tx, ty, w * mm, h * mm)
    b = Board(c, fonts, scale, (tx, ty + h * mm))
    layout(b, work, w, h, orient)
    c.showPage()
    c.save()
    strip_font_refs(path)
    return path


def strip_font_refs(path):
    """reportlabが自動で入れる未使用のHelvetica参照を消す（入稿チェックでフォント警告が出ないように）"""
    import pymupdf
    doc = pymupdf.open(path)
    page = doc[0]
    xref = page.get_contents()[0]
    stream = doc.xref_stream(xref).replace(b"BT /F1 12 Tf 14.4 TL ET", b"")
    doc.update_stream(xref, stream)
    doc.xref_set_key(page.xref, "Resources/Font", "null")
    doc.xref_set_key(page.xref, "Resources/ProcSet", "[/PDF]")
    tmp = path.with_suffix(".tmp.pdf")
    doc.save(tmp, garbage=4, deflate=True)
    doc.close()
    tmp.replace(path)
    assert not pymupdf.open(path)[0].get_fonts(), "フォント参照が残っています"


def preview(pdf_path, png_path, dpi=110):
    import pymupdf
    doc = pymupdf.open(pdf_path)
    page = doc[0]
    pix = page.get_pixmap(dpi=dpi, clip=page.trimbox)
    pix.save(png_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--size", default="A4", choices=SIZES)
    ap.add_argument("--orient", default="portrait", choices=["portrait", "landscape"])
    ap.add_argument("--data", default="captions.json")
    ap.add_argument("--out", default="out")
    ap.add_argument("--no-marks", action="store_true", help="トンボなし（塗り足し3mmのみ）")
    ap.add_argument("--preview", action="store_true", help="仕上がり範囲のPNGも書き出す")
    ap.add_argument("--body-pt", type=float, help="解説文の文字サイズ(A4換算pt)を上書き")
    a = ap.parse_args()
    if a.body_pt:
        STYLE["body"]["size"] = a.body_pt

    fonts = {k: Font(v) for k, v in FONTS.items()}
    out = Path(a.out)
    out.mkdir(exist_ok=True)
    for work in json.loads(Path(a.data).read_text(encoding="utf-8")):
        pdf = build(work, a.size, a.orient, not a.no_marks, out, fonts)
        print(pdf)
        if a.preview:
            preview(pdf, pdf.with_suffix(".png"))


if __name__ == "__main__":
    main()
