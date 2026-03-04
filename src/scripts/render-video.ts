import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadDotenv } from "../lib/env.js";
import { findPlanFiles, type AudioManifest, type VideoPlan, type VideoScript } from "../lib/pipeline.js";
import { readJson, writeJson } from "../lib/io.js";
import { StyleGuideSchema, type StyleGuide } from "../lib/schema.js";

const ROOT = process.cwd();
const STYLE_PATH = path.join(ROOT, "config", "style-guide.json");

function resolveBuildDir(): string {
  const fromEnv = process.env.PIPELINE_BUILD_DIR?.trim();
  if (!fromEnv) return path.join(ROOT, "build");
  return path.isAbsolute(fromEnv) ? fromEnv : path.join(ROOT, fromEnv);
}

type TimedSegment = {
  segmentId: string;
  index: number;
  durationSec: number;
  caption: string;
};

type SubtitleCue = {
  startSec: number;
  endSec: number;
  text: string;
};

const FRAME_W = 1080;
const FRAME_H = 1920;

function ffmpegBin(): string {
  return process.env.FFMPEG_PATH?.trim() || "ffmpeg";
}

function ffmpegAvailable(): boolean {
  const probe = spawnSync(ffmpegBin(), ["-version"], { encoding: "utf-8" });
  return probe.status === 0;
}

function formatSrtTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(
    milli
  ).padStart(3, "0")}`;
}

function formatAssTime(sec: number): string {
  const centis = Math.round(sec * 100);
  const h = Math.floor(centis / 360000);
  const m = Math.floor((centis % 360000) / 6000);
  const s = Math.floor((centis % 6000) / 100);
  const cs = centis % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function loadStyleGuide(): StyleGuide {
  const parsed = StyleGuideSchema.safeParse(readJson<unknown>(STYLE_PATH));
  if (!parsed.success) {
    throw new Error(`style-guide.json invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

function splitByPunctuation(text: string): string[] {
  const cleaned = text.trim().replace(/\s+/g, "");
  if (!cleaned) return [];
  // Split by sentence-level punctuation first.
  const tokens = cleaned.split(/(?<=[。！？!?；;])/).map((s) => s.trim()).filter(Boolean);
  return tokens.length > 0 ? tokens : [cleaned];
}

function chunkText(tokens: string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const token of tokens) {
    const t = token.trim();
    if (!t) continue;
    if (!current) {
      current = t;
      continue;
    }
    if ((current + t).length <= maxChars) {
      current += t;
    } else {
      chunks.push(current);
      current = t;
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [tokens.join("")];
}

function splitLongChunk(chunk: string, maxChars: number): string[] {
  if (chunk.length <= maxChars) return [chunk];
  const out: string[] = [];
  let cursor = 0;
  while (cursor < chunk.length) {
    out.push(chunk.slice(cursor, cursor + maxChars));
    cursor += maxChars;
  }
  return out;
}

function wrapLines(text: string, maxCharsPerLine: number, maxLines: number): string {
  const cleaned = text.replace(/\s+/g, "");
  if (maxLines <= 1 || cleaned.length <= maxCharsPerLine) return cleaned;

  const maxCharsPerCue = maxCharsPerLine * maxLines;
  if (cleaned.length > maxCharsPerCue) {
    const first = cleaned.slice(0, maxCharsPerLine);
    const second = cleaned.slice(maxCharsPerLine, maxCharsPerCue);
    return `${first}\n${second}`;
  }

  // Two-line layout: break near center, prefer punctuation for readability.
  const center = Math.floor(cleaned.length / 2);
  const minBreak = Math.max(4, Math.floor(cleaned.length * 0.35));
  const maxBreak = Math.min(cleaned.length - 2, Math.ceil(cleaned.length * 0.65));
  const punct = /[，、：,:；;]/;

  let best = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = minBreak; i <= maxBreak; i += 1) {
    if (!punct.test(cleaned[i - 1])) continue;
    const d = Math.abs(i - center);
    if (d < bestDist) {
      best = i;
      bestDist = d;
    }
  }

  const splitAt = best > 0 ? best : Math.min(maxCharsPerLine, cleaned.length - 1);
  return `${cleaned.slice(0, splitAt)}\n${cleaned.slice(splitAt)}`;
}

function splitLongSentence(sentence: string, maxCharsPerCue: number): string[] {
  const cleaned = sentence.trim().replace(/\s+/g, "");
  if (!cleaned) return [];
  if (cleaned.length <= maxCharsPerCue) return [cleaned];

  // Prefer clause-level splits so we do not break in awkward positions.
  const clauses = cleaned.split(/(?<=[，、：,:；;])/).map((s) => s.trim()).filter(Boolean);
  if (clauses.length <= 1) {
    return splitLongChunk(cleaned, maxCharsPerCue);
  }

  const merged = chunkText(clauses, maxCharsPerCue);
  return merged.flatMap((chunk) => splitLongChunk(chunk, maxCharsPerCue));
}

function buildSubtitleCues(
  segments: TimedSegment[],
  maxCharsPerLine: number,
  maxLines: number
): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let cursor = 0;
  const minCueDurationSec = 0.9;
  const maxCharsPerCue = Math.max(maxCharsPerLine, maxCharsPerLine * maxLines);

  for (const segment of segments) {
    const segStart = cursor;
    const segEnd = cursor + segment.durationSec;
    const sentenceChunks = splitByPunctuation(segment.caption);
    const chunked = sentenceChunks.flatMap((sentence) => splitLongSentence(sentence, maxCharsPerCue));
    const weighted = chunked.map((c) => Math.max(1, c.length));
    const totalWeight = Math.max(1, weighted.reduce((a, b) => a + b, 0));

    let localCursor = segStart;
    for (let i = 0; i < chunked.length; i += 1) {
      const remainingChunks = chunked.length - i;
      const remainingTime = segEnd - localCursor;
      const ideal = segment.durationSec * (weighted[i] / totalWeight);
      // keep each cue readable and guarantee last cues have time left.
      const maxAllowed = Math.max(0.2, remainingTime - minCueDurationSec * (remainingChunks - 1));
      const duration =
        i === chunked.length - 1 ? remainingTime : Math.min(Math.max(ideal, minCueDurationSec), maxAllowed);
      const cueEnd = i === chunked.length - 1 ? segEnd : localCursor + Math.max(0.2, duration);
      cues.push({
        startSec: localCursor,
        endSec: cueEnd,
        text: wrapLines(chunked[i], maxCharsPerLine, maxLines)
      });
      localCursor = cueEnd;
    }
    cursor = segEnd;
  }

  return cues;
}

function normalizeTimedSegments(plan: VideoPlan, script: VideoScript, manifest?: AudioManifest): TimedSegment[] {
  const defaultDurations = plan.shots.map((shot) => shot.seconds);
  let manifestDurations = defaultDurations;
  let manifestTexts: Array<string | undefined> = defaultDurations.map(() => undefined);

  if (manifest && Array.isArray(manifest.segments) && manifest.segments.length === plan.shots.length) {
    if (typeof manifest.segments[0] !== "string") {
      manifestDurations = (manifest.segments as Array<{ durationSec?: number; text?: string }>).map(
        (seg, i) => seg.durationSec ?? defaultDurations[i]
      );
      manifestTexts = (manifest.segments as Array<{ text?: string }>).map((seg) => seg.text?.trim() || undefined);
    }
  }

  return plan.shots.map((shot, i) => ({
    segmentId: shot.segmentId,
    index: i + 1,
    durationSec: Math.max(0.3, manifestDurations[i] ?? defaultDurations[i]),
    caption:
      manifestTexts[i] ||
      script.segments[i]?.narration?.trim() ||
      script.segments[i]?.onscreenText?.trim() ||
      shot.goal
  }));
}

function writeSrt(videoDir: string, cues: SubtitleCue[]): string {
  const lines: string[] = [];
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i];
    lines.push(String(i + 1));
    lines.push(`${formatSrtTime(cue.startSec)} --> ${formatSrtTime(cue.endSec)}`);
    lines.push(cue.text);
    lines.push("");
  }

  const srtPath = path.join(videoDir, "captions.srt");
  fs.writeFileSync(srtPath, lines.join("\n"), "utf-8");
  return srtPath;
}

function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\n/g, "\\N");
}

function findImageForSegment(imagesDir: string, segment: TimedSegment): string {
  const prefix = `${String(segment.index).padStart(2, "0")}-${segment.segmentId}`;
  const image = fs
    .readdirSync(imagesDir)
    .find((name) => name.startsWith(prefix) && /\.(png|jpg|jpeg|webp)$/i.test(name));
  if (!image) {
    throw new Error(`Cannot find image for segment ${segment.segmentId} in ${imagesDir}`);
  }
  return path.join(imagesDir, image);
}

function computeSubtitleTopMargin(): number {
  const fromEnv = Number(process.env.SUBTITLE_TOP_MARGIN || "");
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.max(200, Math.min(FRAME_H - 200, Math.round(fromEnv)));
  }
  // Fixed baseline keeps all videos visually consistent regardless of slide aspect ratio.
  return 1361;
}

function normalizeSlideImage(inputPath: string, outputPath: string): void {
  const vf = [
    `scale=${FRAME_W}:${FRAME_H}:force_original_aspect_ratio=decrease`,
    `pad=${FRAME_W}:${FRAME_H}:(ow-iw)/2:(oh-ih)/2:color=0x0F1624`
  ].join(",");
  const ff = spawnSync(
    ffmpegBin(),
    ["-y", "-i", inputPath, "-vf", vf, "-frames:v", "1", outputPath],
    { encoding: "utf-8", maxBuffer: 1024 * 1024 * 10 }
  );
  if (ff.status !== 0) {
    throw new Error(`normalize slide failed for ${inputPath}\n${ff.stderr || ff.stdout}`);
  }
}

function writeAss(videoDir: string, cues: SubtitleCue[], subtitleTopMargin: number): string {
  const baseFontSize = 52;
  const sideMargin = 20;
  const assLines: string[] = [];
  assLines.push("[Script Info]");
  assLines.push("ScriptType: v4.00+");
  assLines.push(`PlayResX: ${FRAME_W}`);
  assLines.push(`PlayResY: ${FRAME_H}`);
  assLines.push("WrapStyle: 2");
  assLines.push("ScaledBorderAndShadow: yes");
  assLines.push("");
  assLines.push("[V4+ Styles]");
  assLines.push(
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding"
  );
  assLines.push(
    `Style: Default,PingFang SC,${baseFontSize},&H00FFFFFF,&H000000FF,&H0024160F,&H0024160F,1,0,0,0,100,100,0,0,3,0.8,0,8,${sideMargin},${sideMargin},${subtitleTopMargin},1`
  );
  assLines.push("");
  assLines.push("[Events]");
  assLines.push("Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text");

  for (const cue of cues) {
    const start = formatAssTime(cue.startSec);
    const end = formatAssTime(cue.endSec);
    const text = escapeAssText(cue.text);
    assLines.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`);
  }

  const assPath = path.join(videoDir, "captions.ass");
  fs.writeFileSync(assPath, `${assLines.join("\n")}\n`, "utf-8");
  return assPath;
}

function writeSlides(videoDir: string, segments: TimedSegment[]): string {
  const imagesDir = path.join(videoDir, "images");
  if (!fs.existsSync(imagesDir)) {
    throw new Error(`Missing images dir: ${imagesDir}`);
  }
  const normalizedDir = path.join(videoDir, "slides-normalized");
  fs.rmSync(normalizedDir, { recursive: true, force: true });
  fs.mkdirSync(normalizedDir, { recursive: true });

  const lines: string[] = [];
  let lastNormalizedPath = "";
  for (const segment of segments) {
    const imagePath = findImageForSegment(imagesDir, segment);
    const normalizedPath = path.join(
      normalizedDir,
      `${String(segment.index).padStart(2, "0")}-${segment.segmentId}.png`
    );
    normalizeSlideImage(imagePath, normalizedPath);
    lines.push(`file '${normalizedPath.replace(/'/g, "'\\''")}'`);
    lines.push(`duration ${segment.durationSec.toFixed(3)}`);
    lastNormalizedPath = normalizedPath;
  }

  // concat demuxer expects the last image to appear twice to honor its duration
  if (!lastNormalizedPath) {
    throw new Error("No slides available after normalization.");
  }
  lines.push(`file '${lastNormalizedPath.replace(/'/g, "'\\''")}'`);

  const slidesPath = path.join(videoDir, "slides.txt");
  fs.writeFileSync(slidesPath, `${lines.join("\n")}\n`, "utf-8");
  return slidesPath;
}

function renderOne(videoDir: string): void {
  const styleGuide = loadStyleGuide();
  const plan = readJson<VideoPlan>(path.join(videoDir, "plan.json"));
  const script = readJson<VideoScript>(path.join(videoDir, "script.json"));
  if (plan.shots.length !== script.segments.length) {
    throw new Error(`${plan.videoId}: plan/script segment mismatch`);
  }

  const audioMp3 = path.join(videoDir, "audio", "narration.mp3");
  const audioWav = path.join(videoDir, "audio", "narration.wav");
  const audioInput = fs.existsSync(audioMp3) ? audioMp3 : audioWav;
  if (!fs.existsSync(audioInput)) {
    throw new Error(`${plan.videoId}: missing merged narration audio`);
  }

  const audioManifestPath = path.join(videoDir, "audio-manifest.json");
  const audioManifest = fs.existsSync(audioManifestPath)
    ? readJson<AudioManifest>(audioManifestPath)
    : undefined;
  const timedSegments = normalizeTimedSegments(plan, script, audioManifest);
  const cues = buildSubtitleCues(
    timedSegments,
    styleGuide.subtitle.maxCharsPerLine ?? 16,
    styleGuide.subtitle.maxLines ?? 2
  );
  const subtitleTopMargin = computeSubtitleTopMargin();

  const slidesPath = writeSlides(videoDir, timedSegments);
  const srtPath = writeSrt(videoDir, cues);
  const assPath = writeAss(videoDir, cues, subtitleTopMargin);
  const outputPath = path.join(videoDir, "final.mp4");
  const subtitleEnabled = String(process.env.SUBTITLE_ENABLED || "true").toLowerCase() !== "false";
  const subtitleFilter = subtitleEnabled ? `ass=${assPath}` : null;

  const vfParts = [
    // Keep full source frame (for NotebookLM landscape slides) and pad to 9:16.
    "scale=1080:1920:force_original_aspect_ratio=decrease",
    "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x0F1624",
    `fps=${plan.constraints.fps}`,
    // Reset timeline to 0 so subtitle timing stays stable even if slide source timestamps are offset.
    "setpts=PTS-STARTPTS",
    "format=yuv420p"
  ];
  if (subtitleFilter) vfParts.push(subtitleFilter);
  const vf = vfParts.join(",");

  const args = [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    slidesPath,
    "-i",
    audioInput,
    "-vf",
    vf,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "21",
    "-c:a",
    "aac",
    "-shortest",
    outputPath
  ];

  const ff = spawnSync(ffmpegBin(), args, {
    encoding: "utf-8",
    maxBuffer: 1024 * 1024 * 10
  });
  if (ff.status !== 0) {
    throw new Error(`${plan.videoId}: ffmpeg render failed\n${ff.stderr || ff.stdout}`);
  }

  writeJson(path.join(videoDir, "render-manifest.json"), {
    videoId: plan.videoId,
    generatedAt: new Date().toISOString(),
    output: outputPath,
    audioInput,
    subtitles: srtPath,
    assSubtitles: assPath,
    slides: slidesPath
  });
  console.log(`[${plan.videoId}] render -> ${outputPath}`);
}

function main(): void {
  loadDotenv();
  const buildDir = resolveBuildDir();
  if (!ffmpegAvailable()) {
    throw new Error(
      `ffmpeg is required for render. Set FFMPEG_PATH in .env, current bin: ${ffmpegBin()}`
    );
  }

  const planFiles = findPlanFiles(buildDir);
  if (planFiles.length === 0) {
    throw new Error("No plan.json found. Run `npm run plan` first.");
  }

  for (const planFile of planFiles) {
    renderOne(path.dirname(planFile));
  }
}

main();
