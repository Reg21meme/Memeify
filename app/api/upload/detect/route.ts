// app/api/upload/detect/route.ts
import { NextRequest, NextResponse } from "next/server";
import path from "path";
import os from "os";
import fs from "fs";
import { execSync } from "child_process";

import { topKByFeatures } from "@/lib/search";
import { consensusDebate, toJudgePacket } from "@/lib/judge_ensemble";

export const runtime = "nodejs";

// Call the Python feature embedder and parse its JSON block
function embedFeatures(filePath: string): { clip_vec: number[]; pose_vec: number[] } {
  const script = path.join(process.cwd(), "scripts", "embed_clip_pose.py");
  const out = execSync(`python "${script}" "${filePath}"`, {
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();

  const A = "###FEATURES_START###";
  const B = "###FEATURES_END###";
  const i = out.indexOf(A);
  const j = out.indexOf(B);
  if (i === -1 || j === -1) return { clip_vec: [], pose_vec: [] };

  try {
    return JSON.parse(out.substring(i + A.length, j).trim());
  } catch {
    return { clip_vec: [], pose_vec: [] };
  }
}

// A short hint if you want, but it isn't used to weight anything
const TASK_HINT = `Debate and pick the ONE meme that best matches the user's uploaded image.`;

export async function POST(req: NextRequest) {
  const stage: string[] = [];
  try {
    stage.push("A: start");
    const ct = req.headers.get("content-type") || "";

    let feats: { clip_vec: number[]; pose_vec: number[] } = { clip_vec: [], pose_vec: [] };
    let tempPath: string | null = null;

    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file") as File | null;
      if (!file) return NextResponse.json({ stage, chosen: null, results: [], consensus: null, note: "no-file" });

      const buf = Buffer.from(await file.arrayBuffer());
      tempPath = path.join(os.tmpdir(), `upload-${Date.now()}.jpg`);
      fs.writeFileSync(tempPath, buf);
      stage.push(`B2: wrote temp file -> ${tempPath}`);

      feats = embedFeatures(tempPath);
    } else {
      const body = (await req.json().catch(() => ({}))) as { imagePath?: string };
      if (typeof body.imagePath === "string" && body.imagePath.length > 0) {
        tempPath = body.imagePath;
        stage.push(`B3: body.imagePath -> ${tempPath}`);
        feats = embedFeatures(tempPath);
      } else {
        return NextResponse.json({ stage, chosen: null, results: [], consensus: null, note: "no-imagePath" });
      }
    }

    stage.push(`C1: feats clip=${feats.clip_vec.length} pose=${feats.pose_vec.length}`);

    // 6 candidates from index (vectors only gate this list)
    const results = topKByFeatures(feats, 6);
    stage.push(`D: topK returned ${results.length}`);

    const packet = toJudgePacket(results);

    // === COUNCIL: DEBATE ELIMINATION (no vector weighting) ===
    if (!tempPath) {
      return NextResponse.json({ stage, chosen: null, results, consensus: null, note: "no-tempPath" });
    }



  // debug: log env + ping ollama + then run council
  stage.push("E: before consensusDebate");

  const openaiLen = (process.env.OPENAI_API_KEY || "").length;
  const geminiLen = (process.env.GEMINI_API_KEY || "").length;
  stage.push(`ENV-OPENAI-LEN=${openaiLen}`);
  stage.push(`ENV-GEMINI-LEN=${geminiLen}`);

  const ollamaHost = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
  try {
    const pingRes = await fetch(`${ollamaHost}/api/tags`, { method: "GET" });
    stage.push(`E-PING: ${ollamaHost} -> ${pingRes.status}`);
  } catch (err: any) {
    stage.push(`E-PING-ERR: ${String(err)}`);
  }
    
    let debate;
    try {
      debate = await consensusDebate(TASK_HINT, packet, tempPath);
      stage.push("F: after consensusDebate");
    } catch (err: any) {
      stage.push("E-ERR: " + String(err?.message || err));
      stage.push("E-STACK: " + String(err?.stack || ""));
      throw err;
    }

    // Find the chosen candidate by id
    const chosen =
      results.find((r) => (r.id || "").toString() === debate.chosenId) ||
      results.find((_, i) => `cand_${i}` === debate.chosenId) ||
      results[0] ||
      null;

    // Cleanup temp
    if (tempPath && fs.existsSync(tempPath) && tempPath.startsWith(os.tmpdir())) {
      try { fs.unlinkSync(tempPath); } catch {}
    }

    return NextResponse.json({
      chosen,
      results,
      consensus: debate, // includes rankings, top3, pool, logs, method:"debate"
    });
  } catch (e: any) {
    return NextResponse.json(
      { stage, error: String(e?.message || e), chosen: null, results: [], consensus: null },
      { status: 200 }
    );
  }
}
