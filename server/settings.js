import { promises as fs } from 'fs';
import { SETTINGS_FILE, ensureDataDir } from './storage.js';

let cachedStrictness = null;

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

export async function loadSettings() {
  try {
    const file = await fs.readFile(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(file);
    const normalized = normalizeStrictness(parsed?.strictness);
    if (normalized) {
      cachedStrictness = normalized;
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

export async function saveAnswerStrictness(value) {
  const normalized = normalizeStrictness(value);
  if (!normalized) {
    const error = new Error('Invalid strictness value.');
    error.code = 'INVALID_STRICTNESS';
    throw error;
  }
  cachedStrictness = normalized;
  await ensureDataDir();
  await fs.writeFile(SETTINGS_FILE, JSON.stringify({ strictness: normalized }, null, 2), 'utf8');
  return normalized;
}

export function getRuleMatchingConfig() {
  const strictness = getAnswerStrictness();

  if (strictness === 'strict') {
    return {
      allowCompactMatch: true,
      allowCloseMatch: false,
      allowSynonyms: false,
      allowSubstrings: false,
      closeMatchThreshold: 0.8,
      allowLLMFallback: false,
    };
  }

  if (strictness === 'lenient') {
    return {
      allowCompactMatch: true,
      allowCloseMatch: true,
      allowSynonyms: true,
      allowSubstrings: true,
      closeMatchThreshold: 0.75,
      allowLLMFallback: true,
    };
  }

  return {
    allowCompactMatch: true,
    allowCloseMatch: true,
    allowSynonyms: true,
    allowSubstrings: true,
    closeMatchThreshold: 0.8,
    allowLLMFallback: true,
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
