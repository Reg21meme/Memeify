// lib/judge_ensemble.ts
//
// Council v3 — Fast scoring with remote vision models (no Ollama)
//
// 1) We get ~12 candidates from CLIP+pose retrieval.
// 2) Council slices to top K (COUNCIL_K, default 6) by CLIP score.
// 3) For each judge (Nemotron via OpenRouter, GPT-5.1, Gemini 2.5 Pro):
//      - Score EACH candidate 0..100 for pose / gesture / composition match
//        with the user image. (No pairwise duels.)
//      - Take that judge’s Top-3 by score.
// 4) Debate pool = union of all Top-3s (3..9 images).
// 5) Final score for each pool member = average of available judges’ scores.
//      - Winner = highest final score.
//      - Tie-breaker = higher CLIP score (scorePct).
//
// Notes:
// - If a judge’s API key is missing, its scores are 0 and its ranking falls
//   back to the input order; it still “participates” but has no weight.
// - This is MUCH faster than the old pairwise + debate scheme and uses
//   Nemotron (remote GPU) instead of local Ollama.
//

import fs from "fs";
import path from "path";

// ============================ Env & constants ===============================

const NEMO_MODEL =
  process.env.NEMO_MODEL || "nvidia/nemotron-nano-12b-v2-vl:free";

const OPENAI_VISION_MODEL =
  process.env.OPENAI_VISION_MODEL || "gpt-5.1";

const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-2.5-pro";

const COUNCIL_K = Number(process.env.COUNCIL_K || "6");
const MAX_PARALLEL = Number(process.env.COUNCIL_MAX_PARALLEL || "3");

type JudgeName = "nemo" | "openai" | "gemini";

export type JudgeCandidate = {
  id: string;
  labelGuess: string; // informational only
  filename: string;   // e.g., localPath under public/
  url: string;        // e.g., /meme-templates/foo.jpg
  scorePct: number;   // CLIP % from retrieval (for info + tie-breaker)
};

export type ScoreLogEntry = {
  id: string;
  nemo?: number;
  openai?: number;
  gemini?: number;
};

export type DebateOutcome = {
  chosenId: string;
  rankings: {
    // legacy names kept for UI:
    vision: string[]; // alias: nemo
    text: string[];   // alias: openai
    // explicit:
    nemo: string[];
    openai: string[];
    gemini: string[];
  };
  top3: {
    vision: string[];
    text: string[];
    nemo: string[];
    openai: string[];
    gemini: string[];
  };
  pool: string[];
  logs: ScoreLogEntry[];
  method: "scores"; // no longer true "debate", but clearly marked
};

// ============================ Small helpers ================================

function parseMaybeJSON<T = any>(s: string | undefined | null): T | null {
  if (!s) return null;
  const cleaned = s.trim().replace(/^```json\s*|\s*```$/g, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function clampScore(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

/**
 * Robustly extract a 0–100 score from LLM text.
 * 1) Try strict JSON: {"score": 0..100}
 * 2) Fallback: first number in the text
 * 3) Fallback: given default
 */
function parseScoreFromText(
  text: string | null | undefined,
  fallback: number
): number {
  if (!text) return clampScore(fallback);

  // Try JSON first
  const obj = parseMaybeJSON<{ score?: number }>(text);
  if (obj && typeof obj.score === "number") {
    return clampScore(obj.score);
  }

  // Fallback: grab first numeric-looking token
  const m = text.match(/(-?\d+(\.\d+)?)/);
  if (m) {
    const n = Number(m[1]);
    if (!Number.isNaN(n)) return clampScore(n);
  }

  return clampScore(fallback);
}

function ensureIdList(cands: JudgeCandidate[]) {
  return cands.map((c) => c.id.toString());
}

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

// Resolve /public-relative paths to absolute FS path
function resolvePublicPath(maybeRel: string | undefined | null): string | null {
  if (!maybeRel) return null;
  let rel = maybeRel.replace(/\\/g, "/");
  if (rel.startsWith("/")) rel = rel.slice(1);
  if (rel.toLowerCase().startsWith("public/")) rel = rel.slice(7);
  return path.join(process.cwd(), "public", rel);
}

// Convert a local file path to RAW base64 (no data: prefix)
function fileToBase64(absPath: string | null | undefined): string | null {
  try {
    if (!absPath) return null;
    const buf = fs.readFileSync(absPath);
    return buf.toString("base64");
  } catch {
    return null;
  }
}

// Build data URL for image_url
function fileToDataURL(absPath: string, mime = "image/jpeg"): string {
  const b64 = fileToBase64(absPath);
  if (!b64) throw new Error("fileToDataURL: cannot read " + absPath);
  return `data:${mime};base64,${b64}`;
}

// ============================ Prompts ======================================

const SCORING_PROMPT = `
You are a strict visual meme judge.

You will be shown TWO images in ORDER:
1) The USER's attempt at recreating a meme.
2) ONE candidate meme template.

Task:
- Score from 0 to 100 how well the template matches the USER's pose, gesture,
  facial expression, and overall composition.
- IGNORE overlaid text.
- IGNORE minor color/background differences that don't change the pose.

Return ONLY strict JSON:
{"score": 0-100}
`.trim();

// ============================ Judge scoring fns ============================
//
// Each scoring function takes (userImagePath, candidate) and returns a number
// 0..100. On any error / missing API key it returns 0 (fail-soft).

async function nemoScore(
  userImagePath: string,
  cand: JudgeCandidate
): Promise<number> {
  if (!process.env.OPENROUTER_API_KEY) return 0;

  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
  });

  const userUrl = fileToDataURL(userImagePath);
  const candPath = resolvePublicPath(cand.url || cand.filename || "");
  if (!candPath) return 0;
  const candUrl = fileToDataURL(candPath);

  const res = await client.chat.completions.create({
    model: NEMO_MODEL,
    temperature: 0,
    // ask OpenRouter to behave like OpenAI w/ JSON response
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: SCORING_PROMPT },
          { type: "image_url", image_url: { url: userUrl } },
          { type: "image_url", image_url: { url: candUrl } },
        ],
      },
    ],
  });

  const text = res.choices?.[0]?.message?.content || "";
  return parseScoreFromText(text, 0);
}

async function openaiScore(
  userImagePath: string,
  cand: JudgeCandidate
): Promise<number> {
  if (!process.env.OPENAI_API_KEY) return 0;

  const OpenAI = (await import("openai")).default;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const userUrl = fileToDataURL(userImagePath);
  const candPath = resolvePublicPath(cand.url || cand.filename || "");
  if (!candPath) return 0;
  const candUrl = fileToDataURL(candPath);

  const res = await client.chat.completions.create({
    model: OPENAI_VISION_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: SCORING_PROMPT },
          { type: "image_url", image_url: { url: userUrl } },
          { type: "image_url", image_url: { url: candUrl } },
        ],
      },
    ],
  });

  const text = res.choices?.[0]?.message?.content || "";
  return parseScoreFromText(text, 0);
}

async function geminiScore(
  userImagePath: string,
  cand: JudgeCandidate
): Promise<number> {
  if (!process.env.GEMINI_API_KEY) return 0;

  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

  const model = genai.getGenerativeModel({
    model: GEMINI_MODEL,
    // newer SDKs support forcing JSON; if not, prompt + regex still works
    generationConfig: {
      responseMimeType: "application/json",
    } as any,
  });

  const candPath = resolvePublicPath(cand.url || cand.filename || "");
  if (!candPath) return 0;

  const b64 = (p: string) => fs.readFileSync(p).toString("base64");

  const resp = await model.generateContent([
    {
      text: SCORING_PROMPT,
    },
    {
      inlineData: {
        data: b64(userImagePath),
        mimeType: "image/jpeg",
      },
    },
    {
      inlineData: {
        data: b64(candPath),
        mimeType: "image/jpeg",
      },
    },
  ]);

  const text = resp.response?.text() || "";
  return parseScoreFromText(text, 0);
}

// ============================ Scoring harness ==============================

type ScoreFn = (userImagePath: string, cand: JudgeCandidate) => Promise<number>;

type JudgeScores = {
  name: JudgeName;
  scores: Record<string, number>; // id -> score
  ranking: string[];              // ids sorted by score desc
};

async function scoreWithJudge(
  judge: JudgeName,
  userImagePath: string,
  candidates: JudgeCandidate[],
  scorer: ScoreFn
): Promise<JudgeScores> {
  const scores: Record<string, number> = {};
  const ids = candidates.map((c) => c.id.toString());

  const parallel = Math.max(1, MAX_PARALLEL || 3);

  for (let i = 0; i < candidates.length; i += parallel) {
    const batch = candidates.slice(i, i + parallel);
    const batchResults = await Promise.all(
      batch.map(async (c) => {
        try {
          return await scorer(userImagePath, c);
        } catch {
          return 0;
        }
      })
    );
    batch.forEach((c, idx) => {
      scores[c.id.toString()] = batchResults[idx];
    });
  }

  // Sort ids by score desc; tie-breaker = higher CLIP score
  const ranking = ids.slice().sort((a, b) => {
    const sa = scores[a] ?? 0;
    const sb = scores[b] ?? 0;
    if (sb !== sa) return sb - sa;
    const ca = candidates.find((c) => c.id.toString() === a)?.scorePct ?? 0;
    const cb = candidates.find((c) => c.id.toString() === b)?.scorePct ?? 0;
    return cb - ca;
  });

  return { name: judge, scores, ranking };
}

// ============================ Public API ===================================

export async function consensusDebate(
  taskHint: string, // not used yet; kept for compatibility
  candidates: JudgeCandidate[],
  queryImagePath: string
): Promise<DebateOutcome> {
  if (!candidates.length) {
    throw new Error("consensusDebate: no candidates provided");
  }

  // 0) Shortlist to top K by CLIP score (retrieval already sorted, but be safe)
  const sortedByClip = candidates
    .slice()
    .sort((a, b) => (b.scorePct ?? 0) - (a.scorePct ?? 0));
  const shortlist = sortedByClip.slice(0, COUNCIL_K);

  // 1) Score with each judge (Nemotron + optional GPT + Gemini)
  const [nemo, openai, gemini] = await Promise.all([
    scoreWithJudge("nemo", queryImagePath, shortlist, nemoScore),
    scoreWithJudge("openai", queryImagePath, shortlist, openaiScore),
    scoreWithJudge("gemini", queryImagePath, shortlist, geminiScore),
  ]);

  const idsN = nemo.ranking;
  const idsO = openai.ranking;
  const idsG = gemini.ranking;

  // 2) Top-3 each
  const top3N = idsN.slice(0, 3);
  const top3O = idsO.slice(0, 3);
  const top3G = idsG.slice(0, 3);

  // 3) Debate pool = union
  const poolIds = uniq([...top3N, ...top3O, ...top3G]);

  // 4) Aggregate scores across judges
  const finalScores: Record<string, number> = {};
  for (const id of poolIds) {
    const sN = nemo.scores[id] ?? 0;
    const sO = openai.scores[id] ?? 0;
    const sG = gemini.scores[id] ?? 0;
    const vals = [sN, sO, sG].filter((v) => v > 0 || v === 0); // keep zeros as real scores
    if (!vals.length) {
      finalScores[id] = 0;
    } else {
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      finalScores[id] = avg;
    }
  }

  // 5) Choose winner: highest final score, tie-break by CLIP
  let chosenId = poolIds[0];
  for (const id of poolIds) {
    const cur = finalScores[id] ?? 0;
    const best = finalScores[chosenId] ?? 0;
    if (cur > best) {
      chosenId = id;
    } else if (cur === best) {
      const cCur =
        shortlist.find((c) => c.id.toString() === id)?.scorePct ?? 0;
      const cBest =
        shortlist.find((c) => c.id.toString() === chosenId)?.scorePct ?? 0;
      if (cCur > cBest) chosenId = id;
    }
  }

  // 6) Build logs per candidate (for UI inspection)
  const logs: ScoreLogEntry[] = shortlist.map((c) => ({
    id: c.id.toString(),
    nemo: nemo.scores[c.id.toString()],
    openai: openai.scores[c.id.toString()],
    gemini: gemini.scores[c.id.toString()],
  }));

  return {
    chosenId: chosenId.toString(),
    rankings: {
      // legacy aliases:
      vision: idsN,
      text: idsO,
      // explicit:
      nemo: idsN,
      openai: idsO,
      gemini: idsG,
    },
    top3: {
      vision: top3N,
      text: top3O,
      nemo: top3N,
      openai: top3O,
      gemini: top3G,
    },
    pool: poolIds,
    logs,
    method: "scores",
  };
}

// Adapter (unchanged; called from route.ts)
export function toJudgePacket(results: any[]): JudgeCandidate[] {
  return results.map((r: any, i: number) => ({
    id: (r.id ?? `cand_${i}`).toString(),
    labelGuess: (r.localPath || "").split("/")[1] || "",
    filename: r.localPath,
    url: r.localUrl,
    scorePct: r.scorePct ?? 0,
  }));
}
