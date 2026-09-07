import type { NewShowTemplate, ShowTemplate } from "@/db/schema";

import { DEFAULT_HOST_VOICE, resolveHostTtsVoice } from "./guardrails";
import { listShowSkills, resolveSkillForShow } from "./registry";
import type { HostSkillConfig, ShowSkill } from "./types";

/**
 * Serializes a domain ShowSkill into a Drizzle database showTemplates insert record.
 */
export function skillToDbTemplate(skill: ShowSkill): NewShowTemplate {
  return {
    name: skill.name,
    showType: skill.showType,
    referenceImageUrl: skill.referenceImageUrl ?? null,
    hosts: skill.hosts.map(h => ({
      name: h.name,
      role: h.role,
      position: h.position,
      ttsVoice: h.ttsVoice,
      personaCraft: h.personaCraft,
      personality: h.personality ?? h.personaCraft,
      catchphrases: h.catchphrases,
      speakingRateWpm: h.speakingRateWpm,
    })),
    notes: skill.notes ?? skill.description,
    isDefault: skill.isDefault ?? false,
    displayOrder: skill.displayOrder ?? 100,
  };
}

/**
 * Reconstitutes a full domain ShowSkill from a database ShowTemplate record.
 * Uses the ShowSkillRegistry to look up base rhetorical spines, voice vectors,
 * and tangent configs, then overlays any template-level customizations.
 */
export function dbTemplateToSkill(template: ShowTemplate | NewShowTemplate): ShowSkill {
  const baseSkill = resolveSkillForShow(template.name);

  // Parse hosts safely from jsonb
  const rawHosts = Array.isArray(template.hosts) ? template.hosts : [];
  const reconstitutedHosts: HostSkillConfig[] = rawHosts.map((raw: any, index: number) => {
    const baseHost = baseSkill.hosts[index] ?? baseSkill.hosts[0];
    return {
      name: raw.name ?? baseHost.name,
      role: raw.role ?? baseHost.role ?? "anchor",
      position: raw.position ?? baseHost.position ?? "center",
      // Templates saved before the MiniMax migration may still carry a legacy
      // voice name; resolving it here keeps those rows validating and voiced.
      ttsVoice: resolveHostTtsVoice(raw.ttsVoice, baseHost.ttsVoice ?? DEFAULT_HOST_VOICE),
      personaCraft: raw.personaCraft ?? raw.personality ?? baseHost.personaCraft,
      personality: raw.personality ?? raw.personaCraft ?? baseHost.personality,
      catchphrases: Array.isArray(raw.catchphrases) ? raw.catchphrases : (baseHost.catchphrases ?? []),
      speakingRateWpm: typeof raw.speakingRateWpm === "number" ? raw.speakingRateWpm : (baseHost.speakingRateWpm ?? 150),
    };
  });

  return {
    ...baseSkill,
    name: template.name,
    showType: (template.showType === "conversation" ? "conversation" : "monologue"),
    referenceImageUrl: template.referenceImageUrl ?? baseSkill.referenceImageUrl,
    hosts: reconstitutedHosts.length > 0 ? reconstitutedHosts : baseSkill.hosts,
    notes: template.notes ?? baseSkill.notes,
    isDefault: template.isDefault ?? baseSkill.isDefault,
  };
}

/**
 * Returns all registered default Show SKILLs as NewShowTemplate database records.
 * Used for seeding and migrations.
 */
export function getAllSkillsAsDbTemplates(): NewShowTemplate[] {
  return listShowSkills().map(skillToDbTemplate);
}
