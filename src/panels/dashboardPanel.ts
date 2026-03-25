import * as vscode from 'vscode';
import * as path from 'path';
import { AIClient, Message } from '../utils/aiClient';
import {
  getWorkspaceRoot, buildFileTree, detectTechStack,
  buildDependencyMap, readFileSafe, getWorkspaceFiles,
} from '../utils/contextBuilder';

export class DashboardPanel {
  static currentPanel?: DashboardPanel;
  private readonly _panel: vscode.WebviewPanel;
  private _messages: Message[] = [];
  private _ai: AIClient;
  private _context: vscode.ExtensionContext;

  static show(context: vscode.ExtensionContext, ai: AIClient) {
    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'codelensai.dashboard',
      'CodeLens AI',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    DashboardPanel.currentPanel = new DashboardPanel(panel, context, ai);
    panel.onDidDispose(() => { DashboardPanel.currentPanel = undefined; });
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, ai: AIClient) {
    this._panel = panel;
    this._context = context;
    this._ai = ai;
    this._panel.webview.html = this.getShellHtml();
    this.init();

    this._panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':       await this.sendProjectData(); break;
        case 'chat':        await this.handleChat(msg.text); break;
        case 'clearChat':   this._messages = []; this._panel.webview.postMessage({ type: 'chatCleared' }); break;
        case 'explainFile': await this.explainFile(msg.file); break;
        case 'switchProvider': await vscode.commands.executeCommand('codelensai.switchProvider'); break;
        case 'runCommand':  await vscode.commands.executeCommand(msg.command); break;
      }
    });
  }

  private async init() {
    // slight delay so webview JS is ready
    setTimeout(() => this.sendProjectData(), 800);
  }

  private async sendProjectData() {
    const rootPath = getWorkspaceRoot();
    const cfg = this._ai.getProviderConfig();
    const model = this._ai.getModel();

    if (!rootPath) {
      this._panel.webview.postMessage({ type: 'noWorkspace' });
      return;
    }

    const stack = detectTechStack(rootPath);
    const tree = buildFileTree(rootPath);
    const depNodes = buildDependencyMap(rootPath);

    // Build graph data
    const graphNodes = depNodes.map(n => ({
      id: n.relativePath,
      label: path.basename(n.relativePath),
      ext: path.extname(n.relativePath).slice(1),
      size: n.size,
    }));
    const graphEdges: { from: string; to: string }[] = [];
    for (const node of depNodes) {
      for (const imp of node.imports) {
        const target = depNodes.find(n =>
          n.relativePath.replace(/\.[^.]+$/, '').replace(/\\/g, '/') ===
          imp.replace(/^\.\//, '').replace(/^\.\.\//, '').replace(/\\/g, '/')
        );
        if (target) graphEdges.push({ from: node.relativePath, to: target.relativePath });
      }
    }

    // File list with sizes
    const files = getWorkspaceFiles(rootPath, 150).map(f => ({
      name: path.basename(f),
      rel: path.relative(rootPath, f),
      ext: path.extname(f).slice(1),
      size: (() => { try { return require('fs').statSync(f).size; } catch { return 0; } })(),
    }));

    this._panel.webview.postMessage({
      type: 'projectData',
      rootPath,
      stack,
      tree,
      files,
      graph: { nodes: graphNodes, edges: graphEdges },
      provider: cfg.name,
      model,
    });
  }

  private async explainFile(relPath: string) {
    const rootPath = getWorkspaceRoot();
    if (!rootPath) return;
    const fullPath = path.join(rootPath, relPath);
    const content = readFileSafe(fullPath, 30000);
    const imports = content.match(/(?:import|require)\s*.*?['"]([^'"]+)['"]/g)?.slice(0, 10).join('\n') ?? 'none';

    this._panel.webview.postMessage({ type: 'explainStart', file: relPath });
    try {
      const explanation = await this._ai.ask(
        `Explain this file in plain English:\n\nFile: ${relPath}\n\nImports:\n${imports}\n\nContents:\n${content}`,
        'You are CodeLens AI. Explain code files in plain, friendly English. Use bullet points. Be concise but complete. Start with a one-line summary, then list what it does, what it depends on, and anything important.'
      );
      this._panel.webview.postMessage({ type: 'explainResult', file: relPath, explanation });
    } catch (e: unknown) {
      this._panel.webview.postMessage({ type: 'explainError', file: relPath, error: String(e) });
    }
  }

  private async handleChat(text: string) {
    this._messages.push({ role: 'user', content: text });
    const rootPath = getWorkspaceRoot();
    const stack = rootPath ? detectTechStack(rootPath).join(', ') : 'unknown';
    const tree = rootPath ? buildFileTree(rootPath) : '';

    const system = `You are CodeLens AI, a codebase assistant. Answer questions about this project.
Tech stack: ${stack}
File tree:
${tree}
Be concise, practical, and reference specific files when you know them.`;

    this._panel.webview.postMessage({ type: 'chatStreamStart' });
    try {
      await this._ai.stream(this._messages, system, (chunk) => {
        this._panel.webview.postMessage({ type: 'chatChunk', chunk });
      });
      this._panel.webview.postMessage({ type: 'chatStreamEnd' });
      // capture full response from chunks — handled in JS
    } catch (e: unknown) {
      this._panel.webview.postMessage({ type: 'chatError', error: String(e) });
    }
  }

  private getShellHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeLens AI</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Syne:wght@400;600;700;800&display=swap');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg:       #0d0f14;
  --surface:  #13161e;
  --surface2: #1a1e29;
  --border:   #252a38;
  --accent:   #6c63ff;
  --accent2:  #00d4aa;
  --accent3:  #ff6b6b;
  --text:     #e2e4ed;
  --muted:    #6b7280;
  --mono:     'JetBrains Mono', monospace;
  --sans:     'Syne', sans-serif;
}

html, body { height: 100%; background: var(--bg); color: var(--text); font-family: var(--sans); overflow: hidden; }

/* ── Layout ──────────────────────────────────────── */
#app { display: grid; grid-template-rows: 52px 1fr; height: 100vh; }

/* ── Topbar ──────────────────────────────────────── */
#topbar {
  display: flex; align-items: center; gap: 0;
  background: var(--surface); border-bottom: 1px solid var(--border);
  padding: 0 20px; gap: 16px;
}
#logo { font-size: 15px; font-weight: 800; letter-spacing: -0.5px; color: var(--text); white-space: nowrap; }
#logo span { color: var(--accent); }
#provider-pill {
  font-family: var(--mono); font-size: 11px;
  background: var(--surface2); border: 1px solid var(--border);
  padding: 3px 10px; border-radius: 20px; color: var(--muted);
  cursor: pointer; transition: border-color .2s, color .2s;
}
#provider-pill:hover { border-color: var(--accent); color: var(--text); }
#provider-pill b { color: var(--accent2); font-weight: 500; }
.spacer { flex: 1; }
.top-action {
  font-family: var(--mono); font-size: 11px; padding: 5px 14px;
  background: transparent; border: 1px solid var(--border);
  color: var(--muted); border-radius: 6px; cursor: pointer;
  transition: all .15s; white-space: nowrap;
}
.top-action:hover { border-color: var(--accent); color: var(--text); background: rgba(108,99,255,.08); }
.top-action.primary { border-color: var(--accent); color: var(--accent); }

/* ── Main 3-column layout ────────────────────────── */
#main { display: grid; grid-template-columns: 220px 1fr 340px; overflow: hidden; }

/* ── Left sidebar: file list ─────────────────────── */
#sidebar {
  background: var(--surface); border-right: 1px solid var(--border);
  display: flex; flex-direction: column; overflow: hidden;
}
#sidebar-header {
  padding: 14px 16px 10px; font-size: 10px; font-weight: 700;
  letter-spacing: 1.5px; text-transform: uppercase; color: var(--muted);
  border-bottom: 1px solid var(--border);
}
#file-search {
  margin: 8px; padding: 6px 10px;
  background: var(--surface2); border: 1px solid var(--border);
  border-radius: 6px; color: var(--text); font-family: var(--mono); font-size: 11px;
  outline: none; transition: border-color .2s;
}
#file-search:focus { border-color: var(--accent); }
#file-search::placeholder { color: var(--muted); }
#file-list { flex: 1; overflow-y: auto; padding: 0 6px 12px; }
.file-item {
  display: flex; align-items: center; gap: 7px;
  padding: 5px 8px; border-radius: 5px; cursor: pointer;
  font-family: var(--mono); font-size: 11px; color: var(--muted);
  transition: background .12s, color .12s; white-space: nowrap; overflow: hidden;
}
.file-item:hover { background: var(--surface2); color: var(--text); }
.file-item.active { background: rgba(108,99,255,.15); color: var(--accent); }
.file-ext {
  font-size: 9px; padding: 1px 5px; border-radius: 3px;
  font-weight: 600; flex-shrink: 0; text-transform: uppercase;
}
.ext-ts, .ext-tsx { background: #1a3a5c; color: #5ba3f5; }
.ext-js, .ext-jsx { background: #3a2e00; color: #f0c030; }
.ext-py  { background: #1a3a1a; color: #4caf50; }
.ext-css, .ext-scss { background: #2a1a3a; color: #ab77f7; }
.ext-html { background: #3a1a1a; color: #f07070; }
.ext-json { background: #1a2a2a; color: #4db6ac; }
.ext-md   { background: #1a2a3a; color: #60a0c0; }
.ext-other { background: var(--surface2); color: var(--muted); }

/* ── Centre: tabs + content ──────────────────────── */
#centre { display: flex; flex-direction: column; overflow: hidden; }

#tabs {
  display: flex; align-items: flex-end; gap: 2px;
  background: var(--surface); border-bottom: 1px solid var(--border);
  padding: 0 16px;
}
.tab {
  padding: 12px 18px 10px; font-size: 12px; font-weight: 600;
  color: var(--muted); cursor: pointer; border-bottom: 2px solid transparent;
  transition: color .15s, border-color .15s; letter-spacing: 0.3px;
  white-space: nowrap;
}
.tab:hover { color: var(--text); }
.tab.active { color: var(--text); border-bottom-color: var(--accent); }

#tab-content { flex: 1; overflow: hidden; position: relative; }
.tab-pane { position: absolute; inset: 0; overflow: auto; display: none; }
.tab-pane.active { display: flex; flex-direction: column; }

/* ── Overview pane ───────────────────────────────── */
#pane-overview { padding: 24px; gap: 20px; }
.overview-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 10px; padding: 18px; transition: border-color .2s;
}
.card:hover { border-color: #353a4d; }
.card-label {
  font-size: 10px; font-weight: 700; letter-spacing: 1.5px;
  text-transform: uppercase; color: var(--muted); margin-bottom: 12px;
}
.stack-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.stack-tag {
  font-family: var(--mono); font-size: 11px;
  background: rgba(108,99,255,.12); border: 1px solid rgba(108,99,255,.25);
  color: #a89fff; padding: 3px 10px; border-radius: 20px;
}
.stat-row { display: flex; gap: 24px; }
.stat { display: flex; flex-direction: column; gap: 3px; }
.stat-num { font-size: 28px; font-weight: 800; color: var(--text); line-height: 1; }
.stat-lbl { font-size: 11px; color: var(--muted); }
.file-tree-pre {
  font-family: var(--mono); font-size: 11px; line-height: 1.7;
  color: var(--muted); white-space: pre; overflow: auto; max-height: 260px;
}
.file-tree-pre .dir { color: var(--accent2); }
.action-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.action-card {
  background: var(--surface2); border: 1px solid var(--border);
  border-radius: 8px; padding: 14px; cursor: pointer;
  transition: all .15s; text-align: left;
}
.action-card:hover { border-color: var(--accent); background: rgba(108,99,255,.06); transform: translateY(-1px); }
.action-card-icon { font-size: 20px; margin-bottom: 8px; }
.action-card-title { font-size: 12px; font-weight: 700; color: var(--text); margin-bottom: 3px; }
.action-card-desc { font-size: 11px; color: var(--muted); line-height: 1.5; }

/* ── Graph pane ──────────────────────────────────── */
#pane-graph { padding: 0; }
#graph-toolbar {
  display: flex; align-items: center; gap: 10px; padding: 12px 16px;
  background: var(--surface); border-bottom: 1px solid var(--border); flex-shrink: 0;
}
#graph-search {
  background: var(--surface2); border: 1px solid var(--border);
  color: var(--text); font-family: var(--mono); font-size: 11px;
  padding: 5px 10px; border-radius: 6px; outline: none; width: 200px;
  transition: border-color .2s;
}
#graph-search:focus { border-color: var(--accent); }
#graph-search::placeholder { color: var(--muted); }
#graph-stats { font-family: var(--mono); font-size: 11px; color: var(--muted); flex: 1; }
.graph-legend { display: flex; gap: 14px; }
.leg { display: flex; align-items: center; gap: 5px; font-size: 10px; color: var(--muted); }
.leg-dot { width: 8px; height: 8px; border-radius: 50%; }
#graph-canvas { flex: 1; cursor: grab; display: block; }
#graph-canvas:active { cursor: grabbing; }
#graph-tooltip {
  position: fixed; background: var(--surface2); border: 1px solid var(--border);
  border-radius: 8px; padding: 10px 13px; font-size: 11px; font-family: var(--mono);
  pointer-events: none; display: none; max-width: 280px; z-index: 999;
  box-shadow: 0 8px 24px rgba(0,0,0,.4);
}
#graph-tooltip .tt-name { font-weight: 600; color: var(--text); margin-bottom: 4px; }
#graph-tooltip .tt-row { color: var(--muted); line-height: 1.6; }
#graph-tooltip .tt-hl { color: var(--accent2); }

/* ── File explain pane ───────────────────────────── */
#pane-explain { padding: 24px; gap: 0; }
#explain-placeholder {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  flex: 1; gap: 12px; color: var(--muted); text-align: center;
}
#explain-placeholder .hint-icon { font-size: 40px; opacity: .4; }
#explain-placeholder p { font-size: 13px; line-height: 1.7; max-width: 300px; }
#explain-content { display: none; flex-direction: column; gap: 0; flex: 1; }
#explain-file-header {
  display: flex; align-items: center; gap: 10px; padding: 0 0 16px;
  border-bottom: 1px solid var(--border); margin-bottom: 20px;
}
#explain-file-name { font-family: var(--mono); font-size: 13px; font-weight: 500; color: var(--accent2); flex: 1; }
.explain-reload {
  font-family: var(--mono); font-size: 10px; padding: 4px 10px;
  background: transparent; border: 1px solid var(--border);
  color: var(--muted); border-radius: 5px; cursor: pointer; transition: all .15s;
}
.explain-reload:hover { border-color: var(--accent2); color: var(--accent2); }
#explain-body {
  font-size: 13px; line-height: 1.8; color: var(--text); white-space: pre-wrap;
  flex: 1; overflow-y: auto;
}
#explain-body strong { color: var(--accent); }
.skeleton { background: linear-gradient(90deg, var(--surface2) 25%, var(--border) 50%, var(--surface2) 75%); background-size: 200% 100%; animation: shimmer 1.4s infinite; border-radius: 4px; height: 14px; margin-bottom: 10px; }
@keyframes shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }

/* ── Right panel: chat ───────────────────────────── */
#chat-panel {
  background: var(--surface); border-left: 1px solid var(--border);
  display: flex; flex-direction: column; overflow: hidden;
}
#chat-header {
  padding: 14px 16px 12px; border-bottom: 1px solid var(--border);
  display: flex; align-items: center; gap: 8px;
}
#chat-title { font-size: 12px; font-weight: 700; letter-spacing: 0.5px; flex: 1; }
#chat-clear {
  font-size: 10px; padding: 3px 8px; background: transparent;
  border: 1px solid var(--border); color: var(--muted);
  border-radius: 4px; cursor: pointer; transition: all .15s; font-family: var(--mono);
}
#chat-clear:hover { border-color: var(--accent3); color: var(--accent3); }
.quick-actions { display: flex; flex-wrap: wrap; gap: 5px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
.qa {
  font-family: var(--mono); font-size: 10px; padding: 4px 9px;
  background: var(--surface2); border: 1px solid var(--border);
  color: var(--muted); border-radius: 4px; cursor: pointer; transition: all .15s;
}
.qa:hover { border-color: var(--accent); color: var(--text); }
#chat-messages { flex: 1; overflow-y: auto; padding: 14px 12px; display: flex; flex-direction: column; gap: 14px; }
.chat-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  flex: 1; gap: 8px; color: var(--muted); text-align: center; font-size: 12px; line-height: 1.7;
}
.msg { display: flex; flex-direction: column; gap: 4px; }
.msg-who { font-size: 10px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; }
.msg-you .msg-who { color: var(--accent); }
.msg-ai .msg-who  { color: var(--accent2); }
.msg-bubble {
  font-size: 12px; line-height: 1.7; padding: 10px 12px;
  border-radius: 8px; white-space: pre-wrap; word-break: break-word;
}
.msg-you .msg-bubble { background: rgba(108,99,255,.1); border: 1px solid rgba(108,99,255,.2); }
.msg-ai  .msg-bubble { background: var(--surface2); border: 1px solid var(--border); }
.cursor-blink { display: inline-block; width: 7px; height: 13px; background: var(--accent2); animation: blink .7s step-end infinite; vertical-align: text-bottom; border-radius: 1px; }
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
#chat-input-row { padding: 10px 12px; border-top: 1px solid var(--border); display: flex; gap: 6px; }
#chat-input {
  flex: 1; background: var(--surface2); border: 1px solid var(--border);
  color: var(--text); font-family: var(--mono); font-size: 12px;
  padding: 8px 10px; border-radius: 7px; resize: none; outline: none;
  min-height: 36px; max-height: 100px; transition: border-color .2s;
  line-height: 1.5;
}
#chat-input:focus { border-color: var(--accent); }
#chat-input::placeholder { color: var(--muted); }
#chat-send {
  background: var(--accent); color: #fff; border: none;
  padding: 0 14px; border-radius: 7px; font-size: 16px;
  cursor: pointer; transition: background .15s; align-self: flex-end; height: 36px;
}
#chat-send:hover { background: #8078ff; }
#chat-send:disabled { opacity: .4; cursor: not-allowed; }

/* ── Scrollbar ───────────────────────────────────── */
::-webkit-scrollbar { width: 5px; height: 5px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: #353a4d; }

/* ── Loading / empty states ──────────────────────── */
.loading-pulse { animation: pulse 1.5s ease-in-out infinite; }
@keyframes pulse { 0%,100%{opacity:.5} 50%{opacity:1} }
.badge { display: inline-block; font-family: var(--mono); font-size: 9px; padding: 2px 6px; border-radius: 3px; font-weight: 600; }
.badge-imports { background: rgba(0,212,170,.1); color: var(--accent2); border: 1px solid rgba(0,212,170,.2); }
.badge-used    { background: rgba(108,99,255,.1); color: #a89fff; border: 1px solid rgba(108,99,255,.2); }
</style>
</head>
<body>
<div id="app">

  <!-- ── Topbar ── -->
  <div id="topbar">
    <div id="logo">Code<span>Lens</span> AI</div>
    <div id="provider-pill" onclick="post('switchProvider')">
      <b id="provider-name">—</b> · <span id="model-name">—</span>
    </div>
    <div class="spacer"></div>
    <button class="top-action" onclick="post('runCommand','codelensai.projectOverview')">I'm Lost</button>
    <button class="top-action" onclick="post('runCommand','codelensai.generateReadme')">Gen README</button>
    <button class="top-action primary" onclick="post('runCommand','codelensai.setApiKey')">API Key</button>
  </div>

  <!-- ── Main ── -->
  <div id="main">

    <!-- ── Left: file list ── -->
    <div id="sidebar">
      <div id="sidebar-header">Files</div>
      <input id="file-search" placeholder="search files…" oninput="filterFiles(this.value)">
      <div id="file-list"><div style="padding:16px;font-size:11px;color:var(--muted)" class="loading-pulse">Loading files…</div></div>
    </div>

    <!-- ── Centre: tabs ── -->
    <div id="centre">
      <div id="tabs">
        <div class="tab active" onclick="switchTab('overview')">Overview</div>
        <div class="tab" onclick="switchTab('graph')">Dependency Graph</div>
        <div class="tab" onclick="switchTab('explain')">File Explain</div>
      </div>
      <div id="tab-content">

        <!-- Overview -->
        <div class="tab-pane active" id="pane-overview">
          <div class="overview-grid">
            <div class="card">
              <div class="card-label">Tech Stack</div>
              <div class="stack-tags" id="stack-tags"><span style="color:var(--muted);font-size:12px">Scanning…</span></div>
            </div>
            <div class="card">
              <div class="card-label">Project Stats</div>
              <div class="stat-row" id="stats-row">
                <div class="stat"><div class="stat-num" id="stat-files">—</div><div class="stat-lbl">files</div></div>
                <div class="stat"><div class="stat-num" id="stat-imports">—</div><div class="stat-lbl">imports</div></div>
                <div class="stat"><div class="stat-num" id="stat-stack">—</div><div class="stat-lbl">technologies</div></div>
              </div>
            </div>
            <div class="card" style="grid-column:1/-1">
              <div class="card-label">File Tree</div>
              <pre class="file-tree-pre" id="file-tree-pre">Loading…</pre>
            </div>
          </div>
          <div style="margin-top:20px">
            <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-bottom:12px">Quick Actions</div>
            <div class="action-grid">
              <button class="action-card" onclick="post('runCommand','codelensai.projectOverview')">
                <div class="action-card-icon">🗺️</div>
                <div class="action-card-title">Project Overview</div>
                <div class="action-card-desc">Full onboarding guide — stack, entry point, key files</div>
              </button>
              <button class="action-card" onclick="switchTab('graph')">
                <div class="action-card-icon">🕸️</div>
                <div class="action-card-title">Dependency Graph</div>
                <div class="action-card-desc">Interactive map of how files connect</div>
              </button>
              <button class="action-card" onclick="post('runCommand','codelensai.generateReadme')">
                <div class="action-card-icon">📝</div>
                <div class="action-card-title">Generate README</div>
                <div class="action-card-desc">Auto-write a README from your code</div>
              </button>
              <button class="action-card" onclick="focusChat()">
                <div class="action-card-icon">💬</div>
                <div class="action-card-title">Ask a Question</div>
                <div class="action-card-desc">Chat about any part of the codebase</div>
              </button>
            </div>
          </div>
        </div>

        <!-- Graph -->
        <div class="tab-pane" id="pane-graph">
          <div id="graph-toolbar">
            <input id="graph-search" placeholder="Search files…" oninput="graphFilter(this.value)">
            <div id="graph-stats">— files</div>
            <div class="graph-legend">
              <div class="leg"><div class="leg-dot" style="background:#6c63ff"></div>has imports</div>
              <div class="leg"><div class="leg-dot" style="background:#00d4aa"></div>selected</div>
              <div class="leg"><div class="leg-dot" style="background:#3a3f50"></div>standalone</div>
            </div>
          </div>
          <canvas id="graph-canvas"></canvas>
          <div id="graph-tooltip"></div>
        </div>

        <!-- File explain -->
        <div class="tab-pane" id="pane-explain">
          <div id="explain-placeholder">
            <div class="hint-icon">📂</div>
            <p>Click any file in the sidebar to get a plain-English explanation of what it does.</p>
          </div>
          <div id="explain-content">
            <div id="explain-file-header">
              <span id="explain-file-name"></span>
              <button class="explain-reload" id="explain-reload-btn">↻ Re-explain</button>
            </div>
            <div id="explain-body"></div>
          </div>
        </div>

      </div>
    </div>

    <!-- ── Right: chat ── -->
    <div id="chat-panel">
      <div id="chat-header">
        <div id="chat-title">ASK YOUR CODE</div>
        <button id="chat-clear" onclick="post('clearChat')">Clear</button>
      </div>
      <div class="quick-actions">
        <button class="qa" onclick="sendChat('Give me a project overview')">Overview</button>
        <button class="qa" onclick="sendChat('What is the entry point?')">Entry point</button>
        <button class="qa" onclick="sendChat('What are the main dependencies?')">Dependencies</button>
        <button class="qa" onclick="sendChat('How does data flow through this app?')">Data flow</button>
      </div>
      <div id="chat-messages">
        <div class="chat-empty">
          <div style="font-size:32px;opacity:.3">💬</div>
          <div>Ask anything about<br>your codebase</div>
        </div>
      </div>
      <div id="chat-input-row">
        <textarea id="chat-input" placeholder="What does auth.js do?" rows="1"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();doSendChat()}"
          oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,100)+'px'"></textarea>
        <button id="chat-send" onclick="doSendChat()">↑</button>
      </div>
    </div>

  </div>
</div>

<script>
const vscode = acquireVsCodeApi();
function post(type, ...args) {
  if (type === 'runCommand') vscode.postMessage({ type, command: args[0] });
  else vscode.postMessage({ type, ...(args[0] ? { text: args[0] } : {}) });
}

// ── Tab switching ─────────────────────────────────
let activeTab = 'overview';
function switchTab(name) {
  activeTab = name;
  document.querySelectorAll('.tab').forEach((t,i) => {
    const names = ['overview','graph','explain'];
    t.classList.toggle('active', names[i] === name);
  });
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.getElementById('pane-' + name).classList.add('active');
  if (name === 'graph') setTimeout(resizeGraph, 50);
}

// ── File sidebar ──────────────────────────────────
let allFiles = [];
let activeFile = null;
function renderFiles(files) {
  const list = document.getElementById('file-list');
  if (!files.length) { list.innerHTML = '<div style="padding:16px;font-size:11px;color:var(--muted)">No files found</div>'; return; }
  list.innerHTML = files.map(f => {
    const ext = f.ext || 'other';
    return \`<div class="file-item\${activeFile===f.rel?' active':''}" onclick="selectFile('\${esc(f.rel)}')" title="\${esc(f.rel)}">
      <span class="file-ext ext-\${ext}">\${ext||'?'}</span>
      <span style="overflow:hidden;text-overflow:ellipsis">\${esc(f.name)}</span>
    </div>\`;
  }).join('');
}
function filterFiles(q) {
  const f = q.toLowerCase();
  renderFiles(f ? allFiles.filter(x => x.rel.toLowerCase().includes(f)) : allFiles);
}
function selectFile(rel) {
  activeFile = rel;
  renderFiles(allFiles);
  switchTab('explain');
  post('explainFile', rel);
  document.getElementById('explain-placeholder').style.display = 'none';
  document.getElementById('explain-content').style.display = 'flex';
  document.getElementById('explain-file-name').textContent = rel;
  document.getElementById('explain-reload-btn').onclick = () => post('explainFile', rel);
  const body = document.getElementById('explain-body');
  body.innerHTML = ['60%','80%','45%','70%','55%'].map(w =>
    \`<div class="skeleton" style="width:\${w};margin-bottom:12px"></div>\`).join('');
}
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

// ── Graph ─────────────────────────────────────────
let graphData = { nodes: [], edges: [] };
let graphFilter_text = '';
let selectedNode = null;
let panX = 0, panY = 0, zoom = 1;
let draggingNode = null, isPanning = false, panStart = null;
let graphReady = false;
const canvas = document.getElementById('graph-canvas');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('graph-tooltip');

function resizeGraph() {
  const pane = document.getElementById('pane-graph');
  canvas.width = pane.clientWidth;
  canvas.height = pane.clientHeight - 50;
  if (graphData.nodes.length && !graphReady) { initGraphPositions(); graphReady = true; }
}
function initGraphPositions() {
  const cx = canvas.width/2, cy = canvas.height/2;
  const r = Math.min(cx,cy) * 0.65;
  graphData.nodes.forEach((n,i) => {
    const a = (i/graphData.nodes.length)*Math.PI*2;
    n.x = cx + Math.cos(a)*r*(0.4+Math.random()*0.6);
    n.y = cy + Math.sin(a)*r*(0.4+Math.random()*0.6);
    n.vx = 0; n.vy = 0; n.fixed = false;
  });
}
function graphFilter(q) { graphFilter_text = q.toLowerCase(); }

const EXT_COLORS = {
  ts:'#5ba3f5',tsx:'#5ba3f5',js:'#f0c030',jsx:'#f0c030',
  py:'#4caf50',css:'#ab77f7',scss:'#ab77f7',html:'#f07070',
  json:'#4db6ac',md:'#60a0c0',
};
function nodeColor(n) {
  if (n.id === selectedNode) return '#00d4aa';
  const hasEdge = graphData.edges.some(e=>e.from===n.id||e.to===n.id);
  return hasEdge ? (EXT_COLORS[n.ext] || '#6c63ff') : '#3a3f50';
}

let simTick = 0;
function simulate() {
  if (simTick > 400) return;
  const k = Math.sqrt((canvas.width*canvas.height)/(graphData.nodes.length||1));
  graphData.nodes.forEach(n => { n.vx=0; n.vy=0; });
  for (let i=0;i<graphData.nodes.length;i++) {
    for (let j=i+1;j<graphData.nodes.length;j++) {
      const a=graphData.nodes[i], b=graphData.nodes[j];
      const dx=b.x-a.x||.1, dy=b.y-a.y||.1;
      const d=Math.sqrt(dx*dx+dy*dy)||1;
      const f=(k*k)/d*0.4;
      a.vx-=(dx/d)*f; a.vy-=(dy/d)*f;
      b.vx+=(dx/d)*f; b.vy+=(dy/d)*f;
    }
  }
  graphData.edges.forEach(e=>{
    const a=graphData.nodes.find(n=>n.id===e.from);
    const b=graphData.nodes.find(n=>n.id===e.to);
    if(!a||!b)return;
    const dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy)||1;
    const f=(d*d)/k*0.25;
    const fx=(dx/d)*f,fy=(dy/d)*f;
    a.vx+=fx;a.vy+=fy;b.vx-=fx;b.vy-=fy;
  });
  const cx=canvas.width/2,cy=canvas.height/2;
  graphData.nodes.forEach(n=>{
    if(n.fixed)return;
    n.vx+=(cx-n.x)*0.006; n.vy+=(cy-n.y)*0.006;
    n.x+=n.vx*.35; n.y+=n.vy*.35;
  });
  simTick++;
}

function drawGraph() {
  ctx.clearRect(0,0,canvas.width,canvas.height);
  if(!graphData.nodes.length){
    ctx.fillStyle='#6b7280'; ctx.font='13px Syne,sans-serif';
    ctx.textAlign='center'; ctx.fillText('No files found',canvas.width/2,canvas.height/2);
    return;
  }
  ctx.save(); ctx.translate(panX,panY); ctx.scale(zoom,zoom);
  const vis = graphFilter_text
    ? graphData.nodes.filter(n=>n.id.toLowerCase().includes(graphFilter_text))
    : graphData.nodes;
  const visIds = new Set(vis.map(n=>n.id));

  // Edges
  graphData.edges.forEach(e=>{
    if(!visIds.has(e.from)||!visIds.has(e.to))return;
    const a=graphData.nodes.find(n=>n.id===e.from);
    const b=graphData.nodes.find(n=>n.id===e.to);
    if(!a||!b)return;
    const hl = selectedNode && (e.from===selectedNode||e.to===selectedNode);
    ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y);
    ctx.strokeStyle = hl ? '#00d4aa44' : '#252a3888';
    ctx.lineWidth = (hl?1.5:0.7)/zoom; ctx.globalAlpha=hl?.9:.6;
    ctx.stroke(); ctx.globalAlpha=1;
    if(hl){
      const ang=Math.atan2(b.y-a.y,b.x-a.x);
      const r=9,ax=b.x-Math.cos(ang)*r,ay=b.y-Math.sin(ang)*r;
      ctx.beginPath(); ctx.moveTo(ax,ay);
      ctx.lineTo(ax-Math.cos(ang-.4)*5,ay-Math.sin(ang-.4)*5);
      ctx.lineTo(ax-Math.cos(ang+.4)*5,ay-Math.sin(ang+.4)*5);
      ctx.fillStyle='#00d4aa'; ctx.fill();
    }
  });

  // Nodes
  vis.forEach(n=>{
    const sel = n.id===selectedNode;
    const r = sel?9:6;
    const col = nodeColor(n);
    // glow for selected
    if(sel){
      ctx.beginPath(); ctx.arc(n.x,n.y,r+5,0,Math.PI*2);
      ctx.fillStyle=col+'22'; ctx.fill();
    }
    ctx.beginPath(); ctx.arc(n.x,n.y,r,0,Math.PI*2);
    ctx.fillStyle=col; ctx.fill();
    // label
    const fs=(sel?11:9)/zoom;
    ctx.font=\`\${sel?'600 ':''}\${fs}px JetBrains Mono,monospace\`;
    ctx.fillStyle=sel?'#e2e4ed':'#9ca3af'; ctx.textAlign='center';
    ctx.fillText(n.label,n.x,n.y+r+11/zoom);
  });
  ctx.restore();

  const count = vis.length;
  const edgeCount = graphData.edges.filter(e=>visIds.has(e.from)&&visIds.has(e.to)).length;
  document.getElementById('graph-stats').textContent=\`\${count} files · \${edgeCount} imports\`;
}

function getNodeAt(mx,my){
  const wx=(mx-panX)/zoom,wy=(my-panY)/zoom;
  return graphData.nodes.find(n=>Math.hypot(n.x-wx,n.y-wy)<14);
}
canvas.addEventListener('mousedown',e=>{
  const n=getNodeAt(e.offsetX,e.offsetY);
  if(n){ draggingNode=n; n.fixed=true; selectedNode=n.id; }
  else { isPanning=true; panStart={x:e.offsetX-panX,y:e.offsetY-panY}; }
});
canvas.addEventListener('mousemove',e=>{
  if(draggingNode){ draggingNode.x=(e.offsetX-panX)/zoom; draggingNode.y=(e.offsetY-panY)/zoom; }
  else if(isPanning){ panX=e.offsetX-panStart.x; panY=e.offsetY-panStart.y; }
  const n=getNodeAt(e.offsetX,e.offsetY);
  if(n){
    const deps=graphData.edges.filter(x=>x.from===n.id).map(x=>x.to.split('/').pop());
    const used=graphData.edges.filter(x=>x.to===n.id).map(x=>x.from.split('/').pop());
    tooltip.style.display='block';
    tooltip.style.left=(e.clientX+14)+'px'; tooltip.style.top=(e.clientY-10)+'px';
    tooltip.innerHTML=\`<div class="tt-name">\${n.id}</div>
      <div class="tt-row">Imports: <span class="tt-hl">\${deps.length?deps.slice(0,5).join(', '):'none'}</span></div>
      <div class="tt-row">Used by: <span class="tt-hl">\${used.length?used.slice(0,5).join(', '):'none'}</span></div>
      <div style="margin-top:6px;font-size:10px;color:#6b7280">Click node to highlight · Click in sidebar to explain</div>\`;
    canvas.style.cursor='pointer';
  } else { tooltip.style.display='none'; canvas.style.cursor=isPanning?'grabbing':'grab'; }
});
canvas.addEventListener('mouseup',()=>{
  if(draggingNode){draggingNode.fixed=false;draggingNode=null;}
  isPanning=false;
});
canvas.addEventListener('click',e=>{
  const n=getNodeAt(e.offsetX,e.offsetY);
  if(n){ selectedNode=n.id; selectFile(n.id); }
});
canvas.addEventListener('wheel',e=>{
  e.preventDefault();
  const f=e.deltaY>0?.9:1.1;
  panX=e.offsetX-(e.offsetX-panX)*f; panY=e.offsetY-(e.offsetY-panY)*f;
  zoom=Math.max(.15,Math.min(zoom*f,5));
},{passive:false});
new ResizeObserver(resizeGraph).observe(document.getElementById('pane-graph'));

function loop(){
  if(activeTab==='graph'||simTick<400) simulate();
  if(activeTab==='graph') drawGraph();
  requestAnimationFrame(loop);
}
loop();

// ── Chat ──────────────────────────────────────────
let chatStreaming = false;
let streamBubble = null;
let streamText = '';

function sendChat(text){ document.getElementById('chat-input').value=text; doSendChat(); }
function focusChat(){ document.getElementById('chat-input').focus(); }

function doSendChat(){
  const inp = document.getElementById('chat-input');
  const text = inp.value.trim();
  if(!text||chatStreaming)return;
  inp.value=''; inp.style.height='auto';
  addChatMsg('you', text);
  document.getElementById('chat-send').disabled=true;
  chatStreaming=true; streamText='';
  vscode.postMessage({type:'chat',text});
}

function addChatMsg(who, text){
  const el=document.getElementById('chat-messages');
  const empty=el.querySelector('.chat-empty');
  if(empty)empty.remove();
  const div=document.createElement('div');
  div.className='msg msg-'+(who==='you'?'you':'ai');
  div.innerHTML=\`<div class="msg-who">\${who==='you'?'You':'CodeLens AI'}</div><div class="msg-bubble"></div>\`;
  div.querySelector('.msg-bubble').textContent=text;
  el.appendChild(div); el.scrollTop=el.scrollHeight;
  return div.querySelector('.msg-bubble');
}

window.addEventListener('message',e=>{
  const msg=e.data;
  if(msg.type==='projectData'){
    // Provider
    document.getElementById('provider-name').textContent=msg.provider;
    document.getElementById('model-name').textContent=msg.model;
    // Stack
    const tags=document.getElementById('stack-tags');
    tags.innerHTML=msg.stack.length
      ? msg.stack.map(s=>\`<span class="stack-tag">\${s}</span>\`).join('')
      : '<span style="color:var(--muted);font-size:12px">Unknown</span>';
    // Stats
    document.getElementById('stat-files').textContent=msg.files.length;
    document.getElementById('stat-imports').textContent=msg.graph.edges.length;
    document.getElementById('stat-stack').textContent=msg.stack.length;
    // File tree
    const pre=document.getElementById('file-tree-pre');
    pre.textContent=msg.tree;
    // File list
    allFiles=msg.files;
    renderFiles(allFiles);
    // Graph
    graphData=msg.graph;
    graphData.nodes.forEach(n=>{n.x=0;n.y=0;n.vx=0;n.vy=0;n.fixed=false;});
    graphReady=false; simTick=0;
    if(activeTab==='graph'){resizeGraph();}
  }
  else if(msg.type==='noWorkspace'){
    document.getElementById('file-list').innerHTML='<div style="padding:16px;font-size:11px;color:var(--muted)">Open a folder first</div>';
  }
  else if(msg.type==='explainResult'){
    document.getElementById('explain-body').textContent=msg.explanation;
  }
  else if(msg.type==='explainError'){
    document.getElementById('explain-body').innerHTML=\`<span style="color:var(--accent3)">\${msg.error}</span>\`;
  }
  else if(msg.type==='chatStreamStart'){
    streamBubble=addChatMsg('ai','');
    const cur=document.createElement('span');
    cur.className='cursor-blink'; streamBubble.appendChild(cur);
  }
  else if(msg.type==='chatChunk'){
    streamText+=msg.chunk;
    if(streamBubble){
      const cur=streamBubble.querySelector('.cursor-blink');
      streamBubble.textContent=streamText;
      if(cur)streamBubble.appendChild(cur);
      document.getElementById('chat-messages').scrollTop=99999;
    }
  }
  else if(msg.type==='chatStreamEnd'){
    if(streamBubble){const cur=streamBubble.querySelector('.cursor-blink');if(cur)cur.remove();}
    streamBubble=null; chatStreaming=false;
    document.getElementById('chat-send').disabled=false;
  }
  else if(msg.type==='chatError'){
    if(streamBubble){streamBubble.style.color='var(--accent3)';streamBubble.textContent='Error: '+msg.error;const cur=streamBubble.querySelector('.cursor-blink');if(cur)cur.remove();}
    chatStreaming=false; document.getElementById('chat-send').disabled=false;
  }
  else if(msg.type==='chatCleared'){
    document.getElementById('chat-messages').innerHTML='<div class="chat-empty"><div style="font-size:32px;opacity:.3">💬</div><div>Ask anything about<br>your codebase</div></div>';
  }
});
</script>
</body>
</html>`;
  }
}
