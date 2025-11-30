// lib/ai/images.ts
import fs from "fs";

export function fileToBase64(absPath: string | null | undefined): string | null {
  try {
    if (!absPath) return null;
    return fs.readFileSync(absPath).toString("base64");
  } catch {
    return null;
  }
}

export function fileToDataURL(absPath: string, mime = "image/jpeg"): string {
  const b64 = fileToBase64(absPath);
  if (!b64) throw new Error("fileToDataURL: cannot read file " + absPath);
  return `data:${mime};base64,${b64}`;
}

export function parseMaybeJSON<T = any>(s: string | undefined | null): T | null {
  if (!s) return null;
  const cleaned = s.trim().replace(/^```json\s*|\s*```$/g, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}
