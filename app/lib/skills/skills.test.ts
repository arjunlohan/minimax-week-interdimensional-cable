import { describe, expect, it } from "vitest";

import { isKnownVoiceId, MINIMAX_VOICES } from "@/app/lib/gmi/voices";

import { apocalypticSatireSkill } from "./apocalyptic-satire";
import { ARCHETYPE_A_STANDARD_ACTS, calculateClipWordBudgets } from "./archetype-a";
import { closerLookSkill } from "./closer-look";
import {
  dbTemplateToSkill,
  getAllSkillsAsDbTemplates,
  skillToDbTemplate,
} from "./db-adapter";
import {
  assertLicensedMinimaxVoice,
  generateSatiricalDisclaimer,
  isLicensedMinimaxVoice,
  LICENSED_MINIMAX_TTS_VOICES,
  resolveHostTtsVoice,
  sanitizePromptForLegalSafety,
  validateSkillLegalGuardrails,
} from "./guardrails";
import { investigativeDeskSkill } from "./investigative-desk";
import {
  getDefaultShowSkill,
  getShowSkill,
  getShowSkillsByArchetype,
  listShowSkills,
  registerSkill,
  resolveSkillForShow,
  SHOW_SKILL_REGISTRY,
  validateSkill,
} from "./registry";
import { satiricalNewsSkill } from "./satirical-news";
import {
  HostSkillConfigSchema,
  LaughPerMinuteTargetSchema,
  PodcastDynamicsSchema,
  ShowSkillSchema,
} from "./schemas";
import { speculativePodcastSkill } from "./speculative-podcast";
import type { ShowSkill } from "./types";
import { varietyMonologueSkill } from "./variety-monologue";

describe("two-Archetype Modular Show SKILL Engine", () => {
  const allSkills: ShowSkill[] = [
    investigativeDeskSkill,
    closerLookSkill,
    satiricalNewsSkill,
    varietyMonologueSkill,
    speculativePodcastSkill,
    apocalypticSatireSkill,
  ];

  const archetypeASkills: ShowSkill[] = [
    investigativeDeskSkill,
    closerLookSkill,
    satiricalNewsSkill,
    varietyMonologueSkill,
  ];

  const archetypeBSkills: ShowSkill[] = [
    speculativePodcastSkill,
    apocalypticSatireSkill,
  ];

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Master Schema & Contract Validation
  // ───────────────────────────────────────────────────────────────────────────
  describe("zod Schema Validation", () => {
    it("validates all 6 production Show SKILLs against ShowSkillSchema", () => {
      for (const skill of allSkills) {
        const result = ShowSkillSchema.safeParse(skill);
        expect(result.success, `Skill validation failed for ${skill.id}`).toBe(true);
      }
    });

    it("validates that all skills contain valid host configurations", () => {
      for (const skill of allSkills) {
        expect(skill.hosts.length).toBeGreaterThanOrEqual(1);
        for (const host of skill.hosts) {
          const result = HostSkillConfigSchema.safeParse(host);
          expect(result.success, `Host validation failed for ${host.name}`).toBe(true);
          expect(host.personaCraft.length).toBeGreaterThanOrEqual(15);
        }
      }
    });

    it("rejects malformed show skills missing required fields", () => {
      const invalidSkill = {
        id: "invalid-skill",
        name: "Invalid",
        // missing archetype, rhetoricalSpine, hosts, etc.
      };
      const result = ShowSkillSchema.safeParse(invalidSkill);
      expect(result.success).toBe(false);
    });

    it("validates LaughPerMinuteTargetSchema bounds", () => {
      expect(LaughPerMinuteTargetSchema.safeParse({ min: 3.5, max: 4.8 }).success).toBe(true);
      expect(LaughPerMinuteTargetSchema.safeParse({ min: 0.5, max: 15.0 }).success).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Archetype A: Writers'-Room Desk Shows
  // ───────────────────────────────────────────────────────────────────────────
  describe("archetype A (Writers'-Room Desk Shows)", () => {
    it("enforces 3-act rhetorical spines with sum of fractions equal to 1.0", () => {
      for (const skill of archetypeASkills) {
        expect(skill.archetype).toBe("writers_room_desk");
        expect(skill.rhetoricalSpine.acts.length).toBe(3);

        const fractionSum = skill.rhetoricalSpine.acts.reduce(
          (sum, act) => sum + act.targetDurationFraction,
          0,
        );
        expect(fractionSum).toBeCloseTo(1.0, 2);
      }
    });

    it("verifies standard acts contain required comedic formulas", () => {
      expect(ARCHETYPE_A_STANDARD_ACTS.length).toBe(3);
      expect(ARCHETYPE_A_STANDARD_ACTS[0].id).toBe("act_1_thesis_hook");
      expect(ARCHETYPE_A_STANDARD_ACTS[1].id).toBe("act_2_evidence_analogies");
      expect(ARCHETYPE_A_STANDARD_ACTS[2].id).toBe("act_3_synthesis_cta");

      for (const act of ARCHETYPE_A_STANDARD_ACTS) {
        expect(act.comedicFormulas.length).toBeGreaterThanOrEqual(2);
        expect(act.promptGuidance.length).toBeGreaterThan(20);
      }
    });

    it("enforces characteristic Laughs-Per-Minute (LPM) ranges for desk formats", () => {
      // Oliver style: deep dive outrage (~4.2 LPM)
      expect(investigativeDeskSkill.rhetoricalSpine.laughPerMinuteTarget.min).toBe(3.5);
      expect(investigativeDeskSkill.rhetoricalSpine.laughPerMinuteTarget.max).toBe(4.8);

      // Meyers style: surgical snark (~5.0 LPM)
      expect(closerLookSkill.rhetoricalSpine.laughPerMinuteTarget.min).toBe(4.5);
      expect(closerLookSkill.rhetoricalSpine.laughPerMinuteTarget.max).toBe(5.8);

      // Satirical News Desk: dual-anchor punchlines (~5.5 LPM)
      expect(satiricalNewsSkill.rhetoricalSpine.laughPerMinuteTarget.min).toBe(5.0);
      expect(satiricalNewsSkill.rhetoricalSpine.laughPerMinuteTarget.max).toBe(6.5);

      // Variety Monologue: broad pop puns (~4.5 LPM)
      expect(varietyMonologueSkill.rhetoricalSpine.laughPerMinuteTarget.min).toBe(4.2);
      expect(varietyMonologueSkill.rhetoricalSpine.laughPerMinuteTarget.max).toBe(5.5);
    });

    it("calculates accurate clip word budgets across 8s to 40s runtimes", () => {
      // 8s show -> 1 clip (17-23 words)
      const budgets8s = calculateClipWordBudgets(8, investigativeDeskSkill, 8);
      expect(budgets8s.length).toBe(1);
      expect(budgets8s[0].targetWordsMin).toBeGreaterThanOrEqual(15);
      expect(budgets8s[0].targetWordsMax).toBeLessThanOrEqual(25);

      // 40s show -> 5 clips (8s each)
      const budgets40s = calculateClipWordBudgets(40, investigativeDeskSkill, 8);
      expect(budgets40s.length).toBe(5);
      expect(budgets40s[0].assignedActId).toBe("act_1_thesis_hook");
      expect(budgets40s[2].assignedActId).toBe("act_2_evidence_analogies");
      expect(budgets40s[4].assignedActId).toBe("act_3_synthesis_cta");

      const totalDuration = budgets40s.reduce((sum, b) => sum + b.durationSeconds, 0);
      expect(totalDuration).toBe(40);
    });

    it("enforces end_of_sentence punchline position rule for all desk skills", () => {
      for (const skill of archetypeASkills) {
        expect(skill.voiceMechanics.punchlinePositionRule).toBe("end_of_sentence");
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Archetype B: Conversational Long-Form Podcasts
  // ───────────────────────────────────────────────────────────────────────────
  describe("archetype B (Conversational Long-Form Podcasts)", () => {
    it("validates podcast dynamics and talking point trees for podcast skills", () => {
      for (const skill of archetypeBSkills) {
        expect(skill.archetype).toBe("conversational_podcast");
        expect(skill.podcastDynamics).toBeDefined();

        const parsed = PodcastDynamicsSchema.safeParse(skill.podcastDynamics);
        expect(parsed.success).toBe(true);

        const tree = skill.podcastDynamics!.talkingPointTree;
        expect(tree.length).toBeGreaterThanOrEqual(2);
        for (const node of tree) {
          expect(node.id).toBeDefined();
          expect(node.associativeKeywords.length).toBeGreaterThan(0);
        }
      }
    });

    it("verifies dynamic tangent drift configuration and snapback phrases", () => {
      // Rogan style
      const roganDrift = speculativePodcastSkill.podcastDynamics!.driftConfig;
      expect(roganDrift.driftProbability).toBeGreaterThanOrEqual(0.6);
      expect(roganDrift.maxDriftDepthTurns).toBe(4);
      expect(roganDrift.snapbackPhrases.length).toBeGreaterThanOrEqual(3);
      expect(roganDrift.snapbackPhrases.some(p => p.includes("Jamie") || p.includes("how did we get here"))).toBe(true);

      // Dillon style
      const dillonDrift = apocalypticSatireSkill.podcastDynamics!.driftConfig;
      expect(dillonDrift.driftProbability).toBeGreaterThanOrEqual(0.75);
      expect(dillonDrift.maxDriftDepthTurns).toBe(5);
      expect(dillonDrift.snapbackPhrases.some(p => p.includes("fake business") || p.includes("Western civilization"))).toBe(true);
    });

    it("verifies acoustic tag sets contain expressive stage directions for Speech 2.8 HD", () => {
      for (const skill of archetypeBSkills) {
        const tags = skill.podcastDynamics!.acousticTagSet;
        expect(tags).toContain("[laughs]");
        expect(tags).toContain("[chuckles]");
        expect(tags).toContain("[sighs]");
        expect(tags).toContain("[incredulous]");
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Stylometric Vectors & Computational Humor Mechanics
  // ───────────────────────────────────────────────────────────────────────────
  describe("stylometric Vectors & Computational Humor Mechanics", () => {
    it("validates outrage-to-affability ratios match intended comedic archetypes", () => {
      // Oliver: high righteous outrage (0.85)
      expect(investigativeDeskSkill.voiceMechanics.outrageAffabilityRatio).toBe(0.85);

      // Fallon: pure affability (0.05)
      expect(varietyMonologueSkill.voiceMechanics.outrageAffabilityRatio).toBe(0.05);

      // Meyers: cerebral snark balance (0.45)
      expect(closerLookSkill.voiceMechanics.outrageAffabilityRatio).toBe(0.45);

      // Rogan: earnest curiosity / high affability (0.20)
      expect(speculativePodcastSkill.voiceMechanics.outrageAffabilityRatio).toBe(0.2);

      // Dillon: manic satirical outrage (0.92)
      expect(apocalypticSatireSkill.voiceMechanics.outrageAffabilityRatio).toBe(0.92);
    });

    it("validates mean sentence length stylometrics", () => {
      // Staccato newsdesk cadences
      expect(satiricalNewsSkill.voiceMechanics.meanSentenceLengthWords).toBeLessThanOrEqual(13.5);
      expect(closerLookSkill.voiceMechanics.meanSentenceLengthWords).toBeLessThanOrEqual(14.0);

      // Rolling breathless diatribes
      expect(investigativeDeskSkill.voiceMechanics.meanSentenceLengthWords).toBeGreaterThan(16.0);
      expect(apocalypticSatireSkill.voiceMechanics.meanSentenceLengthWords).toBeGreaterThan(20.0);
    });

    it("validates profanity registers across genres", () => {
      expect(closerLookSkill.voiceMechanics.profanityRegister).toBe("clean");
      expect(varietyMonologueSkill.voiceMechanics.profanityRegister).toBe("clean");
      expect(investigativeDeskSkill.voiceMechanics.profanityRegister).toBe("mild");
      expect(satiricalNewsSkill.voiceMechanics.profanityRegister).toBe("mild");
      expect(speculativePodcastSkill.voiceMechanics.profanityRegister).toBe("frequent");
      expect(apocalypticSatireSkill.voiceMechanics.profanityRegister).toBe("explicit");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Legal & Identity Guardrails & Licensed TTS Voices
  // ───────────────────────────────────────────────────────────────────────────
  describe("legal & Identity Guardrails & Licensed TTS Voices", () => {
    it("ensures every host across all skills maps strictly to a licensed MiniMax voice", () => {
      for (const skill of allSkills) {
        for (const host of skill.hosts) {
          expect(
            isLicensedMinimaxVoice(host.ttsVoice),
            `Host ${host.name} in ${skill.id} uses unlicensed voice ${host.ttsVoice}`,
          ).toBe(true);
          expect(LICENSED_MINIMAX_TTS_VOICES).toContain(host.ttsVoice);
        }
      }
    });

    it("assertLicensedMinimaxVoice throws descriptive error for unlicensed voices", () => {
      expect(() => assertLicensedMinimaxVoice("English_magnetic_voiced_man")).not.toThrow();
      expect(() => assertLicensedMinimaxVoice("English_Aussie_Bloke")).not.toThrow();
      expect(() => assertLicensedMinimaxVoice("InvalidVoice123", "TestHost")).toThrow(/Illegal or unlicensed TTS voice/);
    });

    it("resolveHostTtsVoice returns fallback when voice is unapproved", () => {
      expect(resolveHostTtsVoice("English_magnetic_voiced_man")).toBe("English_magnetic_voiced_man");
      expect(resolveHostTtsVoice("UnknownVoice", "English_Aussie_Bloke")).toBe("English_Aussie_Bloke");
      expect(resolveHostTtsVoice(undefined, "English_Persuasive_Man")).toBe("English_Persuasive_Man");
    });

    it("resolves voice names stored before the MiniMax migration to their catalog equivalents", () => {
      expect(resolveHostTtsVoice("Charon")).toBe("English_magnetic_voiced_man");
      expect(resolveHostTtsVoice("Aoede")).toBe("English_Upbeat_Woman");
      // Only catalog ids are licensed; legacy names must be resolved first.
      expect(isLicensedMinimaxVoice("Charon")).toBe(false);
    });

    it("licenses exactly the MiniMax Speech 2.8 HD voice catalog", () => {
      expect([...LICENSED_MINIMAX_TTS_VOICES].sort()).toEqual(MINIMAX_VOICES.map(v => v.id).sort());
      for (const voice of LICENSED_MINIMAX_TTS_VOICES) {
        expect(isKnownVoiceId(voice)).toBe(true);
      }
    });

    it("generates legally compliant satirical disclaimers", () => {
      const disclaimer = generateSatiricalDisclaimer(investigativeDeskSkill, "AI Regulation");
      expect(disclaimer).toContain("Interdimensional Cable AI Comedy Orchestrator");
      expect(disclaimer).toContain("original satirical parody");
      expect(disclaimer).toContain("licensed MiniMax Speech 2.8 HD");
      expect(disclaimer).toContain("Not affiliated with or endorsed by");
    });

    it("sanitizes prompts by stripping network trademarks and biometric deepfake directives", () => {
      const dirtyPrompt = "Create an HBO style deepfake of John Oliver to clone the exact voice of the host.";
      const sanitized = sanitizePromptForLegalSafety(dirtyPrompt);

      expect(sanitized).not.toContain("HBO");
      expect(sanitized).toContain("premium cable broadcast");
      expect(sanitized).not.toContain("deepfake");
      expect(sanitized).toContain("stylized satirical caricature");
      expect(sanitized).not.toContain("clone the exact voice of");
    });

    it("passes validateSkillLegalGuardrails for all registered skills", () => {
      for (const skill of allSkills) {
        const validation = validateSkillLegalGuardrails(skill);
        expect(validation.valid, `Skill ${skill.id} failed guardrails: ${validation.errors.join("; ")}`).toBe(true);
        expect(validation.errors.length).toBe(0);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Central Registry & Smart Resolution
  // ───────────────────────────────────────────────────────────────────────────
  describe("central Registry & Smart Resolution", () => {
    it("indexes all 7 skills in SHOW_SKILL_REGISTRY", () => {
      expect(Object.keys(SHOW_SKILL_REGISTRY).length).toBe(7);
      expect(listShowSkills().length).toBe(7);
    });

    it("looks up skills by ID, slug, and alias", () => {
      expect(getShowSkill("investigative-desk")?.id).toBe("investigative-desk");
      expect(getShowSkill("closer-look")?.id).toBe("closer-look");
      expect(getShowSkill("satirical-news")?.id).toBe("satirical-news-desk");
      expect(getShowSkill("speculative-podcast")?.id).toBe("podcast-speculative-wonder");
      expect(getShowSkill("apocalyptic-satire")?.id).toBe("podcast-apocalyptic-satire");
      expect(getShowSkill("venture-panel")?.id).toBe("panel-venture-roundtable");
      // Real-person aliases were removed deliberately.
      expect(getShowSkill("john-oliver")).toBeUndefined();
      expect(getShowSkill("joe-rogan")).toBeUndefined();
    });

    it("filters skills by archetype", () => {
      const deskSkills = getShowSkillsByArchetype("writers_room_desk");
      expect(deskSkills.length).toBe(4);

      const podcastSkills = getShowSkillsByArchetype("conversational_podcast");
      expect(podcastSkills.length).toBe(3);
    });

    it("resolves default skills correctly", () => {
      const globalDefault = getDefaultShowSkill();
      expect(globalDefault.isDefault).toBe(true);

      const podcastDefault = getDefaultShowSkill("conversational_podcast");
      expect(podcastDefault.archetype).toBe("conversational_podcast");
    });

    it("resolves skills via fuzzy query and smart fallbacks", () => {
      expect(resolveSkillForShow("podcast").archetype).toBe("conversational_podcast");
      expect(resolveSkillForShow("desk").archetype).toBe("writers_room_desk");
      expect(resolveSkillForShow("Colin Jest").id).toBe("satirical-news-desk");
      expect(resolveSkillForShow("Tim Dillon Like").id).toBe("podcast-apocalyptic-satire");
      expect(resolveSkillForShow("random-nonexistent-query")).toBeDefined();
    });

    it("registers and validates dynamic skills", () => {
      const customSkill: ShowSkill = {
        ...closerLookSkill,
        id: "custom-test-skill",
        slug: "custom-test",
        name: "Custom Test Show",
      };

      registerSkill(customSkill);
      expect(getShowSkill("custom-test-skill")?.name).toBe("Custom Test Show");
      expect(validateSkill(customSkill).id).toBe("custom-test-skill");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 7. Database Adapter & Seeding Parity
  // ───────────────────────────────────────────────────────────────────────────
  describe("database Adapter & Seeding Parity", () => {
    it("converts ShowSkill to NewShowTemplate and reconstitutes back to ShowSkill", () => {
      const dbTemplate = skillToDbTemplate(investigativeDeskSkill);
      expect(dbTemplate.name).toBe(investigativeDeskSkill.name);
      expect(dbTemplate.showType).toBe("monologue");
      expect(Array.isArray(dbTemplate.hosts)).toBe(true);

      const reconstituted = dbTemplateToSkill(dbTemplate);
      expect(reconstituted.id).toBe(investigativeDeskSkill.id);
      expect(reconstituted.archetype).toBe("writers_room_desk");
      expect(reconstituted.rhetoricalSpine.acts.length).toBe(3);
    });

    it("normalises the voice on a stored template: legacy names resolve, junk falls back to the base host", () => {
      const template = skillToDbTemplate(closerLookSkill);
      const [host] = template.hosts as Array<Record<string, unknown>>;

      const legacy = dbTemplateToSkill({ ...template, hosts: [{ ...host, ttsVoice: "Orus" }] });
      expect(legacy.hosts[0].ttsVoice).toBe("English_Persuasive_Man");

      const junk = dbTemplateToSkill({ ...template, hosts: [{ ...host, ttsVoice: "Morgan Freeman" }] });
      expect(junk.hosts[0].ttsVoice).toBe(closerLookSkill.hosts[0].ttsVoice);
    });

    it("returns database templates for all registered skills via getAllSkillsAsDbTemplates", () => {
      const templates = getAllSkillsAsDbTemplates();
      expect(templates.length).toBeGreaterThanOrEqual(6);
      for (const t of templates) {
        expect(t.name).toBeDefined();
        expect(t.showType).toMatch(/monologue|conversation/);
        expect(Array.isArray(t.hosts)).toBe(true);
      }
    });
  });
});
