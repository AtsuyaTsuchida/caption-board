import { layoutBoard, SIZES, STYLE, BLEED } from "./layout.js";

const { PDFDocument, cmyk } = window.PDFLib;

const PDF_COLORS = {
  k100: cmyk(0, 0, 0, 1),
  k55: cmyk(0, 0, 0, 0.55),
  reg: cmyk(1, 1, 1, 1), // レジストレーション（トンボ用）
};
const SCREEN_COLORS = { k100: "#000", k55: "#7f7f7f", reg: "#000" };

const FIELDS = ["artist", "title", "year", "medium", "text", "size", "orient", "bodyPt", "marks"];
const STORE_KEY = "caption-board:v1";

const $ = (id) => document.getElementById(id);
let fonts = null;

async function loadFonts() {
  const load = async (file) => {
    const res = await fetch(`fonts/${file}`);
    if (!res.ok) throw new Error(`${file} を読み込めませんでした`);
    return opentype.parse(await res.arrayBuffer());
  };
  const [light, regular, medium] = await Promise.all([
    load("ZenKakuGothicNew-Light.ttf"), load("ZenKakuGothicNew-Regular.ttf"),
    load("ZenKakuGothicNew-Medium.ttf"),
  ]);
  return { light, regular, medium };
}

function readForm() {
  return {
    work: {
      artist: $("artist").value.trim(),
      title: $("title").value.trim(),
      year: $("year").value.trim(),
      medium: $("medium").value.trim(),
      text: $("text").value.replace(/\r\n?/g, "\n").replace(/\s+$/, ""),
    },
    opts: {
      size: $("size").value,
      orient: document.querySelector("input[name=orient]:checked").value,
      bodyPt: parseFloat($("bodyPt").value) || STYLE.body.size,
      marks: $("marks").checked,
    },
  };
}

function saveForm() {
  const data = {};
  for (const f of FIELDS) {
    if (f === "orient") data[f] = document.querySelector("input[name=orient]:checked").value;
    else if (f === "marks") data[f] = $("marks").checked;
    else data[f] = $(f).value;
  }
  try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch { /* 保存できなくても動作は続ける */ }
}

function restoreForm() {
  let data;
  try { data = JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch { data = null; }
  if (!data) return;
  for (const f of FIELDS) {
    if (data[f] === undefined) continue;
    if (f === "orient") {
      const r = document.querySelector(`input[name=orient][value=${data[f]}]`);
      if (r) r.checked = true;
    } else if (f === "marks") $("marks").checked = !!data[f];
    else $(f).value = data[f];
  }
}

function toSVG(scene) {
  // 画面プレビューは仕上がり範囲だけを見せる
  const { trim } = scene;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("xmlns", ns);
  svg.setAttribute("viewBox", `${trim.x} ${trim.y} ${trim.w} ${trim.h}`);
  const bg = document.createElementNS(ns, "rect");
  Object.entries({ x: trim.x, y: trim.y, width: trim.w, height: trim.h, fill: "#fff" })
    .forEach(([k, v]) => bg.setAttribute(k, v));
  svg.appendChild(bg);
  for (const p of scene.paths) {
    const el = document.createElementNS(ns, "path");
    el.setAttribute("d", p.d);
    el.setAttribute("fill", SCREEN_COLORS[p.color]);
    svg.appendChild(el);
  }
  for (const l of scene.lines) {
    if (l.color === "reg") continue;
    const el = document.createElementNS(ns, "line");
    Object.entries({ x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2, stroke: SCREEN_COLORS[l.color], "stroke-width": l.w })
      .forEach(([k, v]) => el.setAttribute(k, v));
    svg.appendChild(el);
  }
  return svg;
}

function render() {
  if (!fonts) return;
  const { work, opts } = readForm();
  const scene = layoutBoard(fonts, work, opts);
  const stage = $("stage");
  stage.replaceChildren(toSVG(scene));
  stage.style.aspectRatio = `${scene.trim.w} / ${scene.trim.h}`;
  stage.classList.toggle("landscape", opts.orient === "landscape");

  const [w, h] = [scene.widthMM, scene.heightMM];
  $("spec").textContent =
    `仕上がり ${w}×${h}mm／塗り足し ${BLEED}mm／${opts.marks ? "トンボ付き" : "トンボなし"}／K版のみ・文字アウトライン`;

  const warn = [];
  if (scene.overflowMM > 0) warn.push(`解説文が下の余白に ${scene.overflowMM.toFixed(1)}mm はみ出しています。文字サイズを下げるか、大きいサイズを選んでください。`);
  if (scene.missing.length) warn.push(`フォントに無い文字があり、表示されません：${scene.missing.join(" ")}`);
  $("warn").textContent = warn.join("\n");
  $("warn").hidden = !warn.length;
  saveForm();
  return scene;
}

function fileBase() {
  const { work, opts } = readForm();
  const name = [work.artist, work.title].filter(Boolean).join("_") || "caption";
  return `${name}_${opts.size}_${opts.orient}`.replace(/[\\/:*?"<>|\s]+/g, "_");
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export async function buildPDF() {
  const { work, opts } = readForm();
  const scene = layoutBoard(fonts, work, opts);
  const doc = await PDFDocument.create();
  doc.setTitle([work.artist, work.title].filter(Boolean).join(" ") + ` キャプション ${opts.size}`);
  doc.setCreator("caption-board");
  doc.setProducer("caption-board (pdf-lib)");
  const H = scene.pageH;
  const page = doc.addPage([scene.pageW, H]);
  const box = (b) => [b.x, H - b.y - b.h, b.w, b.h];
  page.setTrimBox(...box(scene.trim));
  page.setBleedBox(...box(scene.bleed));
  for (const p of scene.paths) {
    // SVGパスはy下向き。drawSvgPath は原点(x,y)からy軸を反転して描く
    page.drawSvgPath(p.d, { x: 0, y: H, color: PDF_COLORS[p.color] });
  }
  for (const l of scene.lines) {
    page.drawLine({
      start: { x: l.x1, y: H - l.y1 }, end: { x: l.x2, y: H - l.y2 },
      thickness: l.w, color: PDF_COLORS[l.color],
    });
  }
  return doc.save();
}

async function exportPDF() {
  const bytes = await buildPDF();
  download(new Blob([bytes], { type: "application/pdf" }), `${fileBase()}.pdf`);
}

async function exportPNG() {
  const scene = render();
  const svg = toSVG(scene);
  // 300dpi を上限に、どのブラウザでも作れる画素数（約1600万）に収める
  const pxPerPt = Math.min(300 / 72, Math.sqrt(16e6 / (scene.trim.w * scene.trim.h)));
  const W = Math.round(scene.trim.w * pxPerPt), Hh = Math.round(scene.trim.h * pxPerPt);
  svg.setAttribute("width", W);
  svg.setAttribute("height", Hh);
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }));
  const img = new Image();
  await new Promise((ok, ng) => { img.onload = ok; img.onerror = ng; img.src = url; });
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = Hh;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, Hh);
  ctx.drawImage(img, 0, 0, W, Hh);
  URL.revokeObjectURL(url);
  canvas.toBlob((blob) => download(blob, `${fileBase()}.png`), "image/png");
}

function busy(btn, fn) {
  return async () => {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "書き出し中…";
    try { await fn(); } catch (e) { alert(`書き出しに失敗しました：${e.message}`); console.error(e); }
    btn.disabled = false;
    btn.textContent = label;
  };
}

async function main() {
  const sel = $("size");
  for (const [k, [w, h]] of Object.entries(SIZES)) {
    sel.add(new Option(`${k}（${w}×${h}mm）`, k));
  }
  sel.value = "A4";
  $("bodyPt").value = STYLE.body.size;
  restoreForm();

  let timer;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(render, 120); };
  document.querySelectorAll("#form input, #form textarea, #form select")
    .forEach((el) => el.addEventListener("input", schedule));

  $("pdf").addEventListener("click", busy($("pdf"), exportPDF));
  $("png").addEventListener("click", busy($("png"), exportPNG));

  try {
    fonts = await loadFonts();
  } catch (e) {
    $("status").textContent = `フォントを読み込めませんでした（${e.message}）`;
    return;
  }
  $("status").hidden = true;
  $("pdf").disabled = false;
  $("png").disabled = false;
  render();
}

main();
