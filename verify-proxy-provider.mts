/**
 * Standalone harness: replays Pluely's own request-construction pipeline
 * (fetchAIResponse, src/lib/functions/ai-response.function.ts:213-407) against
 * a local CLIProxyAPI instance, using the real helper functions from the app.
 *
 * Run: npx tsx verify-proxy-provider.mts
 */
import curl2Json from "@bany/curl-to-json";
import {
  buildDynamicMessages,
  deepVariableReplacer,
  getByPath,
  getStreamingContent,
} from "./src/lib/functions/common.function";
import { readFileSync } from "node:fs";

// ── The provider exactly as it would be saved in Pluely ────────────────────
const provider = {
  id: "cliproxy-claude",
  streaming: true,
  responseContentPath: "choices[0].message.content",
  curl: `curl http://127.0.0.1:8317/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer {{API_KEY}}" \\
  -d '{
    "model": "{{MODEL}}",
    "messages": [{"role": "system", "content": "{{SYSTEM_PROMPT}}"}, {"role": "user", "content": [{"type": "text", "text": "{{TEXT}}"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,{{IMAGE}}"}}]}]
  }'`,
};

const selectedProvider = {
  provider: "cliproxy-claude",
  variables: {
    API_KEY: "local-test-key-change-me",
    MODEL: "claude-sonnet-5",
  },
};

const SCRATCH =
  "C:/Users/astep/AppData/Local/Temp/claude/C--Users-astep-OneDrive-Documents-Projects-poker-tracker/416ae99c-5abc-43e9-8e91-e51155ce0da1/scratchpad";

async function run(label: string, userMessage: string, imagesBase64: string[]) {
  console.log(`\n${"=".repeat(70)}\n${label}\n${"=".repeat(70)}`);

  // ---- verbatim from fetchAIResponse ----
  const curlJson: any = curl2Json(provider.curl);

  let bodyObj: any = curlJson.data ? JSON.parse(JSON.stringify(curlJson.data)) : {};
  const messagesKey = Object.keys(bodyObj).find((key) =>
    ["messages", "contents", "conversation", "history"].includes(key)
  );
  if (messagesKey && Array.isArray(bodyObj[messagesKey])) {
    bodyObj[messagesKey] = buildDynamicMessages(
      bodyObj[messagesKey],
      [],
      userMessage,
      imagesBase64
    );
  }

  const allVariables = {
    ...Object.fromEntries(
      Object.entries(selectedProvider.variables).map(([k, v]) => [k.toUpperCase(), v])
    ),
    SYSTEM_PROMPT: "You are a terse assistant. Answer in under 12 words.",
  };

  bodyObj = deepVariableReplacer(bodyObj, allVariables);
  const url = deepVariableReplacer(curlJson.url || "", allVariables);
  const headers: any = deepVariableReplacer(curlJson.header || {}, allVariables);
  headers["Content-Type"] = "application/json";

  if (provider.streaming) {
    const streamKey = Object.keys(bodyObj).find((k) => k.toLowerCase() === "stream");
    if (streamKey) bodyObj[streamKey] = true;
    else bodyObj.stream = true;
  }
  // ---- end verbatim ----

  console.log("URL     :", url);
  console.log("METHOD  :", curlJson.method || "POST");
  console.log("HEADERS :", JSON.stringify(headers));
  console.log(
    "BODY    :",
    JSON.stringify(bodyObj).replace(/"[A-Za-z0-9+/=]{200,}"/g, '"<BASE64 IMAGE>"')
  );

  const res = await fetch(url, {
    method: curlJson.method || "POST",
    headers,
    body: JSON.stringify(bodyObj),
  });

  if (!res.ok) {
    console.log(`\n❌ HTTP ${res.status} ${res.statusText}\n`, (await res.text()).slice(0, 400));
    return false;
  }

  // ---- SSE parse, verbatim from fetchAIResponse ----
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.startsWith("data:")) {
        const trimmed = line.substring(5).trim();
        if (!trimmed || trimmed === "[DONE]") continue;
        try {
          const delta = getStreamingContent(JSON.parse(trimmed), provider.responseContentPath);
          if (delta) out += delta;
        } catch {}
      }
    }
  }

  console.log("\n>>> STREAMED RESPONSE:", JSON.stringify(out));
  console.log(">>> chars:", out.length);
  return out.length > 0;
}

const img = readFileSync(`${SCRATCH}/vision-b64.txt`, "utf8").trim();

const textOk = await run("1. TEXT ONLY (Chat / Listen path)", "Name the capital of Japan.", []);
const visionOk = await run(
  "2. TEXT + SCREENSHOT (Ask path)",
  "What number is in this image and what colour is the background?",
  [img]
);

console.log(`\n${"=".repeat(70)}`);
console.log(`text+stream : ${textOk ? "PASS" : "FAIL"}`);
console.log(`vision      : ${visionOk ? "PASS" : "FAIL"}`);
console.log(`getByPath sanity: ${getByPath({ a: [{ b: "x" }] }, "a[0].b") === "x" ? "PASS" : "FAIL"}`);
console.log("=".repeat(70));
