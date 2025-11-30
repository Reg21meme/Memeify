// lib/clip.ts
import { pipeline } from '@xenova/transformers';

let _pipe: any;

async function getPipe() {
  if (!_pipe) {
    _pipe = await pipeline('feature-extraction', 'Xenova/clip-vit-base-patch32');
  }
  return _pipe;
}

export async function getImageEmbedding(buf: Buffer) {
  const pipe = await getPipe();
  // Raw bytes are fine; no sharp needed.
  const out: any = await pipe(buf);
  const vec = Array.from(out.data || out[0]) as number[];
  return vec;
}

export function normalize(v: number[]) {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / n);
}
