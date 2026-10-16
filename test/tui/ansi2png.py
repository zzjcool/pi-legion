#!/usr/bin/env python3
"""ANSI 终端帧 → PNG 取证渲染器（pi-legion TUI QA playbook §1.4）。

用法:
    python3 ansi2png.py frame.ansi out.png [--cols 120] [--rows 40]
    cat frame.ansi | python3 ansi2png.py - out.png --cols 120

设计约束（来自 docs/tui-qa-playbook.md §1.4/§11）:
- PIL 逐单元格渲染；**不用 ImageMagick Pango**（吞嵌套 foreground 颜色，颜色取证失真）。
- 支持 CJK 宽字符（East Asian Width 的 W/F 占两列）与字体回退（Noto CJK）。
- 支持 SGR 常用子集: 0/1/3/4/7/22/23/24/27、30-37/38;5/38;2/39、40-47/48;5/48;2/49、90-97/100-107。
- 输入是 `tmux capture-pane -p -e` 的输出（含 ANSI 序列，含可能的尾部换行）。

仅做取证渲染，不做位精确的终端模拟器：复杂序列（alternate screen、光标移动）
按行序输出即可满足"给人看"的目的；精确断言用明文/码点（playbook 铁律 1）。
"""

from __future__ import annotations

import argparse
import re
import sys
import unicodedata
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("error: Pillow is required (apt: python3-pil / pip: Pillow)", file=sys.stderr)
    sys.exit(2)

FONT_CANDIDATES = [
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",  # tui-sandbox 镜像自带，覆盖 CJK + 块元素
    "/usr/share/fonts/opentype/noto/NotoSansMono-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
]

# xterm 256 色 → RGB（标准调色板）
_PALETTE = [
    (0, 0, 0), (205, 0, 0), (0, 205, 0), (205, 205, 0), (0, 0, 238), (205, 0, 205),
    (0, 205, 205), (229, 229, 229), (127, 127, 127), (255, 0, 0), (0, 255, 0),
    (255, 255, 0), (92, 92, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255),
] + [
    (r * 40 if r else 0, g * 40 if g else 0, b * 40 if b else 0)
    for r in range(6) for g in range(6) for b in range(6)
] + [(v, v, v) for v in (8, 18, 28, 38, 48, 58, 68, 78, 88, 98, 108, 118, 128, 138, 148, 158, 168, 178, 188, 192, 198, 204, 210, 216, 222, 228, 234, 240, 244, 248, 252)]

_ANSI_RE = re.compile(r"\x1b\[([0-9;:?]*)([A-Za-z])")
_CSI_SKIP = re.compile(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")


def _eaw_wide(ch: str) -> bool:
    return unicodedata.east_asian_width(ch) in ("W", "F")


class Cell:
    __slots__ = ("ch", "fg", "bg", "bold", "underline", "reverse", "italic")

    def __init__(self, ch=" ", fg=None, bg=None, bold=False, underline=False, reverse=False, italic=False):
        self.ch, self.fg, self.bg = ch, fg, bg
        self.bold, self.underline, self.reverse, self.italic = bold, underline, reverse, italic


def parse_ansi(text: str, cols: int):
    """逐序列解析为行×单元格矩阵。忽略光标移动类 CSI（按行序取证渲染）。"""
    grid = [[]]
    fg = None
    bg = None
    bold = underline = reverse = italic = False

    text = _CSI_SKIP.sub("", text.replace("\x1b[k", "").replace("\x1b[2K", ""))
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "\x1b" and i + 1 < len(text) and text[i + 1] == "[":
            m = _ANSI_RE.match(text, i)
            if not m:
                i += 1
                continue
            params, final = m.group(1), m.group(2)
            if final == "m":
                parts = params.split(";") or ["0"]
                j = 0
                while j < len(parts):
                    p = parts[j] or "0"
                    n = int(p) if p.isdigit() else 0
                    if n == 0:
                        fg = None
                        bg = None
                        bold = underline = reverse = italic = False
                    elif n == 1:
                        bold = True
                    elif n == 3:
                        italic = True
                    elif n == 4:
                        underline = True
                    elif n == 7:
                        reverse = True
                    elif n == 22:
                        bold = False
                    elif n == 23:
                        italic = False
                    elif n == 24:
                        underline = False
                    elif n == 27:
                        reverse = False
                    elif 30 <= n <= 37 or 90 <= n <= 97:
                        v = n - 30 if n < 90 else n - 90 + 8
                        fg = _PALETTE[v]
                    elif n == 39:
                        fg = None
                    elif 40 <= n <= 47 or 100 <= n <= 107:
                        v = n - 40 if n < 100 else n - 100 + 8
                        bg = _PALETTE[v]
                    elif n == 49:
                        bg = None
                    elif n in (38, 48):
                        # 38;5;n 或 38;2;r;g;b（以及 (;05;: 形式的冒号变体被 [:;:?] 吞进 params）
                        mode = parts[j + 1].lstrip(":0") or "5"
                        if mode == "5" and j + 2 < len(parts):
                            c = int(parts[j + 2])
                            j += 2
                            if 0 <= c < 256:
                                if n == 38:
                                    fg = _PALETTE[c]
                                else:
                                    bg = _PALETTE[c]
                        elif mode == "2" and j + 4 < len(parts):
                            try:
                                rgb = tuple(int(x) for x in parts[j + 2:j + 5])
                                j += 4
                                if n == 38:
                                    fg = rgb
                                else:
                                    bg = rgb
                            except ValueError:
                                pass
                    j += 1
            # A-H/J/K 等光标操作：取证渲染忽略
            i = m.end()
            continue
        if ch == "\n":
            grid.append([])
            i += 1
            continue
        if ch == "\r":
            i += 1
            continue
        if ch in ("\x07", "\x08", "\x0c"):  # 裸 C0：显示为 ␇/␈/␌ 占位，别吞（曾是要找的缺陷）
            grid[-1].append(Cell({"\x07": "␇", "\x08": "␈", "\x0c": "␌"}[ch], fg, bg, bold, underline, reverse, italic))
            i += 1
            continue
        # 组合字符序列（emoji ZWJ 等）粗略合并
        cluster = ch
        while i + 1 < len(text) and unicodedata.combining(text[i + 1]):
            i += 1
            cluster += text[i]
        grid[-1].append(Cell(cluster, fg, bg, bold, underline, reverse, italic))
        if _eaw_wide(cluster):  # 宽字符占两列：补一个空占位格
            grid[-1].append(Cell(" ", fg, bg, bold, underline, reverse, italic))
        i += 1

    # pad/裁剪到 cols
    out = []
    for row in grid:
        row = row[:cols]
        row += [Cell() for _ in range(cols - len(row))]
        out.append(row)
    return out


def render(grid, font, cw, ch_h, rows=None):
    if rows is not None:
        grid = grid[:rows] or [[Cell()]]
    w, h = cw * (len(grid[0]) if grid else 0), ch_h * max(1, len(grid))
    img = Image.new("RGB", (w, h), (12, 12, 12))
    d = ImageDraw.Draw(img)
    for y, row in enumerate(grid):
        x = 0
        for cell in row:
            fg = cell.fg or (229, 229, 229)
            bg = cell.bg or (12, 12, 12)
            if cell.reverse:
                fg, bg = bg, fg
            if cell.ch != " " or cell.bg:
                d.rectangle([x, y * ch_h, x + cw - 1, y * ch_h + ch_h - 1], fill=bg)
            if cell.ch != " ":
                d.text((x + 1, y * ch_h), cell.ch, font=font, fill=fg)
            if cell.underline:
                d.line([x, y * ch_h + ch_h - 2, x + cw - 1, y * ch_h + ch_h - 2], fill=fg)
            x += cw
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input", help="capture-pane -e 输出文件，或 - 读 stdin")
    ap.add_argument("output", help="输出 PNG 路径")
    ap.add_argument("--cols", type=int, default=120)
    ap.add_argument("--rows", type=int, default=None, help="裁剪到 N 行（默认按内容）")
    args = ap.parse_args()

    text = sys.stdin.read() if args.input == "-" else Path(args.input).read_text(encoding="utf-8", errors="replace")
    grid = parse_ansi(text, args.cols)

    font = None
    for p in FONT_CANDIDATES:
        if Path(p).exists():
            font = ImageFont.truetype(p, 16)
            break
    if font is None:
        font = ImageFont.load_default()
    cw = max(10, font.getbbox("中")[2])  # 以最宽字符（CJK 全角）定列宽
    ch_h = 20
    render(grid, font, cw, ch_h, args.rows).save(args.output)
    print(f"ok: {args.output} ({len(grid)} rows x {args.cols} cols)")


if __name__ == "__main__":
    main()
