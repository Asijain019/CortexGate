import * as groq from './groq.js';
import * as gemini from './gemini.js';

export const providers = {
  groq,
  gemini
};

export function getProviderChain(requestedProvider) {
  const envOrder = (process.env.PROVIDER_ORDER || 'groq,gemini')
    .split(',')
    .map(s => s.trim().toLowerCase());

  const available = Object.keys(providers);
  const chain = [];

  if (requestedProvider && providers[requestedProvider.toLowerCase()]) {
    chain.push(requestedProvider.toLowerCase());
  }

  for (const name of envOrder) {
    if (providers[name] && !chain.includes(name)) {
      chain.push(name);
    }
  }

  for (const name of available) {
    if (!chain.includes(name)) {
      chain.push(name);
    }
  }

  return chain;
}
