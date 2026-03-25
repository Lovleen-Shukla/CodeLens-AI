import * as vscode from 'vscode';
import * as path from 'path';
import { AIClient } from './aiClient';
import {
  getWorkspaceRoot, buildFileContext, buildFileTree,
  detectTechStack, readFileSafe, getWorkspaceFiles,
} from './contextBuilder';

const SYSTEM_PROMPT = `You are CodeLens AI, an expert code explainer built into VS Code.
Your job is to help vibe coders understand their projects in plain, simple English.
- Be concise but complete. Use bullet points where helpful.
- Mention which files/functions are involved.
- Avoid jargon unless you explain it.
- Always tell them what the code DOES, not just what it IS.`;

// ── Explain File ─────────────────────────────────────────────────────────────
export async function explainFile(ai: AIClient, uri?: vscode.Uri): Promise<void> {
  let filePath: string | undefined;

  if (uri) {
    filePath = uri.fsPath;
  } else {
    filePath = vscode.window.activeTextEditor?.document.uri.fsPath;
  }

  if (!filePath) {
    vscode.window.showWarningMessage('CodeLens AI: No file selected.');
    return;
  }

  const rootPath = getWorkspaceRoot();
  if (!rootPath) {
    vscode.window.showWarningMessage('CodeLens AI: Open a workspace folder first.');
    return;
  }

  const fileName = path.basename(filePath);
  const relativePath = path.relative(rootPath, filePath);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Explaining ${fileName}...`, cancellable: false },
    async () => {
      const context = buildFileContext(filePath!, rootPath);
      const prompt = `Please explain this file in plain English:

${context}

Provide:
1. What this file's PURPOSE is in the project (1-2 sentences)
2. What the main things it DOES (bullet points)
3. What other files it DEPENDS ON and why
4. What other parts of the project might DEPEND ON this file
5. Any important patterns or things a newcomer should know`;

      const explanation = await ai.ask(prompt, SYSTEM_PROMPT);

      const doc = await vscode.workspace.openTextDocument({
        content: `# ${fileName}\n\n${explanation}\n\n---\n*Path: ${relativePath}*`,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    }
  );
}

// ── Explain Selection ────────────────────────────────────────────────────────
export async function explainSelection(ai: AIClient): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('CodeLens AI: Open a file first.');
    return;
  }

  const selection = editor.selection;
  if (selection.isEmpty) {
    vscode.window.showWarningMessage('CodeLens AI: Select some code first.');
    return;
  }

  const selectedText = editor.document.getText(selection);
  const filePath = editor.document.uri.fsPath;
  const fileName = path.basename(filePath);
  const language = editor.document.languageId;

  // Also grab a bit of surrounding file context
  const startLine = Math.max(0, selection.start.line - 20);
  const endLine = Math.min(editor.document.lineCount, selection.end.line + 20);
  const surroundingRange = new vscode.Range(startLine, 0, endLine, 0);
  const surroundingContext = editor.document.getText(surroundingRange);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Explaining code...', cancellable: false },
    async () => {
      const prompt = `Explain this ${language} code from ${fileName}:

\`\`\`${language}
${selectedText}
\`\`\`

Surrounding context (for reference):
\`\`\`${language}
${surroundingContext}
\`\`\`

Explain:
1. What this code DOES in plain English (1-2 sentences first)
2. How it works step by step
3. What inputs it takes and what it returns/outputs
4. Why it might be written this way (patterns used)
5. Any gotchas or things to watch out for`;

      const explanation = await ai.ask(prompt, SYSTEM_PROMPT);

      // Show inline in an output channel for quick reads
      const panel = vscode.window.createOutputChannel('CodeLens AI — Code Explanation');
      panel.clear();
      panel.appendLine(`=== Code Explanation ===`);
      panel.appendLine(`File: ${fileName} | Lines ${selection.start.line + 1}–${selection.end.line + 1}`);
      panel.appendLine('');
      panel.appendLine(explanation);
      panel.show(true);
    }
  );
}

// ── Project Overview ("I'm Lost") ────────────────────────────────────────────
export async function projectOverview(ai: AIClient): Promise<void> {
  const rootPath = getWorkspaceRoot();
  if (!rootPath) {
    vscode.window.showWarningMessage('CodeLens AI: Open a workspace folder first.');
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Analysing your project...', cancellable: false },
    async () => {
      const tree = buildFileTree(rootPath);
      const stack = detectTechStack(rootPath);

      // Sample a few key files for extra context
      const allFiles = getWorkspaceFiles(rootPath, 10);
      const samples = allFiles.slice(0, 5).map(f => {
        const rel = path.relative(rootPath, f);
        const content = readFileSafe(f, 3000);
        return `--- ${rel} ---\n${content}`;
      }).join('\n\n');

      const prompt = `I'm a developer who just opened this project and I'm confused. Give me a complete onboarding overview.

Detected tech stack: ${stack.join(', ') || 'unknown'}

File tree:
${tree}

Sample files:
${samples}

Please provide:
1. **What this project is** — what does it do? (2-3 sentences)
2. **Tech stack** — what languages/frameworks are being used and why
3. **Project structure** — what each main folder/file does
4. **Entry point** — where does the code start running?
5. **Key files to understand first** — top 5 files a newcomer should read
6. **How data flows** — brief description of how the app works end-to-end
7. **Quick start tips** — any important things to know before editing code`;

      const overview = await ai.ask(prompt, SYSTEM_PROMPT);

      const doc = await vscode.workspace.openTextDocument({
        content: `# Project Overview\n\n${overview}\n\n---\n*Generated by CodeLens AI*`,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
    }
  );
}

// ── Generate README ───────────────────────────────────────────────────────────
export async function generateReadme(ai: AIClient): Promise<void> {
  const rootPath = getWorkspaceRoot();
  if (!rootPath) {
    vscode.window.showWarningMessage('CodeLens AI: Open a workspace folder first.');
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Generating README...', cancellable: false },
    async () => {
      const tree = buildFileTree(rootPath);
      const stack = detectTechStack(rootPath);
      const allFiles = getWorkspaceFiles(rootPath, 20);
      const samples = allFiles.slice(0, 8).map(f => {
        const rel = path.relative(rootPath, f);
        const content = readFileSafe(f, 2000);
        return `--- ${rel} ---\n${content}`;
      }).join('\n\n');

      const prompt = `Generate a professional, complete README.md for this project.

Tech stack: ${stack.join(', ') || 'unknown'}

File tree:
${tree}

Sample code:
${samples}

The README should include:
# Project Name (infer from the code)
A brief description

## Features
## Tech Stack
## Project Structure
## Getting Started (installation + running)
## How It Works (brief architecture overview)
## Contributing (basic guidelines)
## License

Make it professional but friendly. Use proper markdown formatting.`;

      const readme = await ai.ask(prompt, SYSTEM_PROMPT);

      const doc = await vscode.workspace.openTextDocument({
        content: readme,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, { preview: false });

      const save = await vscode.window.showInformationMessage(
        'README generated! Save it to your project?',
        'Save as README.md',
        'Keep as preview'
      );

      if (save === 'Save as README.md') {
        const saveUri = vscode.Uri.file(path.join(rootPath, 'README.md'));
        await vscode.workspace.fs.writeFile(saveUri, Buffer.from(readme, 'utf8'));
        vscode.window.showInformationMessage('README.md saved!');
      }
    }
  );
}
