import * as vscode from 'vscode';
import * as path from 'path';
import { AIClient } from '../utils/aiClient';
import { ExplainPanel } from '../panels/explainPanel';

const cache = new Map<string, { text: string; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000;

export class HoverProvider implements vscode.HoverProvider {
  constructor(private ai: AIClient) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Hover | undefined> {
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) { return undefined; }

    const word = document.getText(wordRange);
    if (word.length < 3 || /^\d+$/.test(word)) { return undefined; }
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]{2,}$/.test(word)) { return undefined; }

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
    } else {
      try {
        shortExplain = await this.ai.ask(
          `In 1-2 sentences, what is \`${word}\` in this ${lang} code? Be direct and concise.\n\n\`\`\`${lang}\n${context}\n\`\`\``,
          'You are a code explainer. Give a very short, plain-English description of a code symbol. Max 2 sentences. No headers, no bullets.'
        );
        cache.set(cacheKey, { text: shortExplain, ts: Date.now() });
      } catch { return undefined; }
    }

    // Build hover markdown with "Explain in detail" command link
    const md = new vscode.MarkdownString(
      `**$(sparkle) CodeLens AI**\n\n${shortExplain}\n\n---\n[$(book) Explain in detail](command:codelensai.explainHoverDetail?${encodeURIComponent(JSON.stringify({ word, context, lang, fileName }))})`
    );
    md.isTrusted = true;
    md.supportHtml = false;

    return new vscode.Hover(md, wordRange);
  }
}

/**
 * Register the "explain in detail" command.
 * Call this once in extension.ts activate().
 */
export function registerExplainHoverDetail(context: vscode.ExtensionContext, ai: AIClient) {
  context.subscriptions.push(
    vscode.commands.registerCommand('codelensai.explainHoverDetail', async (args: {
      word: string; context: string; lang: string; fileName: string;
    }) => {
      const title = `${args.word} — ${args.fileName}`;
      const panel = ExplainPanel.show(context, title, args.context, args.lang);

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
        await ai.stream(
          [{ role: 'user', content: prompt }],
          'You are an expert code explainer. Give thorough, clear explanations using markdown. Include tables where helpful. Use concrete examples.',
          (chunk) => { panel.stream(chunk); }
        );
        panel.done();
      } catch (e: unknown) {
        panel.error(String(e));
      }
    })
  );
}
