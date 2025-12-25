// llmJudge.js
// Lightweight LLM-backed answer judge for edge cases (when deterministic rules aren't enough)

import { GoogleGenAI } from '@google/genai';

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();

// NOTE: OPENAI_URL must be an OpenAI-compatible chat completions endpoint.
const OPENAI_URL = (process.env.OPENAI_URL || 'https://api.openai.com/v1/chat/completions').trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || 'gpt-4.1-nano').trim();

// Model should be like: gemini-1.5-flash / gemini-2.0-flash / gemma-3-27b-it (as you use)
const GEMINI_MODEL = (process.env.GEMINI_MODEL || 'gemini-1.5-flash').trim();
const GEMINI_CLIENT = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

// Provider priority (matches the Python bot):
// 1) OpenAI (if key present)
// 2) Gemini (if key present)
const PROVIDERS = [];
if (OPENAI_API_KEY) PROVIDERS.push('openai');
if (GEMINI_API_KEY) PROVIDERS.push('gemini');

// Default request timeout. Your UI often sets LLM_TIMEOUT_MS very low (e.g. 2500ms).
// Gemini frequently needs more than that, so we enforce a separate Gemini minimum in callGemini().
const REQUEST_TIMEOUT_MS = Math.max(250, Number(process.env.LLM_TIMEOUT_MS) || 15000);

// Strictness (used in prompt; actual parsing stays strict)
const STRICTNESS = (process.env.ANSWER_STRICTNESS || 'medium').toLowerCase();
// Confidence threshold for "good enough" acceptance by LLM judge
const CONF_THRESHOLD = Number(process.env.LLM_CONFIDENCE_THRESHOLD || 0.7);

// ───────────────────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────────────────

export function isLlmJudgeConfigured() {
  return PROVIDERS.length > 0;
}

export function getLlmConfidenceThreshold() {
  return CONF_THRESHOLD;
}

// Main entry: judge a user answer vs expected answer, returns:
// { verdict: "GOOD"|"ALMOST"|"BAD", confidence: number, reason: string }
export async function judgeAnswerWithLlm({
  questionText,
  context,
  expectedAnswer,
  userAnswer,
  strictness = STRICTNESS,
}) {
  if (!isLlmJudgeConfigured()) {
    throw new Error('LLM judge not configured (no providers).');
  }

  const systemPrompt = buildJudgeSystemPrompt(strictness);
  const userPrompt = buildJudgeUserPrompt({ questionText, context, expectedAnswer, userAnswer });

  const attempts = [];

  for (const provider of PROVIDERS) {
    try {
      const raw = await callProvider(provider, systemPrompt, userPrompt);
      const json = extractJsonObject(raw);

      const verdict = String(json?.verdict || '').toUpperCase();
      const confidence = clamp01(Number(json?.confidence));
      const reason = String(json?.reason || '').trim();

      if (!['GOOD', 'ALMOST', 'BAD'].includes(verdict)) {
        throw new Error(`Invalid verdict from LLM: ${verdict}`);
      }
      if (!Number.isFinite(confidence)) {
        throw new Error(`Invalid confidence from LLM: ${json?.confidence}`);
      }

      return { verdict, confidence, reason };
    } catch (err) {
      attempts.push({ provider, error: String(err?.message || err) });
    }
  }

  const detail = attempts.map(a => `${a.provider}: ${a.error}`).join(' | ');
  throw new Error(`All LLM providers failed. ${detail}`);
}

// Used by /api/test-llm in server.js
export async function runLlmChat({ systemPrompt, userPrompt }) {
  if (!isLlmJudgeConfigured()) {
    return {
      ok: false,
      error: 'LLM judge not configured (no providers).',
      log: [],
    };
  }

  const log = [];

  for (const provider of PROVIDERS) {
    try {
      log.push({ provider, step: 'start' });
      const text = await callProvider(provider, systemPrompt, userPrompt);
      log.push({ provider, step: 'success' });
      const model = provider === 'openai'
        ? OPENAI_MODEL
        : provider === 'gemini'
          ? GEMINI_MODEL
          : null;

      return {
        ok: true,
        provider,
        model,
        text,
        log,
      };
    } catch (err) {
      log.push({
        provider,
        step: 'error',
        error: String(err?.message || err),
      });
    }
  }

  return {
    ok: false,
    error: 'All providers failed.',
    log,
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Provider calls
// ───────────────────────────────────────────────────────────────────────────────

async function callProvider(provider, systemPrompt, userPrompt) {
  if (provider === 'openai') {
    return callOpenAiCompatible(systemPrompt, userPrompt);
  }
  if (provider === 'gemini') {
    return callGemini(systemPrompt, userPrompt);
  }
  throw new Error(`Unknown provider: ${provider}`);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function callOpenAiCompatible(systemPrompt, userPrompt) {
  const body = {
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2,
    max_tokens: 200,
  };

  const res = await fetchWithTimeout(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    const details = JSON.stringify(json).slice(0, 2000);
    throw new Error(`OpenAI HTTP ${res.status}: ${details}`);
  }

  const text =
    json?.choices?.[0]?.message?.content ??
    json?.choices?.[0]?.text ??
    '';

  if (!String(text).trim()) {
    const details = JSON.stringify(json).slice(0, 2000);
    throw new Error(`OpenAI returned empty text: ${details}`);
  }

  return String(text).trim();
}

async function callGemini(systemPrompt, userPrompt) {
  if (!GEMINI_CLIENT) {
    throw new Error('Gemini client not configured (missing GEMINI_API_KEY).');
  }

  // Python-style join: send everything as one "user" message to generateContent.
  const joined = [
    systemPrompt ? `system: ${systemPrompt}` : null,
    userPrompt ? `user: ${userPrompt}` : null,
  ].filter(Boolean).join('\n');

  // Gemini often needs more time than an interactive UI default (e.g. 2500ms).
  // Keep env value, but enforce a sensible floor for Gemini.
  const minGeminiTimeout = Number(process.env.GEMINI_MIN_TIMEOUT_MS) || 15000;
  const timeoutMs = Math.max(REQUEST_TIMEOUT_MS, minGeminiTimeout);

  const request = GEMINI_CLIENT.models.generateContent({
    model: GEMINI_MODEL,
    contents: joined,
    generationConfig: {
      temperature: 0.3,
    },
  });

  const response = await withTimeout(request, timeoutMs, `Gemini request timed out after ${timeoutMs}ms`);
  const text = response?.text ?? '';

  if (!String(text).trim()) {
    throw new Error('Gemini returned empty text.');
  }

  return String(text).trim();
}

// ───────────────────────────────────────────────────────────────────────────────
// Prompt builders
// ───────────────────────────────────────────────────────────────────────────────

function buildJudgeSystemPrompt(strictness) {
  const s = String(strictness || 'medium').toLowerCase();

  // Keep this simple; strict JSON is enforced by extractor/parser.
  return [
    'You are an answer judge for a quiz system.',
    'Return ONLY a JSON object with keys: verdict, confidence, reason.',
    'verdict must be one of: GOOD, ALMOST, BAD.',
    'confidence must be a number between 0 and 1.',
    'reason must be short.',
    '',
    `Strictness level: ${s}.`,
    'Rules:',
    '- GOOD: correct meaning, acceptable wording, minor typos ok.',
    '- ALMOST: close but missing/incorrect minor detail, or partially correct.',
    '- BAD: wrong meaning or clearly incorrect.',
  ].join('\n');
}

function buildJudgeUserPrompt({ questionText, context, expectedAnswer, userAnswer }) {
  const lines = [
    'Judge the user answer against the expected answer.',
    '',
    `QUESTION: ${String(questionText || '')}`,
  ];

  if (context) {
    lines.push(`CONTEXT: ${String(context || '')}`);
    lines.push('Use the context to judge correctness when the expected answer is blank or incomplete.');
  }

  lines.push(`EXPECTED: ${String(expectedAnswer || '')}`);
  lines.push(`USER: ${String(userAnswer || '')}`);
  lines.push('');
  lines.push('Return JSON only.');

  return lines.join('\n');
}

// ───────────────────────────────────────────────────────────────────────────────
// JSON extraction + helpers
// ───────────────────────────────────────────────────────────────────────────────

function extractJsonObject(text) {
  const s = String(text || '').trim();

  // Fast path: already JSON
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_) {}

  // Try to locate first {...} block
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error(`LLM did not return JSON. Raw: ${s.slice(0, 400)}`);
  }

  const candidate = s.slice(firstBrace, lastBrace + 1);
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (err) {
    throw new Error(`Failed to parse JSON: ${String(err?.message || err)} | Raw: ${candidate.slice(0, 400)}`);
  }

  throw new Error(`LLM returned invalid JSON. Raw: ${s.slice(0, 400)}`);
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}
