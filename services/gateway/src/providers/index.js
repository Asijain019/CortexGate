import * as groq from './groq.js';
import * as openrouter from './openrouter.js';
import * as nvidia from './nvidia.js';
import * as gemini from './gemini.js';
import * as sambanova from './sambanova.js';
import * as mistral from './mistral.js';
import * as huggingface from './huggingface.js';
import * as github from './github.js';

export const providers = {
  groq,
  openrouter,
  openai: openrouter,
  nvidia,
  gemini,
  sambanova,
  mistral,
  huggingface,
  github
};

export function getProviderChain(requestedProvider) {
  const envOrder = (process.env.PROVIDER_ORDER || 'groq,openrouter,nvidia,gemini,sambanova,mistral,huggingface,github')
    .split(',')
    .map(s => s.trim().toLowerCase());

  const available = Object.keys(providers).filter(k => k !== 'openai');
  const chain = [];

  if (requestedProvider && typeof requestedProvider === 'string') {
    const key = requestedProvider.toLowerCase();
    const actual = key === 'openai' ? 'openrouter' : key;
    if (providers[actual]) {
      chain.push(actual);
    }
  }

  for (const name of envOrder) {
    const actual = name === 'openai' ? 'openrouter' : name;
    if (providers[actual] && !chain.includes(actual)) {
      chain.push(actual);
    }
  }

  for (const name of available) {
    if (!chain.includes(name)) {
      chain.push(name);
    }
  }

  return chain;
}
