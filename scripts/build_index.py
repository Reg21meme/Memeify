#!/usr/bin/env python3
"""
Index builder: scans folders, computes features, writes data/memes-index.json

Features per image:
  - CLIP embedding (ViT-L/14, RGB)
  - MediaPipe Pose vector (33 keypoints -> 99-dim), normalized by shoulder width
  - MediaPipe FaceMesh vector (468 keypoints -> 1404-dim), normalized by face size
"""

import os, sys, json, time, argparse
from pathlib import Path
import numpy as np
import torch
import open_clip
from PIL import Image
import cv2
import mediapipe as mp

# ---- Model config ----
CLIP_MODEL      = "ViT-L-14"
CLIP_PRETRAINED = "openai"
DEVICE          = "cuda" if torch.cuda.is_available() else "cpu"
IMG_EXTS        = {".jpg", ".jpeg", ".png", ".webp", ".gif"}

os.environ["TF_CPP_MIN_LOG_LEVEL"] = "2"

# MediaPipe modules (pose + facemesh)
mp_pose = mp.solutions.pose
mp_face = mp.solutions.face_mesh


def _find_images(roots):
    files = []
    for root in roots:
        r = Path(root)
        if not r.exists():
            continue
        for p in r.rglob("*"):
            if p.suffix.lower() in IMG_EXTS and p.is_file():
                files.append(p)
    files.sort()
    return files


def _load_clip():
    print(f"[INFO] Loading CLIP model {CLIP_MODEL}/{CLIP_PRETRAINED} on {DEVICE}...")
    model, _, preprocess = open_clip.create_model_and_transforms(
        CLIP_MODEL, pretrained=CLIP_PRETRAINED, device=DEVICE
    )
    model.eval()
    return model, preprocess


def _clip_embed(model, preprocess, image_path):
    # PIL reads any format; use first frame for GIF
    img = Image.open(image_path)
    try:
        img.seek(0)
    except Exception:
        pass
    # RGB (keep full colour / texture info)
    img = img.convert("RGB")
    with torch.no_grad():
        t = preprocess(img).unsqueeze(0).to(DEVICE)
        f = model.encode_image(t)
        f = f / f.norm(dim=-1, keepdim=True)
        return f.cpu().numpy().astype("float32")[0].tolist()


def _read_bgr(image_path: Path):
    img = cv2.imread(str(image_path))
    if img is not None:
        return img
    # Fallback (GIFs / odd formats)
    try:
        pil = Image.open(str(image_path))
        pil.seek(0)
        pil = pil.convert("RGB")
        return cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
    except Exception:
        return None


def _pose_vector(image_path):
    img = _read_bgr(image_path)
    if img is None:
        return []
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    with mp_pose.Pose(static_image_mode=True, model_complexity=2) as pose:
        res = pose.process(rgb)
        if not res.pose_landmarks:
            return []
        lm = res.pose_landmarks.landmark
        L, R = lm[11], lm[12]  # shoulders
        cx, cy = (L.x + R.x) / 2.0, (L.y + R.y) / 2.0
        sw = max(1e-6, float(np.hypot(L.x - R.x, L.y - R.y)))
        pts = np.array([[p.x, p.y, p.visibility] for p in lm], dtype=np.float32)
        pts[:, 0] = (pts[:, 0] - cx) / sw
        pts[:, 1] = (pts[:, 1] - cy) / sw
        return pts.flatten().tolist()   # 99 dims


def _face_vector(image_path):
    """
    Returns a face expression vector using MediaPipe FaceMesh:
    468 landmarks * (x,y,z) = 1404 dims, normalized by face size.
    """
    img = _read_bgr(image_path)
    if img is None:
        return []
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    with mp_face.FaceMesh(
        static_image_mode=True,
        max_num_faces=1,
        refine_landmarks=True,
        min_detection_confidence=0.5
    ) as face_mesh:
        res = face_mesh.process(rgb)
        if not res.multi_face_landmarks:
            return []
        lm = res.multi_face_landmarks[0].landmark
        pts = np.array([[p.x, p.y, p.z] for p in lm], dtype=np.float32)  # (468,3)

        # Normalize: center + scale by RMS distance from center (robust)
        cx, cy = pts[:, 0].mean(), pts[:, 1].mean()
        pts[:, 0] -= cx
        pts[:, 1] -= cy
        scale = np.sqrt((pts[:, 0] ** 2 + pts[:, 1] ** 2).mean()) + 1e-6
        pts[:, 0] /= scale
        pts[:, 1] /= scale
        pts[:, 2] /= scale
        return pts.flatten().tolist()  # 1404 dims


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--roots",
        nargs="+",
        default=["public/uploads", "public/meme-templates"],
    )
    ap.add_argument("--out", default="data/memes-index.json")
    args = ap.parse_args()

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    files = _find_images(args.roots)
    print(f"[INFO] Found {len(files)} images")

    model, preprocess = _load_clip()
    items = []
    t0 = time.time()

    for i, p in enumerate(files, 1):
        rel = str(p).replace("\\", "/")
        parts = [s.lower() for s in rel.split("/")]
        if "public" in parts:
            idx = parts.index("public")
            local_rel = "/".join(rel.split("/")[idx + 1 :])
        else:
            local_rel = rel

        try:
            clip_vec = _clip_embed(model, preprocess, p)
        except Exception:
            clip_vec = []

        try:
            pose_vec = _pose_vector(p)
        except Exception:
            pose_vec = []

        try:
            face_vec = _face_vector(p)
        except Exception:
            face_vec = []

        items.append(
            {
                "id": os.path.splitext(os.path.basename(rel))[0],
                "localPath": local_rel,
                "clip_vec": clip_vec,
                "pose_vec": pose_vec,
                "face_vec": face_vec,
            }
        )

        if i % 25 == 0:
            print(f"[INFO] {i}/{len(files)} processed in {time.time() - t0:.1f}s")

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(items, f, indent=2)
    print(
        f"[DONE] Wrote {len(items)} items -> {out_path} in {time.time() - t0:.1f}s"
    )


if __name__ == "__main__":
    main()
