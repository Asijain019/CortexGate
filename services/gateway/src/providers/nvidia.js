import { createOpenAICompatAdapter } from './openaiCompat.js';

// NVIDIA NIM free developer credits: cost 0.
const adapter = createOpenAICompatAdapter({
  name: 'nvidia', label: 'NVIDIA',
  url: 'https://integrate.api.nvidia.com/v1/chat/completions',
  keyEnv: ['NVIDIA_API_KEY', 'NVDIA_API_KEY'], modelEnv: 'NVIDIA_MODEL',
  defaultModel: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'
});

export const { sendChatCompletion, calculateCost, isConfigured } = adapter;
