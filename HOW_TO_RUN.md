# CodeLens AI — Complete Setup & Run Guide

## What's new in v0.2

CodeLens AI now works with **any AI provider**:

| Provider | Models | Needs API key? |
|---|---|---|
| **Anthropic** (default) | claude-opus-4-5, sonnet, haiku | Yes — console.anthropic.com |
| **OpenAI** | gpt-4o, gpt-4-turbo, gpt-3.5-turbo | Yes — platform.openai.com |
| **Google Gemini** | gemini-1.5-pro, gemini-1.5-flash | Yes — aistudio.google.com |
| **Groq** | llama3, mixtral (very fast) | Yes — console.groq.com |
| **Ollama** | llama3, codellama, mistral... | ❌ No key, runs locally |

---

## Step 1 — Prerequisites

Make sure you have these installed:

```bash
# Check Node.js (need v18+)
node --version

# Check npm
npm --version

# Check VS Code
code --version
```

If Node.js is missing: https://nodejs.org/en/download

---

## Step 2 — Install the VS Code Extension tools

```bash
npm install -g @vscode/vsce
```

This is the official VS Code extension packaging tool.

---

## Step 3 — Download and set up the project

```bash
# Unzip the project
unzip codelens-ai.zip
cd codelens-ai

# Install TypeScript dependencies
npm install
```

Your folder should look like:
```
codelens-ai/
├── src/
│   ├── extension.ts
│   ├── utils/
│   │   ├── aiClient.ts        ← multi-provider AI client
│   │   ├── commands.ts
│   │   └── contextBuilder.ts
│   ├── providers/
│   │   ├── codeLensProvider.ts
│   │   └── hoverProvider.ts
│   └── panels/
│       ├── chatViewProvider.ts
│       └── dependencyGraphPanel.ts
├── media/icon.svg
├── package.json
├── tsconfig.json
└── README.md
```

---

## Step 4 — Compile the TypeScript

```bash
npm run compile
```

You should see an `out/` folder appear. If you get TypeScript errors, run:

```bash
npm install   # makes sure types are installed
npm run compile
```

---

## Step 5 — Run in VS Code (Development Mode)

1. Open the project folder in VS Code:
   ```bash
   code .
   ```

2. Press **F5** (or go to Run → Start Debugging)

3. A new VS Code window opens — this is the **Extension Development Host**. It has CodeLens AI installed and active.

4. Open any code project in that new window (File → Open Folder).

---

## Step 6 — Set your AI provider and API key

In the **Extension Development Host** window:

1. Open the Command Palette: `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (Mac)
2. Type: **CodeLens AI: Switch AI Provider**
3. Pick your provider from the list
4. When prompted, click **Set API Key** and paste your key

### Where to get API keys

| Provider | URL |
|---|---|
| Anthropic | https://console.anthropic.com/ → API Keys |
| OpenAI | https://platform.openai.com/api-keys |
| Google Gemini | https://aistudio.google.com/app/apikey |
| Groq | https://console.groq.com/keys |
| Ollama | No key needed — install from https://ollama.com |

### Ollama setup (local, free)

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh   # Linux/Mac
# Or download from https://ollama.com on Windows

# Start the server
ollama serve

# Pull a model (in a new terminal)
ollama pull llama3          # general purpose
ollama pull codellama       # code-focused
ollama pull deepseek-coder  # great for code

# In VS Code: Switch Provider → Ollama
# No API key needed!
```

---

## Step 7 — Use the extension

### Explain a file
- Right-click any file in the Explorer → **CodeLens AI: Explain This File**
- Or: open a file, press `Ctrl+Shift+P` → **CodeLens AI: Explain This File**

### Explain a block of code
- Select any code in the editor
- Right-click → **CodeLens AI: Explain Selected Code**
- Or use the `⚡ Explain this` link that appears above every function

### Get a full project overview
- `Ctrl+Shift+P` → **CodeLens AI: Project Overview (I'm Lost)**
- This detects your tech stack, entry point, key files, and explains how the whole project works

### Open the chat sidebar
- Click the CodeLens AI icon in the left Activity Bar (it looks like a circuit board)
- Or: `Ctrl+Shift+P` → **CodeLens AI: Open Chat**
- Use the quick-action buttons at the top or type any question

### See the file dependency graph
- `Ctrl+Shift+P` → **CodeLens AI: Show File Dependency Graph**
- An interactive graph opens showing how all your files connect to each other
- Hover over nodes to see what imports what, click to highlight connections

### Generate a README
- `Ctrl+Shift+P` → **CodeLens AI: Generate README**
- CodeLens AI reads your project and writes a full README.md

---

## Switching providers mid-session

You can switch providers at any time:

```
Ctrl+Shift+P → CodeLens AI: Switch AI Provider
```

Or click the provider name in the chat sidebar header.

Each provider's API key is stored separately in VS Code's secure secret storage, so you can have keys for all providers saved and switch freely.

---

## Changing the model

```
Ctrl+Shift+P → CodeLens AI: Show Current Provider & Model → Change Model
```

Or update directly in VS Code Settings (`Ctrl+,` → search "codelensai"):

| Setting | Example values |
|---|---|
| `codelensai.provider` | `anthropic`, `openai`, `gemini`, `groq`, `ollama` |
| `codelensai.model` | `claude-opus-4-5`, `gpt-4o`, `gemini-1.5-flash`, `llama3` |
| `codelensai.ollamaUrl` | `http://localhost:11434` |
| `codelensai.enableCodeLens` | `true` / `false` |

---

## Package as a .vsix file (to share or permanently install)

Once you're happy with the extension:

```bash
# In the project root
vsce package

# This creates:  codelens-ai-0.2.0.vsix
```

To install the `.vsix` permanently in VS Code:

```bash
code --install-extension codelens-ai-0.2.0.vsix
```

Or in VS Code: Extensions panel → `...` menu → **Install from VSIX...**

---

## Troubleshooting

**"Command not found: vsce"**
```bash
npm install -g @vscode/vsce
```

**TypeScript compile errors**
```bash
npm install
npx tsc --version   # should be 5.x
npm run compile
```

**API key not working**
- Make sure you selected the right provider first (`Switch AI Provider`)
- Double-check the key has no extra spaces
- Anthropic keys start with `sk-ant-`, OpenAI with `sk-`, Groq with `gsk_`

**Ollama not responding**
```bash
# Make sure it's running
ollama serve

# Check it's accessible
curl http://localhost:11434/v1/models
```

**Extension not activating**
- Make sure you're in the Extension Development Host window (the one that opened after F5)
- Check the Debug Console in the original VS Code window for errors

---

## Development workflow

```bash
# Terminal 1: watch mode (auto-recompiles on save)
npm run watch

# Then in VS Code: press F5 to launch the host
# When you change code, press Ctrl+R in the host window to reload
```

---

*Built with TypeScript · VS Code Extension API · Supports Anthropic, OpenAI, Gemini, Groq, Ollama*
