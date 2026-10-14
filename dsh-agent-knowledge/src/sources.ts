import { z } from "zod";
import { IdentityId, type Principal } from "@dsh-agent/contracts";
import { origin, KnowledgeError } from "./network.js";
const common = { id: IdentityId,
  readers: z.array(z.object({ tenantId: IdentityId, uid: IdentityId }).strict()).min(1).max(10000) };
const LightRagSource = z.object({ ...common, backend: z.literal("lightrag").default("lightrag"),
  endpoint: z.url(), apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,100}$/) }).strict();
const PostgresSource = z.object({ ...common, backend: z.literal("postgres"), corpusId: IdentityId,
  ragMode: z.enum(["fulltext", "structured", "graph", "hybrid"]).default("fulltext"),
  filterFields: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)).max(16).default([])
    .refine(fields => new Set(fields).size === fields.length),
  graphDepth: z.number().int().min(1).max(3).default(2) }).strict();
const Source = z.union([LightRagSource, PostgresSource]);
export const SourceConfig = z.object({ sources: z.array(Source).max(1000) }).strict();
export type LocalSource = z.infer<typeof PostgresSource> & { apiKey?: undefined };
export type RemoteSource = z.infer<typeof LightRagSource> & { apiKey: string };
export type KnowledgeSource = RemoteSource | LocalSource;
export function sourceRegistry(input: unknown, env: NodeJS.ProcessEnv = process.env) {
  const config = SourceConfig.parse(input), sources = new Map<string, KnowledgeSource>(), endpoints = new Set<string>();
  for (const source of config.sources) {
    if (sources.has(source.id)) throw new Error("Duplicate source ID");
    if (source.backend === "postgres") { sources.set(source.id, source); continue; }
    const url = origin(source.endpoint), apiKey = env[source.apiKeyEnv];
    if (!apiKey || apiKey.length < 16 || apiKey.length > 4096 || /[\r\n]/.test(apiKey)) throw new Error("Configure source API credentials (16+ characters)");
    if (env.NODE_ENV === "production" && url.protocol !== "https:") throw new Error("Production knowledge sources require HTTPS");
    // One endpoint is one explicitly shared corpus, never an implicit per-user namespace.
    if (sources.has(source.id) || endpoints.has(url.href)) throw new Error("Duplicate source ID or endpoint: merge explicit readers instead");
    sources.set(source.id, { ...source, endpoint: url.href, apiKey }); endpoints.add(url.href);
  }
  return {
    count: sources.size,
    usesPostgres: [...sources.values()].some(source => source.backend === "postgres"),
    corpusIds: [...new Set([...sources.values()].filter((source): source is LocalSource => source.backend === "postgres").map(source => source.corpusId))],
    resolve(id: string, actor: Principal): KnowledgeSource {
      const source = sources.get(id);
      if (!source?.readers.some(r => r.tenantId === actor.tenantId && r.uid === actor.uid)) throw new KnowledgeError(403, "FORBIDDEN");
      return source;
    },
  };
}
export type SourceRegistry = ReturnType<typeof sourceRegistry>;
