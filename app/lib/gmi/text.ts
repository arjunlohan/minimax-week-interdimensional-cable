import { createGmicloud } from "@ai-sdk/gmicloud";
import { generateText as aiGenerateText } from "ai";

import { env } from "@/app/lib/env";

import { GMI_LLM_BASE_URL, requireGmiKey } from "./client";

import type { z } from "zod";

/**
 * MiniMax-M3 through the Vercel AI SDK's GMI Cloud provider.
 *
 * Every text call in the product (research, the three writers'-room passes,
 * memory extraction, in-character chat, the Taskmaster's ranking, summaries)
 * goes through the two functions below so the model, the key scope, and the
 * JSON discipline live in exactly one place.
 */

export const MINIMAX_TEXT_MODEL = "MiniMaxAI/MiniMax-M3";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateTextOptions {
  system?: string;
  prompt?: string;
  messages?: ChatTurn[];
  temperature?: number;
  /** Output budget. M3 accepts very large values; the passes ask for 65536. */
  maxOutputTokens?: number;
  model?: string;
  timeoutMs?: number;
}

function textModel(modelId?: string) {
  const provider = createGmicloud({ apiKey: requireGmiKey(), baseURL: GMI_LLM_BASE_URL });
  return provider(modelId ?? env.GMI_TEXT_MODEL ?? MINIMAX_TEXT_MODEL);
}

/**
 * M3 reasons before it answers. The provider routes `reasoning_content` away
 * from `text`, but a backend that inlines the reasoning as <think> blocks would
 * leak it into the answer, so strip that shape too.
 */
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trim();
}

export async function generateText(options: GenerateTextOptions): Promise<string> {
  if (!options.prompt && !options.messages?.length) {
    throw new Error("generateText needs a prompt or messages");
  }

  const result = await aiGenerateText({
    model: textModel(options.model),
    ...(options.system ? { system: options.system } : {}),
    ...(options.messages?.length ? { messages: options.messages } : { prompt: options.prompt ?? "" }),
    temperature: options.temperature,
    maxOutputTokens: options.maxOutputTokens ?? 16_384,
    abortSignal: AbortSignal.timeout(options.timeoutMs ?? 10 * 60_000),
  });

  const text = stripThinking(result.text ?? "");
  if (!text) {
    console.error("[gmi:text] Empty response. finishReason:", result.finishReason, "usage:", JSON.stringify(result.usage));
    throw new Error(`MiniMax-M3 returned an empty response (finishReason: ${result.finishReason})`);
  }
  return text;
}

/**
 * Pulls the first complete JSON value out of a reply that may be wrapped in
 * prose or a code fence. Brace matching respects strings, so a joke containing
 * "}" does not end the object early.
 */
export function extractJsonValue(text: string): string {
  const cleaned = stripThinking(text)
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  const start = cleaned.search(/[{[]/);
  if (start === -1) {
    throw new Error("No JSON object or array found in the model reply");
  }

  const open = cleaned[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        if (ch !== close) {
          break;
        }
        return cleaned.slice(start, i + 1);
      }
    }
  }

  // Unbalanced: the reply was probably truncated. Hand back what exists so the
  // caller's error names the real problem.
  return cleaned.slice(start);
}

const JSON_ONLY_INSTRUCTION =
  "Reply with a single JSON value and nothing else: no prose before or after it, no markdown code fence, no comments. " +
  "Use double quotes for every key and string. Escape newlines inside strings as \\n.";

export interface GenerateJsonOptions<T> extends GenerateTextOptions {
  schema: z.ZodType<T>;
  /** A short name for error messages, e.g. "pass1-research". */
  label?: string;
  /** Repair attempts after the first reply fails to parse or validate (default 1). */
  retries?: number;
}

/**
 * Structured output with validation and one repair round.
 *
 * JSON mode is requested by instruction rather than `response_format` because
 * the reply still has to be extracted defensively either way, and the repair
 * round (feeding the validation error back) recovers the common failures.
 */
export async function generateJson<T>(options: GenerateJsonOptions<T>): Promise<T> {
  const { schema, label = "generateJson", retries = 1, ...rest } = options;
  const system = [rest.system, JSON_ONLY_INSTRUCTION].filter(Boolean).join("\n\n");
  let prompt = rest.prompt;
  let messages = rest.messages;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const text = await generateText({ ...rest, system, prompt, messages });
    try {
      const parsed: unknown = JSON.parse(extractJsonValue(text));
      return schema.parse(parsed);
    } catch (err) {
      lastError = err;
      const problem = err instanceof Error ? err.message.slice(0, 1500) : String(err);
      console.warn(`[gmi:text] ${label}: reply failed validation on attempt ${attempt + 1}/${retries + 1}: ${problem.split("\n")[0]}`);
      const repair =
        `Your previous reply could not be used because: ${problem}\n\n` +
        "Reply again with only the corrected JSON value, keeping the same content but matching the required shape exactly.";
      if (messages?.length) {
        messages = [...messages, { role: "assistant", content: text.slice(0, 20_000) }, { role: "user", content: repair }];
      } else {
        prompt = `${rest.prompt ?? ""}\n\n${repair}`;
      }
    }
  }

  throw new Error(
    `${label}: MiniMax-M3 did not return valid JSON after ${retries + 1} attempts: ${lastError instanceof Error ? lastError.message.split("\n")[0] : String(lastError)}`,
  );
}
