type GeminiGenerateOptions = {
  apiKey: string;
  model: string;
  userText: string;
  systemText?: string;
  timeoutMs?: number;
  responseMimeType?: string;
  temperature?: number;
};

type GeminiImageOptions = {
  apiKey: string;
  model: string;
  prompt: string;
  negativePrompt?: string;
  timeoutMs?: number;
};

type GeminiAudioOptions = {
  apiKey: string;
  model: string;
  text: string;
  voiceName?: string;
  timeoutMs?: number;
};

type GeminiResponse = {
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: {
          mimeType?: string;
          data?: string;
        };
      }>;
    };
  }>;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

async function fetchGemini(
  url: string,
  payload: unknown,
  timeoutMs: number
): Promise<{ ok: boolean; status: number; json: GeminiResponse; rawText: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const rawText = await res.text();
  let json: GeminiResponse = {};
  try {
    json = JSON.parse(rawText) as GeminiResponse;
  } catch {
    // keep rawText for debugging
  }
  return { ok: res.ok, status: res.status, json, rawText };
}

export async function geminiGenerateText(opts: GeminiGenerateOptions): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent?key=${opts.apiKey}`;
  const payload = {
    systemInstruction: opts.systemText
      ? {
          parts: [{ text: opts.systemText }]
        }
      : undefined,
    contents: [
      {
        role: "user",
        parts: [{ text: opts.userText }]
      }
    ],
    generationConfig: {
      temperature: opts.temperature ?? 0.4,
      responseMimeType: opts.responseMimeType
    }
  };
  const { ok, status, json, rawText } = await fetchGemini(url, payload, opts.timeoutMs ?? 60000);
  if (!ok) {
    const message = json.error?.message ?? rawText.slice(0, 300);
    throw new Error(`Gemini text request failed (${status}): ${message}`);
  }

  const parts = (json.candidates ?? []).flatMap((c) => c.content?.parts ?? []);
  const text = parts
    .map((p) => p.text ?? "")
    .join("\n")
    .trim();

  if (!text) {
    throw new Error(`Gemini returned empty text for model ${opts.model}`);
  }
  return text;
}

export async function geminiGenerateImage(opts: GeminiImageOptions): Promise<{
  mimeType: string;
  base64Data: string;
}> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent?key=${opts.apiKey}`;
  const textPrompt = opts.negativePrompt
    ? `${opts.prompt}\n\nNegative prompt: ${opts.negativePrompt}`
    : opts.prompt;

  const payload = {
    contents: [
      {
        parts: [{ text: textPrompt }]
      }
    ],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"]
    }
  };

  const { ok, status, json, rawText } = await fetchGemini(url, payload, opts.timeoutMs ?? 70000);
  if (!ok) {
    const message = json.error?.message ?? rawText.slice(0, 300);
    throw new Error(`Gemini image request failed (${status}): ${message}`);
  }

  const parts = (json.candidates ?? []).flatMap((c) => c.content?.parts ?? []);
  const imagePart = parts.find((p) => p.inlineData?.mimeType?.startsWith("image/"));
  const mimeType = imagePart?.inlineData?.mimeType ?? "";
  const base64Data = imagePart?.inlineData?.data ?? "";

  if (!mimeType || !base64Data) {
    throw new Error(`Model ${opts.model} did not return inline image data`);
  }

  return { mimeType, base64Data };
}

export async function geminiGenerateAudio(opts: GeminiAudioOptions): Promise<{
  mimeType: string;
  base64Data: string;
}> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent?key=${opts.apiKey}`;
  const payload = {
    contents: [
      {
        parts: [{ text: opts.text }]
      }
    ],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: opts.voiceName || "Kore"
          }
        }
      }
    }
  };

  const { ok, status, json, rawText } = await fetchGemini(url, payload, opts.timeoutMs ?? 90000);
  if (!ok) {
    const message = json.error?.message ?? rawText.slice(0, 300);
    throw new Error(`Gemini audio request failed (${status}): ${message}`);
  }

  const parts = (json.candidates ?? []).flatMap((c) => c.content?.parts ?? []);
  const audioPart = parts.find((p) => p.inlineData?.mimeType?.toLowerCase().startsWith("audio/"));
  const mimeType = audioPart?.inlineData?.mimeType ?? "";
  const base64Data = audioPart?.inlineData?.data ?? "";

  if (!mimeType || !base64Data) {
    throw new Error(`Model ${opts.model} did not return inline audio data`);
  }

  return { mimeType, base64Data };
}
