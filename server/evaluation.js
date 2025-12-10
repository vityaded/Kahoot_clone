const synonymCache = new Map();

export function normalise(text = '') {
  return String(text ?? '').trim().toLowerCase();
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

export function isCloseMatch(submitted, expected) {
  const distance = levenshtein(submitted, expected);
  const maxLen = Math.max(submitted.length, expected.length) || 1;
  const closeness = 1 - distance / maxLen;

  if (closeness >= 0.8) return true;
  if (distance === 1 && Math.min(submitted.length, expected.length) >= 3) return true;
  if (distance === 2 && maxLen >= 6 && closeness >= 0.7) return true;

  if (submitted.length >= 5 && expected.includes(submitted)) return true;
  if (expected.length >= 5 && submitted.includes(expected)) return true;

  return false;
}

export async function fetchSynonyms(word) {
  const normalized = normalise(word);
  if (!normalized) return [];
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
        meaning?.synonyms?.forEach((syn) => synonyms.add(normalise(syn)));
        meaning?.definitions?.forEach((definition) => {
          definition?.synonyms?.forEach((syn) => synonyms.add(normalise(syn)));
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
  } = options;

  const expectedAnswers = [question.answer, ...(question.alternateAnswers || [])];
  const normalizedSubmitted = normalise(submission ?? '');
  const normalizedExpected = expectedAnswers.map(normalise);
  const normalizedPartial = (question.partialAnswers || []).map(normalise);
  const normalizedSynonyms = await collectSynonyms(expectedAnswers);

  const isCorrect = normalizedExpected.some((expected) => normalizedSubmitted === expected);
  const isPartial =
    !isCorrect &&
    (normalizedPartial.includes(normalizedSubmitted) ||
      normalizedSynonyms.includes(normalizedSubmitted) ||
      normalizedSynonyms.some((syn) => isCloseMatch(normalizedSubmitted, syn)) ||
      normalizedExpected.some((expected) => isCloseMatch(normalizedSubmitted, expected)));

  const speedBonus = calculateSpeedBonus(durationMs, timeRemainingMs, includeSpeedBonus);
  const baseScore = 1000 + speedBonus;
  const earned = isCorrect ? baseScore : isPartial ? Math.round(baseScore / 2) : 0;

  return {
    isCorrect,
    isPartial,
    earned,
    correctAnswer: question.answer,
    playerAnswer: submission ?? '',
  };
}

export async function scoreSubmission(questions = [], submissions = [], options = {}) {
  const { durationMs = null, timeRemainingMs = null, includeSpeedBonus = true } = options;
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
