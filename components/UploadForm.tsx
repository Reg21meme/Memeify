"use client";

import React, { useMemo, useState } from "react";

type Candidate = {
  id?: string;
  localPath: string;
  localUrl: string;
  scorePct?: number;
};

type RankedVote = {
  judge: string;           // "vision" | "text1" | "text2" | "rule" | "ollama:..."
  ranking: string[];       // array of ids best -> worst
  notes?: string;
};

type DetectResponse = {
  chosen: Candidate | null;
  results: Candidate[];
  consensus?: {
    chosenId: string;
    ranking: string[];
    votes: RankedVote[];
    method: string;
  };
};

export default function UploadForm() {
  const [file, setFile] = useState<File | null>(null);
  const [uploadURL, setUploadURL] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<DetectResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onUpload(f: File) {
    setError(null);
    setData(null);
    setLoading(true);
    setFile(f);

    // preview
    const url = URL.createObjectURL(f);
    setUploadURL(url);

    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await fetch("/api/upload/detect", { method: "POST", body: fd });
      const json = (await res.json()) as DetectResponse;
      setData(json);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  // Build quick lookup maps for the votes table
  const judgeNames = useMemo(() => {
    if (!data?.consensus?.votes) return [];
    return data.consensus.votes.map((v) => v.judge);
  }, [data]);

  const rankMaps = useMemo(() => {
    const maps: Record<string, Map<string, number>> = {};
    if (data?.consensus?.votes) {
      for (const v of data.consensus.votes) {
        const m = new Map<string, number>();
        v.ranking.forEach((id, idx) => m.set(id, idx + 1)); // 1-based rank
        maps[v.judge] = m;
      }
    }
    return maps;
  }, [data]);

  const finalRankMap = useMemo(() => {
    const m = new Map<string, number>();
    if (data?.consensus?.ranking) {
      data.consensus.ranking.forEach((id, idx) => m.set(id, idx + 1));
    }
    return m;
  }, [data]);

  function rankOf(judge: string, id: string) {
    return rankMaps[judge]?.get(id) ?? "-";
  }

  return (
    <div className="space-y-6">
      {/* Uploader */}
      <div className="flex items-center gap-3">
        <label className="inline-flex cursor-pointer rounded border px-3 py-1 hover:bg-gray-50">
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.[0]) onUpload(e.target.files[0]);
            }}
          />
          Choose File
        </label>
        {file && <span className="text-xs opacity-70">{file.name}</span>}
        {loading && <span className="text-xs text-blue-600">Scanning…</span>}
      </div>

      {/* Your input */}
      {uploadURL && (
        <section>
          <h3 className="font-semibold mb-2">Your Input</h3>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={uploadURL} alt="your upload" className="max-w-full rounded border" />
        </section>
      )}

      {/* Winner */}
      {data?.chosen && (
        <section className="rounded-lg border p-4">
          <h3 className="font-semibold text-lg mb-3">Council Winner</h3>
          <div className="flex flex-col md:flex-row gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={data.chosen.localUrl}
              alt={data.chosen.localPath}
              className="w-full md:w-80 rounded border"
            />
            <div className="flex-1 space-y-2">
              <div className="text-sm">
                <div className="font-mono">{data.chosen.localPath}</div>
                <div>Score: {Math.round(data.chosen.scorePct ?? 0)}%</div>
              </div>
              {data?.consensus && (
                <div className="text-sm">
                  <div>
                    Consensus method:{" "}
                    <span className="font-medium">{data.consensus.method}</span>
                  </div>
                  <div className="mt-1">
                    Chosen id:{" "}
                    <span className="font-mono">{data.consensus.chosenId}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Votes table */}
      {data?.results?.length ? (
        <section className="rounded-lg border p-4">
          <h3 className="font-semibold text-lg mb-3">How Each Model Voted</h3>
          <div className="overflow-auto">
            <table className="min-w-[900px] w-full text-sm">
              <thead>
                <tr className="bg-gray-50">
                  <th className="p-2 text-left">Thumb</th>
                  <th className="p-2 text-left">ID / File</th>
                  {judgeNames.map((j) => (
                    <th key={j} className="p-2 text-left">{j}</th>
                  ))}
                  <th className="p-2 text-left">Final rank</th>
                  <th className="p-2 text-left">Vector score</th>
                </tr>
              </thead>
              <tbody>
                {data.results.map((r) => {
                  // id we send to council
                  const id =
                    (r as any).id?.toString() ??
                    (r.localPath ? r.localPath : "");
                  const isWinner =
                    data?.consensus?.chosenId &&
                    (data.consensus.chosenId === id ||
                      `cand_${data.results.indexOf(r)}` ===
                        data.consensus.chosenId);

                  return (
                    <tr
                      key={r.localPath}
                      className={
                        "border-b last:border-0 " +
                        (isWinner ? "bg-green-50" : "")
                      }
                    >
                      <td className="p-2 align-top">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={r.localUrl}
                          alt={r.localPath}
                          className="w-20 h-20 object-cover rounded border"
                        />
                      </td>
                      <td className="p-2 align-top">
                        <div className="font-mono text-xs break-all">
                          {id}
                        </div>
                        <div className="text-[11px] text-gray-500">
                          {r.localPath}
                        </div>
                      </td>
                      {judgeNames.map((j) => (
                        <td key={j} className="p-2 align-top">
                          {rankOf(j, id)}
                        </td>
                      ))}
                      <td className="p-2 align-top">
                        {finalRankMap.get(id) ?? "-"}
                      </td>
                      <td className="p-2 align-top">
                        {Math.round(r.scorePct ?? 0)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* raw JSON for debugging */}
          {data?.consensus && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-gray-600">
                show raw consensus JSON
              </summary>
              <pre className="text-xs bg-black text-green-200 p-3 rounded overflow-auto">
                {JSON.stringify(data.consensus, null, 2)}
              </pre>
            </details>
          )}
        </section>
      ) : null}

      {/* Top-12 by vector score (already sorted from API) */}
      {data?.results?.length ? (
        <section className="rounded-lg border p-4">
          <h3 className="font-semibold text-lg mb-3">
            Top-12 by Vector Score (retrieval shortlist)
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {data.results.map((r) => (
              <div
                key={r.localPath}
                className="rounded border p-2 text-xs flex flex-col gap-1"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={r.localUrl}
                  alt={r.localPath}
                  className="w-full h-32 object-cover rounded border"
                />
                <div className="font-mono break-all">{r.localPath}</div>
                <div>Score: {Math.round(r.scorePct ?? 0)}%</div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {error && (
        <div className="text-sm text-red-600">
          {error}
        </div>
      )}
    </div>
  );
}
