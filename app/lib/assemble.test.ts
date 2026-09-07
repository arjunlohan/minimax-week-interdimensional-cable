import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetDrawtextProbe,
  assembleAudioEpisode,
  assembleEpisode,
  AUDIO_INTRO_SECONDS,
  AUDIO_OUTRO_SECONDS,
  buildAudioAssemblyPlan,
  buildEpisodeAssemblyPlan,
  clampSeconds,
  CREDITS_LINE,
  END_CARD_SECONDS,
  ENGINE_LINE,
  escapeFilterValue,
  resolveCardFont,
  TITLE_CARD_SECONDS,
  wrapLines,
} from "./assemble";
import { probeMedia } from "./media";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("./media", () => ({
  probeMedia: vi.fn(),
}));

const FONT = "/fonts/Syne-Bold.ttf";

function baseInput(overrides: Partial<Parameters<typeof buildEpisodeAssemblyPlan>[0]> = {}) {
  return {
    clips: [
      { path: "/tmp/clip-0.mp4", durationSeconds: 9.5, hasAudio: true },
      { path: "/tmp/clip-1.mp4", durationSeconds: 11.25, hasAudio: true },
      { path: "/tmp/clip-2.mp4", durationSeconds: 8, hasAudio: true },
    ],
    showName: "John Oliver Like",
    episodeTitle: "The Toaster That Learned to Lie",
    creditsLine: "We sang the toaster's name tonight",
    themeMusicPath: "/tmp/theme.mp3",
    creditsMusicPath: "/tmp/credits.mp3",
    outputPath: "/tmp/out/episode.mp4",
    ...overrides,
  };
}

const options = { fontPath: FONT, workDir: "/tmp/work" };

describe("assemble: filter-graph helpers", () => {
  it("escapes every character the filter-graph parser treats specially", () => {
    expect(escapeFilterValue("C:\\fonts\\a,b;c[d]'e")).toBe("C\\:\\\\fonts\\\\a\\,b\\;c\\[d\\]\\'e");
    expect(escapeFilterValue("/plain/path.ttf")).toBe("/plain/path.ttf");
  });

  it("wraps text greedily at the character budget without splitting words", () => {
    expect(wrapLines("Written by MiniMax-M3, voiced by Speech 2.8 HD", 24)).toEqual([
      "Written by MiniMax-M3,",
      "voiced by Speech 2.8 HD",
    ]);
    expect(wrapLines("   spaced    out   ", 40)).toEqual(["spaced out"]);
    expect(wrapLines("Supercalifragilistic", 5)).toEqual(["Supercalifragilistic"]);
    expect(wrapLines("", 10)).toEqual([]);
  });

  it("clamps card lengths into their broadcast windows and defaults when unset", () => {
    expect(clampSeconds(undefined, TITLE_CARD_SECONDS)).toBe(7);
    expect(clampSeconds(2, TITLE_CARD_SECONDS)).toBe(6);
    expect(clampSeconds(30, TITLE_CARD_SECONDS)).toBe(8);
    expect(clampSeconds(Number.NaN, END_CARD_SECONDS)).toBe(13);
    expect(clampSeconds(14, END_CARD_SECONDS)).toBe(14);
    expect(clampSeconds(40, END_CARD_SECONDS)).toBe(15);
  });
});

describe("assemble: video episode plan (pure)", () => {
  it("lists the clips first, then the music files, as ffmpeg inputs", () => {
    const plan = buildEpisodeAssemblyPlan(baseInput(), options);
    const inputs = plan.args.filter((_, i) => plan.args[i - 1] === "-i");
    expect(inputs).toEqual(["/tmp/clip-0.mp4", "/tmp/clip-1.mp4", "/tmp/clip-2.mp4", "/tmp/theme.mp3", "/tmp/credits.mp3"]);
    expect(plan.args.at(-1)).toBe("/tmp/out/episode.mp4");
    expect(plan.outputPath).toBe("/tmp/out/episode.mp4");
  });

  it("joins title card, clips and end card through the concat filter, not the demuxer", () => {
    const plan = buildEpisodeAssemblyPlan(baseInput(), options);
    expect(plan.filterGraph).toContain("[tv][ta][v0][a0][v1][a1][v2][a2][ev][ea]concat=n=5:v=1:a=1[outv][outa]");
    expect(plan.args).not.toContain("concat"); // no `-f concat` demuxer
    expect(plan.args).toContain("-filter_complex");
    expect(plan.args.slice(plan.args.indexOf("-map"))).toEqual([
      "-map",
      "[outv]",
      "-map",
      "[outa]",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-r",
      "24",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "48000",
      "-movflags",
      "+faststart",
      "/tmp/out/episode.mp4",
    ]);
  });

  it("scales and pads every clip to one size at 24 fps and normalises audio to 48 kHz stereo", () => {
    const plan = buildEpisodeAssemblyPlan(baseInput({ width: 1366, height: 768 }), options);
    for (const i of [0, 1, 2]) {
      expect(plan.filterGraph).toContain(
        `[${i}:v]scale=1366:768:force_original_aspect_ratio=decrease,pad=1366:768:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=24,format=yuv420p,setpts=PTS-STARTPTS[v${i}]`,
      );
      expect(plan.filterGraph).toContain(`[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS`);
    }
    // Audio is padded and trimmed to the measured picture length so segments stay aligned.
    expect(plan.filterGraph).toContain("apad=whole_dur=9.5,atrim=0:9.5[a0]");
    expect(plan.filterGraph).toContain("apad=whole_dur=11.25,atrim=0:11.25[a1]");
    expect(plan.layout.width).toBe(1366);
    expect(plan.layout.height).toBe(768);
  });

  it("rounds odd frame sizes up to even pixels (yuv420p needs them)", () => {
    const plan = buildEpisodeAssemblyPlan(baseInput({ width: 1365, height: 767 }), options);
    expect(plan.layout.width).toBe(1366);
    expect(plan.layout.height).toBe(768);
  });

  it("draws the show name, the episode title and the engine line on the title card with the Syne font", () => {
    const plan = buildEpisodeAssemblyPlan(baseInput(), options);
    const titleChain = plan.filterGraph.split(";").find(c => c.endsWith("[tv]"))!;
    expect(titleChain).toMatch(/^color=c=black:s=1280x720:r=24:d=7,format=yuv420p/);
    expect(titleChain.match(/drawtext=/g)).toHaveLength(3);
    expect(titleChain).toContain(`fontfile=${FONT}`);
    expect(titleChain).toContain("expansion=none");
    expect(titleChain).toContain("x=(w-tw)/2");
    const contents = plan.textFiles.map(f => f.content);
    expect(contents).toContain("John Oliver Like");
    expect(contents).toContain("The Toaster That Learned to Lie");
    expect(contents).toContain(ENGINE_LINE);
    expect(ENGINE_LINE).toBe("MiniMax-H3 · Speech 2.8 HD · Music 3.0 on GMI Cloud");
    for (const file of plan.textFiles) {
      expect(file.path.startsWith("/tmp/work/")).toBe(true);
      expect(titleChain + plan.filterGraph).toContain(escapeFilterValue(file.path));
    }
    expect(plan.layout.cardText).toBe(true);
  });

  it("puts the credit roll and the first credits lyric on the end card", () => {
    const plan = buildEpisodeAssemblyPlan(baseInput(), options);
    const endChain = plan.filterGraph.split(";").find(c => c.endsWith("[ev]"))!;
    expect(endChain).toMatch(/^color=c=black:s=1280x720:r=24:d=13,format=yuv420p/);
    const contents = plan.textFiles.map(f => f.content).join("\n");
    // The roll is wrapped across lines, so check it survives as a whole.
    expect(contents.replace(/\n/g, " ")).toContain(CREDITS_LINE);
    expect(CREDITS_LINE).toBe("Written by MiniMax-M3, voiced by Speech 2.8 HD, rendered by MiniMax-H3, scored by Music 3.0, on GMI Cloud");
    expect(contents).toContain("“We sang the toaster's name tonight”");
  });

  it("renders plain cards, still with music, when no font is available", () => {
    const plan = buildEpisodeAssemblyPlan(baseInput(), { fontPath: null, workDir: "/tmp/work" });
    expect(plan.filterGraph).not.toContain("drawtext");
    expect(plan.textFiles).toEqual([]);
    expect(plan.layout.cardText).toBe(false);
    expect(plan.filterGraph).toContain("[3:a]atrim=0:7");
  });

  it("trims, fades and pads the theme under the title card and the credits under the end card", () => {
    const plan = buildEpisodeAssemblyPlan(baseInput(), options);
    expect(plan.filterGraph).toContain(
      "[3:a]atrim=0:7,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.4,afade=t=out:st=5.5:d=1.5,apad=whole_dur=7,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[ta]",
    );
    expect(plan.filterGraph).toContain(
      "[4:a]atrim=0:13,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.4,afade=t=out:st=10.5:d=2.5,apad=whole_dur=13,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[ea]",
    );
  });

  it("substitutes silence when a music track or a clip's audio is missing", () => {
    const plan = buildEpisodeAssemblyPlan(
      baseInput({
        themeMusicPath: null,
        creditsMusicPath: null,
        clips: [
          { path: "/tmp/clip-0.mp4", durationSeconds: 9.5, hasAudio: true },
          { path: "/tmp/clip-1.mp4", durationSeconds: 6, hasAudio: false },
        ],
      }),
      options,
    );
    const inputs = plan.args.filter((_, i) => plan.args[i - 1] === "-i");
    expect(inputs).toEqual(["/tmp/clip-0.mp4", "/tmp/clip-1.mp4"]);
    expect(plan.filterGraph).toContain("anullsrc=r=48000:cl=stereo:d=7,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[ta]");
    expect(plan.filterGraph).toContain("anullsrc=r=48000:cl=stereo:d=13,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[ea]");
    expect(plan.filterGraph).toContain("anullsrc=r=48000:cl=stereo:d=6,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a1]");
    expect(plan.filterGraph).not.toContain("[1:a]");
    expect(plan.filterGraph).toContain("concat=n=4:v=1:a=1");
  });

  it("reports the layout the transcript is offset by: title card, clip offsets, end card, total", () => {
    const plan = buildEpisodeAssemblyPlan(baseInput({ titleCardSeconds: 8, endCardSeconds: 12 }), options);
    expect(plan.layout).toEqual({
      titleCardSeconds: 8,
      clipOffsets: [8, 17.5, 28.75],
      clipDurations: [9.5, 11.25, 8],
      endCardSeconds: 12,
      totalSeconds: 48.75,
      width: 1280,
      height: 720,
      fps: 24,
      cardText: true,
    });
  });

  it("keeps card lengths inside 6 to 8 s and 12 to 15 s", () => {
    const plan = buildEpisodeAssemblyPlan(baseInput({ titleCardSeconds: 1, endCardSeconds: 60 }), options);
    expect(plan.layout.titleCardSeconds).toBe(6);
    expect(plan.layout.endCardSeconds).toBe(15);
  });

  it("refuses to plan an episode with no clips or an unmeasured clip", () => {
    expect(() => buildEpisodeAssemblyPlan(baseInput({ clips: [] }), options)).toThrow("no clips");
    expect(() => buildEpisodeAssemblyPlan(baseInput({ clips: [{ path: "/tmp/x.mp4", durationSeconds: 0 }] }), options)).toThrow("no measured duration");
    expect(() => buildEpisodeAssemblyPlan(baseInput({ clips: [{ path: "", durationSeconds: 5 }] }), options)).toThrow("no file path");
  });

  it("defaults the output path into the work directory", () => {
    const plan = buildEpisodeAssemblyPlan(baseInput({ outputPath: undefined }), options);
    expect(plan.outputPath).toMatch(/^\/tmp\/work\/episode-\d+\.mp4$/);
  });
});

describe("assemble: audio episode plan (pure)", () => {
  it("concatenates a faded theme, the voiced episode and a faded credits tail into 48 kHz stereo PCM", () => {
    const plan = buildAudioAssemblyPlan({
      episodePath: "/tmp/episode.wav",
      themeMusicPath: "/tmp/theme.mp3",
      creditsMusicPath: "/tmp/credits.mp3",
      outputPath: "/tmp/podcast.wav",
    }, "/tmp/work");
    const inputs = plan.args.filter((_, i) => plan.args[i - 1] === "-i");
    expect(inputs).toEqual(["/tmp/episode.wav", "/tmp/theme.mp3", "/tmp/credits.mp3"]);
    expect(plan.filterGraph).toBe([
      "[1:a]atrim=0:8,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.4,afade=t=out:st=6.5:d=1.5,apad=whole_dur=8,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[intro]",
      "[0:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[episode]",
      "[2:a]atrim=0:15,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.4,afade=t=out:st=12:d=3,apad=whole_dur=15,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[outro]",
      "[intro][episode][outro]concat=n=3:v=0:a=1[out]",
    ].join(";"));
    expect(plan.args.slice(plan.args.indexOf("-map"))).toEqual(["-map", "[out]", "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2", "/tmp/podcast.wav"]);
    expect(plan.layout).toEqual({ introSeconds: AUDIO_INTRO_SECONDS, episodeOffsetSeconds: 8, outroSeconds: AUDIO_OUTRO_SECONDS });
  });

  it("drops the bumpers it has no music for and reports a zero offset", () => {
    const plan = buildAudioAssemblyPlan({ episodePath: "/tmp/episode.wav" }, "/tmp/work");
    expect(plan.filterGraph).toBe(
      "[0:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[episode];[episode]concat=n=1:v=0:a=1[out]",
    );
    expect(plan.layout).toEqual({ introSeconds: 0, episodeOffsetSeconds: 0, outroSeconds: 0 });
    expect(plan.outputPath).toMatch(/^\/tmp\/work\/episode-\d+\.wav$/);
  });

  it("refuses to plan without the voiced episode", () => {
    expect(() => buildAudioAssemblyPlan({ episodePath: "" }, "/tmp/work")).toThrow("without the voiced episode");
  });
});

describe("assemble: runners (ffmpeg mocked)", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.mocked(execFile).mockReset();
    vi.mocked(probeMedia).mockReset();
    _resetDrawtextProbe();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "assemble-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function mockFfmpeg(handler: (args: string[]) => { stdout?: string; error?: Error; onRender?: () => void }) {
    vi.mocked(execFile).mockImplementation((_bin: any, args: any, _opts: any, callback?: any): any => {
      const cb = typeof _opts === "function" ? _opts : callback;
      const result = handler(args as string[]);
      if (result.error) {
        cb(Object.assign(result.error, { stderr: "boom from ffmpeg" }));
      } else {
        result.onRender?.();
        cb(null, { stdout: result.stdout ?? "", stderr: "" });
      }
      return {} as any;
    });
  }

  it("assembleEpisode probes unmeasured clips, writes the card text files, runs the plan, then removes them", async () => {
    const font = path.join(tmpDir, "Syne-Bold.ttf");
    fs.writeFileSync(font, "font-bytes");
    const output = path.join(tmpDir, "episode.mp4");
    vi.mocked(probeMedia).mockResolvedValue({ durationSeconds: 9, hasAudio: true, hasVideo: true, width: 1366, height: 768, fps: 24, raw: "" });

    const seenArgs: string[][] = [];
    let textFilesDuringRender: string[] = [];
    mockFfmpeg((args) => {
      seenArgs.push(args);
      if (args.includes("-filters")) {
        return { stdout: " T.C drawtext V->V Draw text\n ..C concat N->N" };
      }
      return {
        onRender: () => {
          textFilesDuringRender = fs.readdirSync(path.join(os.tmpdir(), "interdimensional-cable")).filter(f => /^(?:title|end)-\d+\.txt$/.test(f));
          fs.writeFileSync(output, "mp4");
        },
      };
    });

    const result = await assembleEpisode({
      clips: [{ path: "/tmp/a.mp4", durationSeconds: 9 }],
      showName: "SNL Like",
      episodeTitle: "Blimps",
      themeMusicPath: "/tmp/theme.mp3",
      creditsMusicPath: "/tmp/credits.mp3",
      outputPath: output,
    }, font);

    expect(probeMedia).toHaveBeenCalledWith("/tmp/a.mp4");
    expect(result.outputPath).toBe(output);
    expect(result.layout.width).toBe(1366);
    expect(result.layout.height).toBe(768);
    expect(result.layout.cardText).toBe(true);
    expect(result.layout.clipOffsets).toEqual([7]);
    expect(seenArgs).toHaveLength(2);
    expect(seenArgs[0]).toEqual(["-hide_banner", "-filters"]);
    expect(seenArgs[1]).toContain("-filter_complex");
    expect(seenArgs[1].at(-1)).toBe(output);
    // Text files existed while ffmpeg ran and are gone afterwards.
    expect(textFilesDuringRender.length).toBeGreaterThanOrEqual(3);
    for (const name of textFilesDuringRender) {
      expect(fs.existsSync(path.join(os.tmpdir(), "interdimensional-cable", name))).toBe(false);
    }
  });

  it("falls back to plain cards, with a warning, when the font is missing or ffmpeg lacks drawtext", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await resolveCardFont(path.join(tmpDir, "missing.ttf"))).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Card font not found"));

    const font = path.join(tmpDir, "Syne-Bold.ttf");
    fs.writeFileSync(font, "font-bytes");
    mockFfmpeg(args => (args.includes("-filters") ? { stdout: " ..C concat N->N" } : {}));
    expect(await resolveCardFont(font)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no drawtext filter"));
  });

  it("surfaces ffmpeg's stderr when assembly fails and refuses a missing output", async () => {
    const output = path.join(tmpDir, "episode.mp4");
    mockFfmpeg(args => (args.includes("-filters") ? { stdout: "drawtext" } : { error: new Error("exit 1") }));
    await expect(assembleEpisode({
      clips: [{ path: "/tmp/a.mp4", durationSeconds: 5, hasAudio: true }],
      showName: "A",
      episodeTitle: "B",
      outputPath: output,
      width: 1280,
      height: 720,
    }, path.join(tmpDir, "missing.ttf"))).rejects.toThrow("ffmpeg failed to assemble the episode: boom from ffmpeg");

    mockFfmpeg(() => ({}));
    await expect(assembleAudioEpisode({ episodePath: "/tmp/e.wav", outputPath: path.join(tmpDir, "never-written.wav") }))
      .rejects
      .toThrow("does not exist");
  });

  it("assembleAudioEpisode runs the audio plan and returns the intro offset", async () => {
    const output = path.join(tmpDir, "podcast.wav");
    let args: string[] = [];
    mockFfmpeg((a) => {
      args = a;
      return { onRender: () => fs.writeFileSync(output, "wav") };
    });
    const result = await assembleAudioEpisode({
      episodePath: "/tmp/e.wav",
      themeMusicPath: "/tmp/t.mp3",
      creditsMusicPath: "/tmp/c.mp3",
      outputPath: output,
    });
    expect(result.outputPath).toBe(output);
    expect(result.layout).toEqual({ introSeconds: 8, episodeOffsetSeconds: 8, outroSeconds: 15 });
    expect(args.at(-1)).toBe(output);
    expect(args).toContain("pcm_s16le");
  });
});
