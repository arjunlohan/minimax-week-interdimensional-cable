import { describe, expect, it, vi } from "vitest";

import { isKnownVoiceId } from "./gmi/voices";
import { listShowSkills } from "./skills/registry";
import { deliveryStyleForHost, inferHostAccent, speedForHost, voiceForHostPublic } from "./tts";

// tts.ts imports the GMI speech and text clients, which validate the
// environment at import. Mock that boundary so the registry and the resolver
// can be exercised without a key.
vi.mock("@/app/lib/gmi/speech", () => ({ synthesizeSpeechWav: vi.fn() }));
vi.mock("@/app/lib/gmi/text", () => ({ generateJson: vi.fn() }));

describe("per-show voice assignment", () => {
  const skills = listShowSkills();

  it("registers all seven show archetypes", () => {
    expect(skills.length).toBe(7);
  });

  it("pins an explicit voice on every host, so nothing falls back to round-robin", () => {
    for (const skill of skills) {
      for (const host of skill.hosts) {
        expect(host.ttsVoice, `${skill.name} / ${host.name}`).toBeTruthy();
      }
    }
  });

  it("pins only voices the MiniMax catalog knows", () => {
    for (const skill of skills) {
      for (const host of skill.hosts) {
        expect(isKnownVoiceId(host.ttsVoice), `${skill.name} / ${host.name} pins ${host.ttsVoice}`).toBe(true);
      }
    }
  });

  it("honours the pinned voice rather than inferring one", () => {
    for (const skill of skills) {
      skill.hosts.forEach((host, i) => {
        expect(voiceForHostPublic(host, i)).toBe(host.ttsVoice);
      });
    }
  });

  it("gives co-hosts on the same show different voices", () => {
    for (const skill of skills.filter(s => s.hosts.length > 1)) {
      const voices = skill.hosts.map(h => h.ttsVoice);
      expect(new Set(voices).size, `${skill.name} reuses a voice`).toBe(voices.length);
    }
  });

  it("derives a British delivery for the British-persona host", () => {
    const desk = skills.find(s => s.id.includes("investigative"))!;
    const host = desk.hosts[0];
    expect(inferHostAccent(host)).toMatch(/British/i);
    expect(deliveryStyleForHost(host)).toMatch(/British/i);
  });

  it("speeds up the hosts written as fast talkers and nobody else", () => {
    const byName = new Map(skills.flatMap(s => s.hosts.map(h => [h.name, h] as const)));
    expect(speedForHost(byName.get("John Olive")!)).toBe(1.1);
    expect(speedForHost(byName.get("Jason Calamaris")!)).toBe(1.1);
    expect(speedForHost(byName.get("Tim Villain")!)).toBe(1.1);
    expect(speedForHost(byName.get("Seth Mires")!)).toBeUndefined();
    expect(speedForHost(byName.get("Chamath Capitalia")!)).toBeUndefined();
    expect(speedForHost(byName.get("David Stacks")!)).toBeUndefined();
  });
});
