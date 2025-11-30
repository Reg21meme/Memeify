// lib/judges/gemini_vision.ts
import fs from "fs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { GEMINI_MODEL } from "@/lib/ai/clients";
import { parseMaybeJSON } from "@/lib/ai/images";
import { resolvePublicPath } from "@/lib/paths";
import type { JudgeCandidate } from "@/lib/judge_ensemble";

export type DuelVote = "A" | "B";

const PROMPT = `
You are a strict visual judge.

You will be shown 3 images in ORDER:
1) The USER's attempt at recreating a meme.
2) Meme template A.
3) Meme template B.

Decide which template better matches the USER's pose, gesture, facial expression, and composition.
IGNORE text in images. IGNORE colors/backgrounds unless they change pose/composition.
Return ONLY strict JSON: {"winner":"A"} or {"winner":"B"}.
`.trim();

function fileToInline(path: string): { data: string; mimeType: string } {
  const buf = fs.readFileSync(path);
  return { data: buf.toString("base64"), mimeType: "image/jpeg" };
}

export async function geminiVisionPrefers(
  userImagePath: string,
  A: JudgeCandidate,
  B: JudgeCandidate
): Promise<DuelVote> {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genai.getGenerativeModel({ model: GEMINI_MODEL });

  const aPath = resolvePublicPath(A.url || A.filename || "");
  const bPath = resolvePublicPath(B.url || B.filename || "");

  const resp = await model.generateContent([
    { text: PROMPT },
    { inlineData: { data: fs.readFileSync(userImagePath).toString("base64"), mimeType: "image/jpeg" } },
    { inlineData: fileToInline(aPath!) },
    { inlineData: fileToInline(bPath!) },
  ]);

  const text = resp.response?.text() || "";
  const parsed = parseMaybeJSON<{ winner?: DuelVote }>(text) || {};
  const w = (parsed.winner || "A").toUpperCase() as DuelVote;
  return w === "B" ? "B" : "A";
}
