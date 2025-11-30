// lib/imageData.ts
import fs from "fs";
import path from "path";

export function toDataURL(p: string): string | null {
  try {
    const abs = path.resolve(p);
    const buf = fs.readFileSync(abs);
    const mime =
      abs.toLowerCase().endsWith(".png") ? "image/png" :
      abs.toLowerCase().endsWith(".webp") ? "image/webp" :
      abs.toLowerCase().endsWith(".gif") ? "image/gif" : "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}
