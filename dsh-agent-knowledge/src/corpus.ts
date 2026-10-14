import { createHash } from "node:crypto";
import { z } from "zod";
import { IdentityId } from "@dsh-agent/contracts";
import type { Database } from "./database.js";
import { indexText, normalizedName } from "./text.js";
const text = (max: number) => z.string().max(max).refine(value => value.isWellFormed() && !value.includes("\0"));
export const Corpus = z.object({ id: IdentityId, version: z.number().int().positive().max(2147483647),
  documents: z.array(z.object({ id: IdentityId, title: text(500), content: text(32000).min(1) }).strict()).max(10000).default([]),
  records: z.array(z.object({ id: IdentityId, title: text(500), attributes: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
    z.union([text(2000), z.number().finite(), z.boolean(), z.null()]))
    .refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 32) }).strict()).max(10000).default([]),
  entities: z.array(z.object({ id: IdentityId, name: text(200).min(1), type: text(100), description: text(1000),
    aliases: z.array(text(200).min(1)).max(16).default([]) }).strict()).max(10000).default([]),
  relationships: z.array(z.object({ id: IdentityId, source: IdentityId, target: IdentityId, relation: text(80).min(1), description: text(1000) }).strict()).max(20000).default([]),
}).strict().superRefine((value, ctx) => {
  for (const key of ["documents", "records", "entities", "relationships"] as const) {
    if (new Set(value[key].map(row => row.id)).size !== value[key].length) ctx.addIssue({ code: "custom", path: [key], message: "Duplicate record ID" });
  }
  const entities = new Set(value.entities.map(row => row.id));
  if (value.relationships.some(row => !entities.has(row.source) || !entities.has(row.target))) {
    ctx.addIssue({ code: "custom", path: ["relationships"], message: "Graph endpoints must belong to this corpus" });
  }
});
export async function publishCorpus(db: Database, raw: unknown, replace = false) {
  const corpus = Corpus.parse(raw), serialized = JSON.stringify(corpus);
  if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) throw new Error("Corpus exceeds 16 MiB");
  const digest = createHash("sha256").update(serialized).digest("hex");
  return db.transaction(async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [corpus.id]);
    const previous = (await tx.query("SELECT version,digest FROM knowledge.corpora WHERE id=$1 FOR UPDATE", [corpus.id])).rows[0];
    if (previous?.version === corpus.version && previous.digest === digest) return { id: corpus.id, version: corpus.version, unchanged: true };
    if (previous && (Number(previous.version) >= corpus.version || !replace)) throw new Error("VERSION_CONFLICT: use a newer version and explicit --replace");
    await tx.query("INSERT INTO knowledge.corpora(id,version,digest) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,digest=EXCLUDED.digest,updated_at=now()", [corpus.id, corpus.version, digest]);
    for (const table of ["relationships", "entities", "records", "documents"]) await tx.query(`DELETE FROM knowledge.${table} WHERE corpus_id=$1`, [corpus.id]);
    for (const row of corpus.documents) await tx.query("INSERT INTO knowledge.documents VALUES($1,$2,$3,$4,setweight(to_tsvector('simple',$5),'A') || to_tsvector('simple',$6))", [corpus.id,row.id,row.title,row.content,indexText(row.title),indexText(row.content)]);
    for (const row of corpus.records) await tx.query("INSERT INTO knowledge.records VALUES($1,$2,$3,$4::jsonb,to_tsvector('simple',$5))", [corpus.id,row.id,row.title,JSON.stringify(row.attributes),indexText(row.title + " " + JSON.stringify(row.attributes))]);
    for (const row of corpus.entities) await tx.query("INSERT INTO knowledge.entities VALUES($1,$2,$3,$4,$5,$6::text[],to_tsvector('simple',$7))", [corpus.id,row.id,row.name,row.type,row.description,[row.name,...row.aliases].map(normalizedName),indexText([row.name,row.type,row.description,...row.aliases].join(" "))]);
    for (const row of corpus.relationships) await tx.query("INSERT INTO knowledge.relationships VALUES($1,$2,$3,$4,$5,$6)", [corpus.id,row.id,row.source,row.target,row.relation,row.description]);
    return { id: corpus.id, version: corpus.version, unchanged: false };
  });
}
