import * as vscode from 'vscode';
import * as path from 'path';
import { AIClient, Message } from '../utils/aiClient';
import { getWorkspaceRoot, buildFileTree, detectTechStack } from '../utils/contextBuilder';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _messages: Message[] = [];

  constructor(
    private context: vscode.ExtensionContext,
    private ai: AIClient
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'send') {
        await this.handleUserMessage(msg.text);
      } else if (msg.type === 'clear') {
        this._messages = [];
        this._view?.webview.postMessage({ type: 'cleared' });
      } else if (msg.type === 'quickAction') {
        await this.handleQuickAction(msg.action);
      } else if (msg.type === 'switchProvider') {
        await vscode.commands.executeCommand('codelensai.switchProvider');
        // Refresh the webview to show new provider name
        this._view!.webview.html = this.getHtml();
      }
    });
  }

  private async handleUserMessage(text: string) {
    this._messages.push({ role: 'user', content: text });
    this._view?.webview.postMessage({ type: 'userMessage', text });

    const rootPath = getWorkspaceRoot();
    const stack = rootPath ? detectTechStack(rootPath).join(', ') : 'unknown';
    const tree = rootPath ? buildFileTree(rootPath) : '';
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath ?? 'none';
    const activeFileName = activeFile !== 'none' ? path.basename(activeFile) : 'none';

    const systemPrompt = `You are CodeLens AI, a smart coding assistant inside VS Code helping vibe coders understand their codebase.

Project info:
- Tech stack: ${stack}
- Currently open file: ${activeFileName}
- File tree:
${tree}

Be helpful, concise, and practical. Refer to specific files when you know them. Use plain language.`;

    try {
      let response = '';
      this._view?.webview.postMessage({ type: 'streamStart' });

      await this.ai.stream(this._messages, systemPrompt, (chunk) => {
        response += chunk;
        this._view?.webview.postMessage({ type: 'streamChunk', chunk });
      });

      this._view?.webview.postMessage({ type: 'streamEnd' });
      this._messages.push({ role: 'assistant', content: response });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this._view?.webview.postMessage({ type: 'error', text: msg });
    }
  }

  private async handleQuickAction(action: string) {
    const prompts: Record<string, string> = {
      overview: 'Give me a quick overview of this project — what it does and how it works.',
      currentFile: `Explain the currently open file (${vscode.window.activeTextEditor?.document.fileName ?? 'unknown'}) and its role in the project.`,
      entryPoint: 'Where does this project start? What is the entry point and how does execution flow?',
      dependencies: 'What are the main dependencies in this project and what are they used for?',
    };
    if (prompts[action]) {
      await this.handleUserMessage(prompts[action]);
    }
  }

  private getHtml(): string {
    const cfg = this.ai.getProviderConfig();
    const model = this.ai.getModel();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CodeLens AI</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  #quick-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 8px;
    border-bottom: 1px solid var(--vscode-sideBar-border);
  }
  .qa-btn {
    font-size: 11px;
    padding: 3px 8px;
    border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder));
    border-radius: 4px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    cursor: pointer;
    white-space: nowrap;
  }
  .qa-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .msg { display: flex; flex-direction: column; gap: 4px; }
  .msg-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    opacity: 0.6;
    letter-spacing: 0.05em;
  }
  .msg-user .msg-label { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .msg-ai .msg-label { color: var(--vscode-textLink-foreground); }
  .msg-bubble {
    padding: 8px 10px;
    border-radius: 6px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .msg-user .msg-bubble {
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border);
  }
  .msg-ai .msg-bubble {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-sideBar-border);
  }
  .cursor { display: inline-block; width: 8px; height: 14px; background: var(--vscode-foreground); opacity: 0.7; animation: blink 0.8s step-end infinite; vertical-align: text-bottom; }
  @keyframes blink { 0%,100%{opacity:.7} 50%{opacity:0} }
  .error-msg { color: var(--vscode-errorForeground); font-size: 12px; padding: 6px; }
  #input-row {
    display: flex;
    gap: 6px;
    padding: 8px;
    border-top: 1px solid var(--vscode-sideBar-border);
  }
  #input {
    flex: 1;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 4px;
    padding: 6px 8px;
    font-family: inherit;
    font-size: inherit;
    resize: none;
    min-height: 36px;
    max-height: 120px;
  }
  #input:focus { outline: 1px solid var(--vscode-focusBorder); }
  #send-btn {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 4px;
    padding: 6px 12px;
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
    align-self: flex-end;
  }
  #send-btn:hover { background: var(--vscode-button-hoverBackground); }
  #send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  #clear-btn {
    background: none;
    border: none;
    color: var(--vscode-foreground);
    opacity: 0.4;
    cursor: pointer;
    font-size: 16px;
    align-self: flex-end;
    padding: 6px;
  }
  #clear-btn:hover { opacity: 0.8; }
  #provider-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    background: var(--vscode-editor-background);
    border-bottom: 1px solid var(--vscode-sideBar-border);
    font-size: 10px;
    opacity: 0.8;
  }
  #provider-bar span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #switch-btn {
    font-size: 10px;
    padding: 1px 6px;
    border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder));
    border-radius: 3px;
    background: transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
    opacity: 0.7;
    white-space: nowrap;
  }
  #switch-btn:hover { opacity: 1; }
  .empty-state {
    text-align: center;
    opacity: 0.5;
    padding: 20px;
    font-size: 12px;
    line-height: 1.6;
  }
</style>
</head>
<body>
<div id="provider-bar">
  <span id="provider-label">⚡ ${cfg.name} · ${model}</span>
  <button id="switch-btn" onclick="switchProvider()">Switch</button>
</div>
<div id="quick-actions">
  <button class="qa-btn" onclick="quickAction('overview')">Project overview</button>
  <button class="qa-btn" onclick="quickAction('currentFile')">Explain current file</button>
  <button class="qa-btn" onclick="quickAction('entryPoint')">Entry point?</button>
  <button class="qa-btn" onclick="quickAction('dependencies')">Dependencies?</button>
</div>
<div id="messages">
  <div class="empty-state">
    Ask me anything about your codebase.<br>
    "What does auth.js do?" or<br>
    "Where is the database connected?"
  </div>
</div>
<div id="input-row">
  <textarea id="input" placeholder="Ask about your code..." rows="1"></textarea>
  <button id="send-btn" onclick="send()">↑</button>
  <button id="clear-btn" title="Clear chat" onclick="clearChat()">⊘</button>
</div>
<script>
const vscode = acquireVsCodeApi();
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
let streaming = false;
let streamingEl = null;

function switchProvider() {
  vscode.postMessage({ type: 'switchProvider' });
}

function quickAction(action) {
  vscode.postMessage({ type: 'quickAction', action });
  setLoading(true);
}

function send() {
  const text = inputEl.value.trim();
  if (!text || streaming) return;
  inputEl.value = '';
  inputEl.style.height = 'auto';
  vscode.postMessage({ type: 'send', text });
  setLoading(true);
}

function clearChat() {
  vscode.postMessage({ type: 'clear' });
}

function setLoading(on) {
  streaming = on;
  sendBtn.disabled = on;
}

function addMessage(role, text) {
  const empty = messagesEl.querySelector('.empty-state');
  if (empty) empty.remove();

  const div = document.createElement('div');
  div.className = 'msg msg-' + role;
  div.innerHTML =
    '<div class="msg-label">' + (role === 'user' ? 'You' : 'CodeLens AI') + '</div>' +
    '<div class="msg-bubble">' + escHtml(text) + '</div>';
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div.querySelector('.msg-bubble');
}

function escHtml(t) {
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'userMessage') {
    addMessage('user', msg.text);
  } else if (msg.type === 'streamStart') {
    streamingEl = addMessage('ai', '');
    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    streamingEl.appendChild(cursor);
  } else if (msg.type === 'streamChunk') {
    if (streamingEl) {
      const cursor = streamingEl.querySelector('.cursor');
      const text = document.createTextNode(msg.chunk);
      streamingEl.insertBefore(text, cursor);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  } else if (msg.type === 'streamEnd') {
    if (streamingEl) {
      const cursor = streamingEl.querySelector('.cursor');
      if (cursor) cursor.remove();
      streamingEl = null;
    }
    setLoading(false);
  } else if (msg.type === 'error') {
    if (streamingEl) { streamingEl.remove(); streamingEl = null; }
    const err = document.createElement('div');
    err.className = 'error-msg';
    err.textContent = 'Error: ' + msg.text;
    messagesEl.appendChild(err);
    setLoading(false);
  } else if (msg.type === 'cleared') {
    messagesEl.innerHTML = '<div class="empty-state">Ask me anything about your codebase.<br>"What does auth.js do?" or<br>"Where is the database connected?"</div>';
  }
});

// Auto-resize textarea
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
});
inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
</script>
</body>
</html>`;
  }
}
