import * as vscode from 'vscode';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export type Provider = 'anthropic' | 'openai' | 'gemini' | 'groq' | 'ollama'| 'openrouter';

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  defaultModel: string;
  models: string[];
  headerKey: string;
  extraHeaders?: Record<string, string>;
  format: 'anthropic' | 'openai';
}

export const PROVIDERS: Record<Provider, ProviderConfig> = {
  anthropic: {
    name: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-sonnet-4-5',
    models: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5-20251001'],
    headerKey: 'x-api-key',
    extraHeaders: { 'anthropic-version': '2023-06-01' },
    format: 'anthropic',
  },
  openai: {
    name: 'OpenAI (GPT)',
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    headerKey: 'Authorization',
    format: 'openai',
  },
  gemini: {
    name: 'Google (Gemini)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    defaultModel: 'gemini-2.0-flash',
    models: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-flash', 'gemini-1.5-pro'],
    headerKey: 'Authorization',
    format: 'openai',
  },


  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: 'openai/gpt-oss-120b',
    models: [
      'openai/gpt-oss-120b', 
      'openai/gpt-oss-120b:free', 
      'anthropic/claude-3.5-sonnet', 
      'google/gemini-2.5-pro'
    ],
    headerKey: 'Authorization',
    format: 'openai',
    extraHeaders: {
      'HTTP-Referer': 'https://github.com/lovleen-shukla/codelens-ai', // Recommended by OpenRouter
      'X-Title': 'CodeLens AI'
    }
  },

  groq: {
    name: 'Groq (fast inference)',
    baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    headerKey: 'Authorization',
    format: 'openai',
  },
  ollama: {
    name: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1/chat/completions',
    defaultModel: 'llama3',
    models: ['llama3', 'mistral', 'codellama', 'deepseek-coder'],
    headerKey: 'Authorization',
    format: 'openai',
  },
};

function buildErrorMessage(providerName: string, status: number, body: string, model: string): string {
  let hint = '';
  if (status === 404) hint = ` | Model "${model}" not found — run "CodeLens AI: Show Current Provider & Model" to change it.`;
  else if (status === 401 || status === 403) hint = ` | Invalid API key — run "CodeLens AI: Set API Key".`;
  else if (status === 429) hint = ` | Rate limit hit — try a faster model or wait a moment.`;
  return `${providerName} error ${status}${hint}\n${body}`;
}

export class AIClient {
  constructor(private context: vscode.ExtensionContext) { }

  getProvider(): Provider {
    return (vscode.workspace.getConfiguration('codelensai').get<string>('provider') ?? 'anthropic') as Provider;
  }

  getProviderConfig(): ProviderConfig {
    const cfg = { ...PROVIDERS[this.getProvider()] };
    if (this.getProvider() === 'ollama') {
      const base = vscode.workspace.getConfiguration('codelensai').get<string>('ollamaUrl') ?? 'http://localhost:11434';
      cfg.baseUrl = base.replace(/\/$/, '') + '/v1/chat/completions';
    }
    return cfg;
  }

  getModel(): string {
    const cfg = vscode.workspace.getConfiguration('codelensai');
    const stored = cfg.get<string>('model');
    return stored || this.getProviderConfig().defaultModel;
  }

  private async getApiKey(): Promise<string> {
    const provider = this.getProvider();
    const secretKey = `codelensai.apiKey.${provider}`;
    const secret = await this.context.secrets.get(secretKey);
    if (secret) return secret;
    const legacy = await this.context.secrets.get('codelensai.apiKey');
    if (legacy && provider === 'anthropic') return legacy;
    if (provider === 'ollama') return 'ollama';
    throw new Error(`No API key for ${this.getProviderConfig().name}. Run "CodeLens AI: Set API Key".`);
  }

  async setApiKey(key: string): Promise<void> {
    const provider = this.getProvider();
    await this.context.secrets.store(`codelensai.apiKey.${provider}`, key);
  }

  private buildHeaders(apiKey: string, cfg: ProviderConfig): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.headerKey === 'Authorization') {
      headers['Authorization'] = `Bearer ${apiKey}`;
    } else {
      headers[cfg.headerKey] = apiKey;
    }
    if (cfg.extraHeaders) Object.assign(headers, cfg.extraHeaders);
    return headers;
  }

  // ── Anthropic format ────────────────────────────────────────────────────

  private buildAnthropicBody(messages: Message[], systemPrompt: string | undefined, stream: boolean, maxTokens: number = 2048): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.getModel(),
      max_tokens: maxTokens,
      messages,
    };
    if (systemPrompt) body.system = systemPrompt;
    if (stream) body.stream = true;
    return body;
  }

  private async parseAnthropicResponse(res: Response): Promise<string> {
    const data = await res.json() as { content: Array<{ type: string; text: string }> };
    return data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  }

  private async streamAnthropic(res: Response, onChunk: (t: string) => void): Promise<void> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const json = line.slice(6).trim();
        if (json === '[DONE]') return;
        try {
          const ev = JSON.parse(json) as { type: string; delta?: { type: string; text: string } };
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') onChunk(ev.delta.text);
        } catch { }
      }
    }
  }

  // ── OpenAI-compatible format ────────────────────────────────────────────

  private buildOpenAIBody(messages: Message[], systemPrompt: string | undefined, stream: boolean, maxTokens: number): Record<string, unknown> {
    const oaiMessages: Array<{ role: string; content: string }> = [];
    if (systemPrompt) oaiMessages.push({ role: 'system', content: systemPrompt });
    oaiMessages.push(...messages);
    return {
      model: this.getModel(),
      max_tokens: maxTokens,
      messages: oaiMessages,
      stream,
    };
  }

  private async parseOpenAIResponse(res: Response): Promise<string> {
    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message?.content ?? '';
  }

  private async streamOpenAI(res: Response, onChunk: (t: string) => void): Promise<void> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const json = line.slice(6).trim();
        if (json === '[DONE]') return;
        try {
          const ev = JSON.parse(json) as { choices?: Array<{ delta?: { content?: string } }> };
          const chunk = ev.choices?.[0]?.delta?.content;
          if (chunk) onChunk(chunk);
        } catch { }
      }
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────

  async ask(prompt: string, systemPrompt?: string, maxTokens: number = 2048): Promise<string> {
    return this.chat([{ role: 'user', content: prompt }], systemPrompt, maxTokens);
  }

  async chat(messages: Message[], systemPrompt?: string, maxTokens: number = 2048): Promise<string> {
    const apiKey = await this.getApiKey();
    const cfg = this.getProviderConfig();

    const body = cfg.format === 'anthropic'
      ? this.buildAnthropicBody(messages, systemPrompt, false, maxTokens)
      : this.buildOpenAIBody(messages, systemPrompt, false, maxTokens);

    const res = await fetch(cfg.baseUrl, {
      method: 'POST',
      headers: this.buildHeaders(apiKey, cfg),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(buildErrorMessage(cfg.name, res.status, err, this.getModel()));
    }

    // ── FIX: use correct parser per provider format ──────────────────────
    if (cfg.format === 'anthropic') {
      return this.parseAnthropicResponse(res);
    } else {
      return this.parseOpenAIResponse(res);
    }
  }

  async stream(messages: Message[], systemPrompt: string, onChunk: (text: string) => void): Promise<void> {
    const apiKey = await this.getApiKey();
    const cfg = this.getProviderConfig();
    const body = cfg.format === 'anthropic'
      ? this.buildAnthropicBody(messages, systemPrompt, true, 2048)
      : this.buildOpenAIBody(messages, systemPrompt, true, 2048);

    const res = await fetch(cfg.baseUrl, {
      method: 'POST',
      headers: this.buildHeaders(apiKey, cfg),
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const err = await res.text();
      throw new Error(buildErrorMessage(cfg.name, res.status, err, this.getModel()));
    }

    if (cfg.format === 'anthropic') {
      await this.streamAnthropic(res, onChunk);
    } else {
      await this.streamOpenAI(res, onChunk);
    }
  }
}
