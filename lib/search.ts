import fs from "fs";
import path from "path";

export type IndexItem = {
  id: string;
  localPath: string;
  clip_vec?: number[];
  pose_vec?: number[];
  face_vec?: number[];
};

let CACHE: { items: IndexItem[] } | null = null;

function loadIndex() {
  if (CACHE) return CACHE;
  const fp = path.join(process.cwd(), "data", "memes-index.json");
  const items: IndexItem[] = fs.existsSync(fp)
    ? JSON.parse(fs.readFileSync(fp, "utf-8"))
    : [];
  CACHE = { items };
  return CACHE;
}

function cosine(a: number[], b: number[]) {
  let dot = 0,
    na = 0,
    nb = 0;
  const L = Math.min(a.length, b.length);
  for (let i = 0; i < L; i++) {
    const x = a[i],
      y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb) + 1e-8;
  return d ? dot / d : 0; // [-1,1]
}

const TIMEOUT_KEYWORDS = [
  "timeout",
  "t-pose",
  "tpose",
  "ref",
  "referee",
  "whistle",
  "shaq",
];

function hasTimeoutKeyword(p: string) {
  const s = p.toLowerCase();
  return TIMEOUT_KEYWORDS.some((k) => s.includes(k));
}

export function topKByFeatures(
  q: { clip_vec: number[]; pose_vec: number[]; face_vec?: number[] },
  k = 6
) {
  const { items } = loadIndex();
  if (!items.length) return [];

  const qClip = q.clip_vec || [];
  const qPose = q.pose_vec || [];
  const qFace = q.face_vec || [];

  const queryHasPose = qPose.length > 0;
  const queryHasFace = qFace.length > 0;

  const scored = items.map((m) => {
    const mClip = m.clip_vec || [];
    const mPose = m.pose_vec || [];
    const mFace = m.face_vec || [];

    const sClip = qClip.length && mClip.length ? cosine(qClip, mClip) : 0;
    const sPose = queryHasPose && mPose.length ? cosine(qPose, mPose) : 0;
    const sFace = queryHasFace && mFace.length ? cosine(qFace, mFace) : 0;

    // Normalize to [0,1]
    let clipPart = (sClip + 1) / 2;
    let posePart = (sPose + 1) / 2;
    let facePart = (sFace + 1) / 2;

    // Small robustness tweaks
    if (queryHasPose && !mPose.length) {
      // candidate missing pose but query has one → small penalty
      posePart = 0;
      clipPart *= 0.9;
    }

    if (queryHasFace && !mFace.length) {
      // candidate has no face but query does → bigger penalty
      facePart = 0;
      clipPart *= 0.8;
    }

    // Keyword bias if we *don't* have pose/face info to go on
    if (!queryHasPose && !queryHasFace && hasTimeoutKeyword(m.localPath || "")) {
      clipPart = Math.min(1, clipPart + 0.15);
    }

    // Fusion strategy:
    //  - If we have face + pose: face & clip dominate, pose helps.
    //  - If we only have face: half clip, half face.
    //  - If we only have pose: mostly clip, some pose.
    //  - Else: just clip (+ small keyword bump above).
    let score: number;
    const hasFaceBoth = queryHasFace && mFace.length > 0;
    const hasPoseBoth = queryHasPose && mPose.length > 0;

    if (hasFaceBoth && hasPoseBoth) {
      score = 0.4 * clipPart + 0.4 * facePart + 0.2 * posePart;
    } else if (hasFaceBoth) {
      score = 0.5 * clipPart + 0.5 * facePart;
    } else if (hasPoseBoth) {
      score = 0.7 * clipPart + 0.3 * posePart;
    } else {
      score = clipPart;
    }

    const localUrl = (
      "/" +
      (m.localPath || "")
        .replace(/^[/\\]*public[/\\]+/i, "")
        .replace(/\\/g, "/")
    ).replace(/^\/+/, "");

    return {
      id: m.id,
      localPath: m.localPath,
      localUrl,
      scorePct: Math.round(score * 100),
    };
  });

  scored.sort((a, b) => b.scorePct - a.scorePct);
  return scored.slice(0, k);
}
