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
exports.explainSelection = explainSelection;
exports.explainFile = explainFile;
exports.projectOverview = projectOverview;
exports.generateReadme = generateReadme;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const explainPanel_1 = require("../panels/explainPanel");
const contextBuilder_1 = require("./contextBuilder");
// ── Explain selected code ──────────────────────────────────────────────────
async function explainSelection(ai, context) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('Open a file first.');
        return;
    }
    const selection = editor.selection;
    const selectedText = editor.document.getText(selection.isEmpty ? undefined : selection);
    if (!selectedText.trim()) {
        vscode.window.showWarningMessage('Select some code first.');
        return;
    }
    const fileName = path.basename(editor.document.uri.fsPath);
    const lang = editor.document.languageId;
    const startLine = selection.isEmpty ? 1 : selection.start.line + 1;
    const endLine = selection.isEmpty ? editor.document.lineCount : selection.end.line + 1;
    const title = selection.isEmpty
        ? `${fileName} (full file)`
        : `${fileName} · Lines ${startLine}–${endLine}`;
    // Open the beautiful ExplainPanel
    const panel = explainPanel_1.ExplainPanel.show(context, title, selectedText, lang);
    const prompt = `Explain this ${lang} code from ${fileName} in detail.

\`\`\`${lang}
${selectedText}
\`\`\`

Structure your explanation with these sections:

## Summary
One sentence: what this code does.

## How it works — step-by-step
Walk through the code line by line or block by block. Use a table:

| Step | Code / Concept | What it does | Why |
|------|---------------|--------------|-----|

## Inputs & Outputs
What goes in, what comes out.

## Dependencies & side effects
What does this code rely on? What does it change?

## Patterns & conventions used
Any design patterns, idioms, or conventions worth noting.

## Potential issues or improvements
Anything that could be cleaner, safer, or more performant.`;
    try {
        await ai.stream([{ role: 'user', content: prompt }], `You are an expert ${lang} code explainer. Give thorough, clear explanations. Use markdown with tables where helpful.`, (chunk) => { panel.stream(chunk); });
        panel.done();
    }
    catch (e) {
        panel.error(String(e));
    }
}
// ── Explain a specific file ────────────────────────────────────────────────
async function explainFile(ai, context, filePath) {
    const rootPath = (0, contextBuilder_1.getWorkspaceRoot)();
    // If no path passed, use active editor
    let targetPath = filePath;
    if (!targetPath) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('Open a file first.');
            return;
        }
        targetPath = editor.document.uri.fsPath;
    }
    const content = (0, contextBuilder_1.readFileSafe)(targetPath, 30000);
    if (!content) {
        vscode.window.showWarningMessage('Could not read file.');
        return;
    }
    const fileName = path.basename(targetPath);
    const lang = getLangFromExt(path.extname(targetPath).slice(1));
    const relPath = rootPath ? path.relative(rootPath, targetPath) : fileName;
    const imports = content.match(/(?:import|require|from)\s*.*?['"]([^'"]+)['"]/g)?.slice(0, 10).join('\n') ?? 'none';
    const panel = explainPanel_1.ExplainPanel.show(context, `${fileName} — File Explanation`, content, lang);
    const prompt = `Explain this file thoroughly.

File: ${relPath}
Language: ${lang}
Detected imports:
${imports}

Full file contents:
\`\`\`${lang}
${content}
\`\`\`

Use these sections:

## Summary
What this file does in 1-2 sentences.

## Responsibilities
Bullet list of what this file is responsible for.

## How it works
Walk through the key functions/classes/logic with a table:

| Function / Block | Purpose | Key behaviour |
|-----------------|---------|--------------|

## Dependencies (imports)
What this file imports and why each dependency is needed.

## Used by
What other files likely import or call this file.

## Patterns & conventions
Design patterns, idioms, or conventions used.

## Notes & gotchas
Anything non-obvious, tricky, or worth watching out for.`;
    try {
        await ai.stream([{ role: 'user', content: prompt }], `You are an expert code explainer. Give thorough, clear explanations with markdown tables.`, (chunk) => { panel.stream(chunk); });
        panel.done();
    }
    catch (e) {
        panel.error(String(e));
    }
}
// ── Project Overview ───────────────────────────────────────────────────────
async function projectOverview(ai, context) {
    const rootPath = (0, contextBuilder_1.getWorkspaceRoot)();
    if (!rootPath) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
    }
    const stack = (0, contextBuilder_1.detectTechStack)(rootPath).join(', ') || 'unknown';
    const tree = (0, contextBuilder_1.buildFileTree)(rootPath);
    const files = (0, contextBuilder_1.getWorkspaceFiles)(rootPath, 20);
    const entryContent = files.length > 0 ? (0, contextBuilder_1.readFileSafe)(files[0], 3000) : '';
    const folderName = path.basename(rootPath);
    const panel = explainPanel_1.ExplainPanel.show(context, `${folderName} — Project Overview`, tree, 'text');
    const prompt = `Give a comprehensive project overview for a developer onboarding to this codebase.

Project: ${folderName}
Tech Stack: ${stack}

File Tree:
\`\`\`
${tree}
\`\`\`

Entry file (${files[0] ? path.basename(files[0]) : 'unknown'}):
\`\`\`
${entryContent}
\`\`\`

Structure your response:

## What this project does
2-3 sentence summary.

## Tech Stack
| Technology | Role | Notes |
|-----------|------|-------|

## Project Structure
Explain the folder/file layout — what each major directory/file is for.

## Entry Points & Key Files
| File | Purpose |
|------|---------|

## How to get started
Step-by-step: how would a new developer run and understand this project?

## Architecture at a glance
High-level: how does data flow? How do the pieces connect?

## What to read first
The 5 most important files to read and in what order.`;
    try {
        await ai.stream([{ role: 'user', content: prompt }], 'You are a senior engineer onboarding a new developer. Be thorough and practical.', (chunk) => { panel.stream(chunk); });
        panel.done();
    }
    catch (e) {
        panel.error(String(e));
    }
}
// ── Generate README ────────────────────────────────────────────────────────
async function generateReadme(ai, context) {
    const rootPath = (0, contextBuilder_1.getWorkspaceRoot)();
    if (!rootPath) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
    }
    const stack = (0, contextBuilder_1.detectTechStack)(rootPath).join(', ') || 'unknown';
    const tree = (0, contextBuilder_1.buildFileTree)(rootPath);
    const folderName = path.basename(rootPath);
    const panel = explainPanel_1.ExplainPanel.show(context, `${folderName} — Generated README`, '', 'markdown');
    const prompt = `Generate a professional, complete README.md for this project.

Project: ${folderName}
Stack: ${stack}

File Tree:
\`\`\`
${tree}
\`\`\`

Write a complete README.md with:
# Project Name
Short description + badges placeholder

## Features
## Tech Stack
## Prerequisites
## Installation
## Usage / Getting Started
## Project Structure
## API Reference (if applicable)
## Contributing
## License

Make it professional, developer-friendly, and accurate based on the file structure.`;
    try {
        await ai.stream([{ role: 'user', content: prompt }], 'You are a technical writer. Generate a professional README.md file in proper markdown.', (chunk) => { panel.stream(chunk); });
        panel.done();
    }
    catch (e) {
        panel.error(String(e));
    }
}
// ── Helper ─────────────────────────────────────────────────────────────────
function getLangFromExt(ext) {
    const map = {
        ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
        py: 'python', go: 'go', rs: 'rust', java: 'java', rb: 'ruby',
        php: 'php', cs: 'csharp', cpp: 'cpp', c: 'c', html: 'html',
        css: 'css', scss: 'scss', json: 'json', md: 'markdown',
        yaml: 'yaml', yml: 'yaml', sh: 'bash', sql: 'sql',
    };
    return map[ext.toLowerCase()] || ext || 'text';
}
//# sourceMappingURL=commands.js.map