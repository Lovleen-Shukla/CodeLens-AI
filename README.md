# CodeLens AI

> **AI-powered codebase understanding for VS Code** — instantly explain files, generate architecture diagrams, visualize dependencies, and chat with your code using multiple AI providers.

[![VS Code](https://img.shields.io/badge/VS%20Code-Extension-blue?logo=visualstudiocode)](https://code.visualstudio.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](LICENSE)

---

## Features

| Feature | Description |
|---------|-------------|
| **Dashboard** | Full-screen panel with Overview, Dependency Graph, Architecture, File Explain, and GitHub tabs |
| **Dependency Graph** | Interactive force-directed graph of file imports — color-coded by type, 3D-shaded nodes, click to trace connections |
| **Architecture Diagram** | AI-generated layered architecture SVG with zoom, pan, and fullscreen — layer count adapts to your project |
| **File Explain** | Click any file in the sidebar to get a structured plain-English explanation |
| **Selection Explain** | Select any code block, run *Explain Selection* — opens a beautiful side panel with streaming AI analysis |
| **Project Overview** | Full onboarding report — entry points, tech stack, data flow, and what to read first |
| **GitHub Analyzer** | Paste any public GitHub URL for a comprehensive AI analysis with stats, topics, and action buttons |
| **Clone & Open** | Clone any GitHub repo directly from the GitHub tab — folder picker, progress modal, opens in VS Code |
| **AI Chat** | Ask natural language questions about your codebase with full context awareness |
| **Hover Explanations** | Hover any symbol for a 1-2 sentence AI explanation, with a link to "Explain in detail" |
| **Generate README** | Auto-generate a professional README.md from your project's file tree and stack |
| **Multi-Provider AI** | Anthropic, OpenAI, Gemini, Groq, Ollama (local), OpenRouter — switch anytime |

---

## Screenshots

> Dashboard Overview · Dependency Graph · Architecture Diagram · GitHub Analyzer

---

## Requirements

- **VS Code** 1.74+
- **Node.js** 18+
- An API key from one of the supported AI providers (or Ollama running locally)
- **Git** installed (for Clone & Open feature)

---

## Installation

### From VSIX (local build)

```bash
# 1. Clone the repository
git clone https://github.com/yourusername/codelens-ai.git
cd codelens-ai

# 2. Install dependencies
npm install

# 3. Compile TypeScript
npm run compile

# 4. Package the extension
npm install -g @vscode/vsce
vsce package

# 5. Install in VS Code
code --install-extension codelens-ai-*.vsix
```

### From VS Code Marketplace

Search for **"CodeLens AI"** in the Extensions panel (`Ctrl+Shift+X`).

---

## Quick Start

1. **Open a project** — `File → Open Folder`
2. **Click the CodeLens AI icon** in the Activity Bar (left sidebar)
3. The dashboard opens automatically
4. **Set your API key** — click `API Key` in the top-right of the dashboard
5. Start exploring: click files, switch tabs, ask questions

---

## Supported AI Providers

| Provider | Env / Config Key | Notes |
|----------|-----------------|-------|
| **Anthropic Claude** | `codelensai.provider: anthropic` | Recommended — best for code analysis |
| **OpenAI** | `codelensai.provider: openai` | GPT-4o, GPT-4-turbo |
| **Google Gemini** | `codelensai.provider: gemini` | Gemini 1.5 Pro, Flash |
| **Groq** | `codelensai.provider: groq` | Ultra-fast inference |
| **Ollama** | `codelensai.provider: ollama` | 100% local — no API key needed |
| **OpenRouter** | `codelensai.provider: openrouter` | Access 50+ models via one key |

Switch providers anytime via the pill in the dashboard top-bar or `codelensai.switchProvider`.

---

## Configuration

Add to your VS Code `settings.json`:

```json
{
  "codelensai.provider": "anthropic",
  "codelensai.model": "claude-opus-4-5",
  "codelensai.ollamaUrl": "http://localhost:11434"
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `codelensai.provider` | `anthropic` | AI provider to use |
| `codelensai.model` | *(provider default)* | Specific model to use |
| `codelensai.ollamaUrl` | `http://localhost:11434` | Ollama server URL |

API keys are stored securely in VS Code's built-in secret storage — never in settings files.

---

## Commands

Access via `Ctrl+Shift+P` (Command Palette):

| Command | Description |
|---------|-------------|
| `CodeLens AI: Open Dashboard` | Open the main panel |
| `CodeLens AI: Explain Selection` | Explain selected code in a side panel |
| `CodeLens AI: Explain File` | Explain the current file |
| `CodeLens AI: Project Overview` | Full project onboarding report |
| `CodeLens AI: Generate README` | Auto-generate a README.md |
| `CodeLens AI: Switch Provider` | Change AI provider |
| `CodeLens AI: Set API Key` | Set/update your API key |

---

## Project Structure

```
codelens-ai/
├── src/
│   ├── extension.ts              # Extension entry point, command registration
│   ├── panels/
│   │   ├── dashboardPanel.ts     # Main webview panel (all tabs)
│   │   ├── explainPanel.ts       # Side-panel for code explanations
│   │   └── dependencyGraphPanel.ts  # Standalone dependency graph panel
│   ├── providers/
│   │   ├── codeLensProvider.ts   # CodeLens hints above functions
│   │   └── hoverProvider.ts      # Hover tooltip explanations
│   └── utils/
│       ├── aiClient.ts           # Multi-provider AI client
│       ├── commands.ts           # Command implementations
│       └── contextBuilder.ts     # File scanning, dependency map, tech stack detection
├── package.json                  # Extension manifest
└── tsconfig.json
```

---

## How It Works

### Dependency Graph
The graph uses a **force-directed layout** with:
- **Fibonacci spiral initialization** — nodes spread evenly across the canvas before the first simulation tick (prevents the explosion-to-edges bug)
- **Capped repulsion forces** — `Math.min(k²/d, k×3)` prevents infinite forces at near-zero distances
- **Hard boundary clamp** — nodes cannot leave the canvas bounds
- **3D sphere shading** — radial gradient per node with specular highlight and drop shadow

### Architecture Diagram
AI is prompted to return raw JSON with 2–6 layers based on your project's actual structure. Two parse strategies handle models that wrap JSON in markdown fences. The SVG is rendered inline with zoom, pan, and a fullscreen overlay.

### Context Building
`contextBuilder.ts` scans the workspace, ignoring `node_modules`, virtual envs, and lock files. It extracts:
- Import/require statements to build the dependency edge list
- File extensions and package.json/requirements.txt to detect the tech stack
- Directory structure for the file tree

---

## Development

```bash
# Clone
git clone https://github.com/yourusername/codelens-ai.git
cd codelens-ai

# Install deps
npm install

# Open in VS Code
code .

# Press F5 to launch Extension Development Host
```

### Build

```bash
npm run compile        # One-time build
npm run watch          # Watch mode
```

### Package

```bash
vsce package           # Produces codelens-ai-x.x.x.vsix
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Dashboard doesn't open | Run `CodeLens AI: Open Dashboard` from Command Palette |
| Dependency graph shows 2-3 nodes | Check that your workspace has source files with import statements |
| Architecture diagram blank after generate | The AI response failed to parse — click Generate again; try a faster model |
| "API key not set" error | Click `API Key` button in dashboard top-right |
| Hover provider not working | Make sure the extension is active — check the status bar |
| Ollama not connecting | Ensure Ollama is running: `ollama serve` |
| Clone fails | Ensure `git` is installed and in your PATH |

---

## Known Limitations

- Dependency graph edge detection works best for ES module imports (`import`/`require`). Dynamic requires and barrel files may show incomplete edges.
- Architecture diagram requires the AI to return valid JSON — older/smaller models may struggle. Claude and GPT-4o work best.
- GitHub analysis uses the public GitHub API (60 requests/hour unauthenticated). Large repos may hit rate limits.

---

## Contributing

Contributions welcome! Please:

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/amazing-thing`
3. Commit your changes: `git commit -m 'Add amazing thing'`
4. Push: `git push origin feature/amazing-thing`
5. Open a Pull Request

---

## License

MIT © 2025 — see [LICENSE](LICENSE) for details.
