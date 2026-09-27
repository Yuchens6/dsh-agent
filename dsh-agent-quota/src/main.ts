import { z } from "zod";
import { postgres } from "./database.js";
import { QuotaRepository, defaultPolicy } from "./repository.js";
import { authenticators } from "./auth.js";
import { createQuotaApp } from "./app.js";
import { PointsRepository } from "./points.js";
const billingEnabled=z.enum(["true","false"]).default("false").parse(process.env.POINTS_BILLING_ENABLED)==="true";
const env=z.object({DATABASE_URL:z.string().min(1),API_QUOTA_SECRET:z.string().min(32),RUN_CONTROL_QUOTA_SECRET:z.string().min(32),PORT:z.coerce.number().int().min(1).max(65535).default(8080)}).parse(process.env);
const {db,close}=postgres(env.DATABASE_URL);
const auth=authenticators(env.API_QUOTA_SECRET,env.RUN_CONTROL_QUOTA_SECRET);
const policy=z.object({userActive:z.coerce.number().int().positive().default(defaultPolicy.userActive),tenantActive:z.coerce.number().int().positive().default(defaultPolicy.tenantActive),userDailyOutputTokens:z.coerce.number().int().positive().default(defaultPolicy.userDailyOutputTokens),tenantDailyOutputTokens:z.coerce.number().int().positive().default(defaultPolicy.tenantDailyOutputTokens)}).parse({userActive:process.env.QUOTA_USER_ACTIVE,tenantActive:process.env.QUOTA_TENANT_ACTIVE,userDailyOutputTokens:process.env.QUOTA_USER_DAILY_OUTPUT_TOKENS,tenantDailyOutputTokens:process.env.QUOTA_TENANT_DAILY_OUTPUT_TOKENS});
const app=createQuotaApp({repository:new QuotaRepository(db,policy,billingEnabled),points:new PointsRepository(db,billingEnabled),authenticateApi:auth.api,authenticateControl:auth.control,logger:true,ready:async()=>{if(!(await db.query("SELECT version FROM quota.schema_migrations WHERE version=3")).rows.length)throw new Error("Missing migration");}});
await app.listen({host:"0.0.0.0",port:env.PORT});
async function stop(){await app.close();await close();}
process.once("SIGTERM",()=>void stop());process.once("SIGINT",()=>void stop());
