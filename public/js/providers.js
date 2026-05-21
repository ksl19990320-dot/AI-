// ===== 多 Provider API 调用层 =====

const STYLE_GUIDES = {
  'photorealistic': 'photorealistic, highly detailed, natural lighting, 8k resolution, sharp focus, professional photography',
  'anime': 'anime style, studio ghibli inspired, vibrant colors, clean linework, cel shaded',
  'oil-painting': 'oil painting style, textured brushstrokes, rich impasto, classical composition, museum quality',
  'watercolor': 'watercolor painting style, soft washes, delicate transparency, artistic, flowing colors',
  'cyberpunk': 'cyberpunk aesthetic, neon lights, futuristic city, high tech low life, atmospheric haze',
  'minimalist': 'minimalist design, clean composition, negative space, simple shapes, elegant simplicity',
  '3d-render': '3D render, octane render, cinematic lighting, ray tracing, hyperrealistic CGI',
  'pixel-art': 'pixel art style, 16-bit retro, crisp pixels, limited color palette, game sprite aesthetic',
};

class ImageProviders {
  constructor() {
    this.providers = {
      'bltcy': {
        name: 'BLTCY AI',
        baseURL: 'https://api.bltcy.ai/v1',
        useImagesEndpoint: true,
        models: [
          { id: 'gpt-image-2', name: 'GPT Image 2.0', t2i: true, i2i: true },
          { id: 'gemini-3.1-flash-image-preview', name: 'Nano Banana 2 (香蕉2)', t2i: true, i2i: true },
          { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', t2i: false, i2i: false, chatOnly: true },
          { id: 'gemini-3.1-flash-preview-thinking-128', name: 'Gemini 3.1 Flash', t2i: false, i2i: false, chatOnly: true },
        ],
      },
      'chatgpt-image': {
        name: 'ChatGPT Image',
        baseURL: 'https://api.openai.com/v1',
        useImagesEndpoint: false,
        models: [
          { id: 'gpt-image-1', name: 'ChatGPT Image 2', t2i: true, i2i: true },
          { id: 'dall-e-3', name: 'DALL·E 3', t2i: true, i2i: false },
        ],
      },
      'doubao': {
        name: '豆包',
        baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
        useImagesEndpoint: false,
        models: [
          { id: 'doubao-seedance-2.0', name: 'Seedance 2.0', t2i: true, i2i: true },
          { id: 'doubao-vision-pro-32k', name: '豆包视觉 Pro', t2i: true, i2i: true },
        ],
      },
    };
  }

  getProviderKeys() { return Object.keys(this.providers); }
  getProvider(key) { return this.providers[key]; }

  getAllModels() {
    const models = [];
    for (const [key, provider] of Object.entries(this.providers)) {
      for (const model of provider.models) {
        models.push({ providerKey: key, providerName: provider.name, ...model });
      }
    }
    return models;
  }

  getApiKey(providerKey) { return localStorage.getItem('apikey_' + providerKey) || ''; }
  setApiKey(providerKey, key) { localStorage.setItem('apikey_' + providerKey, key); }

  // ===== 文生图 =====
  async textToImage({ providerKey, model, prompt, negativePrompt, width, height, style, imageSize }) {
    const provider = this.providers[providerKey];
    if (!provider) throw new Error('未知提供商: ' + providerKey);

    const apiKey = this.getApiKey(providerKey);
    if (!apiKey) throw new Error('请先配置 ' + provider.name + ' 的 API Key');

    const enhancedPrompt = this._enhancePrompt(prompt, style, false);

    if (provider.useImagesEndpoint) {
      return this._callImagesEndpoint(provider, apiKey, model, enhancedPrompt, width, height, imageSize);
    }

    return this._callChatCompletions(provider, apiKey, model, enhancedPrompt, negativePrompt, width, height, null);
  }

  // ===== 图生图 =====
  async imageToImage({ providerKey, model, prompt, negativePrompt, imageBase64, strength, width, height, style, imageSize }) {
    const provider = this.providers[providerKey];
    if (!provider) throw new Error('未知提供商: ' + providerKey);

    const apiKey = this.getApiKey(providerKey);
    if (!apiKey) throw new Error('请先配置 ' + provider.name + ' 的 API Key');

    const enhancedPrompt = this._enhancePrompt(prompt, style, true, strength);

    if (provider.useImagesEndpoint) {
      return this._callImagesEndpoint(provider, apiKey, model, enhancedPrompt, width, height, imageSize, imageBase64);
    }

    return this._callChatCompletions(provider, apiKey, model, enhancedPrompt, negativePrompt, width, height, imageBase64);
  }

  // ===== Images 端点 =====
  async _callImagesEndpoint(provider, apiKey, model, prompt, width, height, imageSize, referenceImages) {
    const ratio = this._getAspectRatio(width, height);
    const body = {
      model,
      prompt,
      n: 1,
      response_format: 'url',
      aspect_ratio: ratio,
      image_size: imageSize || '2K',
    };
    if (referenceImages && referenceImages.length > 0) {
      body.image = referenceImages.map(img => 'data:image/png;base64,' + img);
    }

    console.log('[API] POST ' + provider.baseURL + '/images/generations', { model, ratio, prompt: prompt.substring(0, 50) });

    const resp = await fetch(provider.baseURL + '/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify(body),
    });

    const json = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      const msg = json.error?.message || json.message || 'HTTP ' + resp.status;
      throw new Error('[' + resp.status + '] ' + msg);
    }

    let imageUrl = json.data?.[0]?.url;
    let b64 = json.data?.[0]?.b64_json;

    if (!imageUrl && !b64) {
      throw new Error('API 未返回图片: ' + JSON.stringify(json).substring(0, 300));
    }

    if (imageUrl && !b64) {
      console.log('[API] 下载图片:', imageUrl);
      const imgResp = await fetch(imageUrl);
      if (!imgResp.ok) throw new Error('下载图片失败: ' + imgResp.status);
      const blob = await imgResp.blob();
      b64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(',')[1]);
        reader.readAsDataURL(blob);
      });
    }

    return {
      base64: b64,
      revisedPrompt: json.data?.[0]?.revised_prompt || prompt,
    };
  }

  // ===== Chat Completions 端点 =====
  async _callChatCompletions(provider, apiKey, model, prompt, negativePrompt, width, height, imageBase64) {
    const messages = [
      {
        role: 'system',
        content: '你是专业AI绘图助手。生成宽' + width + 'px高' + height + 'px的高质量图片。' + (negativePrompt ? '避免: ' + negativePrompt + ' ' : '') + '直接生成图片，不要文字说明。'
      },
    ];

    const userContent = [];
    const images = Array.isArray(imageBase64) ? imageBase64 : (imageBase64 ? [imageBase64] : []);
    images.forEach(img => {
      userContent.push({
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,' + img, detail: 'high' },
      });
    });
    userContent.push({ type: 'text', text: prompt });
    messages.push({ role: 'user', content: userContent });

    const resp = await fetch(provider.baseURL + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({ model, messages, max_tokens: 4096 }),
    });

    const json = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      const msg = json.error?.message || json.message || 'HTTP ' + resp.status;
      throw new Error('[' + resp.status + '] ' + msg);
    }

    const content = json.choices[0].message.content;
    return this._extractImage(content, prompt);
  }

  _getAspectRatio(width, height) {
    const ratio = width / height;
    if (ratio > 1.7) return '16:9';
    if (ratio > 1.2) return '4:3';
    if (ratio > 0.9) return '1:1';
    if (ratio > 0.6) return '3:4';
    return '9:16';
  }

  _extractImage(content, fallbackPrompt) {
    const match = content.match(/data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/);
    if (match) return { base64: match[1], revisedPrompt: content };
    const mdMatch = content.match(/!\[.*?\]\((data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)\)/);
    if (mdMatch) return { base64: mdMatch[1].split(',')[1], revisedPrompt: content };
    return { base64: null, revisedPrompt: content, error: '未能提取图片数据' };
  }

  _enhancePrompt(prompt, style, isI2I, strength) {
    let p = prompt;
    if (style && STYLE_GUIDES[style]) {
      p = p + ', ' + STYLE_GUIDES[style];
    }
    if (isI2I && strength) {
      p = p + ', maintain composition and similarity to the reference image, strength ' + strength;
    }
    return p;
  }

  // ===== 鏅鸿兘瀵硅瘽 (Chat) =====
  async chat({ providerKey, model, messages }) {
    const provider = this.providers[providerKey];
    if (!provider) throw new Error('链煡鎻愪緵鍟? ' + providerKey);
    const apiKey = this.getApiKey(providerKey);
    if (!apiKey) throw new Error('璇峰厛閰嶇疆 ' + provider.name + ' 鐨?API Key');

    const resp = await fetch(provider.baseURL + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify({ model, messages, max_tokens: 4096 }),
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = json.error?.message || json.message || 'HTTP ' + resp.status;
      throw new Error('[' + resp.status + '] ' + msg);
    }
    return json.choices[0].message.content || '';
  }
}

window.ImageProviders = ImageProviders;