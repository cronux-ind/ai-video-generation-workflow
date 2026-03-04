import path from "node:path";
import { readJson, writeJson, listJsonFiles } from "../lib/io.js";
import { StyleGuideSchema, TopicSchema, type StyleGuide, type Topic } from "../lib/schema.js";

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

const ROOT = process.cwd();
const STYLE_PATH = path.join(ROOT, "config", "style-guide.json");
const TOPIC_DIR = path.join(ROOT, "content", "topics");
const BUILD_DIR = path.join(ROOT, "build");

function narrationBrief(segmentId: string, topic: Topic): string {
  const base = `主题：${topic.term}。受众：${topic.targetAudience}。`;

  switch (segmentId) {
    case "hook":
      return `${base}用7~8秒完整抛出核心问题与反常识点，开场要完整但不拖沓。`;
    case "definition":
      return `${base}用一句话讲清定义，不要术语堆砌。`;
    case "daily_example":
      return `${base}用生活化类比：${topic.analogy}`;
    case "mistake":
      return `${base}指出误区：${topic.commonMistake}`;
    case "how_it_works":
      return `${base}解释底层逻辑，重点围绕：${topic.corePoint}`;
    case "action":
      return `${base}给出一条可执行动作：${topic.actionTip}`;
    case "recap_cta":
      return `${base}10秒内复述核心并引导收藏/关注。`;
    default:
      return `${base}补充说明，保持口语化和节奏感。`;
  }
}

function imageBrief(segmentId: string, topic: Topic, style: StyleGuide): string {
  const direction = topic.visualDirectionPrompt ?? style.visual.stylePrompt;
  const keywords = (topic.visualReferenceKeywords ?? []).join(", ");
  const common = [
    `${direction}`,
    `global-style=${style.visual.stylePrompt}`,
    `concept=${topic.term}`,
    `audience=${topic.targetAudience}`,
    keywords ? `reference-keywords=${keywords}` : ""
  ]
    .filter(Boolean)
    .join("; ");

  switch (segmentId) {
    case "hook":
      return `${common}; strong contrast, high emotional tension, mobile-first composition`;
    case "definition":
      return `${common}; clean explanatory frame, one key metaphor, high readability`;
    case "daily_example":
      return `${common}; everyday scenario tied to money decision, realistic people and context`;
    case "mistake":
      return `${common}; wrong-vs-right comparison setup, clear visual conflict`;
    case "how_it_works":
      return `${common}; data-centric frame with directional flow, chart logic emphasized`;
    case "action":
      return `${common}; actionable checklist mood, practical and concrete`;
    case "recap_cta":
      return `${common}; closing frame with memorable visual anchor`;
    default:
      return common;
  }
}

function loadStyle(): StyleGuide {
  const parsed = StyleGuideSchema.safeParse(readJson<unknown>(STYLE_PATH));
  if (!parsed.success) {
    throw new Error(`style-guide.json 校验失败: ${parsed.error.message}`);
  }
  return parsed.data;
}

function loadTopics(): Topic[] {
  const files = listJsonFiles(TOPIC_DIR);
  if (files.length === 0) {
    throw new Error("content/topics 目录为空，至少需要 1 个主题 JSON。");
  }
  return files.map((filePath) => {
    const parsed = TopicSchema.safeParse(readJson<unknown>(filePath));
    if (!parsed.success) {
      throw new Error(`${path.basename(filePath)} 校验失败: ${parsed.error.message}`);
    }
    return parsed.data;
  });
}

function buildPlanForTopic(topic: Topic, style: StyleGuide): VideoPlan {
  let cursor = 0;
  const shots: PlannedShot[] = style.structure.map((segment) => {
    const startSec = cursor;
    const endSec = cursor + segment.seconds;
    cursor = endSec;

    return {
      segmentId: segment.id,
      startSec,
      endSec,
      seconds: segment.seconds,
      goal: segment.goal,
      narrationBrief: narrationBrief(segment.id, topic),
      imagePromptBrief: imageBrief(segment.id, topic, style)
    };
  });

  return {
    videoId: topic.id,
    title: topic.title,
    term: topic.term,
    targetAudience: topic.targetAudience,
    constraints: {
      totalSeconds: style.durationSec,
      aspectRatio: style.aspectRatio,
      fps: style.fps,
      targetWpm: style.voice.targetWpm
    },
    style: {
      voicePersona: style.voice.persona,
      visualStylePrompt: style.visual.stylePrompt,
      visualNegativePrompt: style.visual.negativePrompt,
      visualDirectionName: topic.visualDirectionName,
      visualDirectionPrompt: topic.visualDirectionPrompt,
      visualReferenceKeywords: topic.visualReferenceKeywords ?? [],
      consistencySeed: style.visual.consistencySeed
    },
    shots
  };
}

function main(): void {
  const style = loadStyle();
  const topics = loadTopics();
  const plans = topics.map((topic) => buildPlanForTopic(topic, style));

  plans.forEach((plan) => {
    const filePath = path.join(BUILD_DIR, plan.videoId, "plan.json");
    writeJson(filePath, plan);
  });

  writeJson(path.join(BUILD_DIR, "index.json"), {
    generatedAt: new Date().toISOString(),
    videos: plans.map((p) => ({
      videoId: p.videoId,
      title: p.title,
      term: p.term,
      shotCount: p.shots.length
    }))
  });

  console.log(`Planned ${plans.length} videos into ${BUILD_DIR}`);
}

main();
