import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { postgres } from "./database.js";
import { CatalogRepository } from "./repository.js";
const { values } = parseArgs({ options: {
  file: { type: "string" }, tenant: { type: "string" }, default: { type: "boolean", default: false },
} });
if (!values.file || !values.tenant || !process.env.DATABASE_URL) throw new Error("--file, --tenant and DATABASE_URL are required");
const { db, close } = postgres(process.env.DATABASE_URL);
try {
  const definition = await new CatalogRepository(db).publish(JSON.parse(await readFile(values.file, "utf8")), values.tenant, values.default!);
  console.log(JSON.stringify({ published: definition.id, version: definition.version, tenant: values.tenant }));
} finally { await close(); }
