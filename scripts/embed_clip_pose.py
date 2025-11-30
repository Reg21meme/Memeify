#!/usr/bin/env python3
import os, sys, json
import numpy as np
import torch, open_clip
from PIL import Image
import cv2, mediapipe as mp

os.environ["TF_CPP_MIN_LOG_LEVEL"] = "2"

CLIP_MODEL, CLIP_PRETRAINED = "ViT-L-14", "openai"
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

mp_pose = mp.solutions.pose
mp_face = mp.solutions.face_mesh


def clip_embed(model, preprocess, image_path):
    img = Image.open(image_path)
    try:
        img.seek(0)
    except Exception:
        pass
    img = img.convert("RGB")
    with torch.no_grad():
        t = preprocess(img).unsqueeze(0).to(DEVICE)
        f = model.encode_image(t)
        f = f / f.norm(dim=-1, keepdim=True)
        return f.cpu().numpy().astype("float32")[0].tolist()


def _read_bgr(image_path):
    img = cv2.imread(str(image_path))
    if img is not None:
        return img
    try:
        pil = Image.open(str(image_path))
        pil.seek(0)
        pil = pil.convert("RGB")
        return cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
    except Exception:
        return None


def pose_vector(image_path):
    img = _read_bgr(image_path)
    if img is None:
        return []
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    with mp_pose.Pose(static_image_mode=True, model_complexity=2) as pose:
        res = pose.process(rgb)
        if not res.pose_landmarks:
            return []
        lm = res.pose_landmarks.landmark
        L, R = lm[11], lm[12]
        cx, cy = (L.x + R.x) / 2.0, (L.y + R.y) / 2.0
        sw = max(1e-6, float(np.hypot(L.x - R.x, L.y - R.y)))
        pts = np.array([[p.x, p.y, p.visibility] for p in lm], dtype=np.float32)
        pts[:, 0] = (pts[:, 0] - cx) / sw
        pts[:, 1] = (pts[:, 1] - cy) / sw
        return pts.flatten().tolist()


def face_vector(image_path):
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
        pts = np.array([[p.x, p.y, p.z] for p in lm], dtype=np.float32)

        cx, cy = pts[:, 0].mean(), pts[:, 1].mean()
        pts[:, 0] -= cx
        pts[:, 1] -= cy
        scale = np.sqrt((pts[:, 0] ** 2 + pts[:, 1] ** 2).mean()) + 1e-6
        pts[:, 0] /= scale
        pts[:, 1] /= scale
        pts[:, 2] /= scale
        return pts.flatten().tolist()


def main():
    if len(sys.argv) < 2:
        print("###FEATURES_START###")
        print(json.dumps({"clip_vec": [], "pose_vec": [], "face_vec": []}))
        print("###FEATURES_END###")
        return

    path = sys.argv[1]
    model, _, preprocess = open_clip.create_model_and_transforms(
        CLIP_MODEL, pretrained=CLIP_PRETRAINED, device=DEVICE
    )
    model.eval()

    try:
        clip_vec = clip_embed(model, preprocess, path)
    except Exception:
        clip_vec = []
    try:
        pose_vec = pose_vector(path)
    except Exception:
        pose_vec = []
    try:
        face_vec = face_vector(path)
    except Exception:
        face_vec = []

    print("###FEATURES_START###")
    print(
        json.dumps(
            {
                "clip_vec": clip_vec,
                "pose_vec": pose_vec,
                "face_vec": face_vec,
            }
        )
    )
    print("###FEATURES_END###")


if __name__ == "__main__":
    main()
