import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadDotenv } from "../lib/env.js";
import { geminiGenerateText } from "../lib/gemini.js";
import {
  extractFirstJsonObject,
  findPlanFiles,
  outputDirForPlan,
  promptFile,
  safeJsonParse,
  type ScriptSegment,
  type VideoPlan
} from "../lib/pipeline.js";
import { readJson, writeJson } from "../lib/io.js";

const ScriptOutputSchema = z.object({
  title: z.string().min(1),
  segments: z.array(
    z.object({
      segmentId: z.string().min(1),
      seconds: z.number().positive(),
      narration: z.string().min(1),
      onscreenText: z.string().min(1)
    })
  )
});

type ScriptOutput = z.infer<typeof ScriptOutputSchema>;

const ROOT = process.cwd();
const SCRIPT_SYSTEM_PROMPT_PATH = promptFile("script-system.md");

function resolveBuildDir(): string {
  const fromEnv = process.env.PIPELINE_BUILD_DIR?.trim();
  if (!fromEnv) return path.join(ROOT, "build");
  return path.isAbsolute(fromEnv) ? fromEnv : path.join(ROOT, fromEnv);
}

function getGeminiKey(): string {
  return process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "";
}

function buildUserPrompt(plan: VideoPlan): string {
  const charBudget = (segmentId: string, seconds: number): number => {
    if (segmentId === "hook") return Math.round(seconds * 6.2);
    return Math.round(seconds * 5.2);
  };

  const segments = plan.shots.map((shot, idx) => ({
    index: idx + 1,
    segmentId: shot.segmentId,
    seconds: shot.seconds,
    maxChars: charBudget(shot.segmentId, shot.seconds),
    goal: shot.goal,
    narrationBrief: shot.narrationBrief
  }));

  const term = plan.term.toLowerCase();
  let caseGuide =
    "请至少给出 2 个真实案例（1个正向、1个风险），优先放在 daily_example / mistake / how_it_works 段。";
  if (term.includes("private equity") || term.includes("私募股权") || /\bpe\b/.test(term)) {
    caseGuide =
      "PE案例要求：至少提到1个头部机构（如 Blackstone、KKR、Carlyle）和1个经典案例。可用案例：Blackstone 收购 Hilton 后通过运营改善与退出获得显著回报；也可补充高杠杆并购在加息周期承压的风险案例。";
  } else if (term.includes("venture capital") || term.includes("风险投资") || /\bvc\b/.test(term)) {
    caseGuide =
      "VC案例要求：至少提到1个头部机构（如 Sequoia、a16z、SoftBank）和1个成功+1个风险案例。可用案例：Sequoia 早期投资 Apple/Google；SoftBank 对 WeWork 的押注后经历估值大幅回撤。";
  } else if (term.includes("支撑线") || term.includes("support")) {
    caseGuide =
      "支撑线案例要求：至少给出1个“支撑有效”与1个“跌破失效”的历史市场案例（可用2020年疫情冲击阶段指数前低附近反弹 vs 跌破支撑后加速下行），不要编造具体收益率。";
  }

  return [
    "请基于下面输入生成金融短视频逐字稿。",
    `视频ID: ${plan.videoId}`,
    `标题候选: ${plan.title}`,
    `术语主题: ${plan.term}`,
    `目标受众: ${plan.targetAudience}`,
    `参考时长: ${plan.constraints.totalSeconds}s（可超出，建议最终成片在 65~85 秒）`,
    "",
    "分镜约束（必须保持顺序和 segmentId，不得增删）：",
    JSON.stringify(segments, null, 2),
    "",
    "输出要求：",
    "- 必须只输出 JSON，不要 markdown。",
    "- segments 数量必须与输入一致。",
    "- hook 段要完整表达（7~8秒），至少包含：反常识点 + 核心问题。",
    "- 每段 narration 要口语化，可直接配音。",
    "- 每段 narration 要有明确停顿节奏，避免机械播报。",
    "- 必须加入真实案例来支撑结论，增强代入感。",
    `- ${caseGuide}`,
    "- 可以点名机构和公司，但不要编造具体金额、收益率和精确年份；不确定时用“显著回报/大幅回撤”等表述。",
    "- narration 必须严格精炼，按每段 maxChars 控制字数，不要超字数。",
    "- 每段 onscreenText 控制在 8~18 个中文字符，利于竖屏阅读。",
    "- 总 narration 建议控制在 250~340 个中文字符内。",
    "",
    "JSON 模板：",
    JSON.stringify(
      {
        title: "string",
        segments: segments.map((s) => ({
          segmentId: s.segmentId,
          seconds: s.seconds,
          narration: "string",
          onscreenText: "string"
        }))
      },
      null,
      2
    )
  ].join("\n");
}

function tightenNarration(text: string, maxChars: number): string {
  const trimmed = text.trim().replace(/\s+/g, "");
  // Allow up to 2x planned chars — let Edge TTS real duration drive timing
  const lenientMax = Math.round(maxChars * 2);
  if (trimmed.length <= lenientMax) return trimmed;

  // Find last sentence-ending punctuation within the lenient limit
  const slice = trimmed.slice(0, lenientMax);
  let lastSentenceEnd = -1;
  for (const p of ["。", "！", "？"]) {
    const i = slice.lastIndexOf(p);
    if (i > lastSentenceEnd) lastSentenceEnd = i;
  }

  if (lastSentenceEnd > 0) {
    return trimmed.slice(0, lastSentenceEnd + 1);
  }

  // No sentence boundary — cut at lenient limit with ellipsis
  return `${trimmed.slice(0, lenientMax - 1)}…`;
}

function charBudget(segmentId: string, seconds: number): number {
  if (segmentId === "hook") return Math.round(seconds * 6.2);
  return Math.round(seconds * 5.2);
}

function buildFallbackScript(plan: VideoPlan): ScriptOutput {
  const segments: ScriptSegment[] = plan.shots.map((shot) => {
    const genericNarration = shot.segmentId === "hook"
      ? `很多人以为${plan.term}只是专业机构才用的概念，其实它直接影响普通人的投资判断。`
      : `${plan.term}这部分重点是：${shot.goal}，你可以先记住这句核心话，再看后面的例子。`;

    return {
      segmentId: shot.segmentId,
      seconds: shot.seconds,
      narration: genericNarration,
      onscreenText: shot.goal.slice(0, 16)
    };
  });

  return {
    title: plan.title,
    segments
  };
}

function alignAndValidate(plan: VideoPlan, scriptOut: ScriptOutput): ScriptOutput {
  if (scriptOut.segments.length !== plan.shots.length) {
    throw new Error(`segments count mismatch: got ${scriptOut.segments.length}, expected ${plan.shots.length}`);
  }

  const alignedSegments = plan.shots.map((shot, idx) => {
    const seg = scriptOut.segments[idx];
    if (seg.segmentId !== shot.segmentId) {
      throw new Error(`segmentId mismatch at #${idx + 1}: got ${seg.segmentId}, expected ${shot.segmentId}`);
    }
    return {
      segmentId: shot.segmentId,
      seconds: shot.seconds,
      narration: tightenNarration(seg.narration, charBudget(shot.segmentId, shot.seconds)),
      onscreenText: seg.onscreenText.trim()
    };
  });

  return { title: scriptOut.title, segments: alignedSegments };
}

async function generateScriptForPlan(planFilePath: string, model: string): Promise<void> {
  const plan = readJson<VideoPlan>(planFilePath);
  const outputDir = outputDirForPlan(planFilePath);
  const outPath = path.join(outputDir, "script.json");
  const systemPrompt = fs.readFileSync(SCRIPT_SYSTEM_PROMPT_PATH, "utf-8");

  const userPrompt = buildUserPrompt(plan);
  let parsed: ScriptOutput;
  let usedFallback = false;

  try {
    const raw = await geminiGenerateText({
      apiKey: getGeminiKey(),
      model,
      userText: userPrompt,
      systemText: systemPrompt,
      responseMimeType: "application/json",
      timeoutMs: 90000,
      temperature: 0.5
    });
    const jsonText = extractFirstJsonObject(raw);
    const candidate = ScriptOutputSchema.parse(safeJsonParse<unknown>(jsonText));
    parsed = alignAndValidate(plan, candidate);
  } catch (err) {
    usedFallback = true;
    parsed = buildFallbackScript(plan);
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[${plan.videoId}] Gemini script failed, using fallback template: ${message}`);
  }

  writeJson(outPath, {
    videoId: plan.videoId,
    title: parsed.title,
    segments: parsed.segments,
    generatedBy: {
      provider: usedFallback ? "local-fallback" : "gemini",
      model: usedFallback ? "fallback-template" : model,
      generatedAt: new Date().toISOString()
    }
  });
  console.log(`[${plan.videoId}] script -> ${outPath}`);
}

async function main(): Promise<void> {
  loadDotenv();
  const buildDir = resolveBuildDir();
  const apiKey = getGeminiKey();
  if (!apiKey) {
    throw new Error("Missing GOOGLE_API_KEY (or GEMINI_API_KEY) in .env");
  }

  const model = process.env.SCRIPT_MODEL || "gemini-2.5-flash";
  const planFiles = findPlanFiles(buildDir);
  if (planFiles.length === 0) {
    throw new Error("No plan.json found. Run `npm run plan` first.");
  }

  for (const planFile of planFiles) {
    await generateScriptForPlan(planFile, model);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
