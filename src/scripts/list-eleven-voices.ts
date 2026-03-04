import { loadDotenv } from "../lib/env.js";

type ElevenVoicesResponse = {
  voices?: Array<{
    voice_id: string;
    name: string;
    category?: string;
    labels?: Record<string, string>;
  }>;
};

async function main(): Promise<void> {
  loadDotenv();
  const apiKey = process.env.ELEVENLABS_API_KEY || "";
  if (!apiKey) throw new Error("Missing ELEVENLABS_API_KEY in .env");

  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: {
      "xi-api-key": apiKey
    }
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`ElevenLabs voices failed (${res.status}): ${raw.slice(0, 500)}`);
  }

  const data = JSON.parse(raw) as ElevenVoicesResponse;
  const voices = data.voices ?? [];
  if (voices.length === 0) {
    console.log("No voices found in this ElevenLabs account.");
    return;
  }

  for (const voice of voices) {
    const labels = Object.entries(voice.labels ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    console.log(`${voice.voice_id}\t${voice.name}\t${voice.category ?? ""}\t${labels}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
