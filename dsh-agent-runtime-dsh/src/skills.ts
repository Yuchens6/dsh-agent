import type { Context } from "@deepseek-ai/cordis";
import SkillRegistry from "@deepseek-ai/dsh-skill";
import * as ToolSkill from "@deepseek-ai/dsh-tool-skill";
import { AgentDefinition } from "@dsh-agent/contracts";

// Catalog supplies an authorized immutable snapshot, not a host directory or user plugin.
// Discovery, invocation policy, /name gestures, rendering and loading belong to DSH.
export async function installSkills(ctx: Context, skills: AgentDefinition["skills"]) {
  if (!skills.length) return;
  // Validate even direct in-process callers before DSH's first-wins registration.
  const approved = AgentDefinition.shape.skills.parse(skills);
  const names = approved.map(skill => skill.name ?? skill.id);
  if (new Set(names).size !== names.length || new Set(approved.map(s => s.id)).size !== approved.length) {
    throw new Error("Duplicate approved skill");
  }
  await ctx.plugin(SkillRegistry);
  for (const skill of approved) {
    ctx.effect(() => ctx.skills.register({
      name: skill.name ?? skill.id,
      description: skill.description ?? `Approved skill ${skill.name ?? skill.id}, version ${skill.version}. Load when requested by name.`,
      content: skill.instructions,
      source: "platform-catalog", provider: "platform-catalog",
      invocation: skill.invocation ?? { modelInvocable: true, userInvocable: true },
      resourceBase: { kind: "opaque", description: "Approved inline instructions only. No skill files, scripts, URLs or host directories are exposed. Workspace files remain subject to authorized workspace tools." },
    }));
  }
  await ctx.plugin(ToolSkill);
}
