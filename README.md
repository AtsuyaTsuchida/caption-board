# caption-board

展示用の作品キャプションボードの入稿用PDFを書き出すスクリプト。
スチレンボード貼りなどのパネル印刷に入稿することを想定している。

- 文字はすべてアウトライン（パス）化。PDFにフォントは埋め込まない
- 色はK版のみのCMYK（本文・見出しはK100、制作年と素材はK55）
- 塗り足し3mm、日本式トンボ付き。TrimBox / BleedBox を設定
- 寸法はA4縦を基準に決めてあり、短辺の比で拡大縮小する。A判・B判（1:√2）ならどのサイズでも同じ見た目になる
- 和文の禁則処理（追い出し・句読点のぶら下げ）、両端揃え、段落最終行の泣き別れ防止

## 準備

書体は [Zen Kaku Gothic New](https://fonts.google.com/specimen/Zen+Kaku+Gothic+New) の Light と Regular を使う。
`~/Library/Fonts/` にインストールしておく（場所が違う場合は `build.py` の `FONT_DIR` を書き換える）。

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## データ

`captions.json` に作品ごとの内容を書く。1作品につき1枚のPDFが書き出される。

| キー | 内容 |
|---|---|
| `id` | ファイル名の先頭に付く番号 |
| `artist` | 作家名 |
| `title` | 作品タイトル |
| `year` | 制作年 |
| `medium` | 素材・技法 |
| `text` | 解説文。`\n` で段落を分け、`\n\n` で段落間にアキを入れる |

## 書き出し

```bash
.venv/bin/python build.py --size B3 --orient portrait --preview
```

| オプション | 内容 |
|---|---|
| `--size` | `A4` `A3` `A2` `B4` `B3` `B2`（B判はJIS） |
| `--orient` | `portrait`（縦）/ `landscape`（横） |
| `--no-marks` | トンボなし（塗り足し3mmのみ） |
| `--preview` | 仕上がり範囲のPNGも書き出す |
| `--body-pt` | 解説文の文字サイズ（A4換算pt）を上書き |
| `--data` / `--out` | 入力JSON / 出力フォルダ（既定は `captions.json` / `out`） |

解説文が下の余白からはみ出すと警告を表示する。

## 注意

厳密な PDF/X-1a（OutputIntent の埋め込み）には対応していない。業者から指定がある場合は別途変換する。
