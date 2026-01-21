import {
  getLlmConfidenceThreshold,
  isLlmJudgeConfigured,
  judgeAnswerWithLlm,
} from './llmJudge.js';
import { getRuleMatchingConfig } from './settings.js';

const synonymCache = new Map();

export function normalise(text = '') {
  return String(text ?? '').trim().toLowerCase();
}

// Normalization intended specifically for answer comparison.
// - lowercases
// - removes most punctuation/symbols
// - collapses whitespace
// - removes diacritics (café -> cafe)
// This makes acceptance resilient to capitalization and punctuation differences.
export function normaliseAnswer(text = '') {
  const raw = String(text ?? '');
  // Normalize unicode (diacritics) and common punctuation variants.
  const unicodeNormalized = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining marks
    // Treat apostrophes as optional (don't == dont).
    .replace(/[’‘‛´`']/g, '')
    .replace(/[“”„«»]/g, '"')
    .replace(/[–—−]/g, '-');

  // Remove punctuation/symbols but keep letters/digits/spaces.
  // \p{L}=letters, \p{N}=numbers (unicode).
  const withoutPunct = unicodeNormalized
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');

  return withoutPunct
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const left = a || '';
  const right = b || '';
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  const matrix = Array.from({ length: left.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= right.length; j += 1) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  return matrix[left.length][right.length];
}

export function isCloseMatch(submitted, expected, config) {
  const { closeMatchThreshold = 0.8, allowSubstrings = true } = config || {};
  const distance = levenshtein(submitted, expected);
  const maxLen = Math.max(submitted.length, expected.length) || 1;
  const closeness = 1 - distance / maxLen;

  if (closeness >= closeMatchThreshold) return true;
  if (distance === 1 && Math.min(submitted.length, expected.length) >= 3) return true;
  if (distance === 2 && maxLen >= 6 && closeness >= Math.max(0.65, closeMatchThreshold - 0.1)) return true;

  if (allowSubstrings) {
    if (submitted.length >= 5 && expected.includes(submitted)) return true;
    if (expected.length >= 5 && submitted.includes(expected)) return true;
  }

  return false;
}

export async function fetchSynonyms(word) {
  const normalized = normaliseAnswer(word);
  if (!normalized) return [];
  // Only look up synonyms for single tokens; the public dictionary endpoint
  // is unreliable for phrases.
  if (normalized.includes(' ')) {
    synonymCache.set(normalized, []);
    return [];
  }
  if (synonymCache.has(normalized)) return synonymCache.get(normalized);

  try {
    const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(normalized)}`);
    if (!response.ok) {
      synonymCache.set(normalized, []);
      return [];
    }

    const payload = await response.json();
    const synonyms = new Set();
    payload?.forEach((entry) => {
      entry?.meanings?.forEach((meaning) => {
        meaning?.synonyms?.forEach((syn) => synonyms.add(normaliseAnswer(syn)));
        meaning?.definitions?.forEach((definition) => {
          definition?.synonyms?.forEach((syn) => synonyms.add(normaliseAnswer(syn)));
        });
      });
    });

    const result = Array.from(synonyms).filter(Boolean);
    synonymCache.set(normalized, result);
    return result;
  } catch (_error) {
    synonymCache.set(normalized, []);
    return [];
  }
}

async function collectSynonyms(answers = []) {
  const entries = await Promise.all(answers.map((expected) => fetchSynonyms(expected)));
  return Array.from(new Set(entries.flat().filter(Boolean)));
}

function calculateSpeedBonus(durationMs, timeRemainingMs, includeSpeedBonus) {
  if (!includeSpeedBonus) return 0;
  const validDuration = Number.isFinite(durationMs) && durationMs > 0;
  const validRemaining = Number.isFinite(timeRemainingMs) && timeRemainingMs >= 0;
  if (!validDuration || !validRemaining) return 0;

  const safeRemaining = Math.max(0, timeRemainingMs);
  return Math.round((safeRemaining / durationMs) * 500);
}

export async function evaluateAnswer(question, submission, options = {}) {
  const {
    durationMs = null,
    timeRemainingMs = null,
    includeSpeedBonus = true,
    debug = false,
    context = '',
    gradingCondition = '',
  } = options;

  const expectedAnswers = [question.answer, ...(question.alternateAnswers || [])].filter(Boolean);
  const normalizedSubmitted = normaliseAnswer(submission ?? '');
  const normalizedExpected = expectedAnswers.map(normaliseAnswer);
  const normalizedPartial = (question.partialAnswers || []).map(normaliseAnswer);
  const cfg = getRuleMatchingConfig();
  let llmAlreadyTried = false;
  let llmDecided = false;
  let llmSuggestedAnswer = '';
  const evaluationLog = [];

  const log = (message, details = null) => {
    if (!debug) return;
    evaluationLog.push(details ? { message, details } : { message });
  };

  let isCorrect = false;
  let isPartial = false;
  let judgedBy = 'rules';

  log('Normalized inputs', {
    submitted: normalizedSubmitted,
    expected: normalizedExpected,
    partial: normalizedPartial,
  });
  log('Rule config', cfg);

  if (cfg.llmPrimaryEnabled && isLlmJudgeConfigured() && normalizedSubmitted) {
    llmAlreadyTried = true;
    log('LLM primary enabled, sending to LLM judge.');
    const llmResult = await judgeAnswerWithLlm({
      questionText: question?.prompt || '',
      context: context || question?.context || '',
      gradingCondition,
      expectedAnswer: expectedAnswers.join(' | '),
      userAnswer: String(submission ?? ''),
    });
    log('LLM primary response', llmResult);
    const threshold = getLlmConfidenceThreshold();
    const llmConfidence = llmResult?.confidence ?? 0;
    const llmVerdict = String(llmResult?.verdict || '').toUpperCase();
    if (llmVerdict === 'GOOD' && llmConfidence >= threshold) {
      isCorrect = true;
      judgedBy = 'llm';
      llmDecided = true;
      log('LLM primary verdict accepted as correct.');
    } else if (llmVerdict === 'ALMOST' && llmConfidence >= threshold) {
      isPartial = true;
      judgedBy = 'llm';
      llmDecided = true;
      log('LLM primary verdict accepted as partial.');
    } else if (llmVerdict === 'BAD' && llmConfidence >= threshold) {
      judgedBy = 'llm';
      llmDecided = true;
      llmSuggestedAnswer = llmResult?.suggestedAnswer || '';
      if (llmSuggestedAnswer) {
        log('LLM primary suggested correction.', { suggestedAnswer: llmSuggestedAnswer });
      }
      log('LLM primary verdict accepted as wrong.');
    }
  }

  if (!llmDecided && !isCorrect && !isPartial) {
    const normalizedSynonyms = cfg.allowSynonyms ? await collectSynonyms(expectedAnswers) : [];
    if (cfg.allowSynonyms) {
      log('Synonym lookup results', normalizedSynonyms);
    }

    // Space-insensitive variants help accept answers with different hyphenation/
    // punctuation spacing (e.g., "e-mail" vs "email", "well-known" vs "well known").
    const compactSubmitted = normalizedSubmitted.replace(/\s+/g, '');
    const compactExpected = normalizedExpected.map((e) => e.replace(/\s+/g, ''));
    log('Compact match values', { compactSubmitted, compactExpected });

    isCorrect =
      normalizedExpected.some((expected) => normalizedSubmitted === expected) ||
      (cfg.allowCompactMatch && compactSubmitted && compactExpected.some((e) => e === compactSubmitted));

    if (!isCorrect) {
      log('Exact/compact match failed.');
      if (normalizedPartial.includes(normalizedSubmitted)) {
        isPartial = true;
        log('Matched partial answer list.');
      } else {
        if (cfg.allowSynonyms && normalizedSynonyms.includes(normalizedSubmitted)) {
          isPartial = true;
          log('Matched synonym list.');
        }

        if (!isPartial && cfg.allowCloseMatch) {
          if (cfg.allowSynonyms && normalizedSynonyms.some((syn) => isCloseMatch(normalizedSubmitted, syn, cfg))) {
            isPartial = true;
            log('Matched close synonym.');
          } else if (normalizedExpected.some((expected) => isCloseMatch(normalizedSubmitted, expected, cfg))) {
            isPartial = true;
            log('Matched close expected answer.');
          }
        }
      }
    } else {
      log('Exact/compact match succeeded.');
    }
  }

  // LLM fallback for edge cases (e.g., close paraphrases, punctuation-heavy answers).
  // Only runs when rule-based matching fails.
  if (!isCorrect && !isPartial && cfg.allowLLMFallback && !llmAlreadyTried && isLlmJudgeConfigured() && normalizedSubmitted) {
    llmAlreadyTried = true;
    log('LLM fallback enabled, sending to LLM judge.');
    const llmResult = await judgeAnswerWithLlm({
      questionText: question?.prompt || '',
      context: context || question?.context || '',
      gradingCondition,
      expectedAnswer: expectedAnswers.join(' | '),
      userAnswer: String(submission ?? ''),
    });
    log('LLM fallback response', llmResult);
    const threshold = getLlmConfidenceThreshold();
    const llmVerdict = String(llmResult?.verdict || '').toUpperCase();
    if (llmVerdict === 'GOOD' && (llmResult.confidence ?? 0) >= threshold) {
      isCorrect = true;
      judgedBy = 'llm';
      log('LLM fallback verdict accepted as correct.');
    } else if (llmVerdict === 'ALMOST' && (llmResult.confidence ?? 0) >= threshold) {
      isPartial = true;
      judgedBy = 'llm';
      log('LLM fallback verdict accepted as partial.');
    } else if (llmVerdict === 'BAD' && (llmResult.confidence ?? 0) >= threshold) {
      llmSuggestedAnswer = llmResult?.suggestedAnswer || '';
      if (llmSuggestedAnswer) {
        log('LLM fallback suggested correction.', { suggestedAnswer: llmSuggestedAnswer });
      }
    }
  }

  const speedBonus = calculateSpeedBonus(durationMs, timeRemainingMs, includeSpeedBonus);
  const baseScore = 1000 + speedBonus;
  const earned = isCorrect ? baseScore : isPartial ? Math.round(baseScore / 2) : 0;
  log('Score calculation', { baseScore, speedBonus, earned });

  const result = {
    isCorrect,
    isPartial,
    earned,
    correctAnswer: question.answer,
    playerAnswer: submission ?? '',
    judgedBy,
  };
  if (!isCorrect && !isPartial && llmSuggestedAnswer) {
    result.suggestedAnswer = llmSuggestedAnswer;
  }
  if (debug) {
    result.evaluationLog = evaluationLog;
  }
  return result;
}

export async function scoreSubmission(questions = [], submissions = [], options = {}) {
  const {
    durationMs = null,
    timeRemainingMs = null,
    includeSpeedBonus = true,
    context = '',
    gradingCondition = '',
  } = options;
  let score = 0;
  const responses = [];

  const getDuration = (index) => (Array.isArray(durationMs) ? durationMs[index] : durationMs);
  const getRemaining = (index) => (Array.isArray(timeRemainingMs) ? timeRemainingMs[index] : timeRemainingMs);

  for (let i = 0; i < questions.length; i += 1) {
    const question = questions[i];
    const submission = submissions[i] ?? '';
    const evaluation = await evaluateAnswer(question, submission, {
      durationMs: getDuration(i),
      timeRemainingMs: getRemaining(i),
      includeSpeedBonus,
      context,
      gradingCondition,
    });

    score += evaluation.earned;
    responses.push({
      prompt: question.prompt,
      submitted: typeof submission === 'string' ? submission : String(submission ?? ''),
      correctAnswer: question.answer,
      isCorrect: evaluation.isCorrect,
      isPartial: evaluation.isPartial,
    });
  }

  return { score, responses };
}
