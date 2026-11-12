#!/usr/bin/env python3
"""
Build real depth maps for the reel.

For every clip on the live site (SITE_URL/api/site) that doesn't have one yet, run
Depth Anything V2 (small) on the frames and write a tiny grayscale "depth video"
to public/depth/, synced frame-for-frame with the clip (brighter = closer).
The reel uses it for the dot positions instead of guessing depth from brightness.

Also turns public/me/me.jpg (if present) into public/me/me-depth.png for the
3D portrait next to the name.

Runs on GitHub Actions (.github/workflows/depth.yml). Locally:
    pip install onnxruntime numpy pillow huggingface_hub
    SITE_URL=https://aviram.app python scripts/depth.py
"""
import hashlib, json, os, subprocess, sys, urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "depth"
MANIFEST = OUT / "manifest.json"
ME = ROOT / "public" / "me"
SITE_URL = os.environ.get("SITE_URL", "https://aviram.app").rstrip("/")
FPS = 15
LONG_SIDE = int(os.environ.get("DEPTH_SIDE", 308))  # model input long side (multiple of 14)
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)


def log(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------- model
_session = None


def model():
    global _session
    if _session is None:
        import onnxruntime as ort
        path = os.environ.get("DEPTH_MODEL") or str(ROOT / ".cache" / "depth_anything_v2_vits_dynamic.onnx")
        if not os.path.exists(path):
            os.makedirs(os.path.dirname(path), exist_ok=True)
            url = "https://github.com/fabio-sim/Depth-Anything-ONNX/releases/download/v2.0.0/depth_anything_v2_vits_dynamic.onnx"
            log(f"downloading model: {url}")
            urllib.request.urlretrieve(url, path)
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = os.cpu_count() or 4
        _session = ort.InferenceSession(path, opts, providers=["CPUExecutionProvider"])
    return _session


def infer(rgb):
    """rgb: HxWx3 uint8 (H, W multiples of 14) -> HxW float32 relative inverse depth (bigger = closer)."""
    if os.environ.get("DEPTH_DUMMY"):  # pipeline test without the model
        return rgb.mean(axis=2).astype(np.float32)
    x = (rgb.astype(np.float32) / 255.0 - MEAN) / STD
    x = np.transpose(x, (2, 0, 1))[None]
    sess = model()
    out = sess.run(None, {sess.get_inputs()[0].name: x})[0]
    d = out[0] if out.ndim == 3 else out[0, 0]
    if d.shape != rgb.shape[:2]:
        from PIL import Image
        d = np.asarray(Image.fromarray(d).resize((rgb.shape[1], rgb.shape[0]), Image.BILINEAR))
    return d.astype(np.float32)


def dims(w, h):
    """Model-friendly size with the clip's aspect, long side = LONG_SIDE."""
    if w >= h:
        W = LONG_SIDE
        H = max(14, round(LONG_SIDE * h / w / 14) * 14)
    else:
        H = LONG_SIDE
        W = max(14, round(LONG_SIDE * w / h / 14) * 14)
    return W, H


# ---------------------------------------------------------------- clips
def probe(src):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
         "-show_entries", "format=duration", "-of", "json", src],
        capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    s = j["streams"][0]
    return s["width"], s["height"], float(j["format"]["duration"])


def depth_video(src, dest):
    w, h, dur = probe(src)
    W, H = dims(w, h)
    log(f"  {w}x{h} {dur:.1f}s -> depth {W}x{H} @ {FPS}fps")
    dec = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", src, "-vf", f"fps={FPS},scale={W}:{H}:flags=area",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
    enc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{W}x{H}", "-r", str(FPS),
         "-i", "-", "-vf", "scale='if(gt(iw,ih),256,-2)':'if(gt(iw,ih),-2,256)':flags=area",
         "-c:v", "libx264", "-preset", "slow", "-crf", "21", "-g", "8", "-pix_fmt", "yuv420p",
         "-movflags", "+faststart", str(dest)], stdin=subprocess.PIPE)
    size = W * H * 3
    lo = hi = None
    prev = None
    n = 0
    while True:
        buf = dec.stdout.read(size)
        if len(buf) < size:
            break
        rgb = np.frombuffer(buf, np.uint8).reshape(H, W, 3)
        d = infer(rgb)
        # per-frame range, smoothed over time so the scale doesn't pump
        flo, fhi = np.percentile(d, 2), np.percentile(d, 99.5)
        if lo is None:
            lo, hi = flo, fhi
        cut = prev is not None and abs(float(fhi - flo) - float(hi - lo)) > 0.6 * float(hi - lo)
        k = 1.0 if cut else 0.25
        lo, hi = lo + (flo - lo) * k, hi + (fhi - hi) * k
        v = np.clip((d - lo) / max(hi - lo, 1e-6), 0, 1) ** 0.9
        # temporal smoothing per pixel, reset on hard cuts
        if prev is not None and not cut and float(np.abs(v - prev).mean()) < 0.18:
            v = 0.65 * v + 0.35 * prev
        prev = v
        enc.stdin.write((v * 255).astype(np.uint8).tobytes())
        n += 1
        if n % 150 == 0:
            log(f"    {n} frames ({n / FPS:.0f}s)")
    enc.stdin.close()
    enc.wait()
    dec.wait()
    if enc.returncode or n == 0:
        raise RuntimeError(f"encoding failed ({n} frames)")
    return {"w": W, "h": H, "fps": FPS, "frames": n}


def slug(path):
    base = Path(path).stem.lower()
    base = "".join(c if c.isalnum() else "-" for c in base).strip("-")[:40] or "clip"
    return f"{base}-{hashlib.sha1(path.encode()).hexdigest()[:8]}"


def clips():
    if os.environ.get("SITE_JSON"):           # offline: a saved copy of /api/site
        site = json.loads(Path(os.environ["SITE_JSON"]).read_text())
    else:
        with urllib.request.urlopen(f"{SITE_URL}/api/site", timeout=30) as r:
            site = json.load(r)
    return [p["video"] for p in site.get("projects", []) if p.get("video")]


def build_clips():
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    wanted = clips()
    changed = False
    for video in wanted:
        if video in manifest and (OUT / Path(manifest[video]["src"]).name).exists():
            continue
        local = json.loads(os.environ.get("SOURCES", "{}")).get(video)   # offline: local copies
        src = local or (video if video.startswith("http") else SITE_URL + video)
        name = slug(video) + ".mp4"
        log(f"depth: {video}")
        try:
            info = depth_video(src, OUT / name)
        except Exception as e:  # keep going; a bad clip shouldn't block the rest
            log(f"  FAILED: {e}")
            continue
        manifest[video] = {"src": f"/depth/{name}", **info}
        changed = True
        MANIFEST.write_text(json.dumps(manifest, indent=2))  # save progress
    # drop maps for clips that are gone
    for video in [v for v in manifest if v not in wanted]:
        f = OUT / Path(manifest[video]["src"]).name
        if f.exists():
            f.unlink()
        del manifest[video]
        changed = True
        log(f"removed depth for {video}")
    if changed or not MANIFEST.exists():
        MANIFEST.write_text(json.dumps(manifest, indent=2))
    return changed


# ---------------------------------------------------------------- portrait
def build_me():
    from PIL import Image, ImageOps
    src = next((p for p in [ME / "me.jpg", ME / "me.jpeg", ME / "me.png"] if p.exists()), None)
    if not src:
        return False
    dest = ME / "me-depth.png"
    if dest.exists() and dest.stat().st_mtime >= src.stat().st_mtime:
        return False
    log(f"depth: {src.name}")
    img = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
    W, H = dims(*img.size)
    W, H = W * 2 // 14 * 7, H * 2 // 14 * 7   # bigger input (multiples of 14) for a sharper portrait
    W, H = W - W % 14, H - H % 14
    small = img.resize((W, H), Image.LANCZOS)
    d = infer(np.asarray(small))
    lo, hi = np.percentile(d, 1), np.percentile(d, 99.7)
    v = np.clip((d - lo) / max(hi - lo, 1e-6), 0, 1)
    # the person is the near part of the frame: Otsu threshold, then fade the background out
    hist, edges = np.histogram(v, 64, (0, 1))
    w0 = np.cumsum(hist); w1 = w0[-1] - w0
    m = np.cumsum(hist * edges[:-1]); mu0 = m / np.maximum(w0, 1); mu1 = (m[-1] - m) / np.maximum(w1, 1)
    t = edges[np.argmax(w0 * w1 * (mu0 - mu1) ** 2)]
    v = np.where(v > t, 0.15 + 0.85 * (v - t) / max(1 - t, 1e-6), 0)
    Image.fromarray((v * 255).astype(np.uint8)).save(dest)
    small.save(ME / "me-color.jpg", quality=88)
    log(f"  wrote {dest.name} ({W}x{H}), cutoff {t:.2f}")
    return True


if __name__ == "__main__":
    a = build_clips()
    b = build_me()
    log("changed" if (a or b) else "nothing to do")
