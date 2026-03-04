import fs from "node:fs";
import path from "node:path";

export type PlannedShot = {
  segmentId: string;
  startSec: number;
  endSec: number;
  seconds: number;
  goal: string;
  narrationBrief: string;
  imagePromptBrief: string;
};

export type VideoPlan = {
  videoId: string;
  title: string;
  term: string;
  targetAudience: string;
  constraints: {
    totalSeconds: number;
    aspectRatio: string;
    fps: number;
    targetWpm: number;
  };
  style: {
    voicePersona: string;
    visualStylePrompt: string;
    visualNegativePrompt: string;
    visualDirectionName?: string;
    visualDirectionPrompt?: string;
    visualReferenceKeywords?: string[];
    consistencySeed: number;
  };
  shots: PlannedShot[];
};

export type ScriptSegment = {
  segmentId: string;
  seconds: number;
  narration: string;
  onscreenText: string;
};

export type VideoScript = {
  videoId: string;
  title: string;
  segments: ScriptSegment[];
  generatedBy: {
    provider: string;
    model: string;
    generatedAt: string;
  };
};

export type AudioManifestSegment = {
  segmentId: string;
  index: number;
  file: string;
  durationSec: number;
  text?: string;
};

export type AudioManifest = {
  videoId: string;
  generatedAt: string;
  provider: string;
  modelId?: string;
  voice?: string;
  voiceId?: string;
  voiceName?: string;
  mergedNarration: string | null;
  mergeError: string | null;
  segments: AudioManifestSegment[] | string[];
};

export function findPlanFiles(rootBuildDir: string): string[] {
  if (!fs.existsSync(rootBuildDir)) return [];

  const files: string[] = [];
  const stack = [rootBuildDir];

  while (stack.length > 0) {
    const dir = stack.pop() as string;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name === "plan.json") {
        files.push(fullPath);
      }
    }
  }

  return files.sort();
}

export function promptFile(fileName: string): string {
  return path.join(process.cwd(), "prompts", fileName);
}

export function outputDirForPlan(planFilePath: string): string {
  return path.dirname(planFilePath);
}

export function safeJsonParse<T>(text: string): T {
  return JSON.parse(text) as T;
}

export function extractFirstJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const fenceStart = trimmed.indexOf("```json");
  if (fenceStart >= 0) {
    const start = trimmed.indexOf("{", fenceStart);
    const endFence = trimmed.indexOf("```", fenceStart + 7);
    if (start >= 0 && endFence > start) {
      const block = trimmed.slice(start, endFence).trim();
      return block;
    }
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return trimmed.slice(first, last + 1);
  }
  throw new Error("Unable to extract JSON object from model response");
}
