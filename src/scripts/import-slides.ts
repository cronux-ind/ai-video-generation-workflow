import fs from "node:fs";
import path from "node:path";
import { loadDotenv } from "../lib/env.js";
import { findPlanFiles, type VideoPlan } from "../lib/pipeline.js";
import { readJson, writeJson } from "../lib/io.js";

const ROOT = process.cwd();
const BUILD_DIR = path.join(ROOT, "build");
const DEFAULT_SOURCE = path.join(ROOT, "external-slides");

function isImage(name: string): boolean {
  return /\.(png|jpg|jpeg|webp)$/i.test(name);
}

function main(): void {
  loadDotenv();
  const baseDir = process.env.EXTERNAL_SLIDES_DIR?.trim() || DEFAULT_SOURCE;
  const planFiles = findPlanFiles(BUILD_DIR);
  if (planFiles.length === 0) {
    throw new Error("No plan.json found. Run `npm run plan` first.");
  }

  for (const planFile of planFiles) {
    const videoDir = path.dirname(planFile);
    const plan = readJson<VideoPlan>(planFile);
    const sourceDir = path.join(baseDir, plan.videoId);
    if (!fs.existsSync(sourceDir)) {
      console.warn(`[${plan.videoId}] skip: source dir not found -> ${sourceDir}`);
      continue;
    }

    const sources = fs
      .readdirSync(sourceDir)
      .filter(isImage)
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    if (sources.length < plan.shots.length) {
      throw new Error(
        `[${plan.videoId}] source slides not enough. need ${plan.shots.length}, got ${sources.length} (${sourceDir})`
      );
    }

    const imageDir = path.join(videoDir, "images");
    fs.rmSync(imageDir, { recursive: true, force: true });
    fs.mkdirSync(imageDir, { recursive: true });

    const items: Array<{ segmentId: string; index: number; file: string; source: string; model: string }> = [];
    for (let i = 0; i < plan.shots.length; i += 1) {
      const shot = plan.shots[i];
      const srcName = sources[i];
      const srcPath = path.join(sourceDir, srcName);
      const ext = path.extname(srcName).toLowerCase() || ".png";
      const outName = `${String(i + 1).padStart(2, "0")}-${shot.segmentId}${ext}`;
      const outPath = path.join(imageDir, outName);
      fs.copyFileSync(srcPath, outPath);
      items.push({
        segmentId: shot.segmentId,
        index: i + 1,
        file: outPath,
        source: srcPath,
        model: "notebooklm-slides"
      });
      console.log(`[${plan.videoId}] slide #${i + 1} -> ${outName}`);
    }

    writeJson(path.join(videoDir, "images-manifest.json"), {
      videoId: plan.videoId,
      generatedAt: new Date().toISOString(),
      provider: "external-slides",
      sourceDir,
      items
    });
  }
}

main();
