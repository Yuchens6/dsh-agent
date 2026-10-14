import { toolNames, phaseNames, latestDefinitions, newDraft, validateDraft, parseFrames } from "./model.mjs";

const root = document.querySelector("#app");
const state = { tab: "agents", actor: null, definitions: [], studio: { enabled: false, canPublish: false, items: [] },
  sessions: [], details: new Map(), draft: null, base: null, session: null, messages: [], running: false, runId: null, preview: "", progress: "", steps: [], dirty: false };
let config, tokens, tokenUntil = 0, refreshing, streamStop, pollTimer, authEpoch = 0;
const $ = (tag, attrs = {}, ...children) => {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith("on")) element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "class") element.className = value;
    else if (key === "text") element.textContent = value;
    else if (value !== undefined && value !== false) element.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) if (child !== undefined && child !== null) element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return element;
};
const button = (label, action, className = "button", disabled = false) => $("button", { type: "button", class: className, disabled, onClick: () => safely(action) }, label);
function notice(message, bad = false) {
  const box = document.querySelector("#notice"); box.textContent = message; box.className = bad ? "notice error" : "notice";
  clearTimeout(notice.timer); notice.timer = setTimeout(() => { box.className = ""; box.textContent = ""; }, 6500);
}
async function safely(work) { try { await work(); } catch (error) { notice(error.message || "操作失败，请稍后重试。", true); } }
function confirmAction(message) {
  return new Promise(resolve => {
    const modal = $("dialog", { class: "dialog", "aria-label": "操作确认" });
    const done = answer => { modal.close(); modal.remove(); resolve(answer); };
    modal.append($("h2", {}, "确认操作"), $("p", { class: "muted" }, message), $("div", { class: "actions" },
      button("取消", () => done(false), "button"), button("确认", () => done(true), "button primary")));
    modal.addEventListener("cancel", event => { event.preventDefault(); done(false); });
    root.append(modal); modal.showModal();
  });
}
const errors = { FORBIDDEN: "没有此操作的权限，请联系租户管理员。", NOT_FOUND: "该资源不存在或未授权给当前租户。",
  VERSION_CONFLICT: "版本已变化，请刷新后重新编辑；不会覆盖已发布内容。", IDEMPOTENCY_CONFLICT: "请求与原幂等操作不一致。",
  QUOTA_EXCEEDED: "已达到配额或版本数量上限，请联系管理员。", DEPENDENCY_UNAVAILABLE: "后端暂不可用，请检查本地服务状态。",
  UNAUTHENTICATED: "登录已过期，请重新登录。", INVALID_REQUEST: "配置未通过后端校验，请检查名称、步骤预算与技能内容。" };
async function exchange(body) {
  const response = await fetch("/auth/token", { method: "POST", body: new URLSearchParams({ client_id: config.clientId, ...body }) });
  if (!response.ok) throw new Error("身份认证失败，请重新登录。");
  const value = await response.json(); tokens = value; tokenUntil = Date.now() + Number(value.expires_in) * 1000; return value.access_token;
}
async function token() {
  if (!tokens) throw new Error(errors.UNAUTHENTICATED);
  if (Date.now() < tokenUntil - 30000) return tokens.access_token;
  if (!refreshing) refreshing = exchange({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }).finally(() => { refreshing = null; });
  return refreshing;
}
async function api(path, method = "GET", body, key) {
  const response = await fetch("/api/v1" + path, { method, headers: { authorization: "Bearer " + await token(),
    ...(body === undefined ? {} : { "content-type": "application/json" }), ...(key ? { "idempotency-key": key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error((errors[value.error?.code] ?? "请求失败") + `（${response.status}）`), { status: response.status });
  return value;
}
async function login() {
  const random = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const verifier = random(), oauthState = random();
  const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  sessionStorage.setItem("dsh-login", JSON.stringify({ verifier, state: oauthState, at: Date.now() }));
  const url = new URL(config.issuer + "/protocol/openid-connect/auth");
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code", scope: "openid", state: oauthState,
    code_challenge_method: "S256", code_challenge: challenge, prompt: "login" }).toString();
  location.assign(url);
}
async function refresh() {
  const [actor, definitions, studio, sessions] = await Promise.all([api("/me"), api("/definitions"), api("/studio"), api("/sessions?limit=20")]);
  Object.assign(state, { actor, definitions: definitions.items, studio, sessions: sessions.items }); state.details.clear(); render();
}
async function detail(item) {
  const key = item.id + ":" + item.version;
  if (!state.details.has(key)) state.details.set(key, await api(`/definitions/${item.id}/versions/${item.version}`));
  return state.details.get(key);
}
async function go(tab) {
  if (state.dirty && !await confirmAction("离开会丢弃未发布的修改，是否继续？")) return;
  state.draft = null; state.dirty = false; state.tab = tab; render();
}
function shell() {
  const sidebar = $("aside", { class: "sidebar" }, $("a", { href: "/", class: "brand" }, $("span", { class: "brand-symbol" }, "d"), $("span", {}, "DSH", $("small", {}, "AGENT STUDIO"))),
    $("div", { class: "section-label" }, "构建与运行"));
  for (const [key, icon, label] of [["agents", "◈", "智能体"], ["workflows", "⌘", "工作流"], ["skills", "✦", "技能库"], ["chat", "▤", "对话测试"]])
    sidebar.append(button($("span", {}, $("span", { class: "nav-icon" }, icon), label), () => go(key), "nav-item " + (state.tab === key ? "selected" : "")));
  sidebar.append($("div", { class: "section-label recent-label" }, "最近会话"));
  for (const session of state.sessions.slice(0, 7)) sidebar.append(button(session.title, () => openSession(session), "recent", state.running));
  if (!state.sessions.length) sidebar.append($("p", { class: "muted small sidebar-note" }, "运行一个智能体，开始新会话。"));
  sidebar.append($("div", { class: "sidebar-bottom" }, $("span", { class: "live-dot" }), "DSH 原生执行", $("small", {}, "权限由服务端校验")));
  const identity = state.actor ? $("div", { class: "identity" }, $("span", { class: "avatar" }, state.actor.uid.slice(0, 2).toUpperCase()),
    $("div", {}, $("strong", {}, state.actor.tenantId), $("small", {}, state.studio.canPublish ? "租户管理员" : "租户成员")),
    button("退出", async () => { if (state.running && !await confirmAction("退出只关闭当前页面连接，不会取消后台任务。重新登录后可从最近会话恢复。继续？")) return;
      if (state.dirty && !await confirmAction("退出会丢弃未发布修改。继续？")) return;
      authEpoch++; tokens = null; streamStop?.abort(); clearTimeout(pollTimer); location.assign("/"); }, "quiet")) : button("登录工作台", login, "button primary");
  return { sidebar, topbar: $("header", { class: "topbar" }, $("div", { class: "breadcrumb" }, "工作空间", $("span", {}, "/"), "智能体工作台"), identity) };
}
function render() {
  const { sidebar, topbar } = shell(); const content = $("main", { class: "content" });
  root.replaceChildren(sidebar, $("div", { class: "main-shell" }, topbar, content));
  if (!state.actor) { landing(content); return; }
  if (state.draft) editor(content);
  else if (state.tab === "chat") chat(content);
  else if (state.tab === "skills") safely(() => skillLibrary(content));
  else collection(content);
}
function heading(parent, eyebrow, title, description, action) {
  parent.append($("div", { class: "page-heading" }, $("div", {}, $("div", { class: "eyebrow" }, eyebrow), $("h1", {}, title), $("p", { class: "muted" }, description)), action));
}
function landing(parent) {
  heading(parent, "YOUR AGENT WORKSPACE", "让专业能力，成为智能体。", "组合技能，定义工作流，让团队在同一个受控工作空间里协作。");
  parent.append($("section", { class: "welcome-panel" }, $("div", {}, $("span", { class: "pill blue" }, "原生 DSH · 租户隔离"),
    $("h2", {}, "从一个想法，到一套可运行的流程。"), $("p", {}, "登录后查看租户已授权的智能体与工作流。管理员可接入文本技能、自定义执行步骤，并发布不可变版本。"),
    button("登录并进入工作台 ↗", login, "button primary")), $("div", { class: "flow-illustration", "aria-label": "配置、原生执行与结果流程" },
      $("div", { class: "mini-node" }, "01", $("strong", {}, "设定目标"), $("small", {}, "提示词 + 技能")), $("span", {}, "↓"),
      $("div", { class: "mini-node active" }, "02", $("strong", {}, "DSH 原生执行"), $("small", {}, "工具与步骤授权")), $("span", {}, "↓"),
      $("div", { class: "mini-node" }, "03", $("strong", {}, "实时获取结果"), $("small", {}, "状态 + 正文推送")))));
  parent.append($("div", { class: "feature-grid" }, ...[["◈", "专属智能体", "复用已授权模板，保持模型、工具和预算的权限边界。"], ["✦", "可组合技能", "编辑或导入 Markdown 文本，支持 /技能名 显式调用。"], ["⌘", "团队工作流", "选择租户已有流程运行，也可由管理员发布新流程。"]].map(([icon, title, text]) => $("article", { class: "feature" }, $("span", {}, icon), $("h3", {}, title), $("p", {}, text)))));
}
function collection(parent) {
  const workflows = state.tab === "workflows";
  heading(parent, workflows ? "WORKFLOW LIBRARY" : "AGENT LIBRARY", workflows ? "把复杂任务，交给流程。" : "你的智能体，从这里开始。",
    workflows ? "租户已授权的流程，可直接运行。顺序与条件由 DSH 原生工作流引擎处理。" : "将指令、技能与工具组合为智能体。每次发布保留独立版本。",
    button(workflows ? "+ 新建工作流" : "+ 创建智能体", () => chooseTemplate(workflows), "button primary", !state.studio.canPublish));
  if (!state.studio.canPublish) parent.append($("p", { class: "banner" }, state.studio.enabled ? "成员模式 · 可运行已授权定义。编辑与发布需要 tenant-admin（租户管理员）角色。" : "只读模式 · 后端尚未启用工作台发布。已授权模板仍可直接运行。"));
  const all = latestDefinitions(state.definitions);
  const items = all.filter(item => workflows ? item.kind === "workflow" : item.kind !== "workflow");
  const search = $("input", { type: "search", placeholder: "搜索名称或描述…", "aria-label": "搜索定义", class: "search" });
  const grid = $("div", { class: "card-grid" });
  const fill = () => {
    const selected = items.filter(item => (item.name + item.description).toLowerCase().includes(search.value.toLowerCase()));
    grid.replaceChildren(...selected.map(item => definitionCard(item)));
    if (!selected.length) grid.append($("div", { class: "empty" }, "暂无匹配定义。请切换分类或联系管理员授权模板。"));
  };
  search.addEventListener("input", fill); fill();
  parent.append($("div", { class: "collection-toolbar" }, $("div", { class: "tabs-label" }, workflows ? "已授权工作流" : "全部智能体", $("span", { class: "count" }, items.length)), search), grid,
    $("p", { class: "footnote" }, "每张卡片展示最新授权版本。已有会话始终保留创建时绑定的版本，不会被后续发布替换。"));
}
function definitionCard(item) {
  const own = state.studio.items.find(value => value.id === item.id);
  return $("article", { class: "definition-card" }, $("div", { class: "card-top" }, $("span", { class: "card-icon " + (item.kind === "workflow" ? "violet" : "") }, item.kind === "workflow" ? "⌘" : "◈"),
    $("span", { class: "pill" }, own ? "租户自定义" : "平台模板")), $("h2", {}, item.name), $("p", { class: "description" }, item.description || "暂无描述"),
    $("div", { class: "tool-tags" }, ...item.tools.map(tool => $("span", {}, toolNames[tool]))),
    $("div", { class: "card-footer" }, $("span", { class: "muted small" }, `v${item.version}${item.isDefault ? " · 默认" : ""}`),
      $("div", { class: "actions" }, button(own ? "编辑" : "查看 / 自定义", () => editDefinition(item), "quiet"), button("运行 ↗", () => launch(item), "button compact", state.running))));
}
async function chooseTemplate(workflow) {
  const templates = latestDefinitions(state.definitions).filter(item => !state.studio.items.some(own => own.id === item.id));
  const modal = $("dialog", { class: "dialog" });
  modal.append($("h2", {}, "选择授权模板"), $("p", { class: "muted" }, "自定义配置不能扩大模板的模型、工具、知识源和执行预算。"));
  for (const item of templates) modal.append(button($("span", {}, item.name, $("small", {}, `${item.kind === "workflow" ? "工作流" : "智能体"} · v${item.version}`)), async () => {
    modal.close(); modal.remove(); await editDefinition(item);
    if (workflow && !state.draft.workflow) { state.draft.workflow = { steps: [{ id: "step-1", instructions: "根据用户任务输出结果。", maxTurns: 1, tools: [] }] }; render(); }
  }, "template-option"));
  modal.append(button("取消", () => { modal.close(); modal.remove(); }, "button")); root.append(modal); modal.showModal();
}
async function editDefinition(item) {
  if (state.dirty && !await confirmAction("丢弃当前未发布的修改？")) return;
  const document = await detail(item), metadata = state.studio.items.find(value => value.id === item.id);
  state.base = metadata ? await detail(metadata.base) : document;
  state.draft = newDraft(document, metadata); state.tab = document.workflow ? "workflows" : "agents"; state.dirty = false; render();
}
function field(label, value, change, options = {}) {
  const { multiline, rows = 3, ...attributes } = options;
  const input = $(multiline ? "textarea" : "input", { ...attributes, ...(multiline ? { rows } : { type: "text" }), disabled: !state.studio.canPublish });
  input.value = value ?? ""; input.addEventListener("input", () => { change(input.value); state.dirty = true; });
  return $("label", { class: "field" }, $("span", {}, label), input);
}
function check(label, checked, change, disabled = false) {
  const input = $("input", { type: "checkbox", checked, disabled });
  input.addEventListener("change", () => { change(input.checked); state.dirty = true; });
  return $("label", { class: "check" }, input, label);
}
function editor(parent) {
  const draft = state.draft, base = state.base, editable = state.studio.canPublish;
  heading(parent, "AGENT BUILDER", draft.expectedVersion ? `编辑 · ${draft.name}` : "构建你的智能体", "配置是数据，不是执行脚本。保存后生成不可变版本，供本租户使用。",
    $("div", { class: "actions" }, button("返回", () => go(state.tab), "button"), button(`发布 v${draft.expectedVersion + 1}`, publish, "button primary", !editable)));
  const form = $("div", { class: "editor-main" });
  form.append($("section", { class: "panel" }, $("h2", {}, "01 / 基本设定"),
    $("div", { class: "two-columns" }, field("显示名称", draft.name, value => draft.name = value, { maxlength: 100 }),
      field("唯一标识（发布后不变）", draft.slug, value => draft.slug = value, { maxlength: 48, readonly: draft.expectedVersion > 0, placeholder: "例如 team-researcher" })),
    field("简短描述", draft.description, value => draft.description = value, { maxlength: 1000 }),
    field("系统提示词", draft.systemPrompt, value => draft.systemPrompt = value, { multiline: true, rows: 7, maxlength: 16000 }),
    $("h3", {}, "启用工具"), $("div", { class: "checks" }, ...base.tools.map(tool => check(toolNames[tool], draft.tools.includes(tool), enabled => {
      draft.tools = enabled ? [...draft.tools, tool] : draft.tools.filter(value => value !== tool);
      if (!enabled) for (const step of draft.workflow?.steps ?? []) step.tools = step.tools.filter(value => value !== tool);
      render();
    }, !editable)))));
  const skillPanel = $("section", { class: "panel" }, $("div", { class: "panel-heading" }, $("h2", {}, `02 / 技能 · ${draft.skills.length}/10`), button("+ 添加技能", () => {
    draft.skills.push({ id: `skill-${draft.skills.length + 1}`, version: 1, description: "", instructions: "", invocation: { modelInvocable: true, userInvocable: true } }); state.dirty = true; render();
  }, "button compact", !editable || draft.skills.length >= 10)), $("p", { class: "muted small" }, "技能由 DSH 原生加载。支持文本指令和 Markdown 导入，不下载远程脚本或挂载本机目录。"));
  draft.skills.forEach((skill, index) => {
    const input = $("input", { type: "file", accept: ".md,.txt,text/markdown,text/plain", "aria-label": "导入技能文本", disabled: !editable });
    input.addEventListener("change", () => safely(async () => {
      const file = input.files[0]; if (!file) return;
      if (file.size > 32000) throw new Error("技能文件过大，最多 32000 字节且正文不超过 8000 字符。");
      const text = await file.text(); if (!text.trim() || text.length > 8000) throw new Error("技能正文需为 1–8000 字符。");
      skill.instructions = text; state.dirty = true; render(); notice("已作为纯文本导入。请确认技能名和调用策略。");
    }));
    const invocation = skill.invocation ??= { modelInvocable: true, userInvocable: true };
    skillPanel.append($("div", { class: "sub-panel" }, $("div", { class: "panel-heading" }, $("strong", {}, `技能 ${index + 1}`), button("移除", () => { draft.skills.splice(index, 1); state.dirty = true; render(); }, "quiet danger", !editable)),
      $("div", { class: "two-columns" }, field("调用名称（如 brief-answer）", skill.name ?? skill.id, value => { skill.id = value; skill.name = value; }, { maxlength: 128 }),
        field("技能描述", skill.description, value => skill.description = value, { maxlength: 1000 })),
      field("技能正文", skill.instructions, value => skill.instructions = value, { multiline: true, rows: 5, maxlength: 8000 }),
      $("div", { class: "checks" }, check("允许模型按需加载", invocation.modelInvocable, value => invocation.modelInvocable = value, !editable),
        check("允许 /技能名 调用", invocation.userInvocable, value => invocation.userInvocable = value, !editable)), input));
  });
  form.append(skillPanel);
  const workflow = $("section", { class: "panel" }, $("div", { class: "panel-heading" }, $("h2", {}, "03 / 原生工作流"),
    check("启用多步骤流程", !!draft.workflow, enabled => { draft.workflow = enabled ? { steps: [{ id: "step-1", instructions: "根据用户任务输出结果。", maxTurns: 1, tools: [] }] } : undefined; render(); }, !editable)),
    $("p", { class: "muted small" }, "各步顺序执行；条件匹配上一成功步骤的输出。总调用预算不超过模板上限。"));
  draft.workflow?.steps.forEach((step, index) => {
    workflow.append($("div", { class: "sub-panel step-panel" }, $("div", { class: "panel-heading" }, $("strong", {}, `${String(index + 1).padStart(2, "0")} / 执行步骤`),
      $("div", { class: "actions" }, button("上移", () => { [draft.workflow.steps[index - 1], draft.workflow.steps[index]] = [step, draft.workflow.steps[index - 1]]; delete draft.workflow.steps[0].whenPreviousContains; state.dirty = true; render(); }, "quiet", !editable || index === 0),
        button("移除", () => { draft.workflow.steps.splice(index, 1); if (draft.workflow.steps[0]) delete draft.workflow.steps[0].whenPreviousContains; state.dirty = true; render(); }, "quiet danger", !editable))),
      $("div", { class: "two-columns" }, field("步骤标识", step.id, value => step.id = value, { maxlength: 128 }),
        field("最多模型调用次数", step.maxTurns, value => step.maxTurns = Number(value), { inputmode: "numeric" })),
      field("步骤指令", step.instructions, value => step.instructions = value, { multiline: true, maxlength: 4000 }),
      index > 0 ? field("条件：上一步包含此文本才执行（留空始终执行）", step.whenPreviousContains, value => { if (value) step.whenPreviousContains = value; else delete step.whenPreviousContains; }, { maxlength: 200 }) : null,
      $("div", { class: "checks" }, ...draft.tools.map(tool => check(toolNames[tool], step.tools.includes(tool), enabled => { step.tools = enabled ? [...step.tools, tool] : step.tools.filter(value => value !== tool); }, !editable)))));
  });
  if (draft.workflow) workflow.append(button("+ 添加步骤", () => { draft.workflow.steps.push({ id: `step-${crypto.randomUUID().slice(0, 6)}`, instructions: "", maxTurns: 1, tools: [] }); state.dirty = true; render(); }, "button", !editable || draft.workflow.steps.length >= 8));
  form.append(workflow);
  const aside = $("aside", { class: "editor-aside panel" }, $("span", { class: "pill blue" }, "权限与预算"), $("h3", {}, base.name), $("p", { class: "muted small" }, `来源版本 v${base.version}`),
    $("dl", {}, $("dt", {}, "模型"), $("dd", {}, base.model.name), $("dt", {}, "总调用上限"), $("dd", {}, `${base.execution.maxTurns} 次`),
      $("dt", {}, "输出上限"), $("dd", {}, `${base.execution.maxOutputTokens} 词元`), $("dt", {}, "最长执行"), $("dd", {}, `${base.execution.timeoutSeconds} 秒`)),
    $("hr"), $("p", { class: "small muted" }, "发布仅对当前租户授权，不改变租户默认智能体。模板、技能、步骤均按发布版本冻结。"),
    $("p", { class: "small muted" }, "不要在提示词或技能中放入密钥。草稿仅存在当前页面内存，离开或刷新会丢失。"));
  parent.append($("div", { class: "editor-layout" }, form, aside));
}
async function publish() {
  const error = validateDraft(state.draft, state.base); if (error) throw new Error(error);
  if (!await confirmAction(`发布「${state.draft.name}」v${state.draft.expectedVersion + 1}？本租户成员将可以使用这个版本。`)) return;
  const published = await api("/studio/agents", "POST", state.draft);
  state.dirty = false; state.draft = null; state.tab = published.workflow ? "workflows" : "agents"; await refresh(); notice(`已发布 ${published.name} · v${published.version}`);
}
async function skillLibrary(parent) {
  heading(parent, "SKILL LIBRARY", "把经验，变成可复用技能。", "从租户已授权定义中发现技能。自定义技能在智能体编辑页接入，并随版本一起发布。",
    button("+ 创建并接入技能", () => chooseTemplate(false), "button primary", !state.studio.canPublish));
  const grid = $("div", { class: "card-grid" }); parent.append(grid);
  const documents = await Promise.all(latestDefinitions(state.definitions).map(detail));
  if (!parent.isConnected) return;
  const skills = new Map();
  for (const document of documents) for (const skill of document.skills) {
    const key = JSON.stringify(skill); if (!skills.has(key)) skills.set(key, { skill, document });
  }
  for (const { skill, document } of skills.values()) grid.append($("article", { class: "definition-card" }, $("div", { class: "card-top" }, $("span", { class: "card-icon amber" }, "✦"), $("span", { class: "pill" }, "原生文本技能")),
    $("h2", {}, skill.name ?? skill.id), $("p", { class: "description" }, skill.description || "按需加载的技能指令"),
    $("div", { class: "tool-tags" }, $("span", {}, skill.invocation?.userInvocable === false ? "不可显式调用" : "/" + (skill.name ?? skill.id)), $("span", {}, skill.invocation?.modelInvocable === false ? "手动加载" : "模型可加载")),
    $("div", { class: "card-footer" }, $("span", { class: "small muted" }, document.name), button("查看所在智能体", () => editDefinition(document), "quiet"))));
  if (!skills.size) grid.append($("div", { class: "empty" }, "当前授权定义暂无技能。管理员可在智能体编辑页添加。"));
}
async function launch(item) {
  if (state.running) throw new Error("请先等待当前运行结束。");
  const session = await api("/sessions", "POST", { title: item.name + " · " + new Date().toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" }), definition: { id: item.id, version: item.version } }, crypto.randomUUID());
  state.sessions.unshift(session); await openSession(session);
}
async function openSession(session) {
  if (state.running) throw new Error("当前有运行中的会话，请先完成或取消。");
  if (state.dirty && !await confirmAction("离开会丢弃未发布修改。继续？")) return;
  state.draft = null; state.dirty = false; state.session = session; state.tab = "chat"; state.preview = ""; state.progress = ""; state.steps = []; state.runId = null; state.pending = null; state.unsent = "";
  await loadHistory(); render();
  const runs = await api(`/runs?sessionId=${session.id}&limit=100`);
  const active = runs.items.find(run => ["queued", "running"].includes(run.state));
  if (active) { state.runId = active.id; state.pending = { id: active.messageId }; state.running = true; state.progress = "正在恢复运行状态"; render(); watch(); }
}
async function loadHistory() {
  const messages = []; let after;
  do {
    const page = await api(`/sessions/${state.session.id}/history?limit=100${after ? "&after=" + after : ""}`); messages.push(...page.items); after = page.nextCursor;
  } while (after);
  state.messages = messages;
}
function chat(parent) {
  heading(parent, "PLAYGROUND", state.session?.title ?? "与智能体对话", state.session ? `固定定义：${state.session.agentDefinitionId} · v${state.session.agentDefinitionVersion}` : "从智能体或工作流卡片点击“运行”，即可开始。",
    state.running && state.runId ? button("取消运行", async () => { await api(`/runs/${state.runId}/cancel`, "POST"); state.progress = "已请求取消，等待服务端终态"; updateChat(); }, "button danger") : null);
  if (!state.session) { parent.append($("div", { class: "empty" }, "选一个智能体，开启第一轮对话。", button("浏览智能体", () => go("agents"), "button primary"))); return; }
  const transcript = $("div", { class: "transcript", id: "transcript", role: "log", "aria-label": "会话消息" });
  const composer = $("form", { class: "composer" });
  const input = $("textarea", { id: "message-input", rows: 3, placeholder: "描述你的任务，或输入 /技能名…", maxlength: 32000, "aria-label": "消息内容", disabled: state.running });
  input.value = state.unsent ?? "";
  input.addEventListener("input", () => state.unsent = input.value);
  const submit = $("button", { class: "button primary", type: "submit", disabled: state.running }, state.running ? "正在执行…" : "发送 ↑");
  composer.append(input, $("div", { class: "composer-footer" }, $("span", { class: "small muted" }, "技能和工作流由 DSH 执行 · 工具权限由平台校验"), submit));
  composer.addEventListener("submit", event => { event.preventDefault(); safely(() => send(input.value)); });
  parent.append($("div", { class: "chat-layout" }, $("div", {}, transcript, composer), $("aside", { class: "panel run-panel" }, $("h3", {}, "执行状态"), $("div", { id: "run-status", role: "status" }), $("div", { id: "workflow-steps" }))));
  updateChat();
}
function updateChat() {
  const transcript = document.querySelector("#transcript"); if (!transcript) return;
  transcript.replaceChildren(...state.messages.map(message => $("article", { class: "message " + message.role }, $("div", { class: "message-author" }, message.role === "user" ? "你" : "DSH 智能体"), $("div", { class: "message-content" }, message.content))));
  if (state.running) transcript.append($("article", { class: "message assistant" }, $("div", { class: "message-author" }, $("span", { class: "live-dot" }), "DSH 智能体"),
    $("div", { class: "message-content" }, state.preview || state.progress || "任务已接收，等待执行…"), $("small", { class: "muted" }, "预览可能变化，以最终回答为准。")));
  if (!state.messages.length && !state.running) transcript.append($("div", { class: "chat-empty" }, $("span", { class: "card-icon" }, "◈"), $("h2", {}, "准备就绪"), $("p", { class: "muted" }, "发送任务后，这里会实时显示状态与回答。")));
  document.querySelector("#run-status").textContent = state.progress || "等待输入";
  const labels = { pending: "等待", running: "进行中", succeeded: "完成", skipped: "已跳过", interrupted: "已中断" };
  document.querySelector("#workflow-steps").replaceChildren(...state.steps.map(step => $("div", { class: "step-status" }, $("strong", {}, step.id), $("span", { class: "pill" }, labels[step.state] ?? step.state))));
  transcript.scrollTop = transcript.scrollHeight;
}
async function send(content) {
  if (!content.trim() || state.running || state.sending) return;
  // Reuse the request key after an ambiguous network failure; never silently duplicate a submitted message.
  if (!state.retryMessage || state.retryMessage.content !== content || state.retryMessage.session !== state.session.id)
    state.retryMessage = { content, session: state.session.id, key: crypto.randomUUID() };
  state.sending = true;
  const sendButton = document.querySelector('.composer button[type="submit"]');
  if (sendButton) { sendButton.disabled = true; sendButton.textContent = "正在提交…"; }
  let pending;
  try { pending = await api(`/sessions/${state.session.id}/messages`, "POST", { content }, state.retryMessage.key); }
  finally { state.sending = false; if (sendButton) { sendButton.disabled = false; sendButton.textContent = "发送 ↑"; } }
  state.pending = pending; state.retryMessage = null; state.unsent = ""; state.running = true; state.runId = null; state.preview = ""; state.steps = []; state.progress = "任务已接收，正在排队";
  if (!state.messages.some(message => message.id === pending.id)) state.messages.push(pending);
  render(); watch();
}
function watch() {
  streamStop?.abort(); clearTimeout(pollTimer); streamStop = new AbortController(); const signal = streamStop.signal;
  const sessionId = state.session.id, messageId = state.pending.id;
  let cursor, retries = 0;
  const isCurrent = () => !signal.aborted && state.session?.id === sessionId && state.pending?.id === messageId;
  async function finish(run) {
    if (!isCurrent()) return;
    state.running = false; state.progress = run.state === "succeeded" ? "执行完成" : run.state === "canceled" ? "已取消" : `执行失败：${run.failureCode ?? "未知原因"}`;
    streamStop.abort(); clearTimeout(pollTimer);
    if (run.output && !state.messages.some(message => message.replyToMessageId === messageId)) state.messages.push({ role: "assistant", content: run.output, replyToMessageId: messageId });
    try { const wf = await api(`/runs/${run.id}/workflow`); state.steps = wf.steps; } catch { /* status is already authoritative */ }
    render();
  }
  async function poll() {
    if (!isCurrent()) return;
    try {
      const runs = await api(`/runs?sessionId=${sessionId}&limit=100`), run = runs.items.find(value => value.messageId === messageId);
      if (run) {
        const newlyIdentified = !state.runId; state.runId = run.id;
        if (["succeeded", "failed", "canceled"].includes(run.state)) { await finish(run); return; }
        state.steps = (await api(`/runs/${run.id}/workflow`)).steps;
        if (newlyIdentified) render(); else updateChat();
      }
    } catch { if (isCurrent()) { state.progress = "连接暂不可用，正在恢复；任务可能仍在执行"; updateChat(); } }
    if (isCurrent()) pollTimer = setTimeout(poll, 3000);
  }
  safely(async () => {
    while (isCurrent()) {
      try {
        const capability = await api(`/sessions/${sessionId}/subscription`, "POST");
        const response = await fetch(`/events/v1/sessions/${sessionId}`, { headers: { authorization: "Bearer " + await token(), "x-session-capability": capability.token,
          ...(cursor ? { "last-event-id": cursor } : {}) }, signal });
        if (response.status === 409) { cursor = undefined; await response.body?.cancel(); throw new Error("事件游标已过期"); }
        if (!response.ok) { await response.body?.cancel(); throw new Error("事件连接失败"); }
        retries = 0; const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
        try {
          while (isCurrent()) {
            const part = await reader.read(); if (part.done) break; buffer += decoder.decode(part.value, { stream: true });
            if (buffer.length > 1024 * 1024) throw new Error("事件帧超出限制");
            const parsed = parseFrames(buffer); buffer = parsed.buffer;
            for (const frame of parsed.frames) {
              cursor = frame.id ?? cursor; const event = frame.event, payload = event.payload;
              if (payload?.messageId !== messageId) continue;
              if (payload.runId) state.runId = payload.runId;
              if (event.eventType === "run.status.v1") state.progress = payload.phase === "workflow" ? `步骤 ${payload.stepId} · ${payload.stepState}` : (phaseNames[payload.phase] ?? payload.phase) + (payload.tool ? ` · ${toolNames[payload.tool] ?? payload.tool}` : "");
              if (event.eventType === "run.output.preview.v1" || event.eventType === "run.output.snapshot.v1") state.preview = payload.text ?? "";
              updateChat();
            }
          }
        } finally { await reader.cancel().catch(() => {}); }
      } catch {
        if (!isCurrent()) return;
        state.progress = "事件连接重连中，后台任务继续执行"; updateChat();
      }
      if (isCurrent()) await new Promise(resolve => setTimeout(resolve, Math.min(1000 * 2 ** retries++, 10000)));
    }
  });
  void poll();
}
window.addEventListener("beforeunload", event => { if (state.dirty) { event.preventDefault(); event.returnValue = ""; } });
await safely(async () => {
  config = await (await fetch("/config")).json();
  if (location.pathname === "/callback") {
    const params = new URLSearchParams(location.search), saved = JSON.parse(sessionStorage.getItem("dsh-login") ?? "null");
    sessionStorage.removeItem("dsh-login"); history.replaceState(null, "", "/");
    if (!saved || Date.now() - saved.at > 600000 || params.get("state") !== saved.state || !params.get("code")) throw new Error("登录状态校验失败，请重新登录。");
    const epoch = authEpoch; await exchange({ grant_type: "authorization_code", code: params.get("code"), code_verifier: saved.verifier, redirect_uri: config.redirectUri });
    if (epoch === authEpoch) await refresh();
  }
});
render();
