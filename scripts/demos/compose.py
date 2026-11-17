# Puts recorded frames into an iPhone frame on a transparent background and writes an animated PNG.
# usage: python3 compose.py <sceneDir> <out.png> [fps] [width]
import json, os, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

scene, dest = sys.argv[1], sys.argv[2]
FPS = float(sys.argv[3]) if len(sys.argv) > 3 else 20
OUT_W = int(sys.argv[4]) if len(sys.argv) > 4 else 480

K = 2  # recorded at 2× CSS pixels; everything below is in CSS px × K
SW, SH = 390, 844  # screen
TOP, BOTTOM = 50, 24  # status bar and home-indicator bands around the 390×770 app
BEZEL, RIM = 12, 3.5
R_OUT = 62
MARGIN_X, MARGIN_TOP, MARGIN_BOTTOM = 34, 26, 44  # room for the side buttons and the shadow

px = lambda v: int(round(v * K))
PW, PH = SW + 2 * (BEZEL + RIM), SH + 2 * (BEZEL + RIM)
CW, CH = px(PW + 2 * MARGIN_X), px(PH + MARGIN_TOP + MARGIN_BOTTOM)
ox, oy = px(MARGIN_X), px(MARGIN_TOP)  # phone's top-left
sx, sy = ox + px(RIM + BEZEL), oy + px(RIM + BEZEL)  # screen's top-left

FONT = ImageFont.truetype('/usr/share/fonts/opentype/inter/Inter-SemiBold.otf', px(16.5))


def rrect(size, box, r, fill):
    m = Image.new('L', size, 0)
    ImageDraw.Draw(m).rounded_rectangle(box, r, fill=fill)
    return m


# ---------- static layers ----------
base = Image.new('RGBA', (CW, CH), (0, 0, 0, 0))
# shadow
sh = rrect((CW, CH), [ox + px(10), oy + px(26), ox + px(PW - 10), oy + px(PH + 8)], px(R_OUT), 90)
sh = sh.filter(ImageFilter.GaussianBlur(px(16)))
base.paste(Image.new('RGBA', (CW, CH), (20, 20, 30, 255)), (0, 0), sh)
# side buttons (left: action, volume up, volume down; right: power), same metal as the rim
metal = (196, 197, 203, 255)
d = ImageDraw.Draw(base)
for x0, y0, h in [(-2.6, 118, 32), (-2.6, 176, 62), (-2.6, 252, 62), (PW - 0.4, 198, 98)]:
    d.rounded_rectangle([ox + px(x0), oy + px(y0), ox + px(x0 + 3), oy + px(y0 + h)], px(1.5), fill=metal)
# rim: a light titanium band with a soft vertical sheen
rim = Image.new('RGBA', (CW, CH))
rd = ImageDraw.Draw(rim)
for y in range(oy, oy + px(PH)):
    k = (y - oy) / px(PH)
    v = int(214 + 22 * (1 - abs(k - 0.35) * 2))
    rd.line([(0, y), (CW, y)], fill=(v - 4, v - 3, v + 2, 255))
base.paste(rim, (0, 0), rrect((CW, CH), [ox, oy, ox + px(PW) - 1, oy + px(PH) - 1], px(R_OUT), 255))
# black glass, the same width on every side
gb = [ox + px(RIM), oy + px(RIM), ox + px(PW - RIM) - 1, oy + px(PH - RIM) - 1]
base.paste(Image.new('RGBA', (CW, CH), (8, 8, 10, 255)), (0, 0), rrect((CW, CH), gb, px(R_OUT - RIM), 255))
screen_mask = rrect((CW, CH), [sx, sy, sx + px(SW) - 1, sy + px(SH) - 1], px(R_OUT - RIM - BEZEL), 255)

# overlays drawn on top of the app: dynamic island, status bar, home indicator
over = Image.new('RGBA', (CW, CH), (0, 0, 0, 0))
o = ImageDraw.Draw(over)
cx = sx + px(SW / 2)
o.rounded_rectangle([cx - px(62), sy + px(11), cx + px(62), sy + px(11 + 36)], px(18), fill=(0, 0, 0, 255))
ink = (18, 18, 20, 255)
o.text((sx + px(54), sy + px(29)), '9:41', font=FONT, fill=ink, anchor='mm')
# signal, wifi, battery
bx = sx + px(SW - 116)
for i in range(4):
    h = 4 + i * 2.6
    o.rounded_rectangle([bx + px(i * 5), sy + px(34 - h), bx + px(i * 5 + 3), sy + px(34)], px(0.8), fill=ink)
wx, wy = sx + px(SW - 82), sy + px(34)
for r, w in [(11, 2.4), (7.2, 2.4)]:
    o.arc([wx - px(r), wy - px(r), wx + px(r), wy + px(r)], 225, 315, fill=ink, width=px(w))
o.ellipse([wx - px(2.2), wy - px(3.6), wx + px(2.2), wy + px(0.8)], fill=ink)
o.rounded_rectangle([sx + px(SW - 64), sy + px(23.5), sx + px(SW - 38), sy + px(35.5)], px(3.6), outline=(18, 18, 20, 110), width=px(1))
o.rounded_rectangle([sx + px(SW - 62), sy + px(25.5), sx + px(SW - 44), sy + px(33.5)], px(2), fill=ink)
o.rounded_rectangle([sx + px(SW - 36.5), sy + px(27.5), sx + px(SW - 35), sy + px(31.5)], px(1), fill=(18, 18, 20, 110))
o.rounded_rectangle([cx - px(67), sy + px(SH - 8 - 5), cx + px(67), sy + px(SH - 8)], px(2.5), fill=ink)

# ---------- frames ----------
meta = json.load(open(os.path.join(scene, 'frames.json')))
src = meta['frames']
n = int(meta['duration'] * FPS)
picks = []
j = 0
for i in range(n):
    t = i / FPS
    while j + 1 < len(src) and src[j + 1]['t'] <= t:
        j += 1
    picks.append(j)

scale = OUT_W / CW
size = (OUT_W, round(CH * scale))
out, durs, last = [], [], None
for j in picks:
    if j == last:
        durs[-1] += 1000 / FPS
        continue
    last = j
    app = Image.open(os.path.join(scene, src[j]['file'])).convert('RGBA')
    if app.width != px(SW):  # the screencast may come at 1×
        app = app.resize((px(SW), round(app.height * px(SW) / app.width)), Image.LANCZOS)
    screen = Image.new('RGBA', (px(SW), px(SH)), app.getpixel((app.width // 2, 2)))
    bottom = app.getpixel((4, app.height - 2))
    ImageDraw.Draw(screen).rectangle([0, px(TOP) + app.height, px(SW), px(SH)], fill=bottom)
    screen.paste(app, (0, px(TOP)))
    frame = base.copy()
    layer = Image.new('RGBA', (CW, CH), (0, 0, 0, 0))
    layer.paste(screen, (sx, sy))
    frame.paste(layer, (0, 0), screen_mask)
    frame.alpha_composite(over)
    out.append(frame.resize(size, Image.LANCZOS))
    durs.append(1000 / FPS)

# ---------- palette: one shared 256-colour palette with per-entry alpha, so frames compress like a GIF ----------
import numpy as np

DITHER = Image.Dither.FLOYDSTEINBERG if os.environ.get('DITHER') else Image.Dither.NONE

arrs = [np.asarray(f) for f in out]
A = arrs[0][..., 3]  # the phone, its shadow and the screen's shape are the same in every frame
opaque, semi = A == 255, (A > 0) & (A < 255)
# screen colours: median cut over pixels sampled across the whole recording
step = max(1, len(arrs) // 30)
sample = np.concatenate([a[opaque][:, :3][::5] for a in arrs[::step]])
side = int(np.ceil(np.sqrt(len(sample))))
sample = np.concatenate([sample, np.repeat(sample[:1], side * side - len(sample), 0)]).reshape(side, side, 3)
N_SCREEN = 256 - 1 - 34 - 16
pal_img = Image.fromarray(sample, 'RGB').quantize(colors=N_SCREEN, method=Image.Quantize.MEDIANCUT)
screen_pal = pal_img.getpalette()[: N_SCREEN * 3]
# The shadow gets fine alpha steps of its own (a coarse step shows as a grey box on white); the rim's anti-aliased
# outer edge gets a few colours.
semi_px = arrs[0][semi].astype(int)
shadow = semi_px[:, 3] < 100
SH_STEP = 3
sh_levels = list(range(SH_STEP, 100 + SH_STEP, SH_STEP))
sh_rgb = semi_px[shadow][:, :3].mean(0).round().astype(int).tolist() if shadow.any() else [20, 20, 30]
semi_idx = np.zeros(len(semi_px), int)
semi_idx[shadow] = 1 + np.clip(np.round(semi_px[shadow][:, 3] / SH_STEP).astype(int) - 1, 0, len(sh_levels) - 1)
edge_px = semi_px[~shadow].astype(np.uint8)
eq = Image.fromarray(edge_px.reshape(1, -1, 4), 'RGBA').quantize(colors=16, method=Image.Quantize.FASTOCTREE)
edge_pal = eq.getpalette('RGBA')
n_edge = len(edge_pal) // 4
semi_idx[~shadow] = 1 + len(sh_levels) + np.asarray(eq).reshape(-1)
n_semi = len(sh_levels) + n_edge
palette = [0, 0, 0] + sh_rgb * len(sh_levels) + [c for i in range(n_edge) for c in edge_pal[i * 4 : i * 4 + 3]] + screen_pal
alphas = bytes([0] + sh_levels + [edge_pal[i * 4 + 3] for i in range(n_edge)] + [255] * N_SCREEN)
off = 1 + n_semi
frames_p = []
for a in arrs:
    q = np.asarray(Image.fromarray(np.ascontiguousarray(a[..., :3]), 'RGB').quantize(palette=pal_img, dither=DITHER))
    idx = np.zeros(A.shape, np.uint8)
    idx[opaque] = q[opaque] + off
    idx[semi] = semi_idx
    im = Image.fromarray(idx, 'P')
    im.putpalette(palette)
    frames_p.append(im)
frames_p[0].save(dest, save_all=True, append_images=frames_p[1:], duration=[round(d) for d in durs], loop=0,
                 disposal=0, blend=0, optimize=True, transparency=alphas)
print(dest, len(out), 'frames', size, f'{os.path.getsize(dest) / 1e6:.1f} MB')
