export interface MaseNetAIEnv {
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GROQ_API_KEY?: string;
  GROQ_MODEL?: string;
  AI?: {
    run(model: string, input: { messages: Array<{role:"system"|"user"|"assistant";content:string}>; max_tokens?: number; chat_template_kwargs?: {enable_thinking?:boolean} }): Promise<unknown>;
  };
}

function responseText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const data = value as any;
  return String(data.output_text || data.response || data.choices?.[0]?.message?.content ||
    data.candidates?.[0]?.content?.parts?.map((part: any) => part.text || "").join("\n") || "");
}

/** Sequential, bounded failover. Provider errors are logged without credentials or user data. */
export async function generateMaseNetFallback(
  env: MaseNetAIEnv,
  systemInstructions: string,
  userMessage: string,
  requireLiveWebResearch = false
): Promise<{text:string;provider:"gemini"|"groq"|"cloudflare";sources?:string[]} | null> {
  const isLoveInTheShell = /love\s+in\s+the\s+shell|nian\s+xiang\s+si|念相思|longing\s+for\s+my\s+beloved/i.test(userMessage);
  const researchInstructions = requireLiveWebResearch
    ? [
        systemInstructions,
        "LIVE RESEARCH RULES: Answer the exact question asked. If the user asks for a release date, answer only about that title and its confirmed release status; do not replace the answer with unrelated catalogue recommendations.",
        "Search the exact title and relevant alternate-language titles. For Love in the Shell, search all of: Love in the Shell, Nian Xiang Si, 念相思, and Longing for My Beloved. Treat these as possible aliases for the same requested drama, but verify that search results refer to the same production before combining them.",
        "Prioritize official iQIYI, production-company, broadcaster, and verified creator announcements. Use reputable entertainment reporting as secondary corroboration. State 'not officially announced' when no official date is confirmed. Clearly label rumours and estimated dates. Include grounded source links and never invent a date or source."
      ].join("\\n\\n")
    : systemInstructions;
  const researchMessage = requireLiveWebResearch
    ? userMessage + (isLoveInTheShell
      ? "\\n\\nResearch aliases to check: Love in the Shell; Nian Xiang Si; 念相思; Longing for My Beloved. Confirm identity against the same drama/production."
      : "\\n\\nUse live web research for this current-information question. Return direct source URLs.")
    : userMessage;

  let researchFailure = env.GEMINI_API_KEY ? "Gemini returned no grounded answer." : "GEMINI_API_KEY is not configured.";
  if (env.GEMINI_API_KEY) {
    const configuredModel = String(env.GEMINI_MODEL || "").trim();
    // Gemini 2.5 Flash supports Google Search grounding on the free tier.
    // The newer Flash models may not offer grounding on free-tier projects.
    const supportedModels = ["gemini-2.5-flash"];
    const models = supportedModels;
    for (const model of models) {
      try {
        const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" +
          encodeURIComponent(model) + ":generateContent", {
          method:"POST", signal:AbortSignal.timeout(18000),
          headers:{"Content-Type":"application/json","x-goog-api-key":env.GEMINI_API_KEY},
          body:JSON.stringify({
            systemInstruction:{parts:[{text:researchInstructions}]},
            contents:[{role:"user",parts:[{text:researchMessage.slice(0,5000)}]}],
            generationConfig:{maxOutputTokens:900,temperature:1},
            ...(requireLiveWebResearch ? {tools:[{google_search:{}}]} : {})
          })
        });
        const data = await response.json().catch(()=>({}));
        const text = responseText(data);
        const groundingChunks = (data as any)?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
        const sources = groundingChunks.map((chunk: any) => chunk?.web?.uri ? (chunk.web.title ? chunk.web.title + ": " : "") + chunk.web.uri : "").filter(Boolean).slice(0,6);
        if (response.ok && text.trim() && (!requireLiveWebResearch || sources.length > 0)) {
          return {text:text.trim(),provider:"gemini",sources};
        }
        const detail = String((data as any)?.error?.message || (data as any)?.error?.status || ("No grounded text or source links returned; finish=" + String((data as any)?.candidates?.[0]?.finishReason || "unknown") + "; chunks=" + String(groundingChunks.length))).slice(0,320);
        researchFailure = "Gemini HTTP " + response.status + " (" + model + "): " + detail;
        console.error("MaseNet Gemini fallback failed", response.status, "model:", model, "detail:", detail);
      } catch (error) {
        researchFailure = "Gemini request error (" + model + "): " + (error instanceof Error ? error.message : "unknown error");
        console.error("MaseNet Gemini fallback error", error instanceof Error ? error.message : "unknown error", "model:", model);
      }
    }
  }
  // Groq is a reliable text fallback. Its browser-search tool is available only on
  // supported GPT-OSS models; live research remains Gemini-grounded above so that
  // we never present an ungrounded Groq answer as verified current information.
  if (!requireLiveWebResearch && env.GROQ_API_KEY) {
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method:"POST", signal:AbortSignal.timeout(18000),
        headers:{"Content-Type":"application/json","Authorization":"Bearer "+env.GROQ_API_KEY},
        body:JSON.stringify({
          model:env.GROQ_MODEL || "openai/gpt-oss-120b",
          messages:[{role:"system",content:systemInstructions},{role:"user",content:userMessage.slice(0,4000)}],
          max_tokens:700
        })
      });
      const data = await response.json().catch(()=>({}));
      const text = responseText(data);
      if (response.ok && text.trim()) return {text:text.trim(),provider:"groq"};
      console.error("MaseNet Groq fallback failed", response.status);
    } catch (error) {
      console.error("MaseNet Groq fallback error", error instanceof Error ? error.message : "unknown error");
    }
  }
  if (!requireLiveWebResearch && env.AI) {
    try {
      const result = await env.AI.run("@cf/google/gemma-4-26b-a4b-it", {
        messages:[{role:"system",content:systemInstructions},{role:"user",content:userMessage.slice(0,4000)}],
        max_tokens:700,
        chat_template_kwargs:{enable_thinking:false}
      });
      const text = responseText(result);
      if (text.trim()) return {text:text.trim(),provider:"cloudflare"};
    } catch (error) {
      console.error("MaseNet Cloudflare AI fallback error", error instanceof Error ? error.message : "unknown error");
    }
  }
  if (requireLiveWebResearch) throw new Error(researchFailure.slice(0, 360));
  return null;
}
