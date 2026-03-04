import fs from "node:fs";
import path from "node:path";
import { readJson } from "../lib/io.js";
import { StyleGuideSchema } from "../lib/schema.js";

type PlannedShot = {
  segmentId: string;
  startSec: number;
  endSec: number;
  seconds: number;
  goal: string;
  narrationBrief: string;
  imagePromptBrief: string;
};

type VideoPlan = {
  videoId: string;
  title: string;
  constraints: {
    totalSeconds: number;
  };
  shots: PlannedShot[];
};

const ROOT = process.cwd();
const STYLE_PATH = path.join(ROOT, "config", "style-guide.json");
const BUILD_DIR = path.join(ROOT, "build");

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function findPlanFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findPlanFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name === "plan.json") {
      files.push(fullPath);
    }
  }

  return files.sort();
}

function main(): void {
  const styleParsed = StyleGuideSchema.safeParse(readJson<unknown>(STYLE_PATH));
  if (!styleParsed.success) {
    throw new Error(`style-guide.json 不合法: ${styleParsed.error.message}`);
  }
  const style = styleParsed.data;

  // build/video-xx/plan.json
  const planFiles = findPlanFiles(BUILD_DIR);
  assert(planFiles.length > 0, "未发现 plan.json，请先运行 npm run plan");

  for (const file of planFiles) {
    const plan = readJson<VideoPlan>(file);
    const total = plan.shots.reduce((sum, shot) => sum + shot.seconds, 0);

    assert(
      total === style.durationSec,
      `${plan.videoId}: 分镜总时长 ${total}s 与 style ${style.durationSec}s 不一致`
    );

    for (const [idx, shot] of plan.shots.entries()) {
      assert(shot.endSec > shot.startSec, `${plan.videoId}: shot #${idx + 1} 时长非法`);
      assert(shot.narrationBrief.trim().length > 0, `${plan.videoId}: shot #${idx + 1} narration 为空`);
      assert(
        shot.imagePromptBrief.trim().length > 0,
        `${plan.videoId}: shot #${idx + 1} image prompt 为空`
      );
    }

    const last = plan.shots[plan.shots.length - 1];
    assert(last.endSec === style.durationSec, `${plan.videoId}: 末尾时间不是 ${style.durationSec}s`);
  }

  console.log(`QA passed for ${planFiles.length} planned videos.`);
}

main();
