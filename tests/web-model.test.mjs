import test from "node:test";
import assert from "node:assert/strict";
import { latestDefinitions, newDraft, validateDraft, parseFrames } from "../dsh-agent-web/public/model.mjs";
const base = { id: "base", version: 1, name: "Base", description: "", systemPrompt: "Safe", tools: ["workspace.read"], skills: [], execution: { maxTurns: 3 } };
test("Web 编辑器：最新版本、草稿深拷贝、标识、步骤预算与技能约束", () => {
  assert.deepEqual(latestDefinitions([{ id: "x", version: 2 }, { id: "x", version: 1 }]), [{ id: "x", version: 2 }]);
  const draft = newDraft(base); draft.slug = "my-agent";
  assert.equal(validateDraft(draft, base), null);
  draft.tools.push("workspace.write"); assert.ok(validateDraft(draft, base)); assert.deepEqual(base.tools, ["workspace.read"]);
  draft.tools.pop(); draft.skills.push({ id: "../escape", version: 1, instructions: "x" }); assert.ok(validateDraft(draft, base));
  draft.skills = []; draft.workflow = { steps: [{ id: "one", instructions: "x", maxTurns: 4, tools: [] }] }; assert.ok(validateDraft(draft, base));
  draft.workflow.steps[0].maxTurns = 2; assert.equal(validateDraft(draft, base), null);
});
test("Web SSE：跨块帧、多行数据、心跳和游标解析", () => {
  const first = parseFrames(': heartbeat\n\nid: 42\ndata: {"eventType":'); assert.equal(first.frames.length, 0);
  const second = parseFrames(first.buffer + '"test",\ndata: "payload":{}}\n\n');
  assert.equal(second.frames[0].id, "42"); assert.equal(second.frames[0].event.eventType, "test"); assert.equal(second.buffer, "");
});
