// Explainable smart routing.
//
// 1. classify(messages): heuristics -> { task, estTokens, score 0..1, tier, reason }.
//    Length is one signal (max +0.25), never enough on its own to reach heavy.
// 2. catalog(provider): light / standard / heavy model per provider, each with a
//    quality score (0..1), blended list price (USD per 1M tokens) and a speed prior.
//    Env overrides: <P>_MODEL_LIGHT, <P>_MODEL (standard), <P>_MODEL_HEAVY.
// 3. route(): rank configured providers by policy-weighted quality / price /
//    live health (breaker state, recent success rate, p95 latency), rotate the
//    start of the top score bucket per request (weighted round robin), and put
//    explicit model/provider overrides first.
import { providers, providerNames, canonicalName, isConfigured, getProviderChain } from '../providers/index.js';
import * as circuit from './circuitBreaker.js';
import * as stats from './providerStats.js';

export const POLICIES = ['cost', 'balanced', 'quality'];
export const TIERS = ['light', 'standard', 'heavy'];

const WEIGHTS = {
  cost: { quality: 0.2, cost: 0.6, health: 0.2 },
  balanced: { quality: 0.4, cost: 0.3, health: 0.3 },
  quality: { quality: 0.7, cost: 0.05, health: 0.25 },
  // Internal: cache-verification calls want the fastest cheap healthy model.
  verify: { quality: 0.1, cost: 0.35, health: 0.55 }
};
const TIER_MIN_QUALITY = { light: 0.45, standard: 0.55, heavy: 0.7 };

const floatEnv = (name, def) => {
  const v = parseFloat(process.env[name] ?? '');
  return Number.isFinite(v) ? v : def;
};
const intEnv = (name, def) => {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : def;
};

export const providerTimeoutMs = () => intEnv('PROVIDER_TIMEOUT_MS', 10000);
export const maxInflight = () => intEnv('PROVIDER_MAX_INFLIGHT', 8);

/** Per-provider attempt timeout: adapters may declare their own (Ollama). */
export function timeoutFor(name) {
  const adapter = providers[name];
  const own = typeof adapter?.timeoutMs === 'function' ? adapter.timeoutMs() : null;
  return Number.isFinite(own) && own > 0 ? own : providerTimeoutMs();
}

export function normalizePolicy(value) {
  const v = String(value || '').trim().toLowerCase();
  if (POLICIES.includes(v)) return v;
  const env = String(process.env.ROUTING_POLICY || '').trim().toLowerCase();
  return POLICIES.includes(env) ? env : 'balanced';
}

// ---------------------------------------------------------------- catalog

// quality 0..1 (rough relative capability), price = blended USD / 1M tokens, speed prior 0..1
export const MODEL_INFO = {
  'openai/gpt-oss-20b': { quality: 0.64, price: 0.19, speed: 0.95 },
  'openai/gpt-oss-120b': { quality: 0.80, price: 0.38, speed: 0.9 },
  'gpt-oss-120b': { quality: 0.80, price: 0.38, speed: 0.85 },
  'gemini-3.5-flash-lite': { quality: 0.62, price: 0.13, speed: 0.85 },
  'gemini-3.5-flash': { quality: 0.72, price: 0.25, speed: 0.75 },
  'gemini-3.8-flash': { quality: 0.78, price: 0.25, speed: 0.7 },
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning': { quality: 0.66, price: 0, speed: 0.55 },
  'liquid/lfm-3-1.7b:free': { quality: 0.38, price: 0, speed: 0.8 },
  'nvidia/nemotron-3.5-lightning:free': { quality: 0.6, price: 0, speed: 0.7 },
  'openrouter/free': { quality: 0.62, price: 0, speed: 0.6 },
  'mistral-small-latest': { quality: 0.66, price: 0.4, speed: 0.8 },
  'openai/gpt-4o-mini': { quality: 0.7, price: 0, speed: 0.8 },
  'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B': { quality: 0.35, price: 0, speed: 0.6 },
  'llama3.1-8b': { quality: 0.55, price: 0, speed: 0.95 },
  '@cf/meta/llama-3.1-8b-instruct': { quality: 0.52, price: 0, speed: 0.7 },
  'command-r7b-12-2024': { quality: 0.55, price: 0, speed: 0.75 },
  'qwen2.5:0.5b': { quality: 0.3, price: 0, speed: 0.4 }
};
const TIER_DEFAULT_QUALITY = { light: 0.55, standard: 0.65, heavy: 0.75 };

// Defaults per provider: [light, standard, heavy]; null = use the standard model.
const DEFAULTS = {
  groq: ['openai/gpt-oss-20b', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b'],
  gemini: ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.8-flash'],
  nvidia: [null, 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', null],
  openrouter: ['liquid/lfm-3-1.7b:free', 'nvidia/nemotron-3.5-lightning:free', 'openrouter/free'],
  sambanova: [null, 'gpt-oss-120b', 'gpt-oss-120b'],
  mistral: [null, 'mistral-small-latest', null],
  github: [null, 'openai/gpt-4o-mini', null],
  huggingface: [null, 'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B', null],
  cerebras: [null, 'llama3.1-8b', null],
  cloudflare: [null, '@cf/meta/llama-3.1-8b-instruct', null],
  cohere: [null, 'command-r7b-12-2024', null],
  ollama: [null, 'qwen2.5:0.5b', null]
};

function modelEntry(model, tier) {
  const info = MODEL_INFO[model] || {};
  return {
    model,
    quality: info.quality ?? TIER_DEFAULT_QUALITY[tier],
    price: info.price ?? 0.3,
    speed: info.speed ?? 0.7
  };
}

/** { light, standard, heavy } model entries for a provider (env-aware, read live). */
export function catalog(name) {
  const P = name.toUpperCase();
  const d = DEFAULTS[name] || [null, null, null];
  const standard = process.env[`${P}_MODEL`] || d[1] || providers[name]?.defaultModel?.() || 'default';
  const light = process.env[`${P}_MODEL_LIGHT`] || d[0] || standard;
  const heavy = process.env[`${P}_MODEL_HEAVY`] || d[2] || standard;
  return {
    light: modelEntry(light, 'light'),
    standard: modelEntry(standard, 'standard'),
    heavy: modelEntry(heavy, 'heavy')
  };
}

export function catalogModels(name) {
  const c = catalog(name);
  return { light: c.light.model, standard: c.standard.model, heavy: c.heavy.model };
}

export function rrWeight(name) {
  const v = parseFloat(process.env[`${name.toUpperCase()}_RR_WEIGHT`] ?? '');
  return Number.isFinite(v) && v > 0 ? v : 1;
}

// ---------------------------------------------------------------- classifier

const text = c => (typeof c === 'string' ? c : JSON.stringify(c ?? ''));

const RX = {
  codeFence: /```/,
  code: /\b(code|coding|function|method|def|regex|regexp|sql|select\s+\w+\s+from|stack ?trace|traceback|exception|compile|compiler|bug|debug|refactor|unit tests?|python|javascript|typescript|node\.?js|java|c\+\+|c#|rust|golang|bash|powershell|json|yaml|html|css|api endpoint|implement|snippet|syntax error|null pointer|linked list|binary tree)\b|[{};]\s*$|=>|\w+\(\)/im,
  reasoning: /\b(prove|proof|step[- ]by[- ]step|analy[sz]e|analysis|derive|explain why|why does|why do|compare|contrast|trade-?offs?|reason(ing)?|calculate|solve|equation|integral|derivative|probability|optimi[sz]e|algorithm complexity|design an? |architecture|evaluate|critique|pros and cons|implications|hypothesis)\b/gi,
  math: /\d+\s*[+\-*/^=×÷]\s*\d+|\b(sqrt|log|sin|cos|matrix|theorem|lemma)\b/i,
  summarize: /\b(summari[sz]e|summary|tl;?dr|condense|key points|main points|bullet points|recap|abstract of)\b/i,
  creative: /\b(story|poem|haiku|song|lyrics|limerick|sonnet|fiction|screenplay|script for|slogan|tagline|rap)\b|\bwrite (me )?an? (essay|story|poem|letter)\b/i,
  factual: /^\s*(what|who|when|where|which|how (many|much|old|far|tall|long)|is|are|was|were|does|do|did|can|define|name)\b/i,
  greeting: /^\s*(hi|hello|hey|thanks|thank you|good (morning|evening|night)|how are you)\b/i,
  depth: /\b(detailed|in[- ]depth|comprehensive|thorough(ly)?|rigorous(ly)?|exhaustive)\b/i,
  brevity: /\b(briefly|one word|one sentence|short answer|quick(ly)?|in a few words|yes or no)\b/i
};

const BASE = { factual: 0.05, chat: 0.1, creative: 0.3, summarize: 0.25, code: 0.4, reasoning: 0.55 };

export function tierForScore(score) {
  const lightMax = floatEnv('ROUTER_LIGHT_MAX', 0.3);
  const heavyMin = floatEnv('ROUTER_HEAVY_MIN', 0.6);
  return score >= heavyMin ? 'heavy' : score >= lightMax ? 'standard' : 'light';
}

export function classify(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const all = list.map(m => text(m.content)).join('\n');
  const lastUser = text([...list].reverse().find(m => m.role === 'user')?.content ?? '');
  const estTokens = Math.ceil(all.length / 4);
  const turns = list.filter(m => m.role !== 'system').length;

  const signals = [];
  const hasFence = RX.codeFence.test(all);
  const codeHit = hasFence || RX.code.test(lastUser);
  const reasoningHits = (lastUser.match(RX.reasoning) || []).length;
  const mathHit = RX.math.test(lastUser);
  const summarizeHit = RX.summarize.test(lastUser);
  const creativeHit = RX.creative.test(lastUser);
  const factualHit = RX.factual.test(lastUser) && lastUser.length < 200;

  let task;
  if (codeHit) { task = 'code'; signals.push(hasFence ? 'code fence' : 'code keywords'); }
  else if (reasoningHits || mathHit) { task = 'reasoning'; signals.push(mathHit && !reasoningHits ? 'math' : 'reasoning keywords'); }
  else if (summarizeHit) { task = 'summarize'; signals.push('summarize request'); }
  else if (creativeHit) { task = 'creative'; signals.push('creative writing'); }
  else if (factualHit) { task = 'factual'; signals.push('short question'); }
  else { task = 'chat'; signals.push(RX.greeting.test(lastUser) ? 'greeting' : turns >= 3 ? 'conversation' : 'general prompt'); }

  let score = BASE[task];
  if (task === 'code' && (reasoningHits || mathHit)) { score += 0.15; signals.push('code + reasoning'); }
  if (task === 'reasoning' && reasoningHits >= 2) { score += 0.1; signals.push(`${reasoningHits} reasoning cues`); }
  if (task === 'reasoning' && mathHit && reasoningHits) score += 0.05;
  if (RX.depth.test(lastUser)) { score += 0.1; signals.push('asks for depth'); }
  if (RX.brevity.test(lastUser)) { score -= 0.1; signals.push('asks for brevity'); }

  // Length: at most +0.25, so length alone never reaches the heavy tier.
  let lengthBonus = 0;
  if (estTokens >= 1500) lengthBonus = 0.25;
  else if (estTokens >= 500) lengthBonus = 0.15;
  else if (estTokens >= 150) lengthBonus = 0.05;
  if (lengthBonus) { score += lengthBonus; signals.push(`~${estTokens} tokens`); }

  if (turns >= 10) { score += 0.15; signals.push(`${turns} turns`); }
  else if (turns >= 4) { score += 0.1; signals.push(`${turns} turns`); }

  // Summaries of long input need a capable but not a heavy model.
  if (task === 'summarize') score = Math.min(score, 0.55);

  score = Math.round(Math.max(0, Math.min(1, score)) * 100) / 100;
  const tier = tierForScore(score);
  const reason = `${task} (${signals.join(', ')}) score ${score.toFixed(2)} -> ${tier} tier`;
  return { task, estTokens, score, tier, reason };
}

// ---------------------------------------------------------------- ranking

/** Health 0..1 from recent success rate and p95 latency (or the model's speed prior). */
export function healthScore(name, entry, { fast = false } = {}) {
  const s = stats.summary(name);
  const timeout = timeoutFor(name);
  let latencyFactor;
  if (s.p95LatencyMs == null) latencyFactor = fast ? entry.speed * entry.speed : entry.speed;
  else if (fast) latencyFactor = 1 / (1 + s.p95LatencyMs / 1500); // strongly favour sub-second providers
  else latencyFactor = Math.max(0.2, Math.min(1, 1 - s.p95LatencyMs / (2 * timeout)));
  return s.recentSuccessRate * latencyFactor;
}

export function scoreCandidate(name, entry, tier, policy) {
  const w = WEIGHTS[policy] || WEIGHTS.balanced;
  // free = 1, $0.25/M = 0.5, $1/M = 0.2
  const costScore = 1 / (1 + entry.price / 0.25);
  const tierFit = Math.max(0.2, 1 - 2.5 * Math.max(0, TIER_MIN_QUALITY[tier] - entry.quality));
  const health = healthScore(name, entry, { fast: policy === 'verify' });
  const score = tierFit * (w.quality * entry.quality + w.cost * costScore + w.health * health);
  return Math.round(score * 1000) / 1000;
}

// Weighted round robin counters, keyed by tier + bucket membership.
const rrCounters = new Map();

export function resetRoundRobin() {
  rrCounters.clear();
}

function rotateBucket(bucket, key) {
  if (bucket.length < 2) return bucket;
  const wheel = [];
  for (const c of bucket) {
    const reps = Math.max(1, Math.round(rrWeight(c.provider)));
    for (let i = 0; i < reps; i++) wheel.push(c.provider);
  }
  const n = rrCounters.get(key) || 0;
  rrCounters.set(key, n + 1);
  const first = wheel[n % wheel.length];
  return [bucket.find(c => c.provider === first), ...bucket.filter(c => c.provider !== first)];
}

function resolveModelOverride(model, providerOverride, configured) {
  if (!model || typeof model !== 'string') return null;
  const m = model.trim();
  if (providerOverride) {
    // "groq/openai/gpt-oss-20b" with provider=groq -> strip the redundant prefix
    const prefix = `${providerOverride}/`;
    return { provider: providerOverride, model: m.startsWith(prefix) && !catalogHas(providerOverride, m) ? m.slice(prefix.length) : m };
  }
  // exact catalog match (prefer configured providers)
  const names = [...configured, ...providerNames().filter(n => !configured.includes(n))];
  for (const n of names) if (catalogHas(n, m)) return { provider: n, model: m };
  // provider/model prefix
  const slash = m.indexOf('/');
  if (slash > 0) {
    const p = canonicalName(m.slice(0, slash));
    if (p) return { provider: p, model: m.slice(slash + 1) };
  }
  return { provider: null, model: m };
}

function catalogHas(name, model) {
  const c = catalogModels(name);
  return c.light === model || c.standard === model || c.heavy === model;
}

/**
 * Build the ranked candidate list.
 * @returns {{ task, tier, estTokens, score, policy, reason, override, candidates, skipped }}
 *   candidates: [{ provider, model, tier, score, state, override? }] in attempt order
 *   skipped:    [{ provider, state }] configured providers not attempted (cooldown/disabled)
 */
export function route({ messages, policy, model, provider, tier: forcedTier, purpose } = {}) {
  const cls = classify(messages);
  const pol = normalizePolicy(policy);
  const weightKey = purpose === 'verify' ? 'verify' : pol;
  const tier = TIERS.includes(forcedTier) ? forcedTier : cls.tier;
  const configured = getProviderChain().filter(isConfigured);
  const notes = [];

  let override = null;
  let forced = provider ? canonicalName(provider) : null;
  if (provider && !forced) notes.push(`unknown provider '${provider}' ignored`);
  if (forced && !configured.includes(forced)) {
    notes.push(`requested provider '${forced}' is not configured`);
    forced = null;
  }
  const modelOv = resolveModelOverride(model, forced, configured);
  if (modelOv?.provider && !configured.includes(modelOv.provider)) {
    notes.push(`model '${model}' belongs to unconfigured provider '${modelOv.provider}'`);
    modelOv.provider = null;
    modelOv.model = null;
  }
  if (modelOv?.model) override = 'model';
  else if (forced) override = 'provider';
  const leadProvider = modelOv?.provider || forced || null;

  const now = Date.now();
  const healthy = [];
  const probing = [];
  const degraded = [];
  const skipped = [];
  for (const name of configured) {
    const entry = catalog(name)[tier];
    const state = circuit.getState(name, now);
    const c = { provider: name, model: entry.model, tier, score: scoreCandidate(name, entry, tier, weightKey), state };
    if (name === leadProvider) {
      if (state === 'disabled' || state === 'cooldown') {
        notes.push(`requested provider '${name}' is ${state}`);
        skipped.push({ provider: name, state });
      }
      continue; // placed first below
    }
    if (state === 'healthy') healthy.push(c);
    else if (state === 'probing') probing.push(c);
    else if (state === 'open') degraded.push(c);
    else skipped.push({ provider: name, state });
  }

  const byScore = (a, b) => b.score - a.score;
  healthy.sort(byScore);
  probing.sort(byScore);
  degraded.sort(byScore);

  // Round robin among the top bucket (scores within RR_BUCKET_DELTA of the best).
  let ordered = healthy;
  if (healthy.length > 1) {
    const delta = floatEnv('RR_BUCKET_DELTA', 0.05);
    const top = healthy[0].score;
    const bucket = healthy.filter(c => top - c.score <= delta);
    const rest = healthy.filter(c => top - c.score > delta);
    const key = `${tier}|${pol}|${bucket.map(c => c.provider).sort().join(',')}`;
    ordered = [...rotateBucket(bucket, key), ...rest];
  }
  let candidates = [...ordered, ...probing, ...degraded];

  if (leadProvider && !skipped.some(s => s.provider === leadProvider)) {
    const entry = catalog(leadProvider)[tier];
    candidates.unshift({
      provider: leadProvider,
      model: modelOv?.model || entry.model,
      tier,
      score: scoreCandidate(leadProvider, entry, tier, weightKey),
      state: circuit.getState(leadProvider, now),
      override: override || 'provider'
    });
  } else if (modelOv?.model && !modelOv.provider && candidates.length) {
    // Unknown bare model: try it on the top-ranked provider, others keep their own models.
    candidates[0] = { ...candidates[0], model: modelOv.model, override: 'model' };
  }

  const head = candidates[0];
  let reason = purpose === 'verify'
    ? `cache verification -> ${tier} tier`
    : forcedTier && TIERS.includes(forcedTier) ? `${cls.task} (tier forced) -> ${tier} tier` : cls.reason;
  reason += `, policy ${pol}`;
  if (head) reason += `; first: ${head.provider}/${head.model}${head.override ? ` (${head.override} override)` : ''}`;
  if (notes.length) reason += `; ${notes.join('; ')}`;
  if (!candidates.length) reason += '; no configured provider available';

  return {
    task: cls.task,
    tier,
    estTokens: cls.estTokens,
    score: cls.score,
    policy: pol,
    reason,
    override: candidates.some(c => c.override) ? override : null,
    candidates,
    skipped
  };
}
