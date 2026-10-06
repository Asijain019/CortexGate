// Second opinion for borderline cache matches. Embeddings say "similar"; this
// shows a model the STORED ANSWER and asks: does it correctly answer the NEW
// question as it stands? ("is peacock the national bird?" is answered by
// "Peacock", but "national bird of india?" is not answered by "Bengal tiger".)
import { dispatch } from '../gateway/dispatch.js';

export async function checkCachedAnswer({ storedQuestion, storedAnswer, newQuestion }) {
  const prompt =
    'You are checking whether a stored answer can be reused.\n\n' +
    `Stored question: ${storedQuestion}\n` +
    `Stored answer: ${String(storedAnswer).slice(0, 500)}\n` +
    `New question: ${newQuestion}\n\n` +
    'Does the stored answer correctly and directly answer the NEW question?\n' +
    'Reply YES if the new question asks for the same information. A yes/no version of the same question, ' +
    'extra or reordered words, and rewordings all count as the same.\n' +
    'Reply NO if the new question is about a different subject, attribute, place, person, number or time, ' +
    'or if the stored answer would not resolve it.\n' +
    'Reply with one word: YES or NO.';

  const out = await dispatch({ messages: [{ role: 'user', content: prompt }] });
  if (!out.result) return { same: null, cost: 0, tokens: 0, provider: null };

  const text = String(out.result.content || '').trim();
  let same = null;
  if (/^\W*yes\b/i.test(text)) same = true;
  else if (/^\W*no\b/i.test(text)) same = false;

  return { same, cost: out.cost, tokens: out.result.usage?.total_tokens || 0, provider: out.provider };
}
