// lib/judges/moderator.ts
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { OPENAI_VISION_MODEL, GEMINI_MODEL } from "@/lib/ai/clients";
import { fileToDataURL, parseMaybeJSON } from "@/lib/ai/images";
import { resolvePublicPath } from "@/lib/paths";
import type { JudgeCandidate } from "@/lib/judge_ensemble";

export type DuelVote = "A" | "B";

const MOD_PROMPT = `
You are moderating a debate between three vision models: Ollama, GPT, Gemini.

They are choosing which meme template (A or B) best matches the USER's pose/expression from three images:
1) USER photo, 2) template A, 3) template B.

You receive their current votes. Write a brief debate (2-4 turns) where they respond to each other.
Then they MUST end in UNANIMOUS agreement on either A or B.

Return STRICT JSON only:
{
  "winner": "A" | "B",
  "debate": "short transcript"
}
`.trim();

export async function runModeratorDebate(
  userImagePath: string,
  A: JudgeCandidate,
  B: JudgeCandidate,
  votes: { ollama: DuelVote; gpt: DuelVote; gemini: DuelVote }
): Promise<{ winner: DuelVote; debate: string }> {
  // Prefer OpenAI as moderator if available
  if (process.env.OPENAI_API_KEY) {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const userUrl = fileToDataURL(userImagePath);
    const aUrl = fileToDataURL(resolvePublicPath(A.url || A.filename || "")!);
    const bUrl = fileToDataURL(resolvePublicPath(B.url || B.filename || "")!);

    const res = await client.chat.completions.create({
      model: OPENAI_VISION_MODEL,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: `${MOD_PROMPT}\n\nCurrent votes:\nOllama: ${votes.ollama}\nGPT: ${votes.gpt}\nGemini: ${votes.gemini}` },
            { type: "image_url", image_url: { url: userUrl } },
            { type: "image_url", image_url: { url: aUrl } },
            { type: "image_url", image_url: { url: bUrl } },
          ],
        },
      ],
    });

    const text = res.choices?.[0]?.message?.content || "";
    const parsed = parseMaybeJSON<{ winner?: DuelVote; debate?: string }>(text) || {};
    const w = (parsed.winner || "A").toUpperCase() as DuelVote;
    return { winner: w === "B" ? "B" : "A", debate: parsed.debate || "" };
  }

  // Fallback to Gemini as moderator
  if (process.env.GEMINI_API_KEY) {
    const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genai.getGenerativeModel({ model: GEMINI_MODEL });

    const fs = await import("fs");
    const b64 = (p: string) => fs.readFileSync(p).toString("base64");
    const aPath = resolvePublicPath(A.url || A.filename || "")!;
    const bPath = resolvePublicPath(B.url || B.filename || "")!;

    const resp = await model.generateContent([
      { text: `${MOD_PROMPT}\n\nCurrent votes:\nOllama: ${votes.ollama}\nGPT: ${votes.gpt}\nGemini: ${votes.gemini}` },
      { inlineData: { data: b64(userImagePath), mimeType: "image/jpeg" } },
      { inlineData: { data: b64(aPath), mimeType: "image/jpeg" } },
      { inlineData: { data: b64(bPath), mimeType: "image/jpeg" } },
    ]);

    const text = resp.response?.text() || "";
    const parsed = parseMaybeJSON<{ winner?: DuelVote; debate?: string }>(text) || {};
    const w = (parsed.winner || "A").toUpperCase() as DuelVote;
    return { winner: w === "B" ? "B" : "A", debate: parsed.debate || "" };
  }

  // If no cloud key at all, fall back to simple majority (last resort)
  const counts = { A: 0, B: 0 } as Record<DuelVote, number>;
  counts[votes.ollama]++; counts[votes.gpt]++; counts[votes.gemini]++;
  return { winner: counts.A >= counts.B ? "A" : "B", debate: "" };
}
