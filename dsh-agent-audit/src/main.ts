import { z } from "zod";
import { postgres } from "./database.js";
import { AuditRepository } from "./repository.js";
import { authenticators } from "./auth.js";
import { createAuditApp } from "./app.js";
const env=z.object({DATABASE_URL:z.string().min(1),API_AUDIT_SECRET:z.string().min(32),RUN_CONTROL_AUDIT_SECRET:z.string().min(32),CHAT_AUDIT_SECRET:z.string().min(32),WORKSPACE_AUDIT_SECRET:z.string().min(32),PORT:z.coerce.number().int().min(1).max(65535).default(8080)}).parse(process.env);
const {db,close}=postgres(env.DATABASE_URL);
const auth=authenticators(env.API_AUDIT_SECRET,env.RUN_CONTROL_AUDIT_SECRET,{chat:env.CHAT_AUDIT_SECRET,workspace:env.WORKSPACE_AUDIT_SECRET});

const app=createAuditApp({repository:new AuditRepository(db),authenticateApi:auth.api,authenticateControl:auth.control,authenticateProducer:auth.producer,logger:true,ready:async()=>{if(!(await db.query("SELECT version FROM audit.schema_migrations WHERE version=2")).rows.length)throw new Error("Missing migration");}});
await app.listen({host:"0.0.0.0",port:env.PORT});
async function stop(){await app.close();await close();}
process.once("SIGTERM",()=>void stop());process.once("SIGINT",()=>void stop());
