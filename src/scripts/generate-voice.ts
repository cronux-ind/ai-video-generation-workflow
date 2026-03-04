import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadDotenv } from "../lib/env.js";
import { findPlanFiles, type VideoScript } from "../lib/pipeline.js";
import { readJson, writeJson } from "../lib/io.js";
import { geminiGenerateAudio } from "../lib/gemini.js";

type ElevenVoicesResponse = {
  voices?: Array<{
    voice_id: string;
    name: string;
    category?: string;
    labels?: Record<string, string>;
  }>;
};

type Provider = "edge" | "elevenlabs" | "gemini";

type GeneratedSegment = {
  segmentId: string;
  index: number;
  file: string;
  durationSec: number;
  text: string;
};

type ProviderRunResult = {
  provider: Provider;
  meta: Record<string, string>;
  segments: GeneratedSegment[];
};

const ROOT = process.cwd();

function resolveBuildDir(): string {
  const fromEnv = process.env.PIPELINE_BUILD_DIR?.trim();
  if (!fromEnv) return path.join(ROOT, "build");
  return path.isAbsolute(fromEnv) ? fromEnv : path.join(ROOT, fromEnv);
}

function ffmpegBin(): string {
  return process.env.FFMPEG_PATH?.trim() || "ffmpeg";
}

function hasFfmpeg(): boolean {
  const probe = spawnSync(ffmpegBin(), ["-version"], { encoding: "utf-8" });
  return probe.status === 0;
}

function parseDurationToSec(text: string): number {
  const match = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return 0;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  const ss = Number(match[3]);
  return hh * 3600 + mm * 60 + ss;
}

function parseWavDurationSec(filePath: string): number {
  const buf = fs.readFileSync(filePath);
  const riff = buf.toString("ascii", 0, 4);
  const wave = buf.toString("ascii", 8, 12);
  if (riff !== "RIFF" || wave !== "WAVE") return 0;
  const sampleRate = buf.readUInt32LE(24);
  const channels = buf.readUInt16LE(22);
  const bitsPerSample = buf.readUInt16LE(34);
  const dataSize = buf.readUInt32LE(40);
  const bytesPerSec = (sampleRate * channels * bitsPerSample) / 8;
  if (!bytesPerSec) return 0;
  return dataSize / bytesPerSec;
}

function getAudioDurationSec(filePath: string): number {
  if (hasFfmpeg()) {
    const probe = spawnSync(ffmpegBin(), ["-i", filePath], { encoding: "utf-8" });
    const parsed = parseDurationToSec(`${probe.stderr}\n${probe.stdout}`);
    if (parsed > 0) return parsed;
  }
  if (filePath.endsWith(".wav")) {
    const parsed = parseWavDurationSec(filePath);
    if (parsed > 0) return parsed;
  }
  return 0;
}

function hasEdgeTts(): boolean {
  const probe = spawnSync("python3", ["-m", "edge_tts", "--help"], { encoding: "utf-8" });
  return probe.status === 0;
}

async function resolveVoiceId(apiKey: string): Promise<{ voiceId: string; voiceName: string }> {
  const fromEnv = process.env.ELEVENLABS_VOICE_ID?.trim();
  if (fromEnv) {
    return { voiceId: fromEnv, voiceName: "from-env" };
  }

  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": apiKey }
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Failed to fetch voices (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = JSON.parse(text) as ElevenVoicesResponse;
  const voices = data.voices ?? [];
  if (voices.length === 0) {
    throw new Error("No voices found in ElevenLabs account.");
  }

  const zhPreferred = voices.find((v) =>
    Object.values(v.labels ?? {}).some((value) => /zh|chinese|mandarin/i.test(value))
  );
  const picked = zhPreferred ?? voices[0];
  return { voiceId: picked.voice_id, voiceName: picked.name };
}

async function elevenTts(apiKey: string, voiceId: string, text: string): Promise<Buffer> {
  const modelId = process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";
  const payload = {
    text,
    model_id: modelId,
    output_format: "mp3_44100_128",
    voice_settings: {
      stability: Number(process.env.ELEVENLABS_STABILITY || "0.45"),
      similarity_boost: Number(process.env.ELEVENLABS_SIMILARITY || "0.75"),
      style: Number(process.env.ELEVENLABS_STYLE || "0.25"),
      use_speaker_boost: true
    }
  };

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg"
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90000)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ElevenLabs TTS failed (${res.status}): ${errText.slice(0, 300)}`);
  }
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

function pcm16ToWav(pcm: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcm.length;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcm.copy(buffer, 44);
  return buffer;
}

function parseRateFromMime(mimeType: string): number {
  const match = mimeType.match(/rate=(\d+)/i);
  return match ? Number(match[1]) : 24000;
}

async function geminiTts(text: string): Promise<Buffer> {
  const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "";
  if (!apiKey) throw new Error("Missing GOOGLE_API_KEY (or GEMINI_API_KEY) for Gemini TTS fallback");

  const model = process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts";
  const voiceName = process.env.GEMINI_TTS_VOICE || "Kore";
  const audio = await geminiGenerateAudio({
    apiKey,
    model,
    text,
    voiceName,
    timeoutMs: 120000
  });
  const pcm = Buffer.from(audio.base64Data, "base64");
  const sampleRate = parseRateFromMime(audio.mimeType);
  return pcm16ToWav(pcm, sampleRate);
}

function edgeTtsToFile(text: string, outputPath: string): void {
  const voice = process.env.EDGE_TTS_VOICE || "zh-CN-XiaoxiaoNeural";
  const rate = process.env.EDGE_TTS_RATE || "+0%";
  const pitch = process.env.EDGE_TTS_PITCH || "+0Hz";
  const volume = process.env.EDGE_TTS_VOLUME || "+0%";
  const proc = spawnSync(
    "python3",
    [
      "-m",
      "edge_tts",
      "--voice",
      voice,
      `--rate=${rate}`,
      `--pitch=${pitch}`,
      `--volume=${volume}`,
      "--text",
      text,
      "--write-media",
      outputPath
    ],
    { encoding: "utf-8", maxBuffer: 1024 * 1024 * 8 }
  );
  if (proc.status !== 0) {
    throw new Error(`edge-tts failed: ${proc.stderr || proc.stdout}`);
  }
}

function concatAudio(segmentFiles: string[], outputPath: string): void {
  const tempList = path.join(path.dirname(outputPath), "concat-list.txt");
  const lines = segmentFiles.map((file) => `file '${file.replace(/'/g, "'\\''")}'`);
  fs.writeFileSync(tempList, `${lines.join("\n")}\n`, "utf-8");

  const ffmpeg = spawnSync(
    ffmpegBin(),
    ["-y", "-f", "concat", "-safe", "0", "-i", tempList, "-c:a", "libmp3lame", "-q:a", "2", outputPath],
    { encoding: "utf-8" }
  );
  fs.unlinkSync(tempList);

  if (ffmpeg.status !== 0) {
    throw new Error(`ffmpeg concat failed: ${ffmpeg.stderr || ffmpeg.stdout}`);
  }
}

function parseWavMeta(file: Buffer): { sampleRate: number; channels: number; bitsPerSample: number; dataStart: number } {
  const riff = file.toString("ascii", 0, 4);
  const wave = file.toString("ascii", 8, 12);
  if (riff !== "RIFF" || wave !== "WAVE") throw new Error("Invalid WAV header");

  const sampleRate = file.readUInt32LE(24);
  const channels = file.readUInt16LE(22);
  const bitsPerSample = file.readUInt16LE(34);
  const dataStart = 44;
  return { sampleRate, channels, bitsPerSample, dataStart };
}

function mergeWavFiles(segmentFiles: string[], outputPath: string): void {
  if (segmentFiles.length === 0) throw new Error("No wav segments to merge");
  const first = fs.readFileSync(segmentFiles[0]);
  const meta = parseWavMeta(first);
  const chunks: Buffer[] = [first.slice(meta.dataStart)];

  for (const filePath of segmentFiles.slice(1)) {
    const buf = fs.readFileSync(filePath);
    const m = parseWavMeta(buf);
    if (
      m.sampleRate !== meta.sampleRate ||
      m.channels !== meta.channels ||
      m.bitsPerSample !== meta.bitsPerSample
    ) {
      throw new Error("WAV segment format mismatch");
    }
    chunks.push(buf.slice(m.dataStart));
  }

  const pcm = Buffer.concat(chunks);
  const merged = pcm16ToWav(pcm, meta.sampleRate, meta.channels, meta.bitsPerSample);
  fs.writeFileSync(outputPath, merged);
}

function shouldFallbackToGemini(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("quota_exceeded") ||
    normalized.includes("exceeds your api key") ||
    normalized.includes("insufficient") ||
    normalized.includes("credits remaining")
  );
}

async function buildVideoAudioWithEleven(
  script: VideoScript,
  audioDir: string,
  apiKey: string,
  voiceId: string
): Promise<GeneratedSegment[]> {
  const segments: GeneratedSegment[] = [];
  for (const [idx, segment] of script.segments.entries()) {
    const fileName = `${String(idx + 1).padStart(2, "0")}-${segment.segmentId}.mp3`;
    const outFile = path.join(audioDir, fileName);
    const buffer = await elevenTts(apiKey, voiceId, segment.narration);
    fs.writeFileSync(outFile, buffer);
    segments.push({
      segmentId: segment.segmentId,
      index: idx + 1,
      file: outFile,
      durationSec: getAudioDurationSec(outFile),
      text: segment.narration
    });
    console.log(`[${script.videoId}] audio #${idx + 1} -> ${fileName}`);
  }
  return segments;
}

async function buildVideoAudioWithGemini(script: VideoScript, audioDir: string): Promise<GeneratedSegment[]> {
  const segments: GeneratedSegment[] = [];
  for (const [idx, segment] of script.segments.entries()) {
    const fileName = `${String(idx + 1).padStart(2, "0")}-${segment.segmentId}.wav`;
    const outFile = path.join(audioDir, fileName);
    const buffer = await geminiTts(segment.narration);
    fs.writeFileSync(outFile, buffer);
    segments.push({
      segmentId: segment.segmentId,
      index: idx + 1,
      file: outFile,
      durationSec: getAudioDurationSec(outFile),
      text: segment.narration
    });
    console.log(`[${script.videoId}] audio #${idx + 1} -> ${fileName} (gemini)`);
  }
  return segments;
}

async function buildVideoAudioWithEdge(script: VideoScript, audioDir: string): Promise<GeneratedSegment[]> {
  if (!hasEdgeTts()) {
    throw new Error("edge-tts is not installed. Run: python3 -m pip install edge-tts");
  }
  const segments: GeneratedSegment[] = [];
  for (const [idx, segment] of script.segments.entries()) {
    const fileName = `${String(idx + 1).padStart(2, "0")}-${segment.segmentId}.mp3`;
    const outFile = path.join(audioDir, fileName);
    edgeTtsToFile(segment.narration, outFile);
    segments.push({
      segmentId: segment.segmentId,
      index: idx + 1,
      file: outFile,
      durationSec: getAudioDurationSec(outFile),
      text: segment.narration
    });
    console.log(`[${script.videoId}] audio #${idx + 1} -> ${fileName} (edge)`);
  }
  return segments;
}

function pickProvidersInOrder(): Provider[] {
  const requested = (process.env.VOICE_PROVIDER || "auto").toLowerCase();
  const hasEleven = Boolean(process.env.ELEVENLABS_API_KEY);
  const hasEdge = hasEdgeTts();

  if (requested === "edge") return hasEleven ? ["edge", "elevenlabs", "gemini"] : ["edge", "gemini"];
  if (requested === "elevenlabs") return hasEdge ? ["elevenlabs", "edge", "gemini"] : ["elevenlabs", "gemini"];
  if (requested === "gemini") return ["gemini"];
  if (requested !== "auto") {
    throw new Error(`Unsupported VOICE_PROVIDER=${requested}. Use auto|edge|elevenlabs|gemini.`);
  }

  // Chinese default: prefer edge-tts for natural CN rhythm, then ElevenLabs, then Gemini.
  if (hasEdge && hasEleven) return ["edge", "elevenlabs", "gemini"];
  if (hasEdge) return ["edge", "gemini"];
  if (hasEleven) return ["elevenlabs", "gemini"];
  return ["gemini"];
}

function onlyFiles(segments: GeneratedSegment[]): string[] {
  return segments.map((s) => s.file);
}

async function tryGenerateByProvider(
  provider: Provider,
  script: VideoScript,
  audioDir: string,
  elevenApiKey: string,
  voiceId: string,
  voiceName: string
): Promise<ProviderRunResult> {
  if (provider === "edge") {
    const segments = await buildVideoAudioWithEdge(script, audioDir);
    return {
      provider,
      meta: {
        modelId: "edge-tts",
        voice: process.env.EDGE_TTS_VOICE || "zh-CN-XiaoxiaoNeural"
      },
      segments
    };
  }

  if (provider === "elevenlabs") {
    if (!elevenApiKey) throw new Error("ELEVENLABS_API_KEY missing");
    const segments = await buildVideoAudioWithEleven(script, audioDir, elevenApiKey, voiceId);
    return {
      provider,
      meta: {
        modelId: process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2",
        voiceId,
        voiceName
      },
      segments
    };
  }

  const segments = await buildVideoAudioWithGemini(script, audioDir);
  return {
    provider: "gemini",
    meta: {
      modelId: process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts",
      voice: process.env.GEMINI_TTS_VOICE || "Kore"
    },
    segments
  };
}

async function main(): Promise<void> {
  loadDotenv();
  const buildDir = resolveBuildDir();
  const elevenApiKey = process.env.ELEVENLABS_API_KEY || "";
  let voiceId = "";
  let voiceName = "";
  if (elevenApiKey) {
    const voice = await resolveVoiceId(elevenApiKey);
    voiceId = voice.voiceId;
    voiceName = voice.voiceName;
    console.log(`Using ElevenLabs voice: ${voiceId} (${voiceName})`);
  }
  const providerOrder = pickProvidersInOrder();
  console.log(`Voice provider order: ${providerOrder.join(" -> ")}`);

  const planFiles = findPlanFiles(buildDir);
  if (planFiles.length === 0) throw new Error("No plan.json found. Run `npm run plan` first.");

  for (const planFile of planFiles) {
    const videoDir = path.dirname(planFile);
    const scriptPath = path.join(videoDir, "script.json");
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Missing ${scriptPath}. Run \`npm run script:gen\` first.`);
    }

    const script = readJson<VideoScript>(scriptPath);
    const audioDir = path.join(videoDir, "audio");
    fs.rmSync(audioDir, { recursive: true, force: true });
    fs.mkdirSync(audioDir, { recursive: true });

    let result: ProviderRunResult | null = null;
    const errors: string[] = [];
    for (const provider of providerOrder) {
      fs.rmSync(audioDir, { recursive: true, force: true });
      fs.mkdirSync(audioDir, { recursive: true });
      try {
        result = await tryGenerateByProvider(provider, script, audioDir, elevenApiKey, voiceId, voiceName);
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${provider}: ${message}`);
        if (provider === "elevenlabs" && shouldFallbackToGemini(message)) {
          console.warn(
            `[${script.videoId}] ElevenLabs quota/auth issue, switching provider. detail: ${message}`
          );
        } else {
          console.warn(`[${script.videoId}] ${provider} failed: ${message}`);
        }
      }
    }
    if (!result) {
      throw new Error(`[${script.videoId}] all voice providers failed -> ${errors.join(" | ")}`);
    }

    const canUseFfmpeg = hasFfmpeg();
    const mergedPath = path.join(audioDir, canUseFfmpeg ? "narration.mp3" : "narration.wav");
    let merged = false;
    let mergeError = "";
    if (canUseFfmpeg) {
      try {
        concatAudio(onlyFiles(result.segments), mergedPath);
        merged = true;
      } catch (err) {
        mergeError = err instanceof Error ? err.message : String(err);
      }
    } else if (onlyFiles(result.segments).every((f) => f.endsWith(".wav"))) {
      try {
        mergeWavFiles(onlyFiles(result.segments), mergedPath);
        merged = true;
      } catch (err) {
        mergeError = err instanceof Error ? err.message : String(err);
      }
    } else {
      mergeError = "ffmpeg not found in PATH and segment format is not WAV.";
    }

    writeJson(path.join(videoDir, "audio-manifest.json"), {
      videoId: script.videoId,
      generatedAt: new Date().toISOString(),
      provider: result.provider,
      ...result.meta,
      mergedNarration: merged ? mergedPath : null,
      mergeError: merged ? null : mergeError,
      segments: result.segments
    });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
