import { z } from "zod";
import { s3Store } from "./storage.js";
export function storageConfig(env = process.env) {
  const parsed = z.object({
    S3_ENDPOINT: z.url(), S3_REGION: z.string().default("us-east-1"), S3_BUCKET: z.string().min(3),
    S3_ACCESS_KEY: z.string().min(1), S3_SECRET_KEY: z.string().min(1),
  }).parse(env);
  if (env.NODE_ENV === "production" && !parsed.S3_ENDPOINT.startsWith("https://")) throw new Error("S3 requires TLS in production");
  return { endpoint: parsed.S3_ENDPOINT, region: parsed.S3_REGION, bucket: parsed.S3_BUCKET,
    accessKeyId: parsed.S3_ACCESS_KEY, secretAccessKey: parsed.S3_SECRET_KEY };
}
export function openStorage() { return s3Store(storageConfig()); }
