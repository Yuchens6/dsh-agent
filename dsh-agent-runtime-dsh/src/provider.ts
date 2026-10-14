import { randomUUID } from "node:crypto";
import type { AnonymousUserId } from "@deepseek-ai/dsh-anonymous-user-id";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { DeepSeekAdapter } from "@deepseek-ai/dsh-llm-deepseek";
import { ModelRetry } from "./retry.js";
export function deepseekProvider(apiKey: string, baseURL: string, retry: Partial<ModelRetry> = {}) {
  const policy = ModelRetry.parse(retry);
  // 自行生成合法 UUID，不调用上游会读写用户主目录的持久匿名身份函数。
  const anonymousId = randomUUID() as AnonymousUserId;
  return new DeepSeekAdapter({ resolveApiKey: async () => apiKey, resolveUserId: () => anonymousId,
    options: () => ({ baseURL, apiKeyEnv: credentialRef("DEEPSEEK_API_KEY"), defaults: { thinking: "disabled", reasoningEffort: "off" },
      maxTokens: 8192, defaultContextWindow: 128_000, models: [], streamIdleTimeoutMs: 20_000,
      maxRequestFilesBytes: 1, maxInlineRequestImageBytes: 1, maxImagesPerRequest: 1,
      imageOffloadByteQuantum: 1, inlineImageOffloadByteQuantum: 1, imageOffloadCountQuantum: 1, filesApiTimeoutMs: 1000,
      filePolicy: { expiresAfterSeconds: 3600, refreshMarginSeconds: 0, quotaCleanupBatch: 1 },
      retryPolicy: resolveRetryPolicy({ mode: "normal", maxRetries: policy.maxRetries,
        retryableCodes: ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"],
        backoff: { initialDelayMs: policy.initialDelayMs, maxDelayMs: policy.maxDelayMs, jitterRatio: 0.1 } }, "deepseek-official"),
    }),
  });
}
