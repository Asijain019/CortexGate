// Explainable quality + cost + token + load aware routing.
//
// 1. classify(messages) -> { task, tier, score, estInputTokens (= chars/4 over all
//    messages), estOutputTokens (by task: factual 150, chat 250, summarize
//    min(0.3*input, 600), code 700, creative 500, reasoning 900; x1.6 for
//    "detailed / explain / step by step", x0.3 for "briefly / one word"), reason }.
//    Length is one signal (max +0.25), never enough on its own to reach heavy.
//
// 2. catalog(provider): light / standard / heavy model per provider with quality
//    (0..1), pricePrompt / priceCompletion (USD per 1M tokens), speed prior (0..1)
//    and contextWindow (tokens). Env overrides: <P>_MODEL_LIGHT, <P>_MODEL, <P>_MODEL_HEAVY.
//    Dashboard custom providers (getCustomCatalog()) and newer built-in hints
//    (getBuiltinCatalogHints()) are merged in on every call.
//
// 3. Eligibility: for each configured provider take its tier model, or its next
//    stronger model, whose quality >= requiredQuality (ROUTER_QUALITY_FLOOR_LIGHT
//    0.40 / _STANDARD 0.60 / _HEAVY 0.80) and whose contextWindow >= estIn + estOut.
//    estCost = (estIn * pricePrompt + estOut * priceCompletion) / 1e6.
//
// 4. Pre-dispatch filtering (route.excluded = { provider: reason }):
//    hard: disabled (auth/billing/bad_response), open breaker, probe already in flight,
//          long 429 cooldown, below the quality floor, context too small, request larger
//          than the TPM limit.
//    capacity (-> `waitable`, may be waited for): in-flight >= <P>_MAX_INFLIGHT, rolling
//          60s <P>_RPM / <P>_TPM budget used up, 429 cooldown ending within CAPACITY_WAIT_MS.
//
// 5. Scoring of the ready eligible set (speed = 1 / (1 + p50 / 2000) from measured
//    latency, else the catalog prior (squared for light), times reliability =
//    recent success rate x (1 - 0.7 x recent timeout share)):
//      cost:     0.75 (1 - relCost) + 0.10 quality + 0.15 speed    (relCost min-max over eligible)
//      quality:  0.75 quality + 0.15 speed + 0.10 (1 - normCost)
//      balanced: 0.40 quality + 0.25 (1 - normCost) + 0.35 speed  (light: 0.25 / 0.25 / 0.50)
//      verify:   0.10 quality + 0.25 (1 - normCost) + 0.65 speed
//    normCost = estCost / (estCost + ROUTER_COST_REF ($0.001)).
//    score *= 1 - ROUTER_LOAD_PENALTY (0.5) x load, load = max(inflight/max, rpm/rpmLimit, tpm/tpmLimit).
//
// 6. Selection: top bucket = scores within RR_BUCKET_DELTA (0.12) of the best (quality
//    policy: also quality within 0.03 of the bucket's best; cost policy: estCost within 10%
//    of the cheapest); inside it
//    order by fitness = speed x (1 - load) (least loaded and fastest first); providers
//    whose fitness is within RR_TIE_DELTA (0.1) of the best are tied and rotate by
//    weighted round robin (<P>_RR_WEIGHT). Then the rest by score. Explicit
//    provider/model overrides go first. Capacity waits and tier downgrades happen in
//    dispatch.js (see its header).
import * as providerIndex from '../providers/index.js';
import { providers, providerNames, canonicalName, isConfigured, getProviderChain } from '../providers/index.js';
import * as circuit from './circuitBreaker.js';
import * as stats from './providerStats.js';
import * as capacity from './capacity.js';

export const POLICIES = ['cost', 'balanced', 'quality'];
export const TIERS = ['light', 'standard', 'heavy'];

const WEIGHTS = {
  cost: { quality: 0.10, cost: 0.75, speed: 0.15 },
  balanced: { quality: 0.40, cost: 0.25, speed: 0.35 },
  quality: { quality: 0.75, cost: 0.10, speed: 0.15 },
  // Internal: cache-verification calls want the fastest cheap healthy model.
  verify: { quality: 0.10, cost: 0.25, speed: 0.65 }
};
// Light-tier prompts are easy: move weight from quality to speed (balanced only).
const LIGHT_SPEED_SHIFT = 0.15;
const QUALITY_FLOOR_DEFAULTS = { light: 0.40, standard: 0.60, heavy: 0.80 };
const OUTPUT_TOKENS = { factual: 150, chat: 250, code: 700, creative: 500, reasoning: 900 };

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
export const rrBucketDelta = () => Math.max(0, floatEnv('RR_BUCKET_DELTA', 0.12));
/** How much a fully loaded provider (inflight == max) loses: score * (1 - penalty). */
export const loadPenalty = () => Math.min(0.9, Math.max(0, floatEnv('ROUTER_LOAD_PENALTY', 0.5)));
export const rrTieDelta = () => Math.max(0, floatEnv('RR_TIE_DELTA', 0.1));
const costRef = () => Math.max(1e-9, floatEnv('ROUTER_COST_REF', 0.001));

/** Minimum model quality for a tier (ROUTER_QUALITY_FLOOR_<TIER>). */
export function qualityFloor(tier) {
  return Math.max(0, Math.min(1, floatEnv(`ROUTER_QUALITY_FLOOR_${String(tier).toUpperCase()}`, QUALITY_FLOOR_DEFAULTS[tier] ?? 0.4)));
}

/** One tier down, or null from light. */
export function lowerTier(tier) {
  const i = TIERS.indexOf(tier);
  return i > 0 ? TIERS[i - 1] : null;
}

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

// quality 0..1 (rough relative capability), prices = USD per 1M prompt / completion tokens,
// speed prior 0..1, ctx = context window in tokens.
const M = (quality, pp, pc, speed, ctx) => ({ quality, pricePrompt: pp, priceCompletion: pc, speed, ctx });
export const MODEL_INFO = {
  'openai/gpt-oss-20b': M(0.64, 0.075, 0.30, 0.95, 131072),
  'openai/gpt-oss-120b': M(0.80, 0.15, 0.60, 0.9, 131072),
  'gpt-oss-120b': M(0.80, 0.15, 0.60, 0.85, 131072),
  'gemini-3.5-flash-lite': M(0.62, 0.10, 0.40, 0.85, 1048576),
  'gemini-3.5-flash': M(0.72, 0.15, 0.60, 0.75, 1048576),
  'gemini-3.8-flash': M(0.78, 0.15, 0.60, 0.7, 1048576),
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning': M(0.66, 0, 0, 0.55, 131072),
  'liquid/lfm-3-1.7b:free': M(0.38, 0, 0, 0.8, 32768),
  'nvidia/nemotron-3.5-lightning:free': M(0.6, 0, 0, 0.7, 131072),
  'openrouter/free': M(0.62, 0, 0, 0.6, 131072),
  'mistral-small-latest': M(0.66, 0.10, 0.30, 0.8, 131072),
  'openai/gpt-4o-mini': M(0.7, 0, 0, 0.8, 131072),
  'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B': M(0.35, 0, 0, 0.6, 32768),
  'llama3.1-8b': M(0.55, 0, 0, 0.95, 8192),
  // Cloudflare Workers AI (free daily allocation, then list price; checked 2026-11-26)
  '@cf/meta/llama-3.1-8b-instruct-fast': M(0.52, 0.045, 0.384, 0.85, 8192),
  '@cf/openai/gpt-oss-20b': M(0.64, 0.20, 0.30, 0.85, 131072),
  '@cf/openai/gpt-oss-120b': M(0.80, 0.35, 0.75, 0.75, 131072),
  'command-r7b-12-2024': M(0.55, 0, 0, 0.75, 131072),
  'qwen2.5:0.5b': M(0.3, 0, 0, 0.4, 4096)
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
  cloudflare: ['@cf/meta/llama-3.1-8b-instruct-fast', '@cf/openai/gpt-oss-20b', '@cf/openai/gpt-oss-120b'],
  cohere: [null, 'command-r7b-12-2024', null],
  ollama: [null, 'qwen2.5:0.5b', null]
};

// Unknown models: small / local ones get 8k context, others 32k.
const guessContext = model => (/(\b|[^0-9])(0\.5|1\.5|1\.7|3|7|8)b\b|:\d|local/i.test(model) ? 8192 : 32768);

function modelEntry(model, tier, custom = null) {
  const info = MODEL_INFO[model] || {};
  const pricePrompt = custom?.pricePrompt ?? info.pricePrompt ?? 0.15;
  const priceCompletion = custom?.priceCompletion ?? info.priceCompletion ?? 0.45;
  return {
    model,
    quality: custom?.quality ?? info.quality ?? TIER_DEFAULT_QUALITY[tier],
    pricePrompt,
    priceCompletion,
    price: (pricePrompt + priceCompletion) / 2, // blended USD / 1M (display + legacy callers)
    speed: custom?.speed ?? info.speed ?? 0.7,
    contextWindow: custom?.contextWindow ?? info.ctx ?? guessContext(model)
  };
}

/** Dashboard-registered providers ({ [name]: catalogEntry }); {} if unsupported. */
export function customCatalog() {
  try {
    if (typeof providerIndex.getCustomCatalog !== 'function') return {};
    return providerIndex.getCustomCatalog() || {};
  } catch {
    return {};
  }
}

/** Catalog hints for newer built-ins not in DEFAULTS (same shape as custom entries). */
function builtinHints() {
  try {
    return typeof providerIndex.getBuiltinCatalogHints === 'function' ? providerIndex.getBuiltinCatalogHints() || {} : {};
  } catch {
    return {};
  }
}

const num = v => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** Per-tier { quality, prices, speed, contextWindow } overrides from a custom catalog entry. */
function customTierInfo(entry, tier) {
  const q = entry.quality;
  const quality = num(typeof q === 'object' && q ? (q[tier] ?? q.standard) : q);
  const pr = entry.price;
  let pricePrompt = null;
  let priceCompletion = null;
  if (typeof pr === 'object' && pr) {
    pricePrompt = num(pr.prompt) ?? 0;
    priceCompletion = num(pr.completion) ?? 0;
  } else if (num(pr) !== null) {
    pricePrompt = priceCompletion = num(pr);
  }
  const cw = entry.contextWindow;
  return {
    quality: quality === null ? null : Math.max(0, Math.min(1, quality)),
    pricePrompt,
    priceCompletion,
    speed: num(entry.speed),
    contextWindow: num(typeof cw === 'object' && cw ? (cw[tier] ?? cw.standard) : cw)
  };
}

/** { light, standard, heavy } model entries for a provider (env-aware, read live). */
export function catalog(name) {
  const P = name.toUpperCase();
  const custom = DEFAULTS[name] ? null : customCatalog()[name] || builtinHints()[name] || null;
  const cm = custom?.models || {};
  const d = DEFAULTS[name] || [cm.light || null, cm.standard || null, cm.heavy || null];
  const standard = process.env[`${P}_MODEL`] || d[1] || providers[name]?.defaultModel?.() || 'default';
  const light = process.env[`${P}_MODEL_LIGHT`] || d[0] || standard;
  const heavy = process.env[`${P}_MODEL_HEAVY`] || d[2] || standard;
  return {
    light: modelEntry(light, 'light', custom && customTierInfo(custom, 'light')),
    standard: modelEntry(standard, 'standard', custom && customTierInfo(custom, 'standard')),
    heavy: modelEntry(heavy, 'heavy', custom && customTierInfo(custom, 'heavy'))
  };
}

export function catalogModels(name) {
  const c = catalog(name);
  return { light: c.light.model, standard: c.standard.model, heavy: c.heavy.model };
}

export function catalogContext(name) {
  const c = catalog(name);
  return { light: c.light.contextWindow, standard: c.standard.contextWindow, heavy: c.heavy.contextWindow };
}

/** Expected USD cost of one request on this model entry. */
export function estimateCost(entry, estInputTokens, estOutputTokens) {
  return (estInputTokens * (entry.pricePrompt ?? entry.price ?? 0) + estOutputTokens * (entry.priceCompletion ?? entry.price ?? 0)) / 1e6;
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
  brevity: /\b(briefly|one word|one sentence|short answer|quick(ly)?|in a few words|yes or no)\b/i,
  explain: /\b(explain|step[- ]by[- ]step|walk me through)\b/i
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

  // Expected completion length.
  let estOutputTokens = task === 'summarize' ? Math.max(100, Math.min(Math.round(0.3 * estTokens), 600)) : OUTPUT_TOKENS[task];
  if (RX.depth.test(lastUser) || RX.explain.test(lastUser)) estOutputTokens = Math.round(estOutputTokens * 1.6);
  if (RX.brevity.test(lastUser)) estOutputTokens = Math.max(20, Math.round(estOutputTokens * 0.3));

  return { task, estTokens, estInputTokens: estTokens, estOutputTokens, score, tier, reason };
}

// ---------------------------------------------------------------- ranking

/** Measured speed 0..1 (p50 latency) x reliability; catalog prior when no samples yet. */
export function speedScore(name, entry, { fast = false } = {}) {
  const s = stats.summary(name);
  const raw = s.p50LatencyMs == null
    ? (fast ? entry.speed * entry.speed : entry.speed)
    : 1 / (1 + s.p50LatencyMs / 2000);
  const reliability = s.recentSuccessRate * (1 - 0.7 * (s.recentTimeoutRate || 0));
  return { speed: raw * reliability, raw };
}

/** Back-compat alias: health = speed x reliability. */
export function healthScore(name, entry, opts) {
  return speedScore(name, entry, opts).speed;
}

/** 1 when idle, (1 - ROUTER_LOAD_PENALTY) at full load (in-flight or rate budget). */
export function loadFactor(name, model) {
  return 1 - loadPenalty() * capacity.usage(name, Date.now(), model).load;
}

function weightsFor(policy, tier) {
  const w = { ...(WEIGHTS[policy] || WEIGHTS.balanced) };
  if (tier === 'light' && policy === 'balanced') {
    w.quality -= LIGHT_SPEED_SHIFT;
    w.speed += LIGHT_SPEED_SHIFT;
  }
  return w;
}

/**
 * Score one (provider, model entry). ctx: { estInputTokens, estOutputTokens, minCost, maxCost }.
 * Without ctx (legacy callers) cost is judged from the blended list price.
 */
export function scoreCandidate(name, entry, tier, policy, ctx = {}) {
  const w = weightsFor(policy, tier);
  const fast = policy === 'verify' || tier === 'light';
  const { speed } = speedScore(name, entry, { fast });
  let costTerm;
  if (ctx.estInputTokens == null) {
    costTerm = 1 / (1 + (entry.price ?? 0) / 0.25);
  } else {
    const estCost = estimateCost(entry, ctx.estInputTokens, ctx.estOutputTokens);
    if (policy === 'cost') {
      const span = (ctx.maxCost ?? estCost) - (ctx.minCost ?? estCost);
      costTerm = span > 0 ? 1 - (estCost - ctx.minCost) / span : 1;
    } else {
      costTerm = 1 - estCost / (estCost + costRef());
    }
  }
  const score = (w.quality * entry.quality + w.cost * costTerm + w.speed * speed) * loadFactor(name, entry.model);
  return Math.round(score * 1000) / 1000;
}

// Weighted round robin counters, keyed by tier + bucket membership.
const rrCounters = new Map();

export function resetRoundRobin() {
  rrCounters.clear();
}

function rotateBucket(bucket, key) {
  if (bucket.length < 2) return bucket;
  // Least loaded + fastest first; only near-ties rotate.
  const fit = c => c.fitness ?? 0;
  const sorted = [...bucket].sort((a, b) => fit(b) - fit(a));
  const best = fit(sorted[0]);
  const ties = sorted.filter(c => best - fit(c) <= rrTieDelta());
  const others = sorted.filter(c => best - fit(c) > rrTieDelta());
  if (ties.length < 2) return sorted;
  return [...rotateTies(ties, `${key}|${ties.map(c => c.provider).sort().join(',')}`), ...others];
}

function rotateTies(bucket, key) {
  const wheel = [];
  for (const c of [...bucket].sort((a, b) => a.provider.localeCompare(b.provider))) { // stable wheel order
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

/** Configured providers in PROVIDER_ORDER, plus dashboard-registered custom ones. */
export function configuredProviders() {
  const chain = getProviderChain();
  for (const name of Object.keys(customCatalog())) {
    if (providers[name] && !chain.includes(name)) chain.push(name);
  }
  return chain.filter(isConfigured);
}

/** Model entry of `name` for `tier`, or its next stronger model meeting the floor. */
function pickModel(name, tier, floor) {
  const c = catalog(name);
  const order = TIERS.slice(TIERS.indexOf(tier));
  for (const t of order) if (c[t].quality >= floor) return { entry: c[t], from: t };
  return { entry: c[tier], from: tier, belowFloor: true };
}

const fmtMs = ms => `${Math.ceil(ms / 1000)}s`;

/**
 * Build the ranked candidate list.
 * @param {object} p  messages, policy, model, provider, tier (forced), purpose,
 *   allowDowngrade (bool), exclude (iterable of providers to leave out, e.g. already tried),
 *   waitBudgetMs (cooldowns ending within this are 'waitable', default CAPACITY_WAIT_MS)
 * @returns {{ task, tier, estTokens, estInputTokens, estOutputTokens, requiredQuality, score, policy,
 *   reason, override, allowDowngrade, estCost, eligible, excluded, candidates, waitable, skipped, top }}
 *   candidates: ready now, in attempt order [{ provider, model, tier, quality, estCost, score, speed, load, state, override? }]
 *   waitable:   eligible but at capacity [{ ...same, readyInMs, why }]
 *   skipped:    [{ provider, state }] health-blocked providers (legacy field)
 *   top:        first 5 of candidates+waitable as { provider, model, quality, estCost, score }
 */
export function route({ messages, policy, model, provider, tier: forcedTier, purpose, allowDowngrade, exclude, waitBudgetMs } = {}) {
  const cls = classify(messages);
  const pol = normalizePolicy(policy);
  const weightKey = purpose === 'verify' ? 'verify' : pol;
  const tier = TIERS.includes(forcedTier) ? forcedTier : cls.tier;
  const requiredQuality = qualityFloor(tier);
  const estIn = cls.estInputTokens;
  const estOut = cls.estOutputTokens;
  const estTotal = estIn + estOut;
  const waitBudget = waitBudgetMs ?? capacity.capacityWaitMs();
  const excludeSet = new Set(exclude || []);
  const allow = resolveAllowDowngrade(pol, allowDowngrade, purpose);
  const configured = configuredProviders();
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
  const excluded = {};
  const skipped = [];
  const ready = [];
  const waitable = [];

  // Pass 1: eligibility (quality floor, context) and health/capacity filtering.
  const pool = [];
  for (const name of configured) {
    if (excludeSet.has(name)) continue;
    const state = circuit.getState(name, now);
    const isLead = name === leadProvider;
    if (state === 'disabled' || state === 'open' || (state === 'cooldown' && circuit.blockedUntil(name, now) - now > waitBudget)) {
      const reason = state === 'disabled'
        ? `disabled (${circuit.disabledReason(name, now) || 'auth'})`
        : state === 'open' ? `breaker open (retry in ${fmtMs(circuit.blockedUntil(name, now) - now)})`
          : `rate limited (cooldown ${fmtMs(circuit.blockedUntil(name, now) - now)})`;
      excluded[name] = reason;
      skipped.push({ provider: name, state });
      if (isLead) notes.push(`requested provider '${name}' is ${state}`);
      continue;
    }
    let entry;
    if (isLead) {
      entry = catalog(name)[tier];
      if (modelOv?.model && modelOv.provider === name) entry = { ...modelEntry(modelOv.model, tier), model: modelOv.model };
    } else {
      const pick = pickModel(name, tier, requiredQuality);
      if (pick.belowFloor) {
        excluded[name] = `quality ${pick.entry.quality.toFixed(2)} < required ${requiredQuality.toFixed(2)}`;
        continue;
      }
      entry = pick.entry;
      if (entry.contextWindow < estTotal) {
        excluded[name] = `context ${entry.contextWindow} < ~${estTotal} tokens`;
        continue;
      }
    }
    pool.push({ name, entry, state, isLead });
  }

  const costs = pool.map(p => estimateCost(p.entry, estIn, estOut));
  const ctx = { estInputTokens: estIn, estOutputTokens: estOut, minCost: Math.min(...costs), maxCost: Math.max(...costs) };

  for (const p of pool) {
    const { name, entry, state, isLead } = p;
    const { raw } = speedScore(name, entry, { fast: weightKey === 'verify' || tier === 'light' });
    const load = capacity.usage(name, now, entry.model).load;
    const c = {
      provider: name, model: entry.model, tier, quality: entry.quality,
      estCost: estimateCost(entry, estIn, estOut),
      score: scoreCandidate(name, entry, tier, weightKey, ctx),
      speed: Math.round(raw * 1000) / 1000, load: Math.round(load * 1000) / 1000,
      fitness: raw * (1 - load), contextWindow: entry.contextWindow, state
    };
    if (isLead) c.override = override || 'provider';
    const block = capacity.capacityBlock(name, estTotal, now, entry.model);
    const probeBusy = state === 'probing' && !circuit.canAttempt(name);
    const coolMs = state === 'cooldown' ? circuit.blockedUntil(name, now) - now : 0;
    if (block?.hard) { excluded[name] = block.reason; continue; }
    if (probeBusy) { excluded[name] = 'breaker half-open (probe in flight)'; skipped.push({ provider: name, state }); continue; }
    if (block || coolMs > 0) {
      const readyInMs = coolMs > 0 ? Math.max(coolMs, block?.readyInMs || 0) : block.readyInMs;
      if (readyInMs != null && readyInMs > waitBudget) { excluded[name] = block?.reason || `rate limited (cooldown ${fmtMs(coolMs)})`; continue; }
      const why = coolMs > 0 ? `rate limited (cooldown ${fmtMs(coolMs)})` : block.reason;
      excluded[name] = why;
      waitable.push({ ...c, readyInMs, why });
      continue;
    }
    ready.push(c);
  }

  const byScore = (a, b) => b.score - a.score;
  const lead = ready.find(c => c.override);
  const healthy = ready.filter(c => !c.override && c.state === 'healthy').sort(byScore);
  const probing = ready.filter(c => !c.override && c.state !== 'healthy').sort(byScore);
  waitable.sort((a, b) => (a.override ? -1 : b.override ? 1 : b.score - a.score));

  // Top bucket: least loaded + fastest first, near-ties rotate (weighted round robin).
  let ordered = healthy;
  if (healthy.length > 1) {
    const top = healthy[0].score;
    let bucket = healthy.filter(c => top - c.score <= rrBucketDelta());
    // cost / quality policies: the bucket must also be near-equal on the primary metric,
    // so "fastest within the bucket" never trades away the cheapest / best model.
    if (weightKey === 'quality') {
      const maxQ = Math.max(...bucket.map(c => c.quality));
      bucket = bucket.filter(c => c.quality >= maxQ - 0.03);
    } else if (weightKey === 'cost') {
      const minC = Math.min(...bucket.map(c => c.estCost));
      bucket = bucket.filter(c => c.estCost <= minC + Math.max(1e-7, minC * 0.1));
    }
    const rest = healthy.filter(c => !bucket.includes(c));
    const key = `${tier}|${pol}|${bucket.map(c => c.provider).sort().join(',')}`;
    ordered = [...rotateBucket(bucket, key), ...rest];
  }
  let candidates = [...(lead ? [lead] : []), ...ordered, ...probing];

  if (!leadProvider && modelOv?.model && !modelOv.provider && candidates.length) {
    // Unknown bare model: try it on the top-ranked provider, others keep their own models.
    candidates[0] = { ...candidates[0], model: modelOv.model, override: 'model' };
  }

  const eligibleCount = candidates.length + waitable.length;
  const head = candidates[0] || waitable[0];
  let reason = purpose === 'verify'
    ? `cache verification -> ${tier} tier`
    : forcedTier && TIERS.includes(forcedTier) ? `${cls.task} (tier forced) -> ${tier} tier` : cls.reason;
  reason += `, policy ${pol}, needs quality >= ${requiredQuality.toFixed(2)}, ~${estIn}+${estOut} tokens, ${eligibleCount} eligible`;
  if (head) reason += `; first: ${head.provider}/${head.model}${head.override ? ` (${head.override} override)` : ''}${candidates[0] ? '' : ' (at capacity)'}`;
  if (notes.length) reason += `; ${notes.join('; ')}`;
  if (!eligibleCount) reason += '; no eligible provider available';

  const strip = ({ fitness, ...c }) => c;
  candidates = candidates.map(strip);
  const waitList = waitable.map(strip);
  return {
    task: cls.task,
    tier,
    estTokens: cls.estTokens,
    estInputTokens: estIn,
    estOutputTokens: estOut,
    requiredQuality,
    score: cls.score,
    policy: pol,
    reason,
    override: candidates.some(c => c.override) || waitList.some(c => c.override) ? override : null,
    allowDowngrade: allow,
    estCost: head ? head.estCost : null,
    eligible: eligibleCount,
    excluded,
    candidates,
    waitable: waitList,
    skipped,
    top: [...candidates, ...waitList].slice(0, 5).map(c => ({ provider: c.provider, model: c.model, quality: c.quality, estCost: c.estCost, score: c.score }))
  };
}

/** Downgrade policy: request value (bool / 'true' / 'false'), else true for cost & balanced, false for quality. */
export function resolveAllowDowngrade(policy, value, purpose) {
  if (purpose === 'verify') return false;
  if (value === true || value === false) return value;
  const v = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes'].includes(v)) return true;
  if (['false', '0', 'no'].includes(v)) return false;
  const env = String(process.env.ROUTER_ALLOW_DOWNGRADE || '').trim().toLowerCase();
  if (env === 'true' || env === 'false') return env === 'true';
  return normalizePolicy(policy) !== 'quality';
}
