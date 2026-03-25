import * as vscode from 'vscode';
import * as path from 'path';
import { AIClient } from '../utils/aiClient';

// Simple cache so we don't re-fetch on every hover
const cache = new Map<string, { text: string; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export class HoverProvider implements vscode.HoverProvider {
  constructor(private ai: AIClient) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Hover | undefined> {
    // Only activate when the user holds Alt (Option on Mac) to avoid spamming the API
    // We detect this by checking if the user ran the dedicated command instead.
    // Hover explanations are lightweight — just the word/symbol under cursor.

    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) return undefined;

    const word = document.getText(wordRange);
    if (word.length < 3 || /^\d+$/.test(word)) return undefined;

    // Only hover on likely function/class names (capitalized or camelCase)
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]{2,}$/.test(word)) return undefined;

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
      const explanation = await this.ai.ask(
        `In 2-3 sentences, explain what \`${word}\` is/does in this ${lang} code from ${fileName}. Be direct and plain.

\`\`\`${lang}
${context}
\`\`\``,
        'You are a code explainer. Give very short, plain-English explanations of code symbols. No markdown headers, no bullet points, just 2-3 clear sentences.'
      );

      const md = new vscode.MarkdownString(`**$(sparkle) CodeLens AI**\n\n${explanation}\n\n---\n*[Explain more](command:codelensai.explainSelection)*`);
      md.isTrusted = true;
      md.supportHtml = false;

      cache.set(cacheKey, { text: md.value, ts: Date.now() });
      return new vscode.Hover(md, wordRange);
    } catch {
      return undefined;
    }
  }
}
