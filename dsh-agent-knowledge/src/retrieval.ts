import { createHash } from "node:crypto";
import { KnowledgeResult, type KnowledgeSearch } from "@dsh-agent/contracts";
import type { Database, Sql } from "./database.js";
import type { KnowledgeSource, LocalSource } from "./sources.js";
import { lightRagClient } from "./lightrag.js";
import { KnowledgeError } from "./network.js";
import { normalizedName, searchQuery } from "./text.js";
export type Retrieve = (source: KnowledgeSource, query: KnowledgeSearch, signal: AbortSignal) => Promise<ReturnType<typeof KnowledgeResult.parse>>;
type Row = Record<string, unknown>;
type Evidence = { id: string; content: string };
export function retrievalRouter(database?: Database): Retrieve {
  const remote = lightRagClient();
  return async (source, query, signal) => {
    if (source.backend === "lightrag") return remote(source, query, signal);
    if (!database) throw new KnowledgeError(503, "DEPENDENCY_UNAVAILABLE");
    const keys = Object.keys(query.filters ?? {});
    if (keys.length && (!(source.ragMode === "structured" || source.ragMode === "hybrid") || keys.some(key => !source.filterFields.includes(key)))) throw new KnowledgeError(400, "INVALID_REQUEST");
    try {
      signal = AbortSignal.any([signal,AbortSignal.timeout(15000)]);
      return await database.transaction(async tx => {
        await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const sql: Sql = { query: async <T extends Row = Row>(text: string, values?: unknown[]) => {
          signal.throwIfAborted(); const result = await tx.query<T>(text, values); signal.throwIfAborted(); return result;
        } };
        const corpus = (await sql.query("SELECT version FROM knowledge.corpora WHERE id=$1", [source.corpusId])).rows[0];
        if (!corpus) throw new Error("Corpus unavailable");
        const term = searchQuery([...query.keywords, query.query].join(" "));
        let truncated = false;
        const groups: Evidence[][] = [];
        let entities: Row[] = [], relationships: Row[] = [];
        if (source.ragMode === "fulltext" || source.ragMode === "hybrid") {
          const rows = (await sql.query("SELECT id,title,content FROM knowledge.documents WHERE corpus_id=$1 AND search_vector @@ websearch_to_tsquery('simple',$2) ORDER BY ts_rank_cd(search_vector,websearch_to_tsquery('simple',$2)) DESC,id LIMIT $3", [source.corpusId,term,query.limit + 1])).rows;
          truncated ||= rows.length > query.limit;
          groups.push(rows.slice(0,query.limit).map(row => ({ id: "document:" + row.id, content: `${row.title}\n${row.content}` })));
        }
        if (source.ragMode === "structured" || source.ragMode === "hybrid") {
          const rows = (await sql.query("SELECT id,title,attributes FROM knowledge.records WHERE corpus_id=$1 AND attributes @> $2::jsonb AND ($3::boolean OR search_vector @@ websearch_to_tsquery('simple',$4)) ORDER BY ts_rank_cd(search_vector,websearch_to_tsquery('simple',$4)) DESC,id LIMIT $5", [source.corpusId,JSON.stringify(query.filters ?? {}),keys.length > 0,term,query.limit + 1])).rows;
          truncated ||= rows.length > query.limit;
          groups.push(rows.slice(0,query.limit).map(row => ({ id: "record:" + row.id, content: `${row.title}\n${JSON.stringify(row.attributes)}` })));
        }
        if (source.ragMode === "graph" || source.ragMode === "hybrid") {
          const graph = await traverse(sql,source,query,term);
          truncated ||= graph.truncated;
          entities = graph.entities; relationships = graph.relationships;
          // Graph facts are evidence too: pure graph retrieval produces usable citations.
          groups.push([
            ...relationships.map(row => ({ id: "relationship:" + row.id, content: `${row.source_name} --${row.relation}--> ${row.target_name}\n${row.description}` })),
            ...entities.map(row => ({ id: "entity:" + row.id, content: `${row.name} (${row.type})\n${row.description}` })),
          ]);
        }
        const evidence: Evidence[] = [];
        // Round-robin prevents large document lists from starving record/graph evidence.
        for (let i = 0; groups.some(group => group[i]); i++) for (const group of groups) if (group[i]) evidence.push(group[i]!);
        let remaining = 16000;
        const trim = (value: unknown, max: number) => {
          const text = String(value ?? ""); let result = text.slice(0,Math.min(max,remaining));
          if (!result.isWellFormed()) result = result.slice(0,-1);
          remaining -= result.length; truncated ||= result.length !== text.length; return result;
        };
        const take = <T>(rows: T[]) => { truncated ||= rows.length > query.limit; return rows.slice(0,query.limit); };
        const chunks = take(evidence).map(row => ({ citation: source.id + ":" + createHash("sha256").update(JSON.stringify([source.id,source.corpusId,corpus.version,row.id,row.content])).digest("hex").slice(0,24), content: trim(row.content,4000) }));
        const entityOutput = take(entities).map(row => ({ name: trim(row.name,200), type: trim(row.type,100), description: trim(row.description,1000) }));
        const relationOutput = take(relationships).map(row => ({ source: trim(row.source_name,200), target: trim(row.target_name,200), description: trim(`${row.relation}: ${row.description}`,1000) }));
        return KnowledgeResult.parse({ sourceId: source.id,chunks,entities: entityOutput,relationships: relationOutput,truncated });
      });
    } catch { throw new KnowledgeError(503,"DEPENDENCY_UNAVAILABLE"); }
  };
}
async function traverse(sql: Sql, source: LocalSource, query: KnowledgeSearch, term: string) {
  const seeds = (await sql.query("SELECT id FROM knowledge.entities WHERE corpus_id=$1 AND (name_keys && $2::text[] OR search_vector @@ websearch_to_tsquery('simple',$3)) ORDER BY (name_keys && $2::text[]) DESC,ts_rank_cd(search_vector,websearch_to_tsquery('simple',$3)) DESC,id LIMIT $4", [source.corpusId,[query.query,...query.keywords].map(normalizedName),term,query.limit + 1])).rows;
  let truncated = seeds.length > query.limit;
  const visited = new Set(seeds.slice(0,query.limit).map(row => String(row.id))), edges = new Map<string,Row>();
  let frontier = [...visited];
  for (let depth = 0; depth < source.graphDepth && frontier.length; depth++) {
    const rows = (await sql.query("SELECT id,source_id,target_id,relation,description FROM knowledge.relationships WHERE corpus_id=$1 AND (source_id=ANY($2::text[]) OR target_id=ANY($2::text[])) ORDER BY id LIMIT 101", [source.corpusId,frontier])).rows;
    truncated ||= rows.length > 100; const next: string[] = [];
    for (const row of rows.slice(0,100)) {
      const id = String(row.id), nodes = [String(row.source_id),String(row.target_id)];
      const added = nodes.filter(node => !visited.has(node));
      if ((!edges.has(id) && edges.size >= 100) || visited.size + added.length > 100) { truncated = true; continue; }
      edges.set(id,row); for (const node of added) { visited.add(node); next.push(node); }
    }
    frontier = next;
  }
  const rows = visited.size ? (await sql.query("SELECT id,name,type,description FROM knowledge.entities WHERE corpus_id=$1 AND id=ANY($2::text[]) ORDER BY id", [source.corpusId,[...visited]])).rows : [];
  const names = new Map(rows.map(row => [String(row.id),String(row.name)]));
  return { entities: rows, relationships: [...edges.values()].map(row => ({ ...row, source_name: names.get(String(row.source_id)), target_name: names.get(String(row.target_id)) })), truncated };
}
