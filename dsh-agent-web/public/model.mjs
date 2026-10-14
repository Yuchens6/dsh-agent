export const toolNames = { "workspace.list": "列举文件", "workspace.read": "读取文件", "workspace.write": "写入文件", "knowledge.search": "知识检索" };
export const phaseNames = { queued: "任务已接收，正在排队", preparing: "正在准备上下文", waiting_model: "模型思考中", tool: "正在使用工具", retrying_model: "模型重试中" };
export function latestDefinitions(items) {
  const result = new Map();
  for (const item of items) if (!result.has(item.id) || result.get(item.id).version < item.version) result.set(item.id, item);
  return [...result.values()];
}
export function newDraft(base, metadata) {
  return { slug: metadata?.slug ?? "", expectedVersion: metadata?.version ?? 0,
    base: metadata?.base ?? { id: base.id, version: base.version }, name: metadata ? base.name : base.name + " · 自定义",
    description: base.description, systemPrompt: base.systemPrompt, tools: [...base.tools], skills: structuredClone(base.skills),
    ...(base.workflow ? { workflow: structuredClone(base.workflow) } : {}) };
}
export function validateDraft(draft, base) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.slug) || draft.slug.length > 48) return "标识请使用不超过 48 位的小写字母、数字和短横线。";
  if (!draft.name.trim() || draft.name.length > 100) return "请填写 1–100 字的名称。";
  if (!draft.systemPrompt.trim() || draft.systemPrompt.length > 16000) return "系统提示词需为 1–16000 字符。";
  if (draft.description.length > 1000) return "描述不能超过 1000 字符。";
  if (draft.tools.some(tool => !base.tools.includes(tool))) return "工具不能超出来源模板的授权。";
  if (draft.skills.length > 10) return "一个智能体最多接入 10 个技能。";
  const names = new Set();
  for (const skill of draft.skills) {
    const name = skill.name ?? skill.id;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 128 || names.has(name)) return "技能名称须为唯一的小写英文短横线名称。";
    names.add(name);
    if (!skill.instructions.trim() || skill.instructions.length > 8000) return "每个技能正文需为 1–8000 字符。";
    if (skill.description?.length > 1000) return "技能描述不能超过 1000 字符。";
  }
  if (draft.workflow) {
    const steps = draft.workflow.steps;
    if (!steps.length || steps.length > 8) return "工作流需要 1–8 个步骤。";
    if (steps.reduce((n, step) => n + step.maxTurns, 0) > base.execution.maxTurns) return `步骤调用总数不能超过模板预算 ${base.execution.maxTurns}。`;
    const ids = new Set();
    for (const [i, step] of steps.entries()) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(step.id) || ids.has(step.id)) return "步骤标识须唯一，且仅包含英文字母、数字、短横线或下划线。";
      ids.add(step.id);
      if (!Number.isInteger(step.maxTurns) || step.maxTurns < 1) return "每个步骤至少分配 1 次模型调用。";
      if (!step.instructions.trim() || step.instructions.length > 4000 || draft.systemPrompt.length + step.instructions.length + 64 > 16000) return "步骤提示词长度超出范围。";
      if (step.whenPreviousContains?.length > 200 || i === 0 && step.whenPreviousContains) return "首步不能设置前序条件；条件最长 200 字符。";
      if (step.tools.some(tool => !draft.tools.includes(tool))) return "步骤使用了智能体未启用的工具。";
    }
  }
  return null;
}
export function parseFrames(buffer) {
  const frames = []; let boundary;
  buffer = buffer.replaceAll("\r\n", "\n");
  while ((boundary = buffer.indexOf("\n\n")) >= 0) {
    const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
    const lines = frame.split("\n"); const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (data) frames.push({ id: lines.find(line => line.startsWith("id:"))?.slice(3).trim(), event: JSON.parse(data) });
  }
  return { frames, buffer };
}
