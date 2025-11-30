// lib/judges/openai_vision.ts
import fs from "fs";
import OpenAI from "openai";
import { OPENAI_VISION_MODEL } from "@/lib/ai/clients";
import { fileToDataURL, parseMaybeJSON } from "@/lib/ai/images";
import { resolvePublicPath } from "@/lib/paths";
import type { JudgeCandidate } from "@/lib/judge_ensemble";

export type DuelVote = "A" | "B";

const PROMPT = `
You are a strict visual judge.

You will be shown 3 images in ORDER:
1) The USER's attempt at recreating a meme.
2) Meme template A.
3) Meme template B.

Task:
- Decide whether template A or template B better matches the USER's pose, gesture, facial expression, and overall composition.
- IGNORE any text in the images.
- IGNORE colors/backgrounds unless they change pose/composition.
- You MUST choose exactly one winner: "A" or "B".
- Return ONLY strict JSON: {"winner":"A"} or {"winner":"B"}.
`.trim();

export async function openaiVisionPrefers(
  userImagePath: string,
  A: JudgeCandidate,
  B: JudgeCandidate
): Promise<DuelVote> {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const userUrl = fileToDataURL(userImagePath);
  const aPath = resolvePublicPath(A.url || A.filename || "");
  const bPath = resolvePublicPath(B.url || B.filename || "");
  const aUrl = fileToDataURL(aPath!);
  const bUrl = fileToDataURL(bPath!);

  const res = await client.chat.completions.create({
    model: OPENAI_VISION_MODEL,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: PROMPT },
          { type: "image_url", image_url: { url: userUrl } },
          { type: "image_url", image_url: { url: aUrl } },
          { type: "image_url", image_url: { url: bUrl } },
        ],
      },
    ],
  });

  const text = res.choices?.[0]?.message?.content || "";
  const parsed = parseMaybeJSON<{ winner?: DuelVote }>(text) || {};
  const w = (parsed.winner || "A").toUpperCase() as DuelVote;
  return w === "B" ? "B" : "A";
}
