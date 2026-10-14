import { readFile, stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { postgres } from "./database.js";
import { publishCorpus } from "./corpus.js";
const args = parseArgs({ options: { file: { type: "string" }, replace: { type: "boolean", default: false } } });
if (!args.values.file || !process.env.DATABASE_URL) throw new Error("Specify --file and the knowledge owner DATABASE_URL");
if ((await stat(args.values.file)).size > 16 * 1024 * 1024) throw new Error("Corpus exceeds 16 MiB");
const db = postgres(process.env.DATABASE_URL,{ readOnly: false,max: 1 });
try { console.log(JSON.stringify(await publishCorpus(db,JSON.parse(await readFile(args.values.file,"utf8")),args.values.replace))); }
catch { console.error("Corpus import failed: check JSON schema, database privileges, version and explicit --replace for updates"); process.exitCode = 1; }
finally { await db.close(); }
