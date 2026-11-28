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
  userMessage: string
): Promise<{text:string;provider:"gemini"|"groq"|"cloudflare"} | null> {
  if (env.GEMINI_API_KEY) {
    try {
      const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" +
        encodeURIComponent(env.GEMINI_MODEL || "gemini-3.8-flash") + ":generateContent", {
        method:"POST", signal:AbortSignal.timeout(18000),
        headers:{"Content-Type":"application/json","x-goog-api-key":env.GEMINI_API_KEY},
        body:JSON.stringify({
          systemInstruction:{parts:[{text:systemInstructions}]},
          contents:[{role:"user",parts:[{text:userMessage.slice(0,4000)}]}],
          generationConfig:{maxOutputTokens:700}
        })
      });
      const data = await response.json().catch(()=>({}));
      const text = responseText(data);
      if (response.ok && text.trim()) return {text:text.trim(),provider:"gemini"};
      console.error("MaseNet Gemini fallback failed", response.status);
    } catch (error) {
      console.error("MaseNet Gemini fallback error", error instanceof Error ? error.message : "unknown error");
    }
  }
  if (env.GROQ_API_KEY) {
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
  if (env.AI) {
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
  return null;
}
