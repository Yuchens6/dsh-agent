import { postgres } from "./database.js";
import { openStorage } from "./config.js";
import { WorkspaceRepository } from "./repository.js";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const { db, close } = postgres(process.env.DATABASE_URL);
const storage = openStorage();
try {
  const repository = new WorkspaceRepository(db, storage);
  let count = 0;
  while (count < 1000 && await repository.collectOne()) count++;
  console.log(JSON.stringify({ collectedObjects: count }));
} finally { storage.close(); await close(); }
