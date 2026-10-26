// キャプションボードのレイアウト。build.py と同じ寸法・組版規則を使う。
// 座標はすべて pt、ページ左上原点・y下向き。

export const MM = 72 / 25.4;

export const SIZES = { // 縦置きの [幅, 高さ] mm。B判はJIS
  A4: [210, 297], A3: [297, 420], A2: [420, 594],
  B4: [257, 364], B3: [364, 515], B2: [515, 728],
};

export const BLEED = 3;     // 塗り足し mm
export const MARK_PAD = 15; // トンボ用の余白 mm

// A4縦での値。size は pt、それ以外は mm
export const STYLE = {
  margin_x: 24, margin_top: 28, margin_bottom: 24,
  artist: { font: "regular", size: 15, leading: 1.5, track: 0.08, color: "k100" },
  title: { font: "medium", size: 28, leading: 1.45, track: 0.04, color: "k100" },
  meta: { font: "regular", size: 12, leading: 1.8, track: 0.04, color: "k100" },
  body: { font: "light", size: 14, leading: 1.95, track: 0.0, color: "k100" },
  gap_artist_title: 3.5, gap_title_meta: 5, gap_meta_rule: 14,
  rule_len: 10, rule_weight: 0.3, gap_rule_body: 9,
  body_max_em: 34,   // 1行の最大文字数
  para_gap: 1.5,     // 段落間の行送り（1行送り=1）
  landscape_meta_ratio: 0.40,
};

// 行頭禁則・行末禁則
const NO_START = new Set("、。，．,.)）」』】〕〉》’”・:：;；?？!！ーぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ々ゝゞ〜…‥");
const NO_END = new Set("(（「『【〔〈《‘“");
const HANG = new Set("、。，．,.");

const chars = (s) => Array.from(s);
const first = (s) => chars(s)[0];
const lastCh = (s) => { const a = chars(s); return a[a.length - 1]; };

class Board {
  constructor(fonts, style, k, ox, oy) {
    this.fonts = fonts;
    this.style = style;
    this.k = k;
    this.ox = ox; // 仕上がり左上 (pt)
    this.oy = oy;
    this.paths = [];
    this.lines = [];
    this.missing = new Set();
    this.glyphCache = new Map();
  }

  spec(name) {
    const s = { ...this.style[name] };
    s.size *= this.k;
    s.fontObj = this.fonts[s.font];
    return s;
  }

  glyph(font, ch) {
    let cache = this.glyphCache.get(font);
    if (!cache) this.glyphCache.set(font, cache = new Map());
    let g = cache.get(ch);
    if (!g) {
      g = font.charToGlyph(ch);
      if (g.index === 0 && ch !== " ") this.missing.add(ch);
      cache.set(ch, g);
    }
    return g;
  }

  charW(ch, s) {
    const f = s.fontObj;
    return this.glyph(f, ch).advanceWidth / f.unitsPerEm * s.size + s.track * s.size;
  }

  tokW(tok, s) {
    let w = 0;
    for (const ch of chars(tok)) w += this.charW(ch, s);
    return w;
  }

  tokens(text) {
    // 英数字の連続は1語として扱い、途中で改行しない
    return text.match(/[A-Za-z0-9#'\-/.,:]+| |./gu) || [];
  }

  wrap(text, s, width) {
    const lines = [];
    for (const para of text.split("\n")) {
      if (!para) { lines.push({ toks: null, last: true }); continue; } // 空行＝段落間のアキ
      const start = lines.length;
      let line = [], w = 0;
      for (const tok of this.tokens(para)) {
        const tw = this.tokW(tok, s);
        if (line.length && w + tw > width + 0.01) {
          if (HANG.has(tok) && w + tw <= width + s.size) {
            line.push(tok); // ぶら下げ
            lines.push({ toks: line, last: false });
            line = []; w = 0;
            continue;
          }
          let carry = [];
          if (NO_START.has(first(tok)) && line.length > 1) carry = [line.pop()]; // 追い出し
          while (line.length > 1 && NO_END.has(lastCh(line[line.length - 1]))) carry.unshift(line.pop());
          while (line.length && line[line.length - 1] === " ") line.pop();
          lines.push({ toks: line, last: false });
          line = carry;
          w = line.reduce((a, t) => a + this.tokW(t, s), 0);
        }
        if (tok === " " && !line.length) continue;
        line.push(tok); w += tw;
      }
      lines.push({ toks: line, last: true }); // 段落の最終行
      this.fixWidow(lines.slice(start));
    }
    return lines;
  }

  fixWidow(para) {
    // 段落の最終行が2文字以下なら、前の行から文字を送る
    if (para.length < 2) return;
    const prev = para[para.length - 2].toks, last = para[para.length - 1].toks;
    const count = (l) => l.reduce((a, t) => a + (t === " " ? 0 : chars(t).length), 0);
    const move = () => { const t = prev.pop(); if (t !== " ") last.unshift(t); };
    while (count(last) <= 2 && count(prev) > 8) {
      move();
      // 行頭禁則・行末禁則にかかる間は続けて送る
      while (prev.length && count(prev) > 8 && (
        NO_START.has(first(last[0])) || prev[prev.length - 1] === " " ||
        NO_END.has(lastCh(prev[prev.length - 1])))) move();
    }
    while (prev.length && prev[prev.length - 1] === " ") prev.pop();
  }

  drawLine(toks, s, x, yBase, width, justify) {
    const cs = [], gaps = [];
    toks.forEach((t, i) => {
      const a = chars(t);
      cs.push(...a);
      for (let j = 0; j < a.length; j++) gaps.push(j === a.length - 1 && i < toks.length - 1);
    });
    if (!cs.length) return;
    const natural = cs.reduce((a, ch) => a + this.charW(ch, s), 0) - s.track * s.size;
    // 両端揃え：英単語の内側以外の字間に均等に配分
    const nGaps = gaps.filter(Boolean).length;
    let extra = 0;
    if (justify && nGaps && natural < width) extra = (width - natural) / nGaps;
    let d = "", cx = x;
    cs.forEach((ch, i) => {
      if (ch !== " ") d += this.glyph(s.fontObj, ch).getPath(cx, yBase, s.size).toPathData(3);
      cx += this.charW(ch, s) + (gaps[i] ? extra : 0);
    });
    if (d) this.paths.push({ d, color: s.color });
  }

  textBlock(text, name, xMM, topMM, widthMM, justify = false) {
    // 仕上がり左上基準の mm 座標で文字を組む。下端(mm)を返す
    const s = this.spec(name);
    const x = this.ox + xMM * MM;
    const width = widthMM * MM;
    const lead = s.size * s.leading;
    // 1行目は仮想ボディの上端を top に合わせる
    let y = this.oy + topMM * MM + s.size * 0.88;
    const y0 = y;
    const lines = this.wrap(text, s, width);
    lines.forEach(({ toks, last }, i) => {
      if (toks === null) { y += lead * (this.style.para_gap - 1); return; } // 次の行送りと合わせて段落アキ
      this.drawLine(toks, s, x, y, width, justify && !last);
      if (i < lines.length - 1) y += lead;
    });
    return topMM + (s.size * 0.88 + (y - y0) + s.size * 0.12) / MM;
  }

  rule(xMM, yMM, lenMM) {
    const y = this.oy + yMM * MM;
    this.lines.push({
      x1: this.ox + xMM * MM, y1: y, x2: this.ox + (xMM + lenMM) * MM, y2: y,
      w: this.style.rule_weight * this.k, color: "k100",
    });
  }
}

function headBlock(b, work, x, top, width) {
  // 作家名・タイトル・年・素材。下端を返す
  const st = b.style, k = b.k;
  let y = b.textBlock(work.artist || "", "artist", x, top, width);
  y = b.textBlock(work.title || "", "title", x, y + st.gap_artist_title * k, width);
  const meta = [work.year, work.medium].filter(Boolean).join("\n");
  return b.textBlock(meta, "meta", x, y + st.gap_title_meta * k, width);
}

function bodyWidth(b, avail) {
  const s = b.spec("body");
  const em = s.size * (1 + s.track) / MM;
  return Math.min(avail, b.style.body_max_em * em);
}

function cropMarks(x0, top, w, h) {
  // 日本式トンボ（角トンボ二重＋センタートンボ）。y下向きで計算する
  const out = [];
  const L = 10 * MM, bl = BLEED * MM, m4 = 4 * MM, m8 = 8 * MM;
  const line = (x1, y1, x2, y2) => out.push({ x1, y1, x2, y2, w: 0.25, color: "reg" });
  const x1 = x0 + w, y1 = top + h;
  for (const [cx, sx] of [[x0, -1], [x1, 1]]) {
    for (const [cy, sy] of [[top, -1], [y1, 1]]) {
      // 内トンボ（仕上がり線の延長）と外トンボ（塗り足し線の延長）
      for (const off of [0, bl]) {
        line(cx + sx * off, cy + sy * bl, cx + sx * off, cy + sy * (bl + L));
        line(cx + sx * bl, cy + sy * off, cx + sx * (bl + L), cy + sy * off);
      }
    }
  }
  const mx = x0 + w / 2, my = top + h / 2;
  for (const [cy, sy] of [[top, -1], [y1, 1]]) {
    line(mx - m8, cy + sy * (bl + m4), mx + m8, cy + sy * (bl + m4));
    line(mx, cy + sy * bl, mx, cy + sy * (bl + L));
  }
  for (const [cx, sx] of [[x0, -1], [x1, 1]]) {
    line(cx + sx * (bl + m4), my - m8, cx + sx * (bl + m4), my + m8);
    line(cx + sx * bl, my, cx + sx * (bl + L), my);
  }
  return out;
}

/**
 * work: {artist, title, year, medium, text}
 * opts: {size, orient, marks, bodyPt}
 * 戻り値: ページ寸法・仕上がり枠・塗り足し枠・描画するパスと線・はみ出し情報
 */
export function layoutBoard(fonts, work, opts) {
  const style = structuredClone(STYLE);
  if (opts.bodyPt) style.body.size = opts.bodyPt;
  let [w, h] = SIZES[opts.size];
  if (opts.orient === "landscape") [w, h] = [h, w];
  const k = Math.min(w, h) / 210;
  const pad = opts.marks ? MARK_PAD : BLEED;
  const pageW = (w + 2 * pad) * MM, pageH = (h + 2 * pad) * MM;
  const trim = { x: pad * MM, y: pad * MM, w: w * MM, h: h * MM };
  const bleed = { x: (pad - BLEED) * MM, y: (pad - BLEED) * MM, w: (w + 2 * BLEED) * MM, h: (h + 2 * BLEED) * MM };

  const b = new Board(fonts, style, k, trim.x, trim.y);
  const mx = style.margin_x * k, mt = style.margin_top * k, mb = style.margin_bottom * k;
  const inner = w - 2 * mx;
  let bottom;
  if (opts.orient === "portrait") {
    let y = headBlock(b, work, mx, mt, inner);
    y += style.gap_meta_rule * k;
    b.rule(mx, y, style.rule_len * k);
    y += style.gap_rule_body * k;
    bottom = b.textBlock(work.text || "", "body", mx, y, bodyWidth(b, inner), true);
  } else {
    const col = inner * style.landscape_meta_ratio;
    headBlock(b, work, mx, mt, col - 8 * k);
    const bx = mx + col;
    b.rule(bx, mt + 1.6 * k, style.rule_len * k);
    bottom = b.textBlock(work.text || "", "body", bx, mt + style.gap_rule_body * k,
      bodyWidth(b, inner - col), true);
  }
  const lines = [...b.lines, ...(opts.marks ? cropMarks(trim.x, trim.y, trim.w, trim.h) : [])];
  return {
    pageW, pageH, trim, bleed, widthMM: w, heightMM: h,
    paths: b.paths, lines,
    overflowMM: bottom > h - mb ? bottom - (h - mb) : 0,
    missing: [...b.missing],
  };
}
