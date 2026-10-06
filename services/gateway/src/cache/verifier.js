// Second opinion for borderline cache matches. Embeddings say "similar";
// this asks a model "do both questions need the same answer?" (YES/NO).
// Prevents wrong hits like "national animal of India" vs "national bird of India".
import { dispatch } from '../gateway/dispatch.js';

export async function areSameQuestion(questionA, questionB) {
  const prompt =
    'Decide whether one single answer would be correct for BOTH questions.\n' +
    'Reply YES only if they ask for exactly the same information.\n' +
    'Reply NO if the subject, attribute, place, person, number or time differs, ' +
    'even when the wording looks almost identical.\n' +
    'Reply with one word: YES or NO.\n\n' +
    `Question A: ${questionA}\nQuestion B: ${questionB}`;

  const out = await dispatch({ messages: [{ role: 'user', content: prompt }] });
  if (!out.result) return { same: null, cost: 0, tokens: 0, provider: null };

  const text = String(out.result.content || '').trim();
  let same = null;
  if (/^\W*yes\b/i.test(text)) same = true;
  else if (/^\W*no\b/i.test(text)) same = false;

  return { same, cost: out.cost, tokens: out.result.usage?.total_tokens || 0, provider: out.provider };
}
