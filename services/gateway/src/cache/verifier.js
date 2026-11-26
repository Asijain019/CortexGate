// Second opinion for borderline cache matches. Embeddings say "similar"; this
// shows a model the STORED ANSWER and asks: does it correctly answer the NEW
// question as it stands? ("is peacock the national bird?" is answered by
// "Peacock", but "national bird of india?" is not answered by "Bengal tiger".)
//
// Cost control: the prompt is capped (questions VERIFY_MAX_QUESTION_CHARS,
// default 300; answer VERIFY_MAX_ANSWER_CHARS, default 400), it asks for the
// light tier, and semanticCache calls this at most once per request.
// Never throws: any failure returns { same: null }.

const cap = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}...` : t;
};
const intEnv = (name, def) => {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : def;
};

export function buildVerifyPrompt({ storedQuestion, storedAnswer, newQuestion }) {
  const qMax = intEnv('VERIFY_MAX_QUESTION_CHARS', 300);
  const aMax = intEnv('VERIFY_MAX_ANSWER_CHARS', 400);
  return (
    'You are checking whether a stored answer can be reused.\n\n' +
    `Stored question: ${cap(storedQuestion, qMax)}\n` +
    `Stored answer: ${cap(storedAnswer, aMax)}\n` +
    `New question: ${cap(newQuestion, qMax)}\n\n` +
    'Does the stored answer correctly and directly answer the NEW question?\n' +
    'Reply YES if the new question asks for the same information. A yes/no version of the same question, ' +
    'extra or reordered words, and rewordings all count as the same.\n' +
    'Reply NO if the new question is about a different subject, attribute, place, person, number or time, ' +
    'if one question is negated and the other is not, or if the stored answer would not resolve it.\n' +
    'Reply with one word: YES or NO.'
  );
}

// Loaded lazily so the cache module does not depend on the gateway at import time.
let dispatchImpl = null;
async function getDispatch() {
  if (!dispatchImpl) dispatchImpl = (await import('../gateway/dispatch.js')).dispatch;
  return dispatchImpl;
}

/** Test hook: replace dispatch. Pass null to restore the real one. */
export function setDispatch(fn) { dispatchImpl = fn; }

export async function checkCachedAnswer({ storedQuestion, storedAnswer, newQuestion }) {
  try {
    const prompt = buildVerifyPrompt({ storedQuestion, storedAnswer, newQuestion });
    const dispatch = await getDispatch();
    const out = await dispatch({ messages: [{ role: 'user', content: prompt }], tier: 'light', purpose: 'verify' });
    const cost = Number(out?.cost) || 0;
    if (!out?.result) return { same: null, cost, tokens: 0, provider: out?.provider || null };

    const text = String(out.result.content || '').trim();
    let same = null;
    if (/^\W*yes\b/i.test(text)) same = true;
    else if (/^\W*no\b/i.test(text)) same = false;

    return { same, cost, tokens: out.result.usage?.total_tokens || 0, provider: out.provider || null };
  } catch (err) {
    console.warn(`[Cache] Verifier error: ${err.message}`);
    return { same: null, cost: 0, tokens: 0, provider: null };
  }
}
