import { createHash } from "node:crypto";
import { v7 as uuid } from "uuid";
import { SessionBinding, AssistantResult, ExecutionContext, type Principal, type Session, type Message, type PublicEvent } from "@dsh-agent/contracts";
import type { Database, Sql } from "./database.js";
import { UpdateSession } from "@dsh-agent/contracts";
import { enqueueAudit, publishAuditBatch } from "./audit.js";
import type { ChatAuditRecord } from "@dsh-agent/contracts";
import { admitMessage, defaultAdmission, validateAdmission, type AdmissionPolicy } from "./admission.js";

export class ChatError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
const hash = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
const timestamp = (v: unknown) => new Date(v as string).toISOString();
const session = (r: Record<string, unknown>): Session => ({
  id: String(r.id), title: String(r.title),
  agentDefinitionId: String(r.agent_definition_id), agentDefinitionVersion: Number(r.agent_definition_version),
  workspaceId: r.workspace_id === null ? null : String(r.workspace_id), createdAt: timestamp(r.created_at),
  archived: Boolean(r.archived), revision: Number(r.revision),
});
const message = (r: Record<string, unknown>): Message => ({
  id: String(r.id), sessionId: String(r.session_id), role: r.role as Message["role"],
  ...(r.role === "assistant" ? { runId: String(r.run_id), replyToMessageId: String(r.reply_to_message_id) } : {}),
  content: String(r.content), createdAt: timestamp(r.created_at),
});
export class ChatRepository {
  constructor(private db: Database, private provision: (actor: Principal) => Promise<SessionBinding>, private admission: AdmissionPolicy = defaultAdmission) { validateAdmission(admission); }

  private async own(tx: Sql, actor: Principal, id: string, lock = false) {
    const { rows } = await tx.query(
      "SELECT * FROM chat.conversations WHERE id=$1 AND tenant_id=$2 AND owner_uid=$3" +
      (lock ? " FOR UPDATE" : ""), [id, actor.tenantId, actor.uid]);
    if (!rows[0]) throw new ChatError(404, "NOT_FOUND");
    return rows[0];
  }
  async get(actor: Principal, id: string) { return session(await this.own(this.db, actor, id)); }
  async update(actor: Principal, id: string, input: unknown) {
    const data = UpdateSession.parse(input);
    return this.db.transaction(async tx => {
      const prior = await this.own(tx, actor, id, true);
      if (Number(prior.revision) !== data.expectedRevision) throw new ChatError(409, "VERSION_CONFLICT");
      const updated = session((await tx.query("UPDATE chat.conversations SET title=COALESCE($2,title),archived=COALESCE($3,archived),revision=revision+1 WHERE id=$1 RETURNING *",
        [id, data.title ?? null, data.archived ?? null])).rows[0]!);
      await this.audit(tx, actor, id, id, "session.updated", { revision: updated.revision, archived: updated.archived });
      return updated;
    });
  }
  async list(actor: Principal, limit: number, after?: string) {
    const { rows } = await this.db.query(
      "SELECT * FROM chat.conversations WHERE tenant_id=$1 AND owner_uid=$2 " +
      "AND ($3::uuid IS NULL OR id < $3) ORDER BY id DESC LIMIT $4",
      [actor.tenantId, actor.uid, after ?? null, limit + 1]);
    return { items: rows.slice(0, limit).map(session),
      nextCursor: rows.length > limit ? String(rows[limit - 1]!.id) : null };
  }
  async history(actor: Principal, id: string, limit: number, after?: string) {
    await this.own(this.db, actor, id);
    let position: unknown = null;
    if (after) {
      const cursor = await this.db.query("SELECT position FROM chat.conversation_messages WHERE id=$1 AND session_id=$2 AND tenant_id=$3 AND owner_uid=$4",
        [after, id, actor.tenantId, actor.uid]);
      if (!cursor.rows[0]) throw new ChatError(404, "NOT_FOUND");
      position = cursor.rows[0].position;
    }
    const { rows } = await this.db.query(
      "SELECT * FROM chat.conversation_messages WHERE session_id=$1 AND tenant_id=$2 AND owner_uid=$3 " +
      "AND ($4::bigint IS NULL OR position > $4) ORDER BY position LIMIT $5",
      [id, actor.tenantId, actor.uid, position, limit + 1]);
    return { items: rows.slice(0, limit).map(message),
      nextCursor: rows.length > limit ? String(rows[limit - 1]!.id) : null };
  }
  async executionContext(actor: Principal, id: string, messageId: string): Promise<ExecutionContext> {
    return this.db.transaction(async tx => {
      const conversation = await this.own(tx, actor, id, true);
      if (!conversation.workspace_id) throw new ChatError(409, "INVALID_STATE");
      const target = await tx.query("SELECT * FROM chat.conversation_messages WHERE id=$1 AND session_id=$2 AND role='user'",
        [messageId, id]);
      if (!target.rows[0]) throw new ChatError(404, "NOT_FOUND");
      const users = await tx.query("SELECT * FROM chat.conversation_messages WHERE session_id=$1 AND role='user' AND position<=$2 ORDER BY position DESC LIMIT 21",
        [id, target.rows[0].position]);
      const answers = await tx.query("SELECT * FROM chat.conversation_messages WHERE session_id=$1 AND role='assistant' AND reply_to_message_id=ANY($2::uuid[])",
        [id, users.rows.map(row => row.id)]);
      const replies = new Map(answers.rows.map(row => [String(row.reply_to_message_id), row]));
      const messages: Message[] = [];
      let length = 0, truncated = users.rows.length > 20;
      for (const row of users.rows.slice(0, 20)) {
        const answer = row.id === messageId ? undefined : replies.get(String(row.id));
        const pair = [message(row), ...(answer ? [message(answer)] : [])];
        const size = pair.reduce((sum, item) => sum + item.content.length, 0);
        // 保留完整问答对，不截断字符；当前用户消息必须包含在内。
        if (length + size > 64_000) { truncated = true; break; }
        messages.unshift(...pair); length += size;
      }
      return ExecutionContext.parse({ sessionId: id, messageId, messages, truncated,
        binding: { workspaceId: conversation.workspace_id, agentDefinitionId: conversation.agent_definition_id,
          agentDefinitionVersion: Number(conversation.agent_definition_version) } });
    });
  }
  async appendAssistant(actor: Principal, id: string, input: unknown) {
    const data = AssistantResult.parse(input);
    if (!data.output.isWellFormed() || data.output.includes("\0")) throw new ChatError(400, "INVALID_REQUEST");
    return this.db.transaction(async tx => {
      await this.own(tx, actor, id, true);
      const parent = await tx.query("SELECT id FROM chat.conversation_messages WHERE id=$1 AND session_id=$2 AND role='user'", [data.messageId, id]);
      if (!parent.rows[0]) throw new ChatError(404, "NOT_FOUND");
      const requestHash = hash(data);
      const inserted = await tx.query("INSERT INTO chat.conversation_messages(id,session_id,tenant_id,owner_uid,role,content,request_hash,run_id,reply_to_message_id) " +
        "VALUES($1,$2,$3,$4,'assistant',$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING *",
        [uuid(), id, actor.tenantId, actor.uid, data.output, requestHash, data.runId, data.messageId]);
      if (inserted.rows[0]) {
        await this.audit(tx, actor, id, String(inserted.rows[0].id), "assistant.projected", { runId: data.runId });
        return message(inserted.rows[0]);
      }
      const old = await tx.query("SELECT * FROM chat.conversation_messages WHERE run_id=$1 AND session_id=$2 AND tenant_id=$3 AND owner_uid=$4",
        [data.runId, id, actor.tenantId, actor.uid]);
      if (!old.rows[0] || old.rows[0].request_hash !== requestHash) throw new ChatError(409, "IDEMPOTENCY_CONFLICT");
      // 不产生用户接受事件，因此不会递归创建新的运行。
      return message(old.rows[0]);
    });
  }
  private async event(tx: Sql, actor: Principal, id: string, subjectId: string,
    eventType: "conversation.created.v1" | "conversation.message.accepted.v1", traceId: string) {
    await this.audit(tx, actor, id, subjectId, eventType === "conversation.created.v1" ? "session.created" : "message.accepted");
    const envelope = {
      eventId: uuid(), eventType, occurredAt: new Date().toISOString(),
      producer: "dsh-agent-chat", tenantId: actor.tenantId, ownerUid: actor.uid,
      sessionId: id, subjectId, traceId,
      payload: eventType === "conversation.created.v1" ? { sessionId: id } : { messageId: subjectId },
    };
    await tx.query("INSERT INTO chat.conversation_outbox(event_id,session_id,subject,envelope) VALUES($1,$2,$3,$4)",
      [envelope.eventId, id, "agent.events." + actor.tenantId + "." + actor.uid + "." + id, JSON.stringify(envelope)]);
    if (eventType === "conversation.message.accepted.v1") {
      const command = { ...envelope, eventId: uuid() };
      await tx.query("INSERT INTO chat.conversation_outbox(event_id,session_id,subject,envelope) VALUES($1,$2,$3,$4)",
        [command.eventId, id, "agent.commands.run.requested.v1", JSON.stringify(command)]);
    }
  }
  async create(actor: Principal, title: string, key: string, traceId: string) {
    const requestHash = hash({ title });
    // 已成功的幂等重放不依赖定义中心或工作区在线，也不会切换已绑定版本。
    const prior = await this.db.query(
      "SELECT * FROM chat.conversations WHERE tenant_id=$1 AND owner_uid=$2 AND idempotency_key=$3",
      [actor.tenantId, actor.uid, key]);
    if (prior.rows[0]) {
      if (prior.rows[0].request_hash !== requestHash) throw new ChatError(409, "IDEMPOTENCY_CONFLICT");
      return session(prior.rows[0]);
    }
    const binding = SessionBinding.parse(await this.provision(actor));
    return this.db.transaction(async tx => {
      const { rows } = await tx.query(
        "INSERT INTO chat.conversations(id,tenant_id,owner_uid,title,agent_definition_id,agent_definition_version," +
        "idempotency_key,request_hash,workspace_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) " +
        "ON CONFLICT(tenant_id,owner_uid,idempotency_key) DO NOTHING RETURNING *",
        [uuid(), actor.tenantId, actor.uid, title, binding.agentDefinitionId, binding.agentDefinitionVersion, key, requestHash, binding.workspaceId]);
      if (rows[0]) {
        await this.event(tx, actor, String(rows[0].id), String(rows[0].id), "conversation.created.v1", traceId);
        return session(rows[0]);
      }
      const existing = await tx.query(
        "SELECT * FROM chat.conversations WHERE tenant_id=$1 AND owner_uid=$2 AND idempotency_key=$3",
        [actor.tenantId, actor.uid, key]);
      const row = existing.rows[0]!;
      if (row.request_hash !== requestHash) throw new ChatError(409, "IDEMPOTENCY_CONFLICT");
      return session(row);
    });
  }
  async send(actor: Principal, id: string, content: string, key: string, traceId: string) {
    return this.db.transaction(async tx => {
      const conversation = await this.own(tx, actor, id, true);
      const requestHash = hash({ content });
      const old = await tx.query(
        "SELECT * FROM chat.conversation_messages WHERE session_id=$1 AND tenant_id=$2 AND owner_uid=$3 AND idempotency_key=$4",
        [id, actor.tenantId, actor.uid, key]);
      if (old.rows[0]) {
        if (old.rows[0].request_hash !== requestHash) throw new ChatError(409, "IDEMPOTENCY_CONFLICT");
        return message(old.rows[0]);
      }
      // 归档阻止新消息，已经接受的消息重放、在途回答投影和历史读取继续有效。
      if (conversation.archived) throw new ChatError(409, "INVALID_STATE");
      await admitMessage(tx,actor,id,this.admission);
      const { rows } = await tx.query(
        "INSERT INTO chat.conversation_messages(id,session_id,tenant_id,owner_uid,role,content,idempotency_key,request_hash) " +
        "VALUES($1,$2,$3,$4,'user',$5,$6,$7) RETURNING *",
        [uuid(), id, actor.tenantId, actor.uid, content, key, requestHash]);
      await this.event(tx, actor, id, String(rows[0]!.id), "conversation.message.accepted.v1", traceId);
      return message(rows[0]!);
    });
  }
  async publishBatch(publish: (subject: string, event: PublicEvent) => Promise<void>) {
    // 与消息写入共用会话行锁；多发布器不会倒序发布同一会话的事件。
    return this.db.transaction(async tx => {
      const chosen = await tx.query(
        "SELECT c.id FROM chat.conversations c WHERE EXISTS " +
        "(SELECT 1 FROM chat.conversation_outbox o WHERE o.session_id=c.id AND o.published_at IS NULL) " +
        "ORDER BY c.id FOR UPDATE OF c SKIP LOCKED LIMIT 1");
      if (!chosen.rows[0]) return 0;
      const events = await tx.query(
        "SELECT * FROM chat.conversation_outbox WHERE session_id=$1 AND published_at IS NULL ORDER BY sequence LIMIT 50",
        [chosen.rows[0].id]);
      for (const row of events.rows) {
        await publish(String(row.subject), row.envelope as PublicEvent);
        await tx.query("UPDATE chat.conversation_outbox SET published_at=now() WHERE event_id=$1", [row.event_id]);
      }
      return events.rows.length;
    });
  }
  private async audit(tx: Sql, actor: Principal, sessionId: string, subjectId: string, action: ChatAuditRecord["action"], extra: Partial<Pick<ChatAuditRecord, "revision" | "archived" | "runId">> = {}) {
    await enqueueAudit(tx, { eventId: uuid(), occurredAt: new Date().toISOString(), producer: "dsh-agent-chat",
      tenantId: actor.tenantId, ownerUid: actor.uid, sessionId, subjectId, action, ...extra });
  }
  publishAuditBatch(deliver: (record: ChatAuditRecord) => Promise<void>) { return publishAuditBatch(this.db, deliver); }
  async metrics(): Promise<Record<string, number>> {
    const row = (await this.db.query("SELECT " +
      "(SELECT count(*) FROM chat.audit_outbox WHERE delivered_at IS NULL) AS audit_pending," +
      "(SELECT COALESCE(GREATEST(EXTRACT(EPOCH FROM clock_timestamp()-min(created_at)),0),0) FROM chat.audit_outbox WHERE delivered_at IS NULL) AS audit_oldest_age_seconds," +
      "(SELECT COALESCE(max(attempts),0) FROM chat.audit_outbox WHERE delivered_at IS NULL) AS audit_max_attempts," +
      "(SELECT count(*) FROM chat.conversation_outbox WHERE published_at IS NULL) AS events_pending," +
      "(SELECT COALESCE(GREATEST(EXTRACT(EPOCH FROM clock_timestamp()-min(created_at)),0),0) FROM chat.conversation_outbox WHERE published_at IS NULL) AS events_oldest_age_seconds")).rows[0]!;
    return Object.fromEntries(Object.entries(row).map(([key,value]) => [key, Number(value)]));
  }
}
