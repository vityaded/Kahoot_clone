import { promises as fs } from 'fs';
import { SETTINGS_FILE, ensureDataDir } from './storage.js';

let cachedStrictness = null;
let cachedLlmFallback = null;

function normalizeStrictness(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return null;
  if (raw === '0') return 'strict';
  if (raw === '1') return 'normal';
  if (raw === '2') return 'lenient';
  if (raw === 'strict' || raw === 'normal' || raw === 'lenient') return raw;
  return null;
}

function normalizeLlmFallback(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return null;
  if (['true', '1', 'yes', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'off'].includes(raw)) return false;
  return null;
}

function buildSettingsPayload() {
  const payload = {
    strictness: getAnswerStrictness(),
  };
  if (cachedLlmFallback !== null) {
    payload.llmFallbackEnabled = cachedLlmFallback;
  }
  return payload;
}

async function persistSettings() {
  await ensureDataDir();
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(buildSettingsPayload(), null, 2), 'utf8');
}

export async function loadSettings() {
  try {
    const file = await fs.readFile(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(file);
    const normalized = normalizeStrictness(parsed?.strictness);
    if (normalized) {
      cachedStrictness = normalized;
    }
    const normalizedLlmFallback = normalizeLlmFallback(parsed?.llmFallbackEnabled);
    if (normalizedLlmFallback !== null) {
      cachedLlmFallback = normalizedLlmFallback;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      /* eslint-disable no-console */
      console.error('Failed to load settings from disk', error);
    }
  }
}

export function getAnswerStrictness() {
  return cachedStrictness ?? normalizeStrictness(process.env.ANSWER_STRICTNESS) ?? 'normal';
}

export function parseAnswerStrictness(value) {
  return normalizeStrictness(value);
}

export function parseLlmFallbackEnabled(value) {
  return normalizeLlmFallback(value);
}

export function getLlmFallbackEnabled() {
  return cachedLlmFallback;
}

export async function saveSettings({ strictness, llmFallbackEnabled } = {}) {
  if (strictness === undefined && llmFallbackEnabled === undefined) {
    const error = new Error('No settings provided.');
    error.code = 'NO_SETTINGS';
    throw error;
  }

  if (strictness !== undefined) {
    const normalized = normalizeStrictness(strictness);
    if (!normalized) {
      const error = new Error('Invalid strictness value.');
      error.code = 'INVALID_STRICTNESS';
      throw error;
    }
    cachedStrictness = normalized;
  }

  if (llmFallbackEnabled !== undefined) {
    const normalized = normalizeLlmFallback(llmFallbackEnabled);
    if (normalized === null) {
      const error = new Error('Invalid LLM fallback value.');
      error.code = 'INVALID_LLM_FALLBACK';
      throw error;
    }
    cachedLlmFallback = normalized;
  }

  await persistSettings();
  return {
    strictness: getAnswerStrictness(),
    llmFallbackEnabled: getLlmFallbackEnabled(),
  };
}

export async function saveAnswerStrictness(value) {
  const { strictness } = await saveSettings({ strictness: value });
  return strictness;
}

export async function saveLlmFallbackEnabled(value) {
  const { llmFallbackEnabled } = await saveSettings({ llmFallbackEnabled: value });
  return llmFallbackEnabled;
}

export function getRuleMatchingConfig() {
  const strictness = getAnswerStrictness();
  const llmFallbackOverride = getLlmFallbackEnabled();

  const baseConfig = {
    allowCompactMatch: true,
    allowCloseMatch: strictness !== 'strict',
    allowSynonyms: strictness !== 'strict',
    allowSubstrings: strictness !== 'strict',
    closeMatchThreshold: strictness === 'lenient' ? 0.75 : 0.8,
    allowLLMFallback: strictness !== 'strict',
  };

  return {
    ...baseConfig,
    allowLLMFallback: llmFallbackOverride ?? baseConfig.allowLLMFallback,
  };
}

export function getLlmConfigOverrides() {
  const strictness = getAnswerStrictness();

  if (strictness === 'strict') {
    return {
      mode: 'strict',
      confidenceThreshold: 0.9,
    };
  }
  if (strictness === 'lenient') {
    return {
      mode: 'lenient',
      confidenceThreshold: 0.7,
    };
  }
  return {
    mode: 'strict',
    confidenceThreshold: 0.8,
  };
}
