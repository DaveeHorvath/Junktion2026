#!/usr/bin/env python3
"""Maxwell SPINNING while bouncing around a 64x32 HUB75 LED panel.

Needs NOTHING extra: no internet, no library, no Cython, no compiling.
Only plain Python 3 that comes with Raspberry Pi OS.
Works on Raspberry Pi 1, 2, 3, 4 and Zero (not Pi 5).
Uses the same wiring as before (hzeller "regular" mapping).

Usage:
    sudo python3 maxwell_spin.py maxwell.png            turntable spin (the meme)
    sudo python3 maxwell_spin.py maxwell.png --flat     spin like a clock hand instead
    python3 maxwell_spin.py maxwell.png --preview       print the spin frames as text

The picture must be a .png file. Stop with Ctrl+C.
"""
import math
import mmap
import os
import struct
import sys
import time
import zlib

# ----------------------------------------------------------------- settings
PANEL_W, PANEL_H = 64, 32
CAT_MAX_W, CAT_MAX_H = 34, 24     # cat size on the panel, in LEDs
SPEED_X, SPEED_Y = 0.5, 0.3       # LEDs per step
STEPS_PER_SECOND = 30
SPIN_FRAMES = 24                  # pictures per full turn
STEPS_PER_SPIN_FRAME = 2          # higher = slower spin
OUTLINE = True                    # pixel-art style 1-LED outline around the cat
OUTLINE_COLOUR = 7                # 0-7 (r*4 + g*2 + b), 7 = white
BG_THRESHOLD = 14                 # how close to the grey background counts as background

# Background colours (only on/off per colour is possible): (red, green, blue)
BACKGROUNDS = [(0, 0, 1), (1, 0, 1), (0, 1, 0), (1, 0, 0), (0, 1, 1), (1, 1, 0)]

# GPIO numbers for the wiring we did (physical pin in comment)
R1, G1, B1 = 11, 27, 7     # pins 23, 13, 26
R2, G2, B2 = 8, 9, 10      # pins 24, 21, 19
ADDR = [22, 23, 24, 25]    # A B C D = pins 15, 16, 18, 22
CLK, LAT, OE = 17, 4, 18   # pins 11, 7, 12


# ------------------------------------------------------------ PNG reading
def read_png(path):
    """Tiny PNG decoder using only the standard library."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        sys.exit(f"{path} is not a PNG file. Save the picture as .png and try again.")
    pos, idat, palette, trns = 8, bytearray(), None, None
    w = h = depth = ctype = interlace = None
    while pos < len(data):
        length, = struct.unpack(">I", data[pos:pos + 4])
        kind = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if kind == b"IHDR":
            w, h, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", chunk)
        elif kind == b"PLTE":
            palette = [tuple(chunk[i:i + 3]) for i in range(0, len(chunk), 3)]
        elif kind == b"tRNS":
            trns = chunk
        elif kind == b"IDAT":
            idat += chunk
        elif kind == b"IEND":
            break
    if depth != 8 or interlace != 0 or ctype not in (0, 2, 3, 4, 6):
        sys.exit("Unsupported PNG type. Re-save it as a normal 8-bit PNG.")
    bpp = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ctype]
    raw = zlib.decompress(bytes(idat))
    stride = w * bpp
    prev = bytearray(stride)
    rows = []
    i = 0
    for _ in range(h):
        ftype = raw[i]
        line = bytearray(raw[i + 1:i + 1 + stride])
        i += 1 + stride
        if ftype == 1:
            for x in range(bpp, stride):
                line[x] = (line[x] + line[x - bpp]) & 255
        elif ftype == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif ftype == 3:
            for x in range(stride):
                left = line[x - bpp] if x >= bpp else 0
                line[x] = (line[x] + ((left + prev[x]) >> 1)) & 255
        elif ftype == 4:
            for x in range(stride):
                a = line[x - bpp] if x >= bpp else 0
                b = prev[x]
                c = prev[x - bpp] if x >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pred) & 255
        rows.append(line)
        prev = line

    def pixel(x, y):
        line = rows[y]
        if ctype == 6:
            return tuple(line[4 * x:4 * x + 4])
        if ctype == 2:
            r, g, b = line[3 * x:3 * x + 3]
            return r, g, b, 255
        if ctype == 3:
            idx = line[x]
            r, g, b = palette[idx]
            a = trns[idx] if trns and idx < len(trns) else 255
            return r, g, b, a
        if ctype == 4:
            v, a = line[2 * x:2 * x + 2]
            return v, v, v, a
        v = line[x]
        return v, v, v, 255

    return w, h, pixel


# -------------------------------------------------------- picture preparing
def prepare_cat(path):
    """Returns (width, height, pixels) where each pixel is a colour 0-7 or None (see-through)."""
    cache = path + ".cat.txt"
    if os.path.exists(cache) and os.path.getmtime(cache) >= os.path.getmtime(path):
        with open(cache) as f:
            lines = f.read().split()
        cw, ch = int(lines[0]), int(lines[1])
        px = [None if c == "." else int(c) for c in "".join(lines[2:])]
        return cw, ch, px

    print("Preparing the picture (first time only, can take up to a minute)...")
    w, h, pixel = read_png(path)

    # 1) shrink to a working size
    scale = max(w, h) / 256
    sw, sh = max(1, int(w / scale)), max(1, int(h / scale))
    small = [[pixel(min(w - 1, int(x * scale)), min(h - 1, int(y * scale)))
              for x in range(sw)] for y in range(sh)]

    # 2) remove the background: flood-fill from the corners
    ref = small[0][0]

    def is_bg(p):
        return p[3] < 128 or max(abs(p[0] - ref[0]), abs(p[1] - ref[1]), abs(p[2] - ref[2])) <= BG_THRESHOLD

    bg = [[False] * sw for _ in range(sh)]
    todo = [(0, 0), (sw - 1, 0), (0, sh - 1), (sw - 1, sh - 1)]
    while todo:
        x, y = todo.pop()
        if 0 <= x < sw and 0 <= y < sh and not bg[y][x] and is_bg(small[y][x]):
            bg[y][x] = True
            todo += [(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)]

    # 3) crop to the cat
    ys = [y for y in range(sh) if not all(bg[y])]
    xs = [x for x in range(sw) if not all(bg[y][x] for y in range(sh))]
    if not xs or not ys:
        sys.exit("Couldn't find the cat in the picture.")
    x0, x1, y0, y1 = xs[0], xs[-1] + 1, ys[0], ys[-1] + 1

    # 4) shrink to panel size, keeping its shape
    k = min(CAT_MAX_W / (x1 - x0), CAT_MAX_H / (y1 - y0))
    cw, ch = max(1, round((x1 - x0) * k)), max(1, round((y1 - y0) * k))
    px = []
    for cy in range(ch):
        for cx in range(cw):
            ax, bx = x0 + int(cx / k), max(x0 + int(cx / k) + 1, x0 + int((cx + 1) / k))
            ay, by = y0 + int(cy / k), max(y0 + int(cy / k) + 1, y0 + int((cy + 1) / k))
            n = fg = r = g = b = 0
            for yy in range(ay, min(by, y1)):
                for xx in range(ax, min(bx, x1)):
                    n += 1
                    if not bg[yy][xx]:
                        p = small[yy][xx]
                        fg += 1
                        r, g, b = r + p[0], g + p[1], b + p[2]
            if fg * 2 < max(n, 1):
                px.append(None)
            else:
                # each colour can only be on or off on this simple driver
                px.append((r // fg >= 128) * 4 + (g // fg >= 128) * 2 + (b // fg >= 128))

    with open(cache, "w") as f:
        f.write(f"{cw} {ch}\n")
        for cy in range(ch):
            f.write("".join("." if p is None else str(p) for p in px[cy * cw:(cy + 1) * cw]) + "\n")
    return cw, ch, px


def print_preview(cw, ch, px):
    marks = {None: " ", 0: "#", 7: "o"}
    for cy in range(ch):
        print("".join(marks.get(p, "+") for p in px[cy * cw:(cy + 1) * cw]))
    print(f"({cw}x{ch} LEDs.  # = black fur, o = white, + = other colour)")


# ------------------------------------------------------------ spin frames
def add_outline(bw, bh, px):
    """Grow the picture by 1 LED on every side and draw an outline around the cat."""
    nw, nh = bw + 2, bh + 2
    out = [None] * (nw * nh)
    for y in range(bh):
        out[(y + 1) * nw + 1:(y + 1) * nw + 1 + bw] = px[y * bw:(y + 1) * bw]
    if not OUTLINE:
        return nw, nh, out
    res = list(out)
    for y in range(nh):
        for x in range(nw):
            if out[y * nw + x] is None:
                for ax, ay in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if 0 <= ax < nw and 0 <= ay < nh and out[ay * nw + ax] is not None:
                        res[y * nw + x] = OUTLINE_COLOUR
                        break
    return nw, nh, res


def turntable_frames(cw, ch, cat):
    """Spin around the vertical axis, like Maxwell on his turntable.
    Every frame has the same box size, so the bounce stays inside the panel."""
    frames = []
    for i in range(SPIN_FRAMES):
        c = math.cos(2 * math.pi * i / SPIN_FRAMES)
        w = max(1, round(cw * abs(c)))
        off = (cw - w) // 2
        px = [None] * (cw * ch)
        for y in range(ch):
            for j in range(w):
                sx = min(cw - 1, int((j + 0.5) * cw / w))
                if c < 0:
                    sx = cw - 1 - sx                     # seen from behind = mirrored
                p = cat[y * cw + sx]
                if p is not None and c < 0:
                    p = 0                                # his back is all black fur
                px[y * cw + off + j] = p
        frames.append(add_outline(cw, ch, px))
    return frames


def flat_frames(cw, ch, cat):
    """Spin like a clock hand. The cat is shrunk so every angle fits the panel height."""
    diag = math.hypot(cw, ch)
    box = min(math.ceil(diag), PANEL_H - 2)
    f = box / diag                                       # shrink factor
    frames = []
    for i in range(SPIN_FRAMES):
        a = 2 * math.pi * i / SPIN_FRAMES
        ca, sa = math.cos(a), math.sin(a)
        px = [None] * (box * box)
        for y in range(box):
            for x in range(box):
                dx, dy = (x + 0.5 - box / 2) / f, (y + 0.5 - box / 2) / f
                sx = int(ca * dx + sa * dy + cw / 2)     # rotate back into the picture
                sy = int(-sa * dx + ca * dy + ch / 2)
                if 0 <= sx < cw and 0 <= sy < ch:
                    px[y * box + x] = cat[sy * cw + sx]
        frames.append(add_outline(box, box, px))
    return frames


def print_frames(frames, count=4):
    marks = {None: " ", 0: "#", 7: "o"}
    step = max(1, len(frames) // count)
    for k in range(0, len(frames), step):
        bw, bh, px = frames[k]
        print(f"--- frame {k} ---")
        for y in range(bh):
            print("".join(marks.get(p, "+") for p in px[y * bw:(y + 1) * bw]).rstrip())


# ------------------------------------------------------------- GPIO driver
class Panel:
    GPSET0, GPCLR0 = 0x1C // 4, 0x28 // 4

    def __init__(self):
        try:
            with open("/proc/device-tree/model") as f:
                model = f.read()
        except OSError:
            model = ""
        if "Raspberry Pi 5" in model:
            sys.exit("This simple driver doesn't work on a Raspberry Pi 5, sorry.")
        try:
            fd = os.open("/dev/gpiomem", os.O_RDWR | os.O_SYNC)
        except PermissionError:
            sys.exit("No access to GPIO. Run it with: sudo python3 " + " ".join(sys.argv))
        self.mem = mmap.mmap(fd, 4096, mmap.MAP_SHARED, mmap.PROT_READ | mmap.PROT_WRITE)
        os.close(fd)
        self.reg = memoryview(self.mem).cast("I")

        pins = [R1, G1, B1, R2, G2, B2, CLK, LAT, OE] + ADDR
        for p in pins:                              # make every pin an output
            i, shift = p // 10, (p % 10) * 3
            self.reg[i] = (self.reg[i] & ~(7 << shift)) | (1 << shift)

        self.data_mask = (1 << R1) | (1 << G1) | (1 << B1) | (1 << R2) | (1 << G2) | (1 << B2)
        self.addr_mask = sum(1 << p for p in ADDR)
        self.clk = 1 << CLK
        self.lat = 1 << LAT
        self.oe = 1 << OE
        self.top = [((c >> 2) & 1) << R1 | ((c >> 1) & 1) << G1 | (c & 1) << B1 for c in range(8)]
        self.bot = [((c >> 2) & 1) << R2 | ((c >> 1) & 1) << G2 | (c & 1) << B2 for c in range(8)]
        self.addr = [sum(((r >> bit) & 1) << p for bit, p in enumerate(ADDR)) for r in range(16)]
        self.off()

    def build(self, image):
        """image: list of 32 rows of 64 colours (0-7). Returns ready-to-send bit masks."""
        top, bot = self.top, self.bot
        return [[top[a] | bot[b] for a, b in zip(image[r], image[r + 16])] for r in range(16)]

    def refresh(self, frame):
        """Draw one whole frame (all 16 row pairs) once."""
        reg, SET, CLR = self.reg, self.GPSET0, self.GPCLR0
        clear_cols = self.data_mask | self.clk
        clk, lat, oe, amask, addr = self.clk, self.lat, self.oe, self.addr_mask, self.addr
        for r in range(16):
            for bits in frame[r]:            # shift in the next row (old row stays lit)
                reg[CLR] = clear_cols
                reg[SET] = bits
                reg[SET] = clk
            reg[SET] = oe                    # LEDs off
            reg[CLR] = amask
            reg[SET] = addr[r]               # choose the row
            reg[SET] = lat                   # latch the new data
            reg[CLR] = lat
            reg[CLR] = oe                    # LEDs on

    def off(self):
        self.reg[self.GPSET0] = self.oe


# --------------------------------------------------------------------- main
def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    path = args[0] if args else "maxwell.png"
    if not os.path.exists(path):
        sys.exit(f"Can't find {path}. Put the picture next to this script.")
    cw, ch, cat = prepare_cat(path)
    # outline adds 2 LEDs, so make sure the turntable box still fits
    if ch + 2 > PANEL_H or cw + 2 > PANEL_W:
        sys.exit("Cat is too big: lower CAT_MAX_W / CAT_MAX_H and delete the .cat.txt file.")
    frames = flat_frames(cw, ch, cat) if "--flat" in sys.argv else turntable_frames(cw, ch, cat)
    if "--preview" in sys.argv:
        print_frames(frames)
        return

    bw, bh = frames[0][0], frames[0][1]
    panel = Panel()
    max_x, max_y = PANEL_W - bw, PANEL_H - bh
    spin_i, spin_count = 0, 0
    x, y = max_x / 2, max_y / 2
    dx, dy = SPEED_X, SPEED_Y
    bg_i = 0
    step_time = 1 / STEPS_PER_SECOND
    next_step = 0.0
    frame = None
    print("Running! Press Ctrl+C to stop.")
    try:
        while True:
            now = time.monotonic()
            if now >= next_step:
                next_step = now + step_time
                x, y = x + dx, y + dy
                bounced = False
                if x <= 0 or x >= max_x:     # keep the whole cat on screen
                    x, dx, bounced = min(max(x, 0), max_x), -dx, True
                if y <= 0 or y >= max_y:
                    y, dy, bounced = min(max(y, 0), max_y), -dy, True
                if bounced:
                    bg_i = (bg_i + 1) % len(BACKGROUNDS)
                r, g, b = BACKGROUNDS[bg_i]
                bgc = r * 4 + g * 2 + b
                spin_count += 1
                if spin_count >= STEPS_PER_SPIN_FRAME:
                    spin_count, spin_i = 0, (spin_i + 1) % len(frames)
                _, _, sprite = frames[spin_i]
                img = [[bgc] * PANEL_W for _ in range(PANEL_H)]
                ox, oy = round(x), round(y)
                for cy in range(bh):
                    row = img[oy + cy]
                    for cx in range(bw):
                        p = sprite[cy * bw + cx]
                        if p is not None:
                            row[ox + cx] = p
                frame = panel.build(img)
            panel.refresh(frame)
    except KeyboardInterrupt:
        panel.off()
        print("\nBye, Maxwell")


if __name__ == "__main__":
    main()
