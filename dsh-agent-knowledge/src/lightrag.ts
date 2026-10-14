import { createHash } from "node:crypto";
import { z } from "zod";
import { KnowledgeResult, type KnowledgeSearch } from "@dsh-agent/contracts";
import type { KnowledgeSource } from "./sources.js";
import { boundedJson, KnowledgeError } from "./network.js";
const text = z.string().max(1_000_000).refine(s => s.isWellFormed() && !s.includes("\0"));
const Upstream = z.object({ status: z.literal("success"), data: z.object({
  chunks: z.array(z.object({ content: text, chunk_id: text.optional(), reference_id: text.optional() })).max(1000),
  entities: z.array(z.object({ entity_name: text, entity_type: text.optional(), description: text.optional() })).max(1000),
  relationships: z.array(z.object({ src_id: text, tgt_id: text, description: text.optional() })).max(1000),
}) });
export function lightRagClient(config: { timeoutMs?: number } = {}) {
  return async (source: KnowledgeSource, query: KnowledgeSearch, signal: AbortSignal) => {
    try {
      if (source.backend !== "lightrag" || Object.keys(query.filters ?? {}).length) throw new KnowledgeError(400, "INVALID_REQUEST");
      const response = await fetch(new URL("/query/data", source.endpoint), { method: "POST", redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs ?? 15000)]),
        headers: { "content-type": "application/json", "X-API-Key": source.apiKey },
        // Explicit keywords suppress the upstream keyword-extraction LLM call. No answer generation/reranker.
        body: JSON.stringify({ query: query.query, mode: query.mode, top_k: query.limit, chunk_top_k: query.limit,
          hl_keywords: query.keywords, ll_keywords: query.keywords, enable_rerank: false,
          max_entity_tokens: 1000, max_relation_tokens: 1000, max_total_tokens: 4000,
          include_references: true, include_chunk_content: true }),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error("Retrieval unavailable"); }
      const data = Upstream.parse(await boundedJson(response, 1024 * 1024)).data;
      let truncated = false, remaining = 16000;
      const trim = (value: string, limit: number) => {
        let result = value.slice(0, Math.min(limit, remaining));
        if (!result.isWellFormed()) result = result.slice(0, -1);
        remaining -= result.length; if (result.length !== value.length) truncated = true; return result;
      };
      const take = <T>(items: T[]) => { if (items.length > query.limit) truncated = true; return items.slice(0, query.limit); };
      const chunks = take(data.chunks).map(c => ({
        // Stable opaque citations; never expose upstream file paths, endpoints or private metadata.
        citation: source.id + ":" + createHash("sha256").update(JSON.stringify([source.id, c.chunk_id ?? c.reference_id ?? "", c.content])).digest("hex").slice(0, 24),
        content: trim(c.content, 4000),
      }));
      const entities = take(data.entities).map(e => ({ name: trim(e.entity_name, 200), type: trim(e.entity_type ?? "", 100), description: trim(e.description ?? "", 1000) }));
      const relationships = take(data.relationships).map(r => ({ source: trim(r.src_id, 200), target: trim(r.tgt_id, 200), description: trim(r.description ?? "", 1000) }));
      return KnowledgeResult.parse({ sourceId: source.id, chunks, entities, relationships, truncated });
    } catch (error) {
      if (error instanceof KnowledgeError && error.status === 400) throw error;
      throw new KnowledgeError(503, "DEPENDENCY_UNAVAILABLE");
    }
  };
}
