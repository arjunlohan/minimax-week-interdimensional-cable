import { z } from "zod";

import { generateJson } from "@/app/lib/gmi/text";
import { calculateClipWordBudgets } from "@/app/lib/skills/archetype-a";
import type { ClipWordBudget, RhetoricalAct, ShowSkill } from "@/app/lib/skills/types";

import { ComedicBeatSchema, HeadWriterDraftModelOutputSchema, HeadWriterDraftSchema } from "./schemas";
import type {
  CallbackLink,
  ComedicBeat,
  ComedicMechanism,
  HeadWriterDraft,
  Pass2Input,
  PodcastTurn,
  ShowOutputFormat,
  TurnType,
} from "./types";

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Beat planning
// ─────────────────────────────────────────────────────────────────────────────

/** Audio episodes keep the fixed grid the desk path has always been cut on. */
export const AUDIO_BEAT_SECONDS = 8;
/** Video beats aim for this length; MiniMax-H3 renders one clip per beat. */
export const VIDEO_BEAT_TARGET_SECONDS = 10;
export const VIDEO_BEAT_MIN_SECONDS = 8;
export const VIDEO_BEAT_MAX_SECONDS = 12;
/** Measured spoken delivery rate; the head writer's hard total word budget is derived from it. */
export const SPOKEN_WORDS_PER_SECOND = 2.46;

/**
 * Slices a video episode into integer beat lengths that sum to the duration.
 * The count is the duration over ten seconds, so every slot lands between 8
 * and 12 s for any total of 16 s or more; below that the single slot (or the
 * 8 + 7 split at 15 s) stays inside MiniMax-H3's 4 to 15 s clip range.
 */
export function planVideoBeatSlots(durationSeconds: number): number[] {
  const total = Math.max(1, Math.round(durationSeconds));
  const count = Math.max(1, Math.round(total / VIDEO_BEAT_TARGET_SECONDS));
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

function actAtProgress(acts: RhetoricalAct[], progressFraction: number): RhetoricalAct | undefined {
  let cumulativeFraction = 0;
  for (const act of acts) {
    cumulativeFraction += act.targetDurationFraction;
    if (progressFraction <= cumulativeFraction) {
      return act;
    }
  }
  return acts[acts.length - 1];
}

/**
 * Per-beat word budgets for a desk show. Video beats come from
 * `planVideoBeatSlots`; audio keeps `calculateClipWordBudgets`' 8 s grid. Acts
 * and the word band follow the same rules as that helper so the two formats
 * differ only in slot length.
 */
export function planClipWordBudgets(
  durationSeconds: number,
  skill: ShowSkill,
  format: ShowOutputFormat = "video",
): ClipWordBudget[] {
  if (format === "audio") {
    return calculateClipWordBudgets(durationSeconds, skill, AUDIO_BEAT_SECONDS);
  }

  const slots = planVideoBeatSlots(durationSeconds);
  const total = slots.reduce((sum, slot) => sum + slot, 0);
  const wordsPerSecond = skill.rhetoricalSpine.wordBudgetPerSecond || 2.5;
  const acts = skill.rhetoricalSpine.acts;

  let startTime = 0;
  return slots.map((duration, index) => {
    const endTime = startTime + duration;
    const act = actAtProgress(acts, (startTime + duration / 2) / total);
    const targetWords = duration * wordsPerSecond;
    const budget: ClipWordBudget = {
      clipIndex: index,
      startTimeSeconds: startTime,
      endTimeSeconds: endTime,
      durationSeconds: duration,
      targetWordsMin: Math.max(10, Math.floor(targetWords * 0.92)),
      targetWordsMax: Math.ceil(targetWords * 1.04),
      assignedActId: act?.id ?? "act_1_thesis_hook",
      actName: act?.name ?? "Act 1",
    };
    startTime = endTime;
    return budget;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Desk Show (Archetype A) System Instruction & Synthesizer
// ─────────────────────────────────────────────────────────────────────────────

const DESK_SHOW_SYSTEM_INSTRUCTION = `You are an elite Head Writer in a late-night comedy television writers' room (in the caliber of Last Week Tonight, A Closer Look, The Daily Show, and Weekend Update).

YOUR OBJECTIVES:
Construct an airtight, joke-dense 3-Act desk show script delivered as consecutive timed beats.

CORE COMEDIC CRAFT RULES:
1. INCONGRUITY-RESOLUTION: Every joke must establish a normal, journalistic expectation (Schema 1) and resolve it with a surprising, logically sound absurdity (Schema 2).
2. PUNCHLINE POSITION RULE: The operative punchline word or phrase MUST BE PLACED AT THE ABSOLUTE END of the sentence. Never bury the funny noun in the middle.
3. RULE-OF-THREE: Use [Normal Example] -> [Heightened Example] -> [Surreal Absurdist Breakdown].
4. ESCALATING ANALOGIES: Deploy hyper-specific, unexpected similes ("X is like Y, if Y were run by Z").
5. TAGS: After major laughs, immediately tack on 1-2 rapid 3-8 word punchline tags to elevate the laugh momentum.
6. CALLBACK: Plant an absurd, memorable noun/persona in Act 1/2 (e.g., "Kevin, the unlicensed taxidermist"), and deliver a triumphant comedic callback payoff in Act 3.
7. BEAT GRANULARITY: The prompt supplies the exact beat slots (start, end, duration, act) and a word budget for each. Every beat is ONE continuous spoken line by ONE host: no speaker change inside a beat, no stage directions in the dialogue. Land inside each beat's word budget; the hard total word budget matters most.
8. DUAL-TRACK OUTPUT: For every beat, generate both the spoken dialogue AND a vivid visual prompt for MiniMax-H3 video conditioning.

OUTPUT FORMAT:
Output ONLY valid JSON matching this schema:
{
  "showTitle": string,
  "beats": [
    {
      "id": "beat-0",
      "actId": string (copied from the slot),
      "actName": string (copied from the slot),
      "clipIndex": 0,
      "startTimeSeconds": number (copied from the slot),
      "endTimeSeconds": number (copied from the slot),
      "durationSeconds": number (copied from the slot),
      "targetWordCount": number (copied from the slot),
      "actualWordCount": number,
      "speaker": string (exactly one of the listed hosts),
      "setup": string,
      "punchline": string,
      "tags": [string],
      "fullText": string,
      "mechanism": "setup_misdirection" | "rule_of_three" | "escalating_analogy" | "rapid_tag" | "callback" | "character_act_out" | "rhetorical_crescendo" | "theatrical_cta",
      "plantedCallbackMotif": string (optional),
      "resolvedCallbackMotif": string (optional),
      "visualPrompt": string (host desk scene with lighting, gesture, and over-the-shoulder graphic),
      "actingDirection": string
    }
  ],
  "callbacks": [
    {
      "plantedInBeatId": "beat-1",
      "resolvedInBeatId": "beat-4",
      "motif": "Kevin, the unlicensed taxidermist"
    }
  ],
  "metrics": {
    "totalDurationSeconds": number,
    "totalWordCount": number,
    "estimatedLpm": number,
    "jokeCount": number,
    "callbackCount": number,
    "ruleOfThreeCount": number
  },
  "pass1Context": {
    "verifiedFactsCount": number,
    "incongruitySeedsCount": number
  }
}`;

// ─────────────────────────────────────────────────────────────────────────────
// Podcast (Archetype B) System Instruction & Synthesizer
// ─────────────────────────────────────────────────────────────────────────────

const PODCAST_SYSTEM_INSTRUCTION = `You are the executive showrunner and dialogue architect for a top-charting comedy/speculative podcast studio (in the style of Joe Rogan Experience, Tim Dillon Show).

YOUR OBJECTIVES:
Transform the verified research brief and selected premise into an authentic multi-speaker dialogue tree featuring organic tangent drift, high-voltage riffs, and natural turn-taking.

CORE CONVERSATIONAL CRAFT RULES:
1. MULTI-SPEAKER TURN TAKING: Alternate turns between hosts with authentic personality dynamics.
   - Lead Host: Drives open-ended curiosity or breathless satirical diatribes.
   - Co-Host / Sounding Board: Injects supportive/incredulous backchannels, suppressed giggles, and probing questions.
2. DYNAMIC TANGENT DRIFT:
   - Traverse the talking point tree from root premise to associative tangents (primal evolutionary biology, suburban Ponzi schemes, ancient technology).
   - If drift depth exceeds the limit, execute a natural SNAPBACK turn using the host's signature transition phrase.
3. ACOUSTIC TAGGING:
   - Embed authentic acoustic tags directly in the dialogue: [laughs], [chuckles], [snickers], [sighs], [gasps], [whispering], [incredulous], [wheezes].
   - Place acoustic tags where a real human speaker would naturally chuckle or pause for breath.
4. RHYTHM & PACING:
   - Mix turn lengths: Short backchannels (2-6 words), rapid ping-pong (5-15 words), and long rolling speculative riffs / diatribes (25-60 words).

OUTPUT FORMAT:
Output ONLY valid JSON matching this schema:
{
  "showTitle": string,
  "turns": [
    {
      "id": "turn-0",
      "turnIndex": 0,
      "speaker": string (exactly one of the listed hosts),
      "role": string (the host's role as listed),
      "ttsVoice": string (the host's voice id exactly as listed),
      "turnType": "inquiry" | "speculative_riff" | "diatribe" | "ping_pong" | "backchannel" | "tangent_pivot" | "snapback",
      "text": string (with acoustic tags like [laughs]),
      "acousticTags": [string],
      "wordCount": number,
      "estimatedDurationSeconds": number,
      "currentNodeId": string,
      "isTangent": boolean,
      "driftDepth": number,
      "snapbackTriggered": boolean (optional)
    }
  ],
  "callbacks": [],
  "metrics": {
    "totalDurationSeconds": number,
    "totalWordCount": number,
    "estimatedLpm": number,
    "jokeCount": number,
    "callbackCount": number,
    "ruleOfThreeCount": number,
    "tangentCount": number,
    "maxDriftDepthReached": number
  },
  "pass1Context": {
    "verifiedFactsCount": number,
    "incongruitySeedsCount": number
  }
}`;

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic Desk Show Synthesizer (Resilience Fallback)
// ─────────────────────────────────────────────────────────────────────────────

export function synthesizeDeterministicDeskDraft(input: Pass2Input): HeadWriterDraft {
  const { researchBrief, skill, durationSeconds } = input;
  const clipBudgets = planClipWordBudgets(durationSeconds, skill, input.format ?? "video");
  const primaryHost = skill.hosts[0] ?? { name: "John", role: "anchor" };
  const topic = researchBrief.topic;
  const angle = researchBrief.selectedAngle;
  const facts = researchBrief.groundedFacts;

  const callbackMotif = "Kevin, the unlicensed artisanal taxidermist in New Jersey";

  const sampleBeats: Array<{
    setup: string;
    punchline: string;
    tags: string[];
    mechanism: ComedicMechanism;
    visual: string;
    planted?: string;
    resolved?: string;
  }> = [
    {
      setup: `Welcome back. Tonight we turn to ${topic},`,
      punchline: `a topic so bizarre reality feels like a nap in a dumpster fire.`,
      tags: ["Yes, really."],
      mechanism: "setup_misdirection",
      visual: `A professional late-night talk show set. Host ${primaryHost.name} sits behind the desk with an incredulous expression. Over-the-shoulder monitor displays title graphic for ${topic}. High-contrast studio lighting.`,
    },
    {
      setup: `Official spending on ${topic} skyrocketed,`,
      punchline: `because the core patent was filed on a diner napkin by ${callbackMotif}.`,
      tags: ["Cool. Great system."],
      mechanism: "escalating_analogy",
      visual: `Close-up of host ${primaryHost.name} gesturing with raised eyebrows. Over-the-shoulder monitor displays a comical sketch of a greasy diner napkin patent diagram.`,
      planted: callbackMotif,
    },
    {
      setup: `Their customer policy is three simple steps:`,
      punchline: `apologize, charge forty dollars, and transfer your mortgage to an emotional support badger.`,
      tags: ["Paragraph twelve."],
      mechanism: "rule_of_three",
      visual: `Medium shot of host ${primaryHost.name} leaning forward over the desk, counting on fingers with satirical exasperation. Monitor displays absurd fine-print terms.`,
    },
    {
      setup: `Spokespeople insist this has ninety-nine percent precision,`,
      punchline: `like a toddler claiming the cookies were stolen by aliens.`,
      tags: ["Flawless logic."],
      mechanism: "character_act_out",
      visual: `Wide desk shot. Host ${primaryHost.name} acts out a defensive corporate executive shrug, spreading hands with sarcastic smirk. Studio lighting glows warm.`,
    },
    {
      setup: `So as we move forward, remember:`,
      punchline: `if your toaster demands advice, send a postcard directly to ${callbackMotif}.`,
      tags: ["Good night!"],
      mechanism: "callback",
      visual: `Cinematic wide shot of the late-night talk show set. Host ${primaryHost.name} delivers a triumphant, impassioned closing stare into the camera as the desk lights flare dramatically.`,
      resolved: callbackMotif,
    },
  ];

  const beats: ComedicBeat[] = clipBudgets.map((budget, index) => {
    const template = sampleBeats[index % sampleBeats.length];
    const fullText = `${template.setup} ${template.punchline} ${template.tags.join(" ")}`.trim();
    const actualWordCount = countWords(fullText);

    return {
      id: `beat-${index}`,
      actId: budget.assignedActId,
      actName: budget.actName,
      clipIndex: index,
      startTimeSeconds: budget.startTimeSeconds,
      endTimeSeconds: budget.endTimeSeconds,
      durationSeconds: budget.durationSeconds,
      targetWordCount: Math.round((budget.targetWordsMin + budget.targetWordsMax) / 2),
      actualWordCount,
      speaker: primaryHost.name,
      setup: template.setup,
      punchline: template.punchline,
      tags: template.tags,
      fullText,
      mechanism: template.mechanism,
      plantedCallbackMotif: template.planted,
      resolvedCallbackMotif: template.resolved,
      visualPrompt: template.visual,
      actingDirection: `Deliver with ${skill.voiceMechanics.sentenceCadence ?? "sharp late-night"} cadence, holding punchline surprise until the final word.`,
      visualPromptSeed: template.visual,
    };
  });

  const totalWordCount = beats.reduce((acc, b) => acc + b.actualWordCount, 0);
  const jokeCount = beats.length;
  const tagCount = beats.reduce((acc, b) => acc + (b.tags?.length ?? 0), 0);
  const estimatedLpm = Number((((jokeCount + tagCount) / (durationSeconds / 60))).toFixed(2));

  const callbacks: CallbackLink[] = [
    {
      plantedInBeatId: "beat-1",
      resolvedInBeatId: `beat-${beats.length - 1}`,
      motif: callbackMotif,
    },
  ];

  return {
    archetype: "writers_room_desk",
    showId: `show-desk-${Date.now()}`,
    showTitle: angle.title,
    topic,
    selectedPremise: angle,
    beats,
    callbacks,
    callbacksPlanted: [callbackMotif],
    clipWordBudgets: clipBudgets,
    metrics: {
      totalDurationSeconds: durationSeconds,
      totalWordCount,
      estimatedLpm,
      jokeCount,
      callbackCount: callbacks.length,
      ruleOfThreeCount: beats.filter(b => b.mechanism === "rule_of_three").length,
    },
    pass1Context: {
      verifiedFactsCount: facts.length,
      incongruitySeedsCount: researchBrief.incongruitySeeds.length,
    },
    totalEstimatedSeconds: durationSeconds,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic Podcast Synthesizer (Resilience Fallback)
// ─────────────────────────────────────────────────────────────────────────────

export function synthesizeDeterministicPodcastDraft(input: Pass2Input): HeadWriterDraft {
  const { researchBrief, skill, durationSeconds } = input;
  const leadHost = skill.hosts.find(h => h.role === "lead_host" || h.role === "anchor") ?? skill.hosts[0] ?? { name: "Joe", role: "lead_host", ttsVoice: "English_magnetic_voiced_man" };
  // A solo format has no second seat. Falling back to an invented "Jamie" gave
  // single-host shows a phantom co-host, so the lead simply takes every turn.
  const coHost = skill.hosts.find(h => h !== leadHost) ?? leadHost;
  const topic = researchBrief.topic;
  const angle = researchBrief.selectedAngle;
  const facts = researchBrief.groundedFacts;
  const snapbackPhrase = skill.podcastDynamics?.driftConfig?.snapbackPhrases?.[0] ?? "Wait, how did we get here? Right, back to the actual issue...";

  const rawTurns: Array<{
    speaker: string;
    role: string;
    voice: string;
    turnType: TurnType;
    text: string;
    tags: string[];
    isTangent: boolean;
    driftDepth: number;
    snapback?: boolean;
  }> = [
    {
      speaker: leadHost.name,
      role: leadHost.role,
      voice: leadHost.ttsVoice ?? "English_magnetic_voiced_man",
      turnType: "inquiry",
      text: `[laughs] Have you actually looked at what is happening with ${topic} recently? It is completely off the rails.`,
      tags: ["[laughs]"],
      isTangent: false,
      driftDepth: 0,
    },
    {
      speaker: coHost.name,
      role: coHost.role,
      voice: coHost.ttsVoice ?? "English_Trustworth_Man",
      turnType: "speculative_riff",
      text: `[chuckles] 100 percent. The official reports say they spent millions on automated apologies. It is like discovering ancient primate rituals were secretly sponsored by venture capital.`,
      tags: ["[chuckles]"],
      isTangent: true,
      driftDepth: 1,
    },
    {
      speaker: leadHost.name,
      role: leadHost.role,
      voice: leadHost.ttsVoice ?? "English_magnetic_voiced_man",
      turnType: "backchannel",
      text: `[incredulous] Wait, really? That's insane. Chimps would never agree to that terms of service agreement.`,
      tags: ["[incredulous]"],
      isTangent: true,
      driftDepth: 2,
    },
    {
      speaker: coHost.name,
      role: coHost.role,
      voice: coHost.ttsVoice ?? "English_Trustworth_Man",
      turnType: "diatribe",
      text: `Exactly! Chimps have basic dignity. Humans just scroll down 84 pages of legal jargon and click 'Agree', giving away their soul for a faster toaster.`,
      tags: [],
      isTangent: true,
      driftDepth: 2,
    },
    {
      speaker: leadHost.name,
      role: leadHost.role,
      voice: leadHost.ttsVoice ?? "English_magnetic_voiced_man",
      turnType: "snapback",
      text: `[sighs] ${snapbackPhrase} The real wild part is the 1987 patent origin.`,
      tags: ["[sighs]"],
      isTangent: false,
      driftDepth: 0,
      snapback: true,
    },
    {
      speaker: coHost.name,
      role: coHost.role,
      voice: coHost.ttsVoice ?? "English_Trustworth_Man",
      turnType: "ping_pong",
      text: `The taxidermist in New Jersey! You can't make this stuff up.`,
      tags: [],
      isTangent: false,
      driftDepth: 0,
    },
    {
      speaker: leadHost.name,
      role: leadHost.role,
      voice: leadHost.ttsVoice ?? "English_magnetic_voiced_man",
      turnType: "speculative_riff",
      text: `[whispering] It makes you wonder if our entire digital simulation is being hosted on Kevin's garage server. Pull that up, see if the diner is still open.`,
      tags: ["[whispering]"],
      isTangent: false,
      driftDepth: 0,
    },
  ];

  // The turn skeleton above is written for a two-hander. A wider panel would
  // otherwise leave every host past the second silent, so the non-lead turns are
  // distributed across the remaining seats. The lead keeps their turns, since
  // the skeleton's lead lines carry the act structure.
  const otherHosts = skill.hosts.filter(h => h.name !== leadHost.name);
  if (otherHosts.length > 1) {
    let seat = 0;
    for (const turn of rawTurns) {
      if (turn.speaker === leadHost.name) {
        continue;
      }
      const host = otherHosts[seat % otherHosts.length];
      turn.speaker = host.name;
      turn.role = host.role;
      turn.voice = host.ttsVoice;
      seat++;
    }
  }

  // Calculate proportional turn durations to match durationSeconds
  const avgWps = 2.4;
  const turns: PodcastTurn[] = rawTurns.map((turn, idx) => {
    const wordCount = countWords(turn.text);
    const estimatedDurationSeconds = Math.max(3, Math.round((wordCount / avgWps) * 10) / 10);

    return {
      id: `turn-${idx}`,
      turnIndex: idx,
      speaker: turn.speaker,
      role: turn.role,
      ttsVoice: turn.voice,
      turnType: turn.turnType,
      text: turn.text,
      acousticTags: turn.tags,
      wordCount,
      estimatedDurationSeconds,
      currentNodeId: `node-${turn.isTangent ? "tangent" : "core"}-${idx}`,
      isTangent: turn.isTangent,
      driftDepth: turn.driftDepth,
      snapbackTriggered: turn.snapback,
    };
  });

  const totalWordCount = turns.reduce((acc, t) => acc + t.wordCount, 0);
  const jokeCount = turns.filter(t => t.turnType === "speculative_riff" || t.turnType === "diatribe").length;
  const estimatedLpm = Number(((jokeCount / (durationSeconds / 60))).toFixed(2));
  const tangentCount = turns.filter(t => t.isTangent).length;
  const maxDriftDepthReached = Math.max(...turns.map(t => t.driftDepth), 0);

  return {
    archetype: "conversational_podcast",
    showId: `show-podcast-${Date.now()}`,
    showTitle: angle.title,
    topic,
    selectedPremise: angle,
    turns,
    callbacks: [],
    callbacksPlanted: [],
    metrics: {
      totalDurationSeconds: durationSeconds,
      totalWordCount,
      estimatedLpm,
      jokeCount,
      callbackCount: 0,
      ruleOfThreeCount: 0,
      tangentCount,
      maxDriftDepthReached,
    },
    pass1Context: {
      verifiedFactsCount: facts.length,
      incongruitySeedsCount: researchBrief.incongruitySeeds.length,
    },
    totalEstimatedSeconds: durationSeconds,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pass 2 Generator Entry Point
// ─────────────────────────────────────────────────────────────────────────────

function describeBeatPlan(durationSeconds: number, clipBudgets: ClipWordBudget[], format: ShowOutputFormat): string {
  if (format === "audio") {
    return `Total Duration: ${durationSeconds} seconds (${clipBudgets.length} beats of ${AUDIO_BEAT_SECONDS} seconds each).`;
  }
  return `Total Duration: ${durationSeconds} seconds, delivered as ${clipBudgets.length} beat${clipBudgets.length === 1 ? "" : "s"} of ${VIDEO_BEAT_MIN_SECONDS} to ${VIDEO_BEAT_MAX_SECONDS} seconds each.
MiniMax-H3 renders one video clip per beat (4 to 15 s), so every beat must be ONE continuous spoken line by a single host that fits its slot at ${SPOKEN_WORDS_PER_SECOND} words per second (roughly 20 to 30 words).`;
}

/** Only one voice exists on a solo format, whatever the model decided to call the speaker. */
function pinSoloSpeaker(skill: ShowSkill, draft: HeadWriterDraft): void {
  if (skill.hosts.length !== 1) {
    return;
  }
  const only = skill.hosts[0];
  for (const beat of draft.beats ?? []) {
    beat.speaker = only.name;
  }
  // On a solo rant the model reliably addresses an imagined producer and
  // hands them lines, which would then be synthesized as a second speaker.
  for (const turn of draft.turns ?? []) {
    if (turn.speaker !== only.name) {
      turn.speaker = only.name;
      turn.role = only.role;
      turn.ttsVoice = only.ttsVoice;
    }
  }
}

async function generateDeskShowDraft(input: Pass2Input): Promise<HeadWriterDraft> {
  const { researchBrief, skill, durationSeconds } = input;
  const format = input.format ?? "video";
  const clipBudgets = planClipWordBudgets(durationSeconds, skill, format);
  const primaryHost = skill.hosts[0] ?? { name: "John", role: "anchor", personaCraft: "", catchphrases: [] };

  if (input.options?.forceMock) {
    return synthesizeDeterministicDeskDraft(input);
  }

  const prompt = `SHOW CONFIGURATION:
Show Name: "${skill.name}"
Hosts (a beat's speaker must be exactly one of these names):
${skill.hosts.map(h => `- "${h.name}" (Role: ${h.role}): ${h.personaCraft}`).join("\n") || `- "${primaryHost.name}" (Role: ${primaryHost.role})`}
Catchphrases: ${primaryHost.catchphrases?.join(", ") || "None"}
Mean Sentence Length Words: ${skill.voiceMechanics.meanSentenceLengthWords}
Profanity Register: ${skill.voiceMechanics.profanityRegister}
Outrage/Affability Ratio: ${skill.voiceMechanics.outrageAffabilityRatio}
Laugh Per Minute Target: ${skill.rhetoricalSpine.laughPerMinuteTarget.min} - ${skill.rhetoricalSpine.laughPerMinuteTarget.max} LPM

RESEARCH BRIEF:
Topic: "${researchBrief.topic}"
Selected Premise Angle: "${researchBrief.selectedAngle.title}" (${researchBrief.selectedAngle.angleType})
Logline: "${researchBrief.selectedAngle.logline}"
Thematic Hook: "${researchBrief.selectedAngle.thematicHook}"
Escalation Ladder:
1. ${researchBrief.selectedAngle.escalationLadder[0]}
2. ${researchBrief.selectedAngle.escalationLadder[1]}
3. ${researchBrief.selectedAngle.escalationLadder[2]}
Anchor Facts:
${researchBrief.groundedFacts.map(f => `- [${f.category}] ${f.fact} (${f.bizarreMetric ?? ""})`).join("\n")}
Suggested Analogies:
${researchBrief.selectedAngle.suggestedAnalogies.map(a => `- ${a}`).join("\n")}

ACT & BEAT BUDGET CONSTRAINTS:
${describeBeatPlan(durationSeconds, clipBudgets, format)}
HARD TOTAL WORD BUDGET: ${Math.round(durationSeconds * SPOKEN_WORDS_PER_SECOND)} words across all beats (spoken delivery measures ${SPOKEN_WORDS_PER_SECOND} words/second).
Staying within this total matters more than filling any individual beat to its maximum. Going over makes the episode run long.
Beat slots:
${clipBudgets.map(b => `- Beat ${b.clipIndex} (${b.startTimeSeconds}s - ${b.endTimeSeconds}s, ${b.durationSeconds} s, Act: ${b.actName}, actId: ${b.assignedActId}): ${b.targetWordsMin}-${b.targetWordsMax} words`).join("\n")}

Write a complete 3-Act HeadWriterDraft with exactly ${clipBudgets.length} ComedicBeats, one per slot in slot order, with planted callbacks, rule-of-three, tags, and MiniMax-H3 visual prompts. Output valid JSON only.`;

  // Not falling back on failure. The deterministic skeleton is identical for
  // every topic, so substituting it silently shipped the same episode
  // repeatedly while reporting success.
  const modelDraft = await generateJson({
    // The beat count is part of the contract: the repair round tells the model
    // the exact number when it writes too few or too many.
    schema: HeadWriterDraftModelOutputSchema.extend({
      beats: z.array(ComedicBeatSchema).length(clipBudgets.length),
    }),
    label: "pass2-head-writer",
    system: DESK_SHOW_SYSTEM_INSTRUCTION,
    prompt,
    temperature: input.options?.temperature ?? 0.85,
    // A smaller budget truncated the draft mid-JSON.
    maxOutputTokens: 65536,
  });

  // The plan is authoritative for timing. The model's copy of the slots is
  // redundant at best and drifts at worst, and a clip rendered to the wrong
  // length cannot hold its line.
  const beats: ComedicBeat[] = modelDraft.beats.map((beat, index) => {
    const slot = clipBudgets[index];
    const fullText = beat.fullText.trim();
    return {
      ...beat,
      clipIndex: index,
      actId: slot.assignedActId,
      actName: slot.actName,
      startTimeSeconds: slot.startTimeSeconds,
      endTimeSeconds: slot.endTimeSeconds,
      durationSeconds: slot.durationSeconds,
      targetWordCount: Math.round((slot.targetWordsMin + slot.targetWordsMax) / 2),
      actualWordCount: countWords(fullText) || beat.actualWordCount,
      fullText,
    };
  });

  const validated = HeadWriterDraftSchema.parse({
    ...modelDraft,
    archetype: "writers_room_desk",
    showId: `show-desk-${Date.now()}`,
    topic: researchBrief.topic,
    selectedPremise: researchBrief.selectedAngle,
    beats,
    metrics: {
      ...modelDraft.metrics,
      totalDurationSeconds: durationSeconds,
      totalWordCount: beats.reduce((sum, beat) => sum + beat.actualWordCount, 0),
    },
    totalEstimatedSeconds: durationSeconds,
  }) as HeadWriterDraft;
  validated.clipWordBudgets = clipBudgets;

  pinSoloSpeaker(skill, validated);
  return validated;
}

async function generatePodcastDraft(input: Pass2Input): Promise<HeadWriterDraft> {
  const { researchBrief, skill, durationSeconds } = input;

  if (input.options?.forceMock) {
    return synthesizeDeterministicPodcastDraft(input);
  }

  const prompt = `SHOW CONFIGURATION:
Show Name: "${skill.name}"
Hosts (a turn's speaker must be exactly one of these names):
${skill.hosts.map(h => `- ${h.name} (${h.role}, TTS Voice: ${h.ttsVoice}): ${h.personaCraft}`).join("\n")}
Talking Point Tree:
${skill.podcastDynamics?.talkingPointTree.map(n => `- Node ${n.id}: ${n.title} (Premise: ${n.premise})`).join("\n") ?? "None"}
Tangent Drift Config:
- Drift Probability: ${skill.podcastDynamics?.driftConfig.driftProbability ?? 0.7}
- Max Drift Turns: ${skill.podcastDynamics?.driftConfig.maxDriftDepthTurns ?? 3}
- Snapback Phrases: ${skill.podcastDynamics?.driftConfig.snapbackPhrases.join(" | ") ?? "Wait, back to the point"}
- Acoustic Tags to Embed: ${skill.podcastDynamics?.acousticTagSet.join(", ") ?? "[laughs], [chuckles], [sighs]"}

RESEARCH BRIEF:
Topic: "${researchBrief.topic}"
Selected Premise Angle: "${researchBrief.selectedAngle.title}" (${researchBrief.selectedAngle.angleType})
Anchor Facts:
${researchBrief.groundedFacts.map(f => `- ${f.fact}`).join("\n")}

CONSTRAINTS:
Total Duration: ${durationSeconds} seconds
Construct a dynamic multi-speaker conversation traversing core nodes and tangents with natural snapbacks and acoustic tags. Output valid JSON only.`;

  // Not falling back; see the desk path above. Three consecutive shows on
  // unrelated topics produced near-identical transcripts because this path
  // silently substituted a fixed skeleton.
  const modelDraft = await generateJson({
    schema: HeadWriterDraftModelOutputSchema,
    label: "pass2-head-writer",
    system: PODCAST_SYSTEM_INSTRUCTION,
    prompt,
    temperature: input.options?.temperature ?? 0.85,
    // A smaller budget truncated the draft mid-JSON.
    maxOutputTokens: 65536,
  });

  const validated = HeadWriterDraftSchema.parse({
    ...modelDraft,
    archetype: "conversational_podcast",
    showId: `show-podcast-${Date.now()}`,
    topic: researchBrief.topic,
    selectedPremise: researchBrief.selectedAngle,
  }) as HeadWriterDraft;

  pinSoloSpeaker(skill, validated);
  return validated;
}

export async function generateHeadWriterDraft(input: Pass2Input): Promise<HeadWriterDraft> {
  const { skill } = input;
  if (skill.archetype === "conversational_podcast") {
    return generatePodcastDraft(input);
  }
  return generateDeskShowDraft(input);
}
