// lib/paths.ts
import path from "path";

export function resolvePublicPath(maybeRel: string | null | undefined): string | null {
  if (!maybeRel) return null;
  let rel = maybeRel.replace(/\\/g, "/");
  if (rel.startsWith("/")) rel = rel.slice(1);
  if (rel.toLowerCase().startsWith("public/")) rel = rel.slice(7);
  return path.join(process.cwd(), "public", rel);
}
