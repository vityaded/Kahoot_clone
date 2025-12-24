export function getAnswerStrictness() {
  const raw = String(process.env.ANSWER_STRICTNESS || 'normal').trim().toLowerCase();
  if (raw === '0') return 'strict';
  if (raw === '1') return 'normal';
  if (raw === '2') return 'lenient';
  if (raw === 'strict' || raw === 'normal' || raw === 'lenient') return raw;
  return 'normal';
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
