import type { ErrorCode } from "@dsh-agent/contracts";
export class ServiceError extends Error {
  constructor(public status: number, public code: ErrorCode) { super(code); }
}
