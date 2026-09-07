import type { ClipWordBudget, RhetoricalAct, ShowSkill } from "./types";

/**
 * Standard 3-act rhetorical acts for Writers'-Room Desk Shows (Archetype A).
 * Encodes the proven late-night comedy television structural progression.
 */
export const ARCHETYPE_A_STANDARD_ACTS: RhetoricalAct[] = [
  {
    id: "act_1_thesis_hook",
    name: "Act 1: Thesis & Grounded Incongruity Hook",
    targetDurationFraction: 0.25,
    purpose:
      "Anchor the topic in verified journalistic factuality, establish default cognitive expectation S1, and introduce the core incongruity S2 with an immediate high-traction punchy hook.",
    comedicFormulas: [
      "journalistic_premise",
      "rational_expectation_contrast",
      "thesis_incongruity_hook",
    ],
    promptGuidance:
      "State the topic with newsroom authority. Contrast what ordinary people expect with the bizarre underlying reality. Land a strong hook punchline within the first segment.",
    requiredElements: ["thesis_setup", "grounded_fact"],
  },
  {
    id: "act_2_evidence_analogies",
    name: "Act 2: Supporting Evidence & Escalating Absurdist Analogies",
    targetDurationFraction: 0.5,
    purpose:
      "Advance the core thesis through alternating factual evidence and escalating absurdist analogies, deploying the Rule-of-Three, rapid joke tags, character act-outs, and metaphor callbacks.",
    comedicFormulas: [
      "fact_analogy_loop",
      "escalating_simile_cascade",
      "rule_of_three",
      "rapid_tag",
      "character_act_out",
      "callback_thread",
    ],
    promptGuidance:
      "For every factual detail, deploy an escalating analogy. Follow the Rule of Three (Setup -> Reinforce -> Subvert). Tack on 1-2 rapid tags after major laughs. Plant an absurd character or noun for later callback.",
    requiredElements: [
      "grounded_fact",
      "escalating_analogy",
      "rule_of_three",
      "tag",
      "act_out",
    ],
  },
  {
    id: "act_3_synthesis_cta",
    name: "Act 3: Synthesis, Theatrical Payoff & Call-to-Action",
    targetDurationFraction: 0.25,
    purpose:
      "Synthesize the absurdity into a final moral, existential, or satirical insight, culminating in a theatrical set-piece or exasperated CTA with a hard-hitting closer punchline.",
    comedicFormulas: [
      "existential_moral_synthesis",
      "theatrical_absurdist_cta",
      "crescendo_closer",
    ],
    promptGuidance:
      "Bring all analogies together into a climactic crescendo. Deliver a high-concept comedic CTA or absurd realization. The final sentence must place the punch word at the absolute end.",
    requiredElements: ["callback", "call_to_action"],
  },
];

/**
 * Calculates per-clip word budgets and act distribution for video shows (8s clip granularity).
 * Ensures spoken script segments align with MiniMax-H3 video clip boundaries.
 */
export function calculateClipWordBudgets(
  totalDurationSeconds: number,
  skill: ShowSkill,
  clipDurationSeconds = 8,
): ClipWordBudget[] {
  const clipCount = Math.ceil(totalDurationSeconds / clipDurationSeconds);
  const wordsPerSecond = skill.rhetoricalSpine.wordBudgetPerSecond || 2.5;
  const targetWordsPerClip = clipDurationSeconds * wordsPerSecond; // 20 words for 8s clip

  const acts = skill.rhetoricalSpine.acts;
  const budgets: ClipWordBudget[] = [];

  for (let i = 0; i < clipCount; i++) {
    const startTime = i * clipDurationSeconds;
    const endTime = Math.min((i + 1) * clipDurationSeconds, totalDurationSeconds);
    const duration = endTime - startTime;
    const progressFraction = (startTime + duration / 2) / totalDurationSeconds;

    // Determine which act this clip belongs to based on cumulative duration fractions
    let cumulativeFraction = 0;
    let selectedAct = acts[0];
    for (const act of acts) {
      cumulativeFraction += act.targetDurationFraction;
      if (progressFraction <= cumulativeFraction || act === acts[acts.length - 1]) {
        selectedAct = act;
        break;
      }
    }

    budgets.push({
      clipIndex: i,
      startTimeSeconds: startTime,
      endTimeSeconds: endTime,
      durationSeconds: duration,
      // Models write to the top of whatever band they are given, so a +15% ceiling
      // made a 180s target land at ~200s. Keep the band tight around the target.
      targetWordsMin: Math.max(10, Math.floor(targetWordsPerClip * 0.92)), // ~18 words
      targetWordsMax: Math.ceil(targetWordsPerClip * 1.04), // ~21 words
      assignedActId: selectedAct.id,
      actName: selectedAct.name,
    });
  }

  return budgets;
}
