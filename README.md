# CodeLens AI — Understand Any Codebase

**CodeLens AI** is a VS Code extension that helps vibe coders understand what their code actually does — every file, every function, every connection.

## Features

| Feature | How to use |
|---|---|
| **Explain any file** | Right-click a file → *CodeLens AI: Explain This File* |
| **Explain selected code** | Select code → Right-click → *Explain Selected Code* |
| **"I'm Lost" overview** | Command Palette → *CodeLens AI: Project Overview* |
| **File dependency graph** | Command Palette → *Show File Dependency Graph* |
| **Chat with your codebase** | Click the CodeLens AI icon in the Activity Bar |
| **Inline "Explain" hints** | Click the `⚡ Explain this` hint above any function |
| **Generate README** | Command Palette → *CodeLens AI: Generate README* |

## Getting Started

1. Install the extension
2. Open a project folder in VS Code
3. Run **CodeLens AI: Set API Key** from the Command Palette
4. Enter your [Anthropic API key](https://console.anthropic.com/)
5. Start exploring!

## Settings

| Setting | Default | Description |
|---|---|---|
| `codelensai.model` | `claude-opus-4-5` | Which Claude model to use |
| `codelensai.enableCodeLens` | `true` | Show Explain hints above functions |
| `codelensai.maxFileSize` | `50000` | Max file size (bytes) sent to AI |

## Requirements

- VS Code 1.85+
- An Anthropic API key

## Development

```bash
git clone <repo>
cd codelens-ai
npm install
# Press F5 in VS Code to launch the Extension Development Host
```

## License

MIT
