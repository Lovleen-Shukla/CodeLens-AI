"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIClient = exports.PROVIDERS = void 0;
const vscode = __importStar(require("vscode"));
exports.PROVIDERS = {
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
function buildErrorMessage(providerName, status, body, model) {
    let hint = '';
    if (status === 404)
        hint = ` | Model "${model}" not found — run "CodeLens AI: Show Current Provider & Model" to change it.`;
    else if (status === 401 || status === 403)
        hint = ` | Invalid API key — run "CodeLens AI: Set API Key".`;
    else if (status === 429)
        hint = ` | Rate limit hit — try a faster model or wait a moment.`;
    return `${providerName} error ${status}${hint}\n${body}`;
}
class AIClient {
    constructor(context) {
        this.context = context;
    }
    getProvider() {
        return (vscode.workspace.getConfiguration('codelensai').get('provider') ?? 'anthropic');
    }
    getProviderConfig() {
        const cfg = { ...exports.PROVIDERS[this.getProvider()] };
        if (this.getProvider() === 'ollama') {
            const base = vscode.workspace.getConfiguration('codelensai').get('ollamaUrl') ?? 'http://localhost:11434';
            cfg.baseUrl = base.replace(/\/$/, '') + '/v1/chat/completions';
        }
        return cfg;
    }
    getModel() {
        const cfg = vscode.workspace.getConfiguration('codelensai');
        const stored = cfg.get('model');
        return stored || this.getProviderConfig().defaultModel;
    }
    async getApiKey() {
        const provider = this.getProvider();
        const secretKey = `codelensai.apiKey.${provider}`;
        const secret = await this.context.secrets.get(secretKey);
        if (secret)
            return secret;
        const legacy = await this.context.secrets.get('codelensai.apiKey');
        if (legacy && provider === 'anthropic')
            return legacy;
        if (provider === 'ollama')
            return 'ollama';
        throw new Error(`No API key for ${this.getProviderConfig().name}. Run "CodeLens AI: Set API Key".`);
    }
    async setApiKey(key) {
        const provider = this.getProvider();
        await this.context.secrets.store(`codelensai.apiKey.${provider}`, key);
    }
    buildHeaders(apiKey, cfg) {
        const headers = { 'Content-Type': 'application/json' };
        if (cfg.headerKey === 'Authorization') {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }
        else {
            headers[cfg.headerKey] = apiKey;
        }
        if (cfg.extraHeaders)
            Object.assign(headers, cfg.extraHeaders);
        return headers;
    }
    // ── Anthropic format ────────────────────────────────────────────────────
    buildAnthropicBody(messages, systemPrompt, stream, maxTokens = 2048) {
        const body = {
            model: this.getModel(),
            max_tokens: maxTokens,
            messages,
        };
        if (systemPrompt)
            body.system = systemPrompt;
        if (stream)
            body.stream = true;
        return body;
    }
    async parseAnthropicResponse(res) {
        const data = await res.json();
        return data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    }
    async streamAnthropic(res, onChunk) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.startsWith('data: '))
                    continue;
                const json = line.slice(6).trim();
                if (json === '[DONE]')
                    return;
                try {
                    const ev = JSON.parse(json);
                    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta')
                        onChunk(ev.delta.text);
                }
                catch { }
            }
        }
    }
    // ── OpenAI-compatible format ────────────────────────────────────────────
    buildOpenAIBody(messages, systemPrompt, stream, maxTokens) {
        const oaiMessages = [];
        if (systemPrompt)
            oaiMessages.push({ role: 'system', content: systemPrompt });
        oaiMessages.push(...messages);
        return {
            model: this.getModel(),
            max_tokens: maxTokens,
            messages: oaiMessages,
            stream,
        };
    }
    async parseOpenAIResponse(res) {
        const data = await res.json();
        return data.choices[0]?.message?.content ?? '';
    }
    async streamOpenAI(res, onChunk) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.startsWith('data: '))
                    continue;
                const json = line.slice(6).trim();
                if (json === '[DONE]')
                    return;
                try {
                    const ev = JSON.parse(json);
                    const chunk = ev.choices?.[0]?.delta?.content;
                    if (chunk)
                        onChunk(chunk);
                }
                catch { }
            }
        }
    }
    // ── Public API ──────────────────────────────────────────────────────────
    async ask(prompt, systemPrompt, maxTokens = 2048) {
        return this.chat([{ role: 'user', content: prompt }], systemPrompt, maxTokens);
    }
    async chat(messages, systemPrompt, maxTokens = 2048) {
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
        }
        else {
            return this.parseOpenAIResponse(res);
        }
    }
    async stream(messages, systemPrompt, onChunk) {
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
        }
        else {
            await this.streamOpenAI(res, onChunk);
        }
    }
}
exports.AIClient = AIClient;
//# sourceMappingURL=aiClient.js.map