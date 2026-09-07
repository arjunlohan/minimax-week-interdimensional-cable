import { describe, expect, it } from "vitest";

import { apocalypticSatireSkill } from "./apocalyptic-satire";
import { calculateClipWordBudgets } from "./archetype-a";
import { closerLookSkill } from "./closer-look";
import { dbTemplateToSkill, getAllSkillsAsDbTemplates, skillToDbTemplate } from "./db-adapter";
import {
  assertLicensedMinimaxVoice,
  generateSatiricalDisclaimer,
  LICENSED_MINIMAX_TTS_VOICES,
  sanitizePromptForLegalSafety,
  validateSkillLegalGuardrails,
} from "./guardrails";
import { investigativeDeskSkill } from "./investigative-desk";
import {
  getShowSkill,
  listShowSkills,
  registerSkill,
  resolveSkillForShow,
  validateSkill,
} from "./registry";
import { satiricalNewsSkill } from "./satirical-news";
import {
  HostSkillConfigSchema,
  LaughPerMinuteTargetSchema,
  RhetoricalActSchema,
  RhetoricalSpineSchema,
  VoiceMechanicsSchema,
} from "./schemas";
import { speculativePodcastSkill } from "./speculative-podcast";
import type { ShowSkill } from "./types";
import { varietyMonologueSkill } from "./variety-monologue";

describe("m1 empirical challenger: stress-testing Show SKILL engine", () => {
  const allSkills: ShowSkill[] = [
    investigativeDeskSkill,
    closerLookSkill,
    satiricalNewsSkill,
    varietyMonologueSkill,
    speculativePodcastSkill,
    apocalypticSatireSkill,
  ];

  // ───────────────────────────────────────────────────────────────────────────
  // Suite 1: Zod Schema Validation & Boundary Stress
  // ───────────────────────────────────────────────────────────────────────────
  describe("suite 1: zod schema boundary & rejection stress", () => {
    it("rejects negative LPM values", () => {
      expect(LaughPerMinuteTargetSchema.safeParse({ min: -1.0, max: 4.0 }).success).toBe(false);
      expect(LaughPerMinuteTargetSchema.safeParse({ min: 3.0, max: -5.0 }).success).toBe(false);
      expect(LaughPerMinuteTargetSchema.safeParse({ min: 0.0, max: 0.0 }).success).toBe(false);
      expect(LaughPerMinuteTargetSchema.safeParse({ min: 0.99, max: 5.0 }).success).toBe(false);
      expect(LaughPerMinuteTargetSchema.safeParse({ min: 1.0, max: 12.0 }).success).toBe(true);
      expect(LaughPerMinuteTargetSchema.safeParse({ min: 1.0, max: 12.1 }).success).toBe(false);
    });

    it("rejects invalid voice identifiers in HostSkillConfigSchema", () => {
      const invalidVoices = [
        "Morgan Freeman",
        "Siri",
        "Alexa",
        "ElevenLabs_Rachel",
        "CustomVoice_1",
        "",
        "english_magnetic_voiced_man", // lowercase
        "ENGLISH_PERSUASIVE_MAN", // uppercase
        "Charon", // pre-migration name: the adapter resolves it, the schema does not accept it
      ];

      for (const invalidVoice of invalidVoices) {
        const result = HostSkillConfigSchema.safeParse({
          name: "Test Host",
          role: "anchor",
          position: "center",
          ttsVoice: invalidVoice,
          personaCraft: "A meticulously crafted satirical persona description with sufficient length.",
          speakingRateWpm: 150,
        });
        expect(result.success, `Voice "${invalidVoice}" should be rejected`).toBe(false);
      }
    });

    it("accepts all valid licensed voice identifiers in HostSkillConfigSchema", () => {
      for (const voice of LICENSED_MINIMAX_TTS_VOICES) {
        const result = HostSkillConfigSchema.safeParse({
          name: "Test Host",
          role: "anchor",
          position: "center",
          ttsVoice: voice,
          personaCraft: "A meticulously crafted satirical persona description with sufficient length.",
          speakingRateWpm: 150,
        });
        expect(result.success, `Valid voice "${voice}" failed parsing`).toBe(true);
      }
    });

    it("rejects missing or empty acts in RhetoricalSpineSchema", () => {
      const resultEmptyActs = RhetoricalSpineSchema.safeParse({
        acts: [],
        laughPerMinuteTarget: { min: 3.0, max: 5.0 },
        ruleOfThreeProbability: 0.8,
        callbackTargetCount: 2,
      });
      expect(resultEmptyActs.success).toBe(false);
    });

    it("rejects out-of-bounds speakingRateWpm in HostSkillConfigSchema", () => {
      const baseHost = {
        name: "Test Host",
        role: "anchor" as const,
        position: "center" as const,
        ttsVoice: "English_magnetic_voiced_man" as const,
        personaCraft: "Valid persona craft text over fifteen characters.",
      };

      expect(HostSkillConfigSchema.safeParse({ ...baseHost, speakingRateWpm: 79 }).success).toBe(false);
      expect(HostSkillConfigSchema.safeParse({ ...baseHost, speakingRateWpm: 80 }).success).toBe(true);
      expect(HostSkillConfigSchema.safeParse({ ...baseHost, speakingRateWpm: 240 }).success).toBe(true);
      expect(HostSkillConfigSchema.safeParse({ ...baseHost, speakingRateWpm: 241 }).success).toBe(false);
      expect(HostSkillConfigSchema.safeParse({ ...baseHost, speakingRateWpm: 150.5 }).success).toBe(false);
    });

    it("rejects out-of-bounds meanSentenceLengthWords in VoiceMechanicsSchema", () => {
      const baseMechanics = {
        profanityRegister: "mild" as const,
        outrageAffabilityRatio: 0.5,
        cynicismVsOptimismRatio: 0.5,
        punchlinePositionRule: "end_of_sentence" as const,
      };

      expect(VoiceMechanicsSchema.safeParse({ ...baseMechanics, meanSentenceLengthWords: 4.9 }).success).toBe(false);
      expect(VoiceMechanicsSchema.safeParse({ ...baseMechanics, meanSentenceLengthWords: 5.0 }).success).toBe(true);
      expect(VoiceMechanicsSchema.safeParse({ ...baseMechanics, meanSentenceLengthWords: 40.0 }).success).toBe(true);
      expect(VoiceMechanicsSchema.safeParse({ ...baseMechanics, meanSentenceLengthWords: 40.1 }).success).toBe(false);
    });

    it("rejects out-of-bounds ratios in VoiceMechanicsSchema", () => {
      const baseMechanics = {
        meanSentenceLengthWords: 15.0,
        profanityRegister: "clean" as const,
        cynicismVsOptimismRatio: 0.5,
        punchlinePositionRule: "end_of_sentence" as const,
      };

      expect(VoiceMechanicsSchema.safeParse({ ...baseMechanics, outrageAffabilityRatio: -0.01 }).success).toBe(false);
      expect(VoiceMechanicsSchema.safeParse({ ...baseMechanics, outrageAffabilityRatio: 1.01 }).success).toBe(false);
      expect(VoiceMechanicsSchema.safeParse({ ...baseMechanics, outrageAffabilityRatio: 0.0 }).success).toBe(true);
      expect(VoiceMechanicsSchema.safeParse({ ...baseMechanics, outrageAffabilityRatio: 1.0 }).success).toBe(true);
    });

    it("rejects invalid targetDurationFraction in RhetoricalActSchema", () => {
      const baseAct = {
        id: "act_test",
        name: "Test Act",
        purpose: "Valid purpose description for test act over ten characters.",
        comedicFormulas: ["formula_1"],
        promptGuidance: "Valid prompt guidance over ten characters long.",
      };

      expect(RhetoricalActSchema.safeParse({ ...baseAct, targetDurationFraction: 0.04 }).success).toBe(false);
      expect(RhetoricalActSchema.safeParse({ ...baseAct, targetDurationFraction: 0.05 }).success).toBe(true);
      expect(RhetoricalActSchema.safeParse({ ...baseAct, targetDurationFraction: 0.95 }).success).toBe(true);
      expect(RhetoricalActSchema.safeParse({ ...baseAct, targetDurationFraction: 0.96 }).success).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Suite 2: Registry Lookup Resilience & Edge Cases
  // ───────────────────────────────────────────────────────────────────────────
  describe("suite 2: registry lookup resilience & edge cases", () => {
    it("handles case-insensitive and whitespace-padded lookups in getShowSkill", () => {
      expect(getShowSkill("INVESTIGATIVE-DESK")?.id).toBe("investigative-desk");
      expect(getShowSkill("  closer-look  ")?.id).toBe("closer-look");
      expect(getShowSkill("InVeStIgAtIvE-DeSk")?.id).toBe("investigative-desk");
      expect(getShowSkill("  SATIRICAL-NEWS  ")?.id).toBe("satirical-news-desk");
      expect(getShowSkill("SPECULATIVE-PODCAST")?.id).toBe("podcast-speculative-wonder");
      expect(getShowSkill("APOCALYPTIC-SATIRE")?.id).toBe("podcast-apocalyptic-satire");
    });

    it("returns undefined for unknown or empty keys in getShowSkill", () => {
      expect(getShowSkill("")).toBeUndefined();
      expect(getShowSkill("unknown-skill-xyz-999")).toBeUndefined();
      expect(getShowSkill("non_existent_key")).toBeUndefined();
    });

    it("falls back gracefully in resolveSkillForShow under hostile inputs", () => {
      // Empty string -> global default (investigative desk)
      expect(resolveSkillForShow("").id).toBe("investigative-desk");
      expect(resolveSkillForShow(undefined).id).toBe("investigative-desk");

      // Whitespace
      expect(resolveSkillForShow("   ")).toBeDefined();

      // Gibberish / unknown -> global default
      expect(resolveSkillForShow("qwertyuiop_unknown_12345").id).toBe("investigative-desk");

      // Archetype shortcuts
      expect(resolveSkillForShow("writers_room_desk").archetype).toBe("writers_room_desk");
      expect(resolveSkillForShow("desk").archetype).toBe("writers_room_desk");
      expect(resolveSkillForShow("monologue").archetype).toBe("writers_room_desk");
      expect(resolveSkillForShow("conversational_podcast").archetype).toBe("conversational_podcast");
      expect(resolveSkillForShow("podcast").archetype).toBe("conversational_podcast");
      expect(resolveSkillForShow("conversation").archetype).toBe("conversational_podcast");

      // Substrings in names and hosts
      expect(resolveSkillForShow("Olive").id).toBe("investigative-desk");
      expect(resolveSkillForShow("Mires").id).toBe("closer-look");
      expect(resolveSkillForShow("Fallout").id).toBe("variety-monologue");
      expect(resolveSkillForShow("Michael Chey").id).toBe("satirical-news-desk");
      expect(resolveSkillForShow("Colin Jest").id).toBe("satirical-news-desk");
      expect(resolveSkillForShow("Brogan").id).toBe("podcast-speculative-wonder");
      expect(resolveSkillForShow("Trussed").id).toBe("podcast-speculative-wonder");
      expect(resolveSkillForShow("Villain").id).toBe("podcast-apocalyptic-satire");
    });

    it("dynamic registration and overwrite works as intended", () => {
      const dynamicSkill: ShowSkill = {
        ...investigativeDeskSkill,
        id: "dynamic-bench-skill",
        slug: "dynamic-bench",
        name: "Dynamic Bench Monologue",
        aliases: ["bench-test", "dynamic-mono"],
      };

      registerSkill(dynamicSkill);

      expect(getShowSkill("dynamic-bench-skill")?.name).toBe("Dynamic Bench Monologue");
      expect(getShowSkill("bench-test")?.name).toBe("Dynamic Bench Monologue");
      expect(resolveSkillForShow("dynamic-mono")?.name).toBe("Dynamic Bench Monologue");
      expect(validateSkill(dynamicSkill).id).toBe("dynamic-bench-skill");
    });

    it("rejects dynamic registration of malformed skills", () => {
      const malformedSkill = {
        id: "malformed-skill-1",
        name: "Malformed",
      } as any;

      expect(() => registerSkill(malformedSkill)).toThrow();
      expect(() => validateSkill(malformedSkill)).toThrow();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Suite 3: Legal Safety, Trademark Stripping & Guardrails
  // ───────────────────────────────────────────────────────────────────────────
  describe("suite 3: legal safety, trademark stripping & guardrails", () => {
    it("sanitizes studio trademarks across broadcast and streaming networks", () => {
      const testCases = [
        {
          expectedExclusion: "HBO",
          expectedInclusion: "premium cable broadcast",
          input: "Create an HBO exclusive investigative deep-dive.",
        },
        {
          expectedExclusion: "NBC",
          expectedInclusion: "late-night television network",
          input: "Produce an NBC late-night monologue in the style of Tonight Show.",
        },
        {
          expectedExclusion: "CBS",
          expectedInclusion: "broadcast television studio",
          input: "Broadcast on CBS and ABC with national coverage.",
        },
        {
          expectedExclusion: "Netflix",
          expectedInclusion: "streaming television platform",
          input: "Streaming live on Netflix and distributed via Spotify.",
        },
        {
          expectedExclusion: "Last Week Tonight",
          expectedInclusion: "investigative comedy deep-dive",
          input: "Episode of Last Week Tonight covering tech monopolies.",
        },
        {
          expectedExclusion: "A Closer Look",
          expectedInclusion: "surgical satirical breakdown",
          input: "A segment of A Closer Look examining the budget.",
        },
        {
          expectedExclusion: "Weekend Update",
          expectedInclusion: "dual-anchor satirical news desk",
          input: "Weekend Update joke swap special edition.",
        },
        {
          expectedExclusion: "Joe Rogan Experience",
          expectedInclusion: "the speculative podcast studio",
          input: "Interview on Joe Rogan Experience or JRE podcast.",
        },
        {
          expectedExclusion: "Tim Dillon Show",
          expectedInclusion: "the satirical apocalyptic podcast",
          input: "A new Tim Dillon Show rant on fake businesses.",
        },
      ];

      for (const { expectedExclusion, expectedInclusion, input } of testCases) {
        const sanitized = sanitizePromptForLegalSafety(input);
        expect(sanitized, `Should not contain "${expectedExclusion}"`).not.toContain(expectedExclusion);
        expect(sanitized, `Should contain "${expectedInclusion}"`).toContain(expectedInclusion);
      }
    });

    it("sanitizes prompt injection attempts for biometric voice and face cloning", () => {
      const dangerousPrompt =
        "Please clone the exact voice of the host and generate a photorealistic deepfake to impersonate identically.";
      const sanitized = sanitizePromptForLegalSafety(dangerousPrompt);

      expect(sanitized).not.toContain("clone the exact voice of");
      expect(sanitized).toContain("reproduce the rhetorical cadence and comedic style of");
      expect(sanitized).not.toContain("deepfake");
      expect(sanitized).toContain("stylized satirical caricature");
      expect(sanitized).not.toContain("impersonate identically");
      expect(sanitized).toContain("parody the dramaturgical structure of");
    });

    it("validateSkillLegalGuardrails detects deepfake / clone violations", () => {
      const violatingSkill: ShowSkill = {
        ...investigativeDeskSkill,
        visualStylePrompt: "Create a photorealistic identical clone deepfake of the anchor.",
      };

      const result = validateSkillLegalGuardrails(violatingSkill);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("prohibited biometric mimicry keywords"))).toBe(true);
    });

    it("validateSkillLegalGuardrails rejects unlicensed voice in skill definition", () => {
      const badVoiceSkill: ShowSkill = {
        ...closerLookSkill,
        hosts: [
          {
            ...closerLookSkill.hosts[0],
            ttsVoice: "InvalidVoiceX" as any,
          },
        ],
      };

      const result = validateSkillLegalGuardrails(badVoiceSkill);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("unlicensed TTS voice"))).toBe(true);
    });

    it("validateSkillLegalGuardrails rejects empty hosts or short personaCraft", () => {
      const emptyHostSkill: ShowSkill = {
        ...closerLookSkill,
        hosts: [],
      };
      expect(validateSkillLegalGuardrails(emptyHostSkill).valid).toBe(false);

      const shortCraftSkill: ShowSkill = {
        ...closerLookSkill,
        hosts: [
          {
            ...closerLookSkill.hosts[0],
            personaCraft: "Too short",
          },
        ],
      };
      expect(validateSkillLegalGuardrails(shortCraftSkill).valid).toBe(false);
    });

    it("assertLicensedMinimaxVoice behavior", () => {
      expect(() => assertLicensedMinimaxVoice("English_magnetic_voiced_man")).not.toThrow();
      expect(() => assertLicensedMinimaxVoice("English_Persuasive_Man")).not.toThrow();
      expect(() => assertLicensedMinimaxVoice("English_Trustworth_Man")).not.toThrow();
      expect(() => assertLicensedMinimaxVoice("English_Aussie_Bloke")).not.toThrow();
      expect(() => assertLicensedMinimaxVoice("English_Upbeat_Woman")).not.toThrow();
      expect(() => assertLicensedMinimaxVoice("English_Graceful_Lady")).not.toThrow();
      expect(() => assertLicensedMinimaxVoice("English_expressive_narrator")).not.toThrow();

      expect(() => assertLicensedMinimaxVoice("BannedVoice", "TestHost")).toThrowError(
        /Illegal or unlicensed TTS voice "BannedVoice" for host "TestHost"/,
      );
    });

    it("generateSatiricalDisclaimer includes First Amendment and AI synthesis notice", () => {
      const disclaimer = generateSatiricalDisclaimer("My Satirical News", "Cryptocurrency Crashes");
      expect(disclaimer).toContain("Interdimensional Cable AI Comedy Orchestrator (My Satirical News on \"Cryptocurrency Crashes\")");
      expect(disclaimer).toContain("original satirical parody and comedic commentary");
      expect(disclaimer).toContain("licensed MiniMax Speech 2.8 HD");
      expect(disclaimer).toContain("Not affiliated with or endorsed by any living individual or network");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Suite 4: Clip Word Budget & Timing Granularity Stress
  // ───────────────────────────────────────────────────────────────────────────
  describe("suite 4: clip word budget & timing granularity stress", () => {
    it("handles various total durations with 8-second granularity", () => {
      const testDurations = [8, 16, 24, 32, 40, 48, 80, 120];

      for (const dur of testDurations) {
        const budgets = calculateClipWordBudgets(dur, investigativeDeskSkill, 8);
        const expectedClips = dur / 8;
        expect(budgets.length).toBe(expectedClips);

        // Verify timing continuity
        let lastEnd = 0;
        for (let i = 0; i < budgets.length; i++) {
          expect(budgets[i].clipIndex).toBe(i);
          expect(budgets[i].startTimeSeconds).toBe(lastEnd);
          expect(budgets[i].endTimeSeconds).toBe(lastEnd + 8);
          expect(budgets[i].durationSeconds).toBe(8);
          expect(budgets[i].targetWordsMin).toBeGreaterThanOrEqual(15);
          expect(budgets[i].targetWordsMax).toBeLessThanOrEqual(25);
          expect(budgets[i].assignedActId).toBeDefined();
          lastEnd = budgets[i].endTimeSeconds;
        }
        expect(lastEnd).toBe(dur);
      }
    });

    it("handles non-multiples of 8s gracefully", () => {
      const budgets = calculateClipWordBudgets(35, investigativeDeskSkill, 8);
      // Math.ceil(35 / 8) = 5 clips (4 * 8s + 1 * 3s)
      expect(budgets.length).toBe(5);
      expect(budgets[4].startTimeSeconds).toBe(32);
      expect(budgets[4].endTimeSeconds).toBe(35);
      expect(budgets[4].durationSeconds).toBe(3);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Suite 5: Database Adapter Round-Trip & Resilience Stress
  // ───────────────────────────────────────────────────────────────────────────
  describe("suite 5: database adapter round-trip & resilience stress", () => {
    it("round-trips all 6 skills through DB adapter without data loss", () => {
      for (const skill of allSkills) {
        const dbTemplate = skillToDbTemplate(skill);
        const reconstituted = dbTemplateToSkill(dbTemplate);

        expect(reconstituted.id).toBe(skill.id);
        expect(reconstituted.name).toBe(skill.name);
        expect(reconstituted.archetype).toBe(skill.archetype);
        expect(reconstituted.showType).toBe(skill.showType);
        expect(reconstituted.hosts.length).toBe(skill.hosts.length);

        for (let i = 0; i < skill.hosts.length; i++) {
          expect(reconstituted.hosts[i].name).toBe(skill.hosts[i].name);
          expect(reconstituted.hosts[i].ttsVoice).toBe(skill.hosts[i].ttsVoice);
          expect(reconstituted.hosts[i].speakingRateWpm).toBe(skill.hosts[i].speakingRateWpm);
        }
      }
    });

    it("handles malformed or sparse DB template records in dbTemplateToSkill", () => {
      const sparseTemplate = {
        hosts: null as any,
        name: "Unknown Sparse Show",
        showType: "invalid_type" as any,
      };

      const reconstituted = dbTemplateToSkill(sparseTemplate as any);
      expect(reconstituted).toBeDefined();
      expect(reconstituted.name).toBe("Unknown Sparse Show");
      expect(reconstituted.showType).toBe("monologue"); // defaulted safely
      expect(reconstituted.hosts.length).toBeGreaterThanOrEqual(1);
    });

    it("getAllSkillsAsDbTemplates outputs valid templates for all registered skills", () => {
      const templates = getAllSkillsAsDbTemplates();
      expect(templates.length).toBe(listShowSkills().length);
      for (const t of templates) {
        expect(t.name.length).toBeGreaterThan(0);
        expect(["monologue", "conversation"]).toContain(t.showType);
        expect(Array.isArray(t.hosts)).toBe(true);
      }
    });
  });
});
