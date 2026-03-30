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
exports.HoverProvider = void 0;
exports.registerExplainHoverDetail = registerExplainHoverDetail;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const explainPanel_1 = require("../panels/explainPanel");
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
class HoverProvider {
    constructor(ai) {
        this.ai = ai;
    }
    async provideHover(document, position) {
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange) {
            return undefined;
        }
        const word = document.getText(wordRange);
        if (word.length < 3 || /^\d+$/.test(word)) {
            return undefined;
        }
        if (!/^[a-zA-Z_$][a-zA-Z0-9_$]{2,}$/.test(word)) {
            return undefined;
        }
        const startLine = Math.max(0, position.line - 5);
        const endLine = Math.min(document.lineCount - 1, position.line + 20);
        const contextRange = new vscode.Range(startLine, 0, endLine, 0);
        const context = document.getText(contextRange);
        const cacheKey = `${document.uri.fsPath}:${word}:${startLine}`;
        const cached = cache.get(cacheKey);
        const fileName = path.basename(document.uri.fsPath);
        const lang = document.languageId;
        // Short hover tooltip — just 1-2 sentences
        let shortExplain = '';
        if (cached && Date.now() - cached.ts < CACHE_TTL) {
            shortExplain = cached.text;
        }
        else {
            try {
                shortExplain = await this.ai.ask(`In 1-2 sentences, what is \`${word}\` in this ${lang} code? Be direct and concise.\n\n\`\`\`${lang}\n${context}\n\`\`\``, 'You are a code explainer. Give a very short, plain-English description of a code symbol. Max 2 sentences. No headers, no bullets.');
                cache.set(cacheKey, { text: shortExplain, ts: Date.now() });
            }
            catch {
                return undefined;
            }
        }
        // Build hover markdown with "Explain in detail" command link
        const md = new vscode.MarkdownString(`**$(sparkle) CodeLens AI**\n\n${shortExplain}\n\n---\n[$(book) Explain in detail](command:codelensai.explainHoverDetail?${encodeURIComponent(JSON.stringify({ word, context, lang, fileName }))})`);
        md.isTrusted = true;
        md.supportHtml = false;
        return new vscode.Hover(md, wordRange);
    }
}
exports.HoverProvider = HoverProvider;
/**
 * Register the "explain in detail" command.
 * Call this once in extension.ts activate().
 */
function registerExplainHoverDetail(context, ai) {
    context.subscriptions.push(vscode.commands.registerCommand('codelensai.explainHoverDetail', async (args) => {
        const title = `${args.word} — ${args.fileName}`;
        const panel = explainPanel_1.ExplainPanel.show(context, title, args.context, args.lang);
        const prompt = `Explain \`${args.word}\` thoroughly in this ${args.lang} code from ${args.fileName}.

\`\`\`${args.lang}
${args.context}
\`\`\`

Use these sections:
## What it is
## How it works — step-by-step walk-through
| Step | What happens | Why it matters |
## Inputs & outputs
## Why it's written this way — patterns & conventions
## Related concepts`;
        try {
            await ai.stream([{ role: 'user', content: prompt }], 'You are an expert code explainer. Give thorough, clear explanations using markdown. Include tables where helpful. Use concrete examples.', (chunk) => { panel.stream(chunk); });
            panel.done();
        }
        catch (e) {
            panel.error(String(e));
        }
    }));
}
//# sourceMappingURL=hoverProvider.js.map