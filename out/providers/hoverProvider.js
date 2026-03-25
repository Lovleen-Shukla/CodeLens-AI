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
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
// Simple cache so we don't re-fetch on every hover
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
class HoverProvider {
    constructor(ai) {
        this.ai = ai;
    }
    async provideHover(document, position) {
        // Only activate when the user holds Alt (Option on Mac) to avoid spamming the API
        // We detect this by checking if the user ran the dedicated command instead.
        // Hover explanations are lightweight — just the word/symbol under cursor.
        const wordRange = document.getWordRangeAtPosition(position);
        if (!wordRange)
            return undefined;
        const word = document.getText(wordRange);
        if (word.length < 3 || /^\d+$/.test(word))
            return undefined;
        // Only hover on likely function/class names (capitalized or camelCase)
        if (!/^[a-zA-Z_$][a-zA-Z0-9_$]{2,}$/.test(word))
            return undefined;
        // Get surrounding context (the whole function/block roughly)
        const startLine = Math.max(0, position.line - 5);
        const endLine = Math.min(document.lineCount - 1, position.line + 20);
        const contextRange = new vscode.Range(startLine, 0, endLine, 0);
        const context = document.getText(contextRange);
        const cacheKey = `${document.uri.fsPath}:${word}:${startLine}`;
        const cached = cache.get(cacheKey);
        if (cached && Date.now() - cached.ts < CACHE_TTL) {
            return new vscode.Hover(new vscode.MarkdownString(cached.text));
        }
        // Don't block the hover UI — return a loading message, then update
        const fileName = path.basename(document.uri.fsPath);
        const lang = document.languageId;
        try {
            const explanation = await this.ai.ask(`In 2-3 sentences, explain what \`${word}\` is/does in this ${lang} code from ${fileName}. Be direct and plain.

\`\`\`${lang}
${context}
\`\`\``, 'You are a code explainer. Give very short, plain-English explanations of code symbols. No markdown headers, no bullet points, just 2-3 clear sentences.');
            const md = new vscode.MarkdownString(`**$(sparkle) CodeLens AI**\n\n${explanation}\n\n---\n*[Explain more](command:codelensai.explainSelection)*`);
            md.isTrusted = true;
            md.supportHtml = false;
            cache.set(cacheKey, { text: md.value, ts: Date.now() });
            return new vscode.Hover(md, wordRange);
        }
        catch {
            return undefined;
        }
    }
}
exports.HoverProvider = HoverProvider;
//# sourceMappingURL=hoverProvider.js.map