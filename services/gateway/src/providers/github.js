import { createOpenAICompatAdapter } from './openaiCompat.js';

// GitHub Models (free with a GitHub token). A non-JSON body (the endpoint has
// been seen answering plain-text "OK") is mapped to 502 by the shared helper.
const adapter = createOpenAICompatAdapter({
  name: 'github', label: 'GitHub Models',
  url: 'https://models.github.ai/inference/chat/completions',
  keyEnv: ['GITHUB_TOKEN'], modelEnv: 'GITHUB_MODEL', defaultModel: 'openai/gpt-4o-mini'
});

export const { sendChatCompletion, calculateCost, isConfigured } = adapter;
