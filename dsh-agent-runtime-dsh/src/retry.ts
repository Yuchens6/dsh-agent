import { z } from "zod";

// Only transient provider failures are eligible; deployment cannot enable unbounded retries.
export const ModelRetry = z.object({
  maxRetries: z.number().int().min(0).max(5).default(2),
  initialDelayMs: z.number().int().min(1).max(10_000).default(500),
  maxDelayMs: z.number().int().min(1).max(10_000).default(10_000),
}).strict().refine(value => value.initialDelayMs <= value.maxDelayMs, "Initial retry delay exceeds maximum");
export type ModelRetry = z.infer<typeof ModelRetry>;
