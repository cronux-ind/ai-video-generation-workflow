import { z } from "zod";

export const StyleSegmentSchema = z.object({
  id: z.string().min(1),
  seconds: z.number().positive(),
  goal: z.string().min(1)
});

export const StyleGuideSchema = z.object({
  projectName: z.string().min(1),
  brandTagline: z.string().min(1),
  durationSec: z.number().positive(),
  aspectRatio: z.string().min(1),
  fps: z.number().positive(),
  language: z.string().min(1),
  voice: z.object({
    persona: z.string().min(1),
    pace: z.string().min(1),
    targetWpm: z.number().positive()
  }),
  subtitle: z.object({
    maxCharsPerLine: z.number().int().positive(),
    maxLines: z.number().int().positive(),
    keywordStyle: z.string().min(1)
  }),
  visual: z.object({
    stylePrompt: z.string().min(1),
    negativePrompt: z.string().min(1),
    consistencySeed: z.number().int().nonnegative()
  }),
  structure: z.array(StyleSegmentSchema).min(1)
});

export const TopicSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  term: z.string().min(1),
  targetAudience: z.string().min(1),
  corePoint: z.string().min(1),
  analogy: z.string().min(1),
  commonMistake: z.string().min(1),
  actionTip: z.string().min(1),
  visualDirectionName: z.string().min(1).optional(),
  visualDirectionPrompt: z.string().min(1).optional(),
  visualReferenceKeywords: z.array(z.string().min(1)).optional()
});

export type StyleGuide = z.infer<typeof StyleGuideSchema>;
export type Topic = z.infer<typeof TopicSchema>;
