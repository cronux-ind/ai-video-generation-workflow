import fs from "node:fs";
import path from "node:path";
import { loadDotenv } from "../lib/env.js";
import { geminiGenerateImage } from "../lib/gemini.js";
import { readJson, writeJson } from "../lib/io.js";
import { findPlanFiles, type VideoPlan, type VideoScript } from "../lib/pipeline.js";

type ImageManifestItem = {
  segmentId: string;
  index: number;
  file: string;
  model: string;
  mimeType: string;
  prompt: string;
};

const ROOT = process.cwd();
const BUILD_DIR = path.join(ROOT, "build");

function getGeminiKey(): string {
  return process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "";
}

function modelListFromEnv(): string[] {
  const defaults = [
    "nano-banana-2.0",
    "nano-banana-pro-preview",
    "gemini-2.5-flash-image",
    "gemini-2.0-flash-exp-image-generation"
  ];
  const envValue = process.env.IMAGE_MODEL_LIST?.trim();
  if (!envValue) return defaults;
  return envValue
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

function timeoutForModel(model: string): number {
  const defaultTimeout = Number(process.env.IMAGE_TIMEOUT_MS || "45000");
  const proTimeout = Number(process.env.IMAGE_PRO_TIMEOUT_MS || "90000");
  return model.includes("nano-banana-pro") ? proTimeout : defaultTimeout;
}

function extensionFromMime(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

function segmentVisualIntent(segmentId: string): string {
  switch (segmentId) {
    case "hook":
      return "attention-grabbing opening frame, one strong focal point, strong contrast, media-cover quality";
    case "definition":
      return "clear explanatory frame, concept-first composition, visual metaphor easy to parse, presentation-ready";
    case "daily_example":
      return "financial example translated into chart/flow diagram instead of literal life photo";
    case "mistake":
      return "conflict frame showing incorrect behavior consequences, left-right before/after panel";
    case "how_it_works":
      return "data-first finance visual, chart and directional logic, analytical tone, institutional report quality";
    case "action":
      return "practical execution frame, tactical steps visualized as dashboard/checklist blocks";
    case "recap_cta":
      return "clean recap frame with memorable closing visual anchor, highly legible composition";
    default:
      return "finance visual frame with clear focal hierarchy";
  }
}

function inferTopicTag(term: string): "pe" | "vc" | "support" | "generic" {
  if (/private equity|私募股权|pe/i.test(term)) return "pe";
  if (/venture capital|风险投资|vc/i.test(term)) return "vc";
  if (/支撑线|support/i.test(term)) return "support";
  return "generic";
}

function topicSpecificRecipe(topicTag: "pe" | "vc" | "support" | "generic", segmentId: string): string {
  if (topicTag === "pe") {
    switch (segmentId) {
      case "hook":
        return "show valuation gap tension: low entry valuation tag vs high exit valuation tag with bold upward curve";
      case "definition":
        return "show control-investment flow: fund -> company -> operational improvement -> exit";
      case "daily_example":
        return "replace restaurant literal people with financial timeline: acquire cheap, improve EBITDA, sell at higher multiple";
      case "mistake":
        return "left panel: chase short-term price; right panel: long-cycle value creation";
      case "how_it_works":
        return "visualize IRR drivers: entry multiple, growth, leverage, exit multiple in a clean matrix";
      case "action":
        return "show investment checklist: lock-up period, liquidity risk, exit path";
      case "recap_cta":
        return "summary card with low-buy high-sell logic and long-cycle investing iconography";
      default:
        return "private equity data visualization";
    }
  }

  if (topicTag === "vc") {
    switch (segmentId) {
      case "hook":
        return "power-law return curve with many near-zero outcomes and one extreme winner spike";
      case "definition":
        return "seed to series timeline with risk/return gradient";
      case "daily_example":
        return "portfolio panel: 10 bets, 8 failures, 1 break-even, 1 outlier winner";
      case "mistake":
        return "contrast story-driven hype vs portfolio probability thinking";
      case "how_it_works":
        return "venture portfolio mechanics: follow-on rounds, dilution, exit distribution";
      case "action":
        return "evaluation checklist: stage, thesis, portfolio strategy, cash runway";
      case "recap_cta":
        return "concise venture logic board with asymmetric payoff visual";
      default:
        return "venture capital data storytelling visual";
    }
  }

  if (topicTag === "support") {
    switch (segmentId) {
      case "hook":
        return "candlestick chart touching support zone then either bounce or breakdown in sharp contrast";
      case "definition":
        return "highlight support as a zone band, not a single thin line";
      case "daily_example":
        return "price action sequence: first touch bounce, second touch weaker bounce, third touch breakdown risk";
      case "mistake":
        return "wrong: blind buy at support; right: confirm with volume and stop-loss";
      case "how_it_works":
        return "microstructure view: buy wall absorption, liquidity thinning, break probability";
      case "action":
        return "trading plan panel: entry trigger, invalidation line, position sizing";
      case "recap_cta":
        return "technical-analysis summary board with support-zone probability framing";
      default:
        return "technical chart-focused finance visual";
    }
  }

  return "finance infographic with data-first composition";
}

function extractScenePlan(plan: VideoPlan, segmentId: string): string {
  const topicTag = inferTopicTag(plan.term);
  return topicSpecificRecipe(topicTag, segmentId);
}

function buildPrompt(plan: VideoPlan, segmentId: string, narration: string, imagePromptBrief: string): string {
  const direction = plan.style.visualDirectionPrompt || plan.style.visualStylePrompt;
  const directionName = plan.style.visualDirectionName || "Finance Editorial";
  const keywords = (plan.style.visualReferenceKeywords ?? []).join(", ");
  const scenePlan = extractScenePlan(plan, segmentId);

  return [
    `Visual direction: ${directionName}.`,
    `${direction}.`,
    "Use realistic visual language similar to premium finance short-video and modern pitch-deck visuals.",
    "Prefer information design, charts, dashboards, and symbolic objects over portraits of random people.",
    "No cartoon style, no fantasy style, no uncanny AI faces.",
    `Segment=${segmentId}.`,
    `Segment visual intent=${segmentVisualIntent(segmentId)}.`,
    `Scene plan=${scenePlan}.`,
    `Brief=${imagePromptBrief}.`,
    `Narration context=${narration}.`,
    keywords ? `Reference keywords=${keywords}.` : "",
    "Create one high-quality keyframe for a vertical 9:16 finance explainer.",
    "No visible text, no logos, no watermark, no gibberish.",
    "High-detail, realistic lighting, clean composition, information-rich but not cluttered.",
    "If human figures appear, keep them secondary and professional; never make them the core subject."
  ].join(" ");
}

async function generateImageForSegment(
  apiKey: string,
  models: string[],
  disabledModels: Set<string>,
  prompt: string,
  negativePrompt: string
): Promise<{ model: string; mimeType: string; base64Data: string }> {
  let lastErr = "no models attempted";

  for (const model of models) {
    if (disabledModels.has(model)) continue;
    try {
      const image = await geminiGenerateImage({
        apiKey,
        model,
        prompt,
        negativePrompt,
        timeoutMs: timeoutForModel(model)
      });
      return { model, ...image };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastErr = `${model}: ${message}`;

      // Don't keep retrying models that are not available in current account.
      if (message.includes("not found for API version") || message.includes("not supported for generateContent")) {
        disabledModels.add(model);
      }
      console.warn(`Image model failed: ${lastErr}`);
    }
  }

  throw new Error(`All image models failed. Last error: ${lastErr}`);
}

async function main(): Promise<void> {
  loadDotenv();
  const apiKey = getGeminiKey();
  if (!apiKey) {
    throw new Error("Missing GOOGLE_API_KEY (or GEMINI_API_KEY) in .env");
  }

  const models = modelListFromEnv();
  const planFiles = findPlanFiles(BUILD_DIR);
  if (planFiles.length === 0) {
    throw new Error("No plan.json found. Run `npm run plan` first.");
  }

  const disabledModels = new Set<string>();

  for (const planFile of planFiles) {
    const videoDir = path.dirname(planFile);
    const scriptPath = path.join(videoDir, "script.json");
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Missing ${scriptPath}. Run \`npm run script:gen\` first.`);
    }

    const plan = readJson<VideoPlan>(planFile);
    const script = readJson<VideoScript>(scriptPath);
    if (script.segments.length !== plan.shots.length) {
      throw new Error(`${plan.videoId}: segment count mismatch between plan and script`);
    }

    const imageDir = path.join(videoDir, "images");

    // Check if all images already exist — skip expensive regeneration
    const existingImages = fs.existsSync(imageDir) ? fs.readdirSync(imageDir) : [];
    const allPresent = plan.shots.every((_shot, idx2) => {
      const prefix = `${String(idx2 + 1).padStart(2, "0")}-`;
      return existingImages.some((f) => f.startsWith(prefix) && /\.(png|jpg|jpeg|webp)$/i.test(f));
    });
    if (allPresent) {
      console.log(`[${plan.videoId}] images already complete, skipping generation`);
      continue;
    }

    fs.rmSync(imageDir, { recursive: true, force: true });
    fs.mkdirSync(imageDir, { recursive: true });

    const manifest: ImageManifestItem[] = [];
    for (const [idx, shot] of plan.shots.entries()) {
      const seg = script.segments[idx];
      const prompt = buildPrompt(plan, shot.segmentId, seg.narration, shot.imagePromptBrief);

      const { model, mimeType, base64Data } = await generateImageForSegment(
        apiKey,
        models,
        disabledModels,
        prompt,
        plan.style.visualNegativePrompt
      );

      const ext = extensionFromMime(mimeType);
      const fileName = `${String(idx + 1).padStart(2, "0")}-${shot.segmentId}.${ext}`;
      const outputPath = path.join(imageDir, fileName);
      fs.writeFileSync(outputPath, Buffer.from(base64Data, "base64"));

      manifest.push({
        segmentId: shot.segmentId,
        index: idx + 1,
        file: outputPath,
        model,
        mimeType,
        prompt
      });
      console.log(`[${plan.videoId}] image #${idx + 1} -> ${fileName} (${model})`);
    }

    writeJson(path.join(videoDir, "images-manifest.json"), {
      videoId: plan.videoId,
      generatedAt: new Date().toISOString(),
      modelsTried: models,
      items: manifest
    });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
