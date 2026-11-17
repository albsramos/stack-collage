# Demo media for the README recordings: two illustrated "photos" and a 10 s sunset clip.
import math, os, subprocess, sys
from PIL import Image, ImageDraw, ImageFilter

out = sys.argv[1]
W, H = 1200, 800


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def vgrad(img, top, bottom, y0=0, y1=None):
    d = ImageDraw.Draw(img)
    y1 = img.height if y1 is None else y1
    for y in range(y0, y1):
        d.line([(0, y), (img.width, y)], fill=lerp(top, bottom, (y - y0) / max(1, y1 - y0 - 1)))


# --- mountains ---
im = Image.new('RGB', (W, H))
vgrad(im, (150, 200, 235), (214, 232, 244))
d = ImageDraw.Draw(im)
d.polygon([(-50, 800), (330, 230), (520, 470), (760, 160), (1250, 800)], fill=(84, 106, 132))
d.polygon([(330, 230), (282, 302), (318, 290), (350, 320), (380, 300)], fill=(244, 247, 250))
d.polygon([(760, 160), (700, 252), (744, 236), (782, 268), (822, 246)], fill=(244, 247, 250))
d.polygon([(-50, 800), (180, 520), (420, 800)], fill=(52, 72, 84))
d.polygon([(380, 800), (980, 430), (1250, 640), (1250, 800)], fill=(44, 64, 78))
d.rectangle([0, 740, W, H], fill=(38, 58, 70))
im.save(os.path.join(out, 'mountains.png'))

# --- citrus ---
im = Image.new('RGB', (W, H), (38, 64, 196))
d = ImageDraw.Draw(im)


def slice_(cx, cy, r, rind, flesh):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=rind)
    r2 = r * 0.88
    d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], fill=(255, 246, 214))
    r3 = r * 0.82
    d.ellipse([cx - r3, cy - r3, cx + r3, cy + r3], fill=flesh)
    for k in range(10):
        a = k * math.pi / 5
        d.line([(cx, cy), (cx + math.cos(a) * r3, cy + math.sin(a) * r3)], fill=(255, 238, 190), width=5)


slice_(400, 420, 260, (240, 170, 20), (255, 196, 40))
slice_(800, 360, 220, (232, 110, 30), (250, 140, 50))
slice_(650, 620, 170, (230, 210, 40), (250, 236, 90))
im.save(os.path.join(out, 'citrus.png'))

# --- sunset clip: the sun sinks into the sea, its reflection shimmering ---
fd = os.path.join(out, 'frames')
os.makedirs(fd, exist_ok=True)
VW, VH, FPS, SEC = 960, 640, 30, 10
for f in range(FPS * SEC):
    t = f / (FPS * SEC)
    im = Image.new('RGB', (VW, VH))
    horizon = int(VH * 0.58)
    vgrad(im, lerp((242, 170, 140), (120, 80, 140), t), lerp((250, 214, 170), (240, 120, 90), t), 0, horizon)
    vgrad(im, lerp((70, 90, 140), (40, 40, 80), t), lerp((40, 50, 90), (20, 20, 50), t), horizon, VH)
    glow = Image.new('RGBA', (VW, VH), (255, 220, 160, 0))
    g = ImageDraw.Draw(glow)
    sy = int(VH * 0.22 + t * VH * 0.42)
    r = 70
    g.ellipse([VW / 2 - r * 2.2, sy - r * 2.2, VW / 2 + r * 2.2, sy + r * 2.2], fill=(255, 220, 160, 70))
    glow = glow.filter(ImageFilter.GaussianBlur(30))
    im.paste(glow, (0, 0), glow)
    sun = Image.new('RGBA', (VW, VH), (0, 0, 0, 0))
    ImageDraw.Draw(sun).ellipse([VW / 2 - r, sy - r, VW / 2 + r, sy + r], fill=lerp((255, 236, 180), (255, 150, 90), t) + (255,))
    mask = Image.new('L', (VW, VH), 0)
    ImageDraw.Draw(mask).rectangle([0, 0, VW, horizon], fill=255)
    im.paste(sun, (0, 0), Image.composite(sun, Image.new('RGBA', (VW, VH)), mask))
    d = ImageDraw.Draw(im)
    for k in range(9):  # reflection lines
        y = horizon + 14 + k * 16
        w = (150 - k * 12) * (1 - t * 0.5) * (0.85 + 0.15 * math.sin(f * 0.35 + k))
        d.line([(VW / 2 - w, y), (VW / 2 + w, y)], fill=lerp((255, 220, 170), (255, 150, 100), t), width=4)
    im.save(os.path.join(fd, f'{f:04d}.png'))
subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-framerate', str(FPS), '-i', os.path.join(fd, '%04d.png'),
                '-c:v', 'libvpx-vp9', '-b:v', '2M', '-deadline', 'realtime', '-pix_fmt', 'yuv420p',
                os.path.join(out, 'sunset.webm')], check=True)
print('ok')
