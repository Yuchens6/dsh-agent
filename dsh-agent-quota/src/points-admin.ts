import { readFile } from "node:fs/promises";
import { z } from "zod";
import { postgres } from "./database.js";
import { PointsCommand, PointsRepository } from "./points.js";

// 仅可信平台运维可执行；没有面向终端用户的写入接口。
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--file") throw new Error("Usage: points-admin --file command.json");
const command = PointsCommand.parse(JSON.parse(await readFile(args[1]!,"utf8")));
const { db, close } = postgres(z.string().min(1).parse(process.env.DATABASE_URL));
try { console.log(JSON.stringify(await new PointsRepository(db).command(command))); }
finally { await close(); }
