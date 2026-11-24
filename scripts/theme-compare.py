"""把四套主题截图拼成对比图：单张带标签 + 2x2 总览"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "out/screens/themes")
DST = os.path.join(ROOT, "out/screens/candidates")
os.makedirs(DST, exist_ok=True)

FONT_MED = "/usr/share/fonts/opentype/noto/NotoSansCJK-Medium.ttc"
FONT_REG = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"

THEMES = [
    ("md3", "方案 A · MD3（Material You，teal 种子色）"),
    ("flat", "方案 B · 扁平极简（Linear 风，发丝线 + 单一强调色）"),
    ("paper", "方案 C · 纸墨（Notion 风，暖纸底 + 深墨绿）"),
    ("swiss", "方案 D · 瑞士硬边（Brutalist，黑框 + 硬投影 + 橙）"),
]

BAR = 84          # 标签条高度
MARGIN = 28
GAP = 20
BG = (238, 238, 238)


def label_bar(width, text, color=(20, 20, 20)):
    bar = Image.new("RGB", (width, BAR), (255, 255, 255))
    d = ImageDraw.Draw(bar)
    d.rectangle([0, 0, 10, BAR], fill=(20, 20, 20))
    f = ImageFont.truetype(FONT_MED, 34)
    d.text((30, BAR // 2), text, font=f, fill=color, anchor="lm")
    return bar


def single(theme, title, target_w=1520):
    chat = Image.open(f"{SRC}/chat-{theme}.png").convert("RGB")
    w, h = chat.size
    scale = target_w / w
    chat = chat.resize((target_w, int(h * scale)), Image.LANCZOS)
    bar = label_bar(target_w, title)
    canvas = Image.new("RGB", (target_w, BAR + chat.height), (255, 255, 255))
    canvas.paste(bar, (0, 0))
    canvas.paste(chat, (0, BAR))
    path = f"{DST}/candidate-{theme}.png"
    canvas.save(path, optimize=True)
    return path, canvas


def overview(items, tile_w=760):
    tiles = []
    for theme, title in THEMES:
        chat = Image.open(f"{SRC}/chat-{theme}.png").convert("RGB")
        w, h = chat.size
        chat = chat.resize((tile_w, int(h * tile_w / w)), Image.LANCZOS)
        short = title.split("（")[0].strip()
        bar = label_bar(tile_w, short)
        t = Image.new("RGB", (tile_w, BAR + chat.height), (255, 255, 255))
        t.paste(bar, (0, 0))
        t.paste(chat, (0, BAR))
        tiles.append(t)
    tw = tile_w * 2 + GAP
    th = tiles[0].height * 2 + GAP
    grid = Image.new("RGB", (tw + MARGIN * 2, th + MARGIN * 2), BG)
    for i, t in enumerate(tiles):
        x = MARGIN + (i % 2) * (tile_w + GAP)
        y = MARGIN + (i // 2) * (tiles[0].height + GAP)
        grid.paste(t, (x, y))
    path = f"{DST}/overview-2x2.png"
    grid.save(path, optimize=True)
    return path, grid


def pair(theme, title, target_h=700):
    """登录页 + 聊天页并排，用来看两种页面是否是同一套语言"""
    chat = Image.open(f"{SRC}/chat-{theme}.png").convert("RGB")
    auth = Image.open(f"{SRC}/auth-{theme}.png").convert("RGB")
    # 登录页裁掉两侧空白，只留中间的卡片区域
    aw, ah = auth.size
    crop_w = int(aw * 0.42)
    auth = auth.crop(((aw - crop_w) // 2, int(ah * 0.10), (aw + crop_w) // 2, int(ah * 0.80)))
    ch = chat.resize((int(chat.width * target_h / chat.height), target_h), Image.LANCZOS)
    au = auth.resize((int(auth.width * (target_h * 0.86) / auth.height), int(target_h * 0.86)), Image.LANCZOS)
    total_w = au.width + ch.width + GAP
    canvas = Image.new("RGB", (total_w, BAR + target_h), (255, 255, 255))
    canvas.paste(label_bar(total_w, title), (0, 0))
    canvas.paste(ch, (0, BAR))
    canvas.paste(au, (ch.width + GAP, BAR + (target_h - au.height) // 2))
    path = f"{DST}/pair-{theme}.png"
    canvas.save(path, optimize=True)
    return path, canvas


for theme, title in THEMES:
    p, img = pair(theme, title)
    print("pair", p, img.size)
    p, img = single(theme, title)
    print("single", p, img.size)
p, img = overview(THEMES, 760)
print("overview", p, img.size)
