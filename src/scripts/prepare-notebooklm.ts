import fs from "node:fs";
import path from "node:path";
import { loadDotenv } from "../lib/env.js";
import { findPlanFiles, type VideoPlan, type VideoScript } from "../lib/pipeline.js";
import { readJson } from "../lib/io.js";

const ROOT = process.cwd();

function resolveBuildDir(): string {
  const fromEnv = process.env.PIPELINE_BUILD_DIR?.trim();
  if (!fromEnv) return path.join(ROOT, "build");
  return path.isAbsolute(fromEnv) ? fromEnv : path.join(ROOT, fromEnv);
}

function topicTag(term: string): "pe" | "vc" | "support" | "generic" {
  if (/private equity|私募股权|pe/i.test(term)) return "pe";
  if (/venture capital|风险投资|vc/i.test(term)) return "vc";
  if (/支撑线|support/i.test(term)) return "support";
  return "generic";
}

function visualHint(tag: "pe" | "vc" | "support" | "generic", segmentId: string): string {
  if (tag === "pe") {
    if (segmentId === "daily_example") return "用“低估值买入 -> 经营改善 -> 高估值退出”的时间轴+折线图";
    if (segmentId === "how_it_works") return "四象限矩阵：买入估值、增长、杠杆、退出估值";
    return "机构投资流程图、估值对比图、并购交易逻辑图";
  }
  if (tag === "vc") {
    if (segmentId === "daily_example") return "10个项目分布图：8失败、1平、1爆款，体现幂律";
    if (segmentId === "how_it_works") return "轮次路径图：Seed->A->B->Exit，叠加稀释与回报";
    return "创业融资路径图、风险收益曲线、组合分布图";
  }
  if (tag === "support") {
    if (segmentId === "daily_example") return "K线序列：首次回踩反弹、二次回踩走弱、三次跌破";
    if (segmentId === "how_it_works") return "支撑“区域”示意图+成交量配合";
    return "技术分析图、支撑区间带、策略面板";
  }
  return "数据导向信息图，少人物、多图表";
}

function caseHint(tag: "pe" | "vc" | "support" | "generic", segmentId: string): string {
  if (tag === "pe") {
    if (segmentId === "daily_example" || segmentId === "how_it_works") {
      return "案例建议：Blackstone 收购 Hilton 后通过运营改善与再上市退出，展示“买入-改造-退出”的PE路径。";
    }
    if (segmentId === "mistake") {
      return "风险案例建议：高杠杆并购在加息周期现金流承压，说明PE并非稳赚。";
    }
    return "可点名机构：Blackstone、KKR、Carlyle（点名但不必写具体收益率）。";
  }
  if (tag === "vc") {
    if (segmentId === "daily_example" || segmentId === "how_it_works") {
      return "成功案例建议：Sequoia 早期投资 Apple/Google，体现VC“少数爆款覆盖多数失败”。";
    }
    if (segmentId === "mistake") {
      return "风险案例建议：SoftBank 对 WeWork 的重仓后经历估值大幅回撤。";
    }
    return "可点名机构：Sequoia、a16z、SoftBank。";
  }
  if (tag === "support") {
    if (segmentId === "daily_example" || segmentId === "how_it_works") {
      return "有效支撑案例建议：2020年疫情冲击后，部分指数在前低附近出现止跌反弹。";
    }
    if (segmentId === "mistake") {
      return "失效案例建议：跌破关键支撑后，市场往往出现加速下行。";
    }
    return "强调“支撑是区间不是一根线”，配成交量对照图。";
  }
  return "可加入1个正向案例+1个风险案例，增强结论可信度。";
}

function buildNotebookPrompt(plan: VideoPlan, script: VideoScript): string {
  const tag = topicTag(plan.term);
  const lines: string[] = [];
  lines.push(`# ${plan.title}`);
  lines.push("");
  lines.push("请生成一份 7 页中文讲解PPT（可用于短视频素材截取），要求：");
  lines.push("- 风格像高质量商业简报：简洁、信息密度高、配色统一。");
  lines.push("- 每页核心图形优先用图表/流程图/对比框，不要随机人物摆拍。");
  lines.push("- 字体和布局适合手机观看后期裁切。");
  lines.push("- 每页必须有一个“主视觉+一句核心结论”。");
  lines.push("- 至少包含2个真实案例：1个成功案例、1个风险案例（可分布在不同页）。");
  lines.push("- 案例可点名机构/公司，但避免写未经确认的精确收益率和金额。");
  lines.push("");

  for (let i = 0; i < plan.shots.length; i += 1) {
    const shot = plan.shots[i];
    const seg = script.segments[i];
    lines.push(`## 第${i + 1}页 (${shot.segmentId})`);
    lines.push(`- 旁白要点: ${seg.narration}`);
    lines.push(`- 页面目标: ${shot.goal}`);
    lines.push(`- 推荐视觉: ${visualHint(tag, shot.segmentId)}`);
    lines.push(`- 案例提示: ${caseHint(tag, shot.segmentId)}`);
    lines.push(`- 页面结论文案: ${seg.onscreenText}`);
    lines.push("");
  }

  lines.push("补充要求：");
  lines.push("- 图中可有少量中文标签，但保持简洁。");
  lines.push("- 优先展示金融逻辑图，不要堆砌人物。");
  lines.push("- 输出适合导出PNG逐页截图。");
  return lines.join("\n");
}

function main(): void {
  loadDotenv();
  const buildDir = resolveBuildDir();
  const planFiles = findPlanFiles(buildDir);
  if (planFiles.length === 0) {
    throw new Error("No plan.json found. Run `npm run plan` first.");
  }

  for (const planFile of planFiles) {
    const videoDir = path.dirname(planFile);
    const scriptPath = path.join(videoDir, "script.json");
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Missing ${scriptPath}. Run \`npm run script:gen\` first.`);
    }
    const plan = readJson<VideoPlan>(planFile);
    const script = readJson<VideoScript>(scriptPath);
    const outPath = path.join(videoDir, "notebooklm-input.md");
    fs.writeFileSync(outPath, buildNotebookPrompt(plan, script), "utf-8");
    console.log(`[${plan.videoId}] notebooklm prompt -> ${outPath}`);
  }
}

main();
