import dotenv from 'dotenv';
dotenv.config();

export const OPENROUTER_MODELS = {
  TRINITY: 'nvidia/nemotron-3-ultra-550b-a55b:free',
  QWEN_MATH: 'qwen/qwen3-next-80b-a3b-instruct:free',
  NEMOTRON: 'nvidia/nemotron-3-super-120b-a12b:free',
  GPT_OSS: 'openai/gpt-oss-120b:free',
  LAGUNA_JSON: 'poolside/laguna-m.1:free',
  HERMES_JSON: 'nousresearch/hermes-3-llama-3.1-405b:free',
  DEEPSEEK_FLASH: 'google/gemma-4-31b-it:free',
  GEMMA_TUTOR: 'google/gemma-4-31b-it:free',
  GLM_AIR: 'meta-llama/llama-3.3-70b-instruct:free',
  LIQUID_THINKING: 'qwen/qwen3-coder:free',
  LLAMA_3B: 'qwen/qwen3-coder:free',
  NEMOTRON_VISION: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
};

export const TIER_1_MODELS = [
  OPENROUTER_MODELS.TRINITY,
  OPENROUTER_MODELS.QWEN_MATH,
  OPENROUTER_MODELS.NEMOTRON,
  OPENROUTER_MODELS.GPT_OSS,
];

export const NVIDIA_NIM_MODELS = {
  QWEN_CODER: 'openai/gpt-oss-120b',
  LLAMA_3_3_70B: 'openai/gpt-oss-120b',
  KIMI_K2_6: 'moonshotai/kimi-k2.6',
  LLAMA_4_MAVERICK: 'openai/gpt-oss-120b',
  MINIMAX_2_7: 'moonshotai/kimi-k2.6',
  NEMOTRON_70B: 'moonshotai/kimi-k2.6',
  LLAMA_3_1_70B: 'moonshotai/kimi-k2.6',
};

const NVIDIA_NIM_MODEL_SET = new Set(Object.values(NVIDIA_NIM_MODELS));

export const NVIDIA_IMAGE_MODELS = [
  {
    id: 'flux-schnell',
    label: 'FLUX.1-schnell',
    genaiPath: 'black-forest-labs/flux.1-schnell',
    buildBody: (prompt) => ({
      prompt,
      height: 1024,
      width: 1024,
      seed: Math.floor(Math.random() * 65536),
      steps: 4,
    }),
  },
  {
    id: 'flux-dev',
    label: 'FLUX.1-dev',
    genaiPath: 'black-forest-labs/flux.1-dev',
    buildBody: (prompt) => ({
      prompt,
      height: 1024,
      width: 1024,
      seed: Math.floor(Math.random() * 65536),
      steps: 20,
    }),
  },
  {
    id: 'sd35',
    label: 'SD 3.5 Large',
    genaiPath: 'stabilityai/stable-diffusion-3-5-large',
    buildBody: (prompt) => ({
      prompt,
      seed: Math.floor(Math.random() * 65536),
      cfg_scale: 7.5,
      sampler: 'DDIM',
      steps: 30,
      negative_prompt: 'blurry, low quality',
    }),
  },
  {
    id: 'flux2-klein',
    label: 'FLUX.2-klein-4b',
    genaiPath: 'black-forest-labs/flux.2-klein-4b',
    buildBody: (prompt) => ({
      prompt,
      height: 1024,
      width: 1024,
      seed: Math.floor(Math.random() * 65536),
      steps: 4,
    }),
  },
  {
    id: 'qwen-image',
    label: 'Qwen-Image',
    genaiPath: 'qwen/qwen-image',
    buildBody: (prompt) => ({
      prompt,
      height: 1024,
      width: 1024,
      seed: Math.floor(Math.random() * 65536),
      steps: 20,
    }),
  },
];

const getKeys = (keyString) => {
  if (!keyString) return [];
  return Array.from(new Set(
    keyString.split(',')
      .map(k => k.trim())
      .filter(k => k.length > 15 && !k.includes('YOUR_KEY') && !k.includes('placeholder'))
  ));
};

const OPENROUTER_KEYS = getKeys(process.env.OPENROUTER_API_KEY);
const NVIDIA_NIM_KEYS = getKeys(process.env.NVIDIA_NIM_API_KEY);

function isNvidiaNIMModel(model) {
  return NVIDIA_NIM_MODEL_SET.has(model);
}

async function callOpenRouter(messages, apiKey, model) {
  const targetModel = model || OPENROUTER_MODELS.DEEPSEEK_FLASH;
  const isTier1 = TIER_1_MODELS.includes(targetModel);

  const formattedMessages = messages.map(msg => ({
    role: msg.role,
    content: msg.content,
    ...(msg.reasoning_details ? { reasoning_details: msg.reasoning_details } : {}),
  }));

  const requestBody = {
    model: targetModel,
    messages: formattedMessages,
  };

  if (isTier1) {
    requestBody.reasoning = { enabled: true };
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://testasmastery.com',
      'X-OpenRouter-Title': 'TestAS Mastery Hub',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter returned HTTP ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0];
  const responseMessage = choice?.message;

  const content = responseMessage?.content || '';
  const reasoning_details = responseMessage?.reasoning_details || undefined;

  return { content, reasoning_details };
}

async function callNvidiaNIM(messages, apiKey, model) {
  const formattedMessages = messages.map(msg => ({
    role: msg.role,
    content: msg.content,
    ...(msg.reasoning_details ? { reasoning_details: msg.reasoning_details } : {}),
  }));

  const extraBody = {};
  if (model === NVIDIA_NIM_MODELS.KIMI_K2_6) {
    extraBody.chat_template_kwargs = { thinking: false };
  }

  const requestBody = {
    model,
    messages: formattedMessages,
    max_tokens: 4096,
    ...extraBody,
  };

  const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`NVIDIA NIM returned HTTP ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0];
  const responseMessage = choice?.message;

  const content = responseMessage?.content || '';
  const reasoning_details = responseMessage?.reasoning_details || undefined;

  return { content, reasoning_details };
}

export async function askAI(messages, options = {}) {
  const jsonMode = options?.jsonMode || false;
  const maxRetries = options?.retries !== undefined ? options?.retries : 1;
  const taskType = options?.taskType || 'chat';

  const candidates = [];
  if (options?.model) {
    candidates.push(options.model);
  }

  const FALLBACK_POOLS = {
    math_solver: [
      OPENROUTER_MODELS.QWEN_MATH,
      OPENROUTER_MODELS.TRINITY,
      OPENROUTER_MODELS.NEMOTRON,
      OPENROUTER_MODELS.GPT_OSS,
      NVIDIA_NIM_MODELS.NEMOTRON_70B,
      NVIDIA_NIM_MODELS.LLAMA_3_3_70B,
    ],
    chat: [
      OPENROUTER_MODELS.DEEPSEEK_FLASH,
      OPENROUTER_MODELS.GEMMA_TUTOR,
      OPENROUTER_MODELS.GLM_AIR,
      NVIDIA_NIM_MODELS.MINIMAX_2_7,
      NVIDIA_NIM_MODELS.LLAMA_4_MAVERICK,
      NVIDIA_NIM_MODELS.LLAMA_3_1_70B,
      OPENROUTER_MODELS.LIQUID_THINKING,
      OPENROUTER_MODELS.LLAMA_3B,
    ],
    json_generator: [
      NVIDIA_NIM_MODELS.QWEN_CODER,
      NVIDIA_NIM_MODELS.LLAMA_3_3_70B,
      OPENROUTER_MODELS.LAGUNA_JSON,
      OPENROUTER_MODELS.HERMES_JSON,
      NVIDIA_NIM_MODELS.LLAMA_3_1_70B,
    ],
  };

  const pool = FALLBACK_POOLS[taskType] || FALLBACK_POOLS.chat;
  pool.forEach(m => {
    if (!candidates.includes(m)) {
      candidates.push(m);
    }
  });

  let lastError = null;

  for (const candidateModel of candidates) {
    const isNIM = isNvidiaNIMModel(candidateModel);
    const activeKeys = isNIM ? NVIDIA_NIM_KEYS : OPENROUTER_KEYS;

    if (activeKeys.length === 0) {
      const errMsg = isNIM
        ? 'NVIDIA NIM API Key not configured on the backend.'
        : 'OpenRouter API Key not configured on the backend.';
      lastError = new Error(errMsg);
      continue;
    }

    for (const key of activeKeys) {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          let result;
          if (isNIM) {
            result = await callNvidiaNIM(messages, key, candidateModel);
          } else {
            result = await callOpenRouter(messages, key, candidateModel);
          }

          if (result && (result.content || result.reasoning_details)) {
            const hasErrorText = typeof result.content === 'string' && (
              result.content.includes('429 Rate limit exceeded') ||
              result.content.includes('Provider returned error') ||
              result.content.includes('429 Provider returned error') ||
              result.content.includes('free-models-per-day')
            );
            if (hasErrorText) {
              throw new Error(result.content);
            }
            return result;
          }
        } catch (err) {
          lastError = err;
          const isRateLimit = err.message && (
            err.message.includes('429') ||
            err.message.includes('rate_limit') ||
            err.message.includes('Rate limit') ||
            err.message.includes('quota') ||
            err.message.includes('Provider returned error') ||
            err.message.includes('free-models-per-day')
          );
          if (isRateLimit) {
            break;
          }
          if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
          }
        }
      }
    }
  }

  const finalError = lastError ? lastError.message : 'All model routing attempts failed or service unavailable.';
  if (jsonMode) {
    throw new Error(finalError);
  }

  return {
    content: `Unable to connect to AI providers. Error: ${finalError}`
  };
}

export async function askAIVision(prompt, base64Image, model = OPENROUTER_MODELS.NEMOTRON_VISION) {
  if (OPENROUTER_KEYS.length === 0) {
    throw new Error('OpenRouter API Key not configured on the backend.');
  }

  let lastError = null;

  for (const apiKey of OPENROUTER_KEYS) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://testasmastery.com',
          'X-OpenRouter-Title': 'TestAS Mastery Hub',
        },
        body: JSON.stringify({
          model: model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                {
                  type: 'image_url',
                  image_url: {
                    url: base64Image
                  }
                }
              ]
            }
          ]
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenRouter returned HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || '';

      if (content.includes('429 Rate limit exceeded') || content.includes('Provider returned error') || content.includes('free-models-per-day')) {
        throw new Error(content);
      }
      return content || 'No response from vision model.';
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(`Vision models failed or rate limited on all keys. Last error: ${lastError ? lastError.message : 'Unknown'}`);
}

export async function generateNIMImage(prompt) {
  // Diffusion models (Flux, SD, etc.) cannot render real readable text — asking
  // for "labeled diagrams" or "annotations" makes them hallucinate illegible
  // squiggles that look like text but aren't. Steer toward a clean illustrative
  // style with NO attempted text, and let the surrounding chat message (real,
  // readable HTML) carry any actual labels/explanations instead of the image.
  const enhancedPrompt = `${prompt}, clean scientific illustration, glowing neon accent style, dark background, smooth vector shapes, no text, no labels, no words, no letters, no annotations, ultra high definition, premium quality`;

  const getPollinationsUrl = () => {
    const s = Math.floor(Math.random() * 999999);
    return `https://image.pollinations.ai/prompt/${encodeURIComponent(enhancedPrompt)}?width=1024&height=768&nologo=true&seed=${s}&model=flux`;
  };

  if (NVIDIA_NIM_KEYS.length === 0) {
    console.warn('[generateNIMImage] No NVIDIA NIM keys configured, using Pollinations directly.');
    return { imageUrl: getPollinationsUrl(), modelUsed: 'pollinations/flux', source: 'pollinations' };
  }

  const errors = [];

  // Try each model in priority order (schnell -> dev -> sd35 -> flux2-klein -> qwen-image),
  // and for each model try every configured key, before moving to the next model.
  // This gives a real fallback chain instead of only ever attempting the first model.
  for (const nimModel of NVIDIA_IMAGE_MODELS) {
    for (const nimKey of NVIDIA_NIM_KEYS) {
      try {
        const response = await fetch(`https://ai.api.nvidia.com/v1/genai/${nimModel.genaiPath}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${nimKey}`,
          },
          body: JSON.stringify(nimModel.buildBody(enhancedPrompt)),
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          throw new Error(`HTTP ${response.status}: ${errText.slice(0, 300)}`);
        }

        const data = await response.json();
        const base64 = data?.artifacts?.[0]?.base64;
        if (base64) {
          return { imageUrl: `data:image/png;base64,${base64}`, modelUsed: nimModel.label, source: 'nim' };
        }

        const b64json = data?.data?.[0]?.b64_json;
        if (b64json) {
          return { imageUrl: `data:image/png;base64,${b64json}`, modelUsed: nimModel.label, source: 'nim' };
        }

        const imgUrl = data?.data?.[0]?.url || data?.url;
        if (imgUrl) {
          return { imageUrl: imgUrl, modelUsed: nimModel.label, source: 'nim' };
        }

        throw new Error('No image found in response body');
      } catch (err) {
        // Log so failures are visible in server logs instead of silently
        // falling through — this is what made prior NIM failures invisible.
        console.error(`[generateNIMImage] ${nimModel.label} failed: ${err.message}`);
        errors.push(`${nimModel.label}: ${err.message}`);
        // Try the next key for this same model before giving up on it entirely
      }
    }
  }

  console.error(`[generateNIMImage] All NVIDIA NIM models failed, falling back to Pollinations. Errors: ${errors.join(' | ')}`);
  return { imageUrl: getPollinationsUrl(), modelUsed: 'pollinations/flux (fallback)', source: 'pollinations' };
}