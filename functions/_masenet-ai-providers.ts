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
      ].join("\n\n")
    : systemInstructions;
  const researchMessage = requireLiveWebResearch
    ? userMessage + (isLoveInTheShell
      ? "\n\nResearch aliases to check: Love in the Shell; Nian Xiang Si; 念相思; Longing for My Beloved. Confirm identity against the same drama/production."
      : "\n\nUse live web research for this current-information question. Return direct source URLs.")
    : userMessage;

  let researchFailure = env.GEMINI_API_KEY ? "Gemini returned no grounded answer." : "GEMINI_API_KEY is not configured.";
  if (env.GEMINI_API_KEY) {
    const model = "gemini-3.8-flash";
    try {
      const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
        method:"POST", signal:AbortSignal.timeout(25000),
        headers:{"Content-Type":"application/json","x-goog-api-key":env.GEMINI_API_KEY,"Api-Revision":"2026-05-20"},
        body:JSON.stringify({
          model,
          input:(requireLiveWebResearch ? researchMessage : userMessage).slice(0,5000),
          system_instruction:requireLiveWebResearch ? researchInstructions : systemInstructions,
          ...(requireLiveWebResearch ? {tools:[{type:"google_search"}]} : {}),
          store:false
        })
      });
      const data = await response.json().catch(() => ({})) as any;
      const steps = Array.isArray(data.steps) ? data.steps : [];
      const text = String(data.output_text || steps.filter((step:any)=>step?.type==="model_output").flatMap((step:any)=>Array.isArray(step.content)?step.content.map((part:any)=>part.text||""):[step.text||""]).join("\n") || "");
      const sourceItems: string[] = [];
      for (const step of steps) {
        if (!Array.isArray(step?.content)) continue;
        for (const part of step.content) {
          if (!Array.isArray(part?.annotations)) continue;
          for (const annotation of part.annotations) {
            if (annotation?.type === "url_citation" && typeof annotation.url === "string") {
              sourceItems.push(String(annotation.title || annotation.url) + ": " + annotation.url);
            }
          }
        }
      }
      const sources: string[] = [...new Set(sourceItems)].slice(0,6);
      if (response.ok && text.trim() && (!requireLiveWebResearch || sources.length)) return {text:text.trim(),provider:"gemini",...(sources.length?{sources}:{})};
      const detail = String(data?.error?.message || data?.error?.status || ("No grounded text or source links returned; steps=" + steps.length)).slice(0,320);
      researchFailure = "Gemini Interactions HTTP " + response.status + " (" + model + "): " + detail;
      console.error("MaseNet Gemini Interactions fallback failed",response.status,"detail:",detail);
    } catch (error) {
      researchFailure = "Gemini Interactions request error: " + (error instanceof Error ? error.message : "unknown error");
      console.error("MaseNet Gemini Interactions fallback error",error instanceof Error ? error.message : "unknown error");
    }
  }
  // Independent current-research backup: Groq GPT-OSS browser_search.
  if (requireLiveWebResearch && env.GROQ_API_KEY) {
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method:"POST", signal:AbortSignal.timeout(25000),
        headers:{"Content-Type":"application/json","Authorization":"Bearer "+env.GROQ_API_KEY},
        body:JSON.stringify({
          model:"openai/gpt-oss-120b",
          messages:[
            {role:"system",content:researchInstructions + "\n\nCITATION FORMAT: After the answer, add a Sources heading. For every factual claim, include the source title and its complete direct https URL as plain text. Do not use only numbered citation markers such as 〖1†L2-L5〗 because the Telegram user needs clickable source links."},
            {role:"user",content:researchMessage.slice(0,5000) + "\n\nReturn at least two direct source URLs when reliable sources are available. Never invent URLs."}
          ],
          max_completion_tokens:2048,
          reasoning_effort:"low",
          tool_choice:"required",
          tools:[{type:"browser_search"}]
        })
      });
      const data = await response.json().catch(()=>({})) as any;
      const message = data?.choices?.[0]?.message || {};
      const text = typeof message.content === "string" ? message.content : Array.isArray(message.content)
        ? message.content.map((part:any)=>typeof part==="string"?part:String(part?.text||part?.content||"")).join("\n") : "";
      const foundUrls: string[] = [];
      const collectUrls = (value: any, depth = 0): void => {
        if (depth > 5 || value == null) return;
        if (typeof value === "string") {
          const matches = value.match(/https?:\/\/[^\s<>"'\])}]+/g) || [];
          for (const match of matches) foundUrls.push(match.replace(/[),.;]+$/,""));
          return;
        }
        if (Array.isArray(value)) { for (const item of value) collectUrls(item, depth + 1); return; }
        if (typeof value === "object") {
          for (const [key, item] of Object.entries(value)) {
            if (/url|uri|citation|source|search|result|content/i.test(key)) collectUrls(item, depth + 1);
          }
        }
      };
      collectUrls(data);
      const sources = [...new Set(foundUrls)].filter((url)=>/^https?:\/\//i.test(url)).slice(0,6);
      if (response.ok && text.trim() && sources.length) return {text:text.trim(),provider:"groq",sources};
      const hasInlineSearchCitations = /〖\d+†L\d+(?:-L?\d+)?〗/.test(text);
      const detail = String(data?.error?.message || message?.refusal ||
        (hasInlineSearchCitations ? "Groq searched and returned inline citation markers, but no direct source URLs were exposed in its API response." :
          "Groq returned no answer with extractable source URLs.") +
        " Response fields: " + Object.keys(data || {}).join(", ") +
        "; answer preview: " + text.slice(0,100)).slice(0,320);
      researchFailure = "Groq browser-search HTTP " + response.status + ": " + detail;
      console.error("MaseNet Groq browser-search fallback failed",response.status,detail);
    } catch (error) {
      researchFailure = "Groq browser-search request error: " + (error instanceof Error ? error.message : "unknown error");
      console.error("MaseNet Groq browser-search fallback error",error instanceof Error ? error.message : "unknown error");
    }
  }
  // Cloudflare AI is retained as a final text-only backup for ordinary chat.
  // It is not allowed to fabricate current research when no verified sources exist.
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
