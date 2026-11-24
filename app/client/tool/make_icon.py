"""生成 Windows 图标（与 Web 端 icon-192.svg 同一图案：深色圆角底 + 菱形描边 + 蓝点）
用法：python tool/make_icon.py   （只用标准库，输出 PNG 内嵌的 .ico）"""
import struct, zlib, math, os

BG, FG, DOT = (0x1B, 0x1B, 0x1F), (0xEC, 0xEC, 0xEF), (0x6E, 0x9C, 0xFF)

def cover(fn, x, y, ss=4):
    n = 0
    for i in range(ss):
        for j in range(ss):
            if fn(x + (i + .5) / ss, y + (j + .5) / ss):
                n += 1
    return n / (ss * ss)

def render(size):
    s = size / 192.0
    def in_rrect(x, y, r=38 * s, w=size):
        cx = min(max(x, r), w - r); cy = min(max(y, r), w - r)
        return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
    def diamond_d(x, y):  # 菱形 |dx|/50 + |dy|/62 = 1 的近似距离
        dx, dy = abs(x / s - 96), abs(y / s - 96)
        return (dx / 50 + dy / 62 - 1) * (50 * 62 / math.hypot(50, 62))
    def in_stroke(x, y):
        # 小尺寸时描边至少 1.5 像素宽，不然缩小后看不见
        return abs(diamond_d(x, y)) <= max(3.5, 0.75 / s)
    def in_dot(x, y):
        return (x / s - 96) ** 2 + (y / s - 96) ** 2 <= 17 ** 2 * (1.4 if size < 32 else 1)
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            a = cover(in_rrect, x, y)
            st = cover(in_stroke, x, y)
            d = cover(in_dot, x, y)
            c = [BG[k] * (1 - st - d) + FG[k] * st + DOT[k] * d for k in range(3)]
            row += bytes([max(0, min(255, round(v))) for v in c] + [round(a * 255)])
        rows.append(bytes(row))
    raw = b''.join(rows)
    def chunk(t, data):
        return struct.pack('>I', len(data)) + t + data + struct.pack('>I', zlib.crc32(t + data) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))

def ico(path, sizes):
    pngs = [render(n) for n in sizes]
    head = struct.pack('<HHH', 0, 1, len(sizes))
    off = 6 + 16 * len(sizes)
    ents = b''
    for n, p in zip(sizes, pngs):
        ents += struct.pack('<BBBBHHII', n % 256, n % 256, 0, 0, 1, 32, len(p), off)
        off += len(p)
    with open(path, 'wb') as f:
        f.write(head + ents + b''.join(pngs))

root = os.path.join(os.path.dirname(__file__), '..')
ico(os.path.join(root, 'windows/runner/resources/app_icon.ico'), [16, 24, 32, 48, 64, 256])
ico(os.path.join(root, 'assets/tray.ico'), [16, 20, 24, 32])
with open(os.path.join(root, 'assets/icon.png'), 'wb') as f:
    f.write(render(256))
print('ok')
