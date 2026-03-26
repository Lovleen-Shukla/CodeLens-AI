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
exports.DashboardPanel = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const contextBuilder_1 = require("../utils/contextBuilder");
class DashboardPanel {
    static show(context, ai) {
        if (DashboardPanel.currentPanel) {
            DashboardPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
            return;
        }
        const panel = vscode.window.createWebviewPanel('codelensai.dashboard', 'CodeLens AI', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
        DashboardPanel.currentPanel = new DashboardPanel(panel, context, ai);
        panel.onDidDispose(() => { DashboardPanel.currentPanel = undefined; });
    }
    constructor(panel, context, ai) {
        this._messages = [];
        this._panel = panel;
        this._context = context;
        this._ai = ai;
        this._panel.webview.html = this.getShellHtml();
        setTimeout(() => this.sendProjectData(), 800);
        this._panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'chat':
                    await this.handleChat(msg.text);
                    break;
                case 'clearChat':
                    this._messages = [];
                    this._panel.webview.postMessage({ type: 'chatCleared' });
                    break;
                case 'explainFile':
                    await this.explainFile(msg.file);
                    break;
                case 'genArchDiagram':
                    await this.generateArchDiagram();
                    break;
                case 'switchProvider':
                    await vscode.commands.executeCommand('codelensai.switchProvider');
                    break;
                case 'runCommand':
                    await vscode.commands.executeCommand(msg.command);
                    break;
            }
        });
    }
    async sendProjectData() {
        const rootPath = (0, contextBuilder_1.getWorkspaceRoot)();
        const cfg = this._ai.getProviderConfig();
        const model = this._ai.getModel();
        if (!rootPath) {
            this._panel.webview.postMessage({ type: 'noWorkspace' });
            return;
        }
        const stack = (0, contextBuilder_1.detectTechStack)(rootPath);
        const tree = (0, contextBuilder_1.buildFileTree)(rootPath);
        const depNodes = (0, contextBuilder_1.buildDependencyMap)(rootPath);
        const graphNodes = depNodes.map(n => ({
            id: n.relativePath,
            label: path.basename(n.relativePath),
            ext: path.extname(n.relativePath).slice(1),
            size: n.size,
        }));
        const graphEdges = [];
        for (const node of depNodes) {
            for (const imp of node.imports) {
                const target = depNodes.find(n => n.relativePath.replace(/\.[^.]+$/, '').replace(/\\/g, '/') ===
                    imp.replace(/^\.\//, '').replace(/^\.\.\//, '').replace(/\\/g, '/'));
                if (target)
                    graphEdges.push({ from: node.relativePath, to: target.relativePath });
            }
        }
        const files = (0, contextBuilder_1.getWorkspaceFiles)(rootPath, 150).map(f => ({
            name: path.basename(f),
            rel: path.relative(rootPath, f),
            ext: path.extname(f).slice(1),
            size: (() => { try {
                return require('fs').statSync(f).size;
            }
            catch {
                return 0;
            } })(),
        }));
        this._panel.webview.postMessage({
            type: 'projectData', rootPath, stack, tree, files,
            graph: { nodes: graphNodes, edges: graphEdges },
            provider: cfg.name, model,
        });
    }
    async explainFile(relPath) {
        const rootPath = (0, contextBuilder_1.getWorkspaceRoot)();
        if (!rootPath)
            return;
        const content = (0, contextBuilder_1.readFileSafe)(path.join(rootPath, relPath), 30000);
        const imports = content.match(/(?:import|require)\s*.*?['"]([^'"]+)['"]/g)?.slice(0, 10).join('\n') ?? 'none';
        this._panel.webview.postMessage({ type: 'explainStart', file: relPath });
        try {
            const explanation = await this._ai.ask(`Explain this file:\n\nFile: ${relPath}\nImports:\n${imports}\n\nContents:\n${content}`, `You are CodeLens AI. Explain code files clearly. Format your response as:

**Summary:** One sentence saying what this file does.

**What it does:**
- bullet points of main responsibilities

**Dependencies:** What it imports and why.

**Used by:** What other parts of the app likely depend on this.

**Important notes:** Any gotchas or key things to know.

Keep it concise and developer-friendly.`);
            this._panel.webview.postMessage({ type: 'explainResult', file: relPath, explanation });
        }
        catch (e) {
            this._panel.webview.postMessage({ type: 'explainError', file: relPath, error: String(e) });
        }
    }
    async generateArchDiagram() {
        const rootPath = (0, contextBuilder_1.getWorkspaceRoot)();
        if (!rootPath)
            return;
        const stack = (0, contextBuilder_1.detectTechStack)(rootPath).join(', ');
        const tree = (0, contextBuilder_1.buildFileTree)(rootPath);
        // Increase to 20 files to give the AI more "building blocks"
        const files = (0, contextBuilder_1.getWorkspaceFiles)(rootPath, 20);
        this._panel.webview.postMessage({ type: 'archDiagramStart' });
        try {
            const result = await this._ai.ask(`Project Stack: ${stack}\nFile Tree:\n${tree}`, `You are a Senior Software Architect. Create a layered architecture diagram JSON.
       
       STRICT RULES:
       1. You MUST include 3 layers.
       2. Every layer MUST have at least 2-4 nodes.
       3. Each node MUST be a real filename from the provided File Tree.
       4. Connections MUST show how these files interact (e.g., "imports", "calls").
       5. Return ONLY the raw JSON object.
       
       JSON Shape: { "title": "...", "layers": [{ "name": "...", "color": "#hex", "nodes": ["file.js"] }], "connections": [{ "from": "file.js", "to": "other.js", "label": "imports" }] }`, 4096);
            let parsed = null;
            try {
                const jsonMatch = result.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    let clean = jsonMatch[0].replace(/,(\s*[\]}])/g, '$1');
                    parsed = JSON.parse(clean);
                }
            }
            catch (e) {
                console.error("Parse Error:", e);
            }
            this._panel.webview.postMessage({ type: 'archDiagramResult', data: parsed, raw: result });
        }
        catch (e) {
            this._panel.webview.postMessage({ type: 'archDiagramError', error: String(e) });
        }
    }
    async handleChat(text) {
        this._messages.push({ role: 'user', content: text });
        const rootPath = (0, contextBuilder_1.getWorkspaceRoot)();
        const stack = rootPath ? (0, contextBuilder_1.detectTechStack)(rootPath).join(', ') : 'unknown';
        const tree = rootPath ? (0, contextBuilder_1.buildFileTree)(rootPath) : '';
        const system = `You are CodeLens AI, a codebase assistant. Answer questions about this project concisely.
Tech stack: ${stack}
File tree:
${tree}
Format responses cleanly: use plain sentences. When listing items use simple dashes (-) not numbered lists with asterisks. Never use markdown bold (**text**). Keep answers short and practical.`;
        this._panel.webview.postMessage({ type: 'chatStreamStart' });
        let fullResponse = '';
        try {
            await this._ai.stream(this._messages, system, (chunk) => {
                fullResponse += chunk;
                this._panel.webview.postMessage({ type: 'chatChunk', chunk });
            });
            this._messages.push({ role: 'assistant', content: fullResponse });
            this._panel.webview.postMessage({ type: 'chatStreamEnd' });
        }
        catch (e) {
            this._panel.webview.postMessage({ type: 'chatError', error: String(e) });
        }
    }
    getShellHtml() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeLens AI</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Syne:wght@400;600;700;800&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d0f14;--surface:#13161e;--surface2:#1a1e29;--border:#252a38;
  --accent:#6c63ff;--accent2:#00d4aa;--accent3:#ff6b6b;
  --text:#e2e4ed;--muted:#6b7280;
  --mono:'JetBrains Mono',monospace;--sans:'Syne',sans-serif;
}
html,body{height:100%;background:var(--bg);color:var(--text);font-family:var(--sans);overflow:hidden}
#app{display:grid;grid-template-rows:52px 1fr;height:100vh}

/* topbar */
#topbar{display:flex;align-items:center;gap:12px;background:var(--surface);border-bottom:1px solid var(--border);padding:0 20px}
#logo{font-size:15px;font-weight:800;letter-spacing:-.5px;white-space:nowrap}
#logo span{color:var(--accent)}
#provider-pill{font-family:var(--mono);font-size:11px;background:var(--surface2);border:1px solid var(--border);padding:3px 10px;border-radius:20px;color:var(--muted);cursor:pointer;transition:border-color .2s,color .2s;white-space:nowrap}
#provider-pill:hover{border-color:var(--accent);color:var(--text)}
#provider-pill b{color:var(--accent2);font-weight:500}
.spacer{flex:1}
.top-action{font-family:var(--mono);font-size:11px;padding:5px 14px;background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:6px;cursor:pointer;transition:all .15s;white-space:nowrap}
.top-action:hover{border-color:var(--accent);color:var(--text);background:rgba(108,99,255,.08)}
.top-action.primary{border-color:var(--accent);color:var(--accent)}

/* layout */
#main{display:grid;grid-template-columns:220px 1fr 340px;overflow:hidden}

/* sidebar */
#sidebar{background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden}
#sidebar-header{padding:14px 16px 10px;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border)}
#file-search{margin:8px;padding:6px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:var(--mono);font-size:11px;outline:none;transition:border-color .2s}
#file-search:focus{border-color:var(--accent)}
#file-search::placeholder{color:var(--muted)}
#file-list{flex:1;overflow-y:auto;padding:0 6px 12px}
.file-item{display:flex;align-items:center;gap:7px;padding:5px 8px;border-radius:5px;cursor:pointer;font-family:var(--mono);font-size:11px;color:var(--muted);transition:background .12s,color .12s;white-space:nowrap;overflow:hidden}
.file-item:hover{background:var(--surface2);color:var(--text)}
.file-item.active{background:rgba(108,99,255,.15);color:var(--accent)}
.file-ext{font-size:9px;padding:1px 5px;border-radius:3px;font-weight:600;flex-shrink:0;text-transform:uppercase}
.ext-ts,.ext-tsx{background:#1a3a5c;color:#5ba3f5}
.ext-js,.ext-jsx{background:#3a2e00;color:#f0c030}
.ext-py{background:#1a3a1a;color:#4caf50}
.ext-css,.ext-scss{background:#2a1a3a;color:#ab77f7}
.ext-html{background:#3a1a1a;color:#f07070}
.ext-json{background:#1a2a2a;color:#4db6ac}
.ext-md{background:#1a2a3a;color:#60a0c0}
.ext-other{background:var(--surface2);color:var(--muted)}

/* centre */
#centre{display:flex;flex-direction:column;overflow:hidden}
#tabs{display:flex;align-items:flex-end;background:var(--surface);border-bottom:1px solid var(--border);padding:0 16px;gap:2px}
.tab{padding:12px 18px 10px;font-size:12px;font-weight:600;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;transition:color .15s,border-color .15s;white-space:nowrap}
.tab:hover{color:var(--text)}
.tab.active{color:var(--text);border-bottom-color:var(--accent)}
#tab-content{flex:1;overflow:hidden;position:relative}
.tab-pane{position:absolute;inset:0;overflow:auto;display:none}
.tab-pane.active{display:flex;flex-direction:column}

/* overview */
#pane-overview{padding:24px;gap:20px}
.overview-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:18px;transition:border-color .2s}
.card:hover{border-color:#353a4d}
.card-label{font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-bottom:12px}
.stack-tags{display:flex;flex-wrap:wrap;gap:6px}
.stack-tag{font-family:var(--mono);font-size:11px;background:rgba(108,99,255,.12);border:1px solid rgba(108,99,255,.25);color:#a89fff;padding:3px 10px;border-radius:20px}
.stat-row{display:flex;gap:24px}
.stat-num{font-size:28px;font-weight:800;color:var(--text);line-height:1}
.stat-lbl{font-size:11px;color:var(--muted)}
.file-tree-pre{font-family:var(--mono);font-size:11px;line-height:1.7;color:var(--muted);white-space:pre;overflow:auto;max-height:260px}
.action-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.action-card{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:14px;cursor:pointer;transition:all .15s;text-align:left}
.action-card:hover{border-color:var(--accent);background:rgba(108,99,255,.06);transform:translateY(-1px)}
.action-card-icon{font-size:20px;margin-bottom:8px}
.action-card-title{font-size:12px;font-weight:700;color:var(--text);margin-bottom:3px}
.action-card-desc{font-size:11px;color:var(--muted);line-height:1.5}

/* ── GRAPH pane ── */
#pane-graph{padding:0}
#graph-toolbar{display:flex;align-items:center;gap:10px;padding:10px 16px;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap}
#graph-search{background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:11px;padding:5px 10px;border-radius:6px;outline:none;width:180px;transition:border-color .2s}
#graph-search:focus{border-color:var(--accent)}
#graph-search::placeholder{color:var(--muted)}
#graph-stats{font-family:var(--mono);font-size:11px;color:var(--muted);flex:1}
.graph-legend{display:flex;gap:12px;flex-wrap:wrap}
.leg{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--muted)}
.leg-dot{width:8px;height:8px;border-radius:50%}
.graph-btn{font-family:var(--mono);font-size:10px;padding:4px 10px;background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:5px;cursor:pointer;transition:all .15s}
.graph-btn:hover{border-color:var(--accent2);color:var(--accent2)}
#graph-canvas{flex:1;cursor:grab;display:block;min-height:0}
#graph-canvas:active{cursor:grabbing}
#graph-tooltip{position:fixed;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 13px;font-size:11px;font-family:var(--mono);pointer-events:none;display:none;max-width:280px;z-index:999;box-shadow:0 8px 24px rgba(0,0,0,.4)}
#graph-tooltip .tt-name{font-weight:600;color:var(--text);margin-bottom:4px}
#graph-tooltip .tt-row{color:var(--muted);line-height:1.6}
#graph-tooltip .tt-hl{color:var(--accent2)}

/* ── ARCH DIAGRAM pane ── */
#pane-arch{padding:20px;gap:16px}
#arch-toolbar{display:flex;align-items:center;gap:10px;flex-shrink:0}
#arch-title-text{font-size:13px;font-weight:700;color:var(--text);flex:1}
.arch-gen-btn{font-family:var(--mono);font-size:11px;padding:7px 18px;background:var(--accent);color:#fff;border:none;border-radius:7px;cursor:pointer;transition:background .15s}
.arch-gen-btn:hover{background:#8078ff}
.arch-gen-btn:disabled{opacity:.5;cursor:not-allowed}
#arch-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:14px;color:var(--muted);text-align:center}
#arch-placeholder .big-icon{font-size:48px;opacity:.3}
#arch-placeholder p{font-size:13px;line-height:1.7;max-width:320px}
#arch-canvas-wrap{flex:1;min-height:0;display:none;flex-direction:column;gap:0}
#arch-svg-container{flex:1;overflow:auto;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:20px}
#arch-loading{display:none;align-items:center;gap:10px;font-family:var(--mono);font-size:12px;color:var(--muted)}
.pulse-dot{width:8px;height:8px;border-radius:50%;background:var(--accent2);animation:pulsedot 1.2s ease-in-out infinite}
@keyframes pulsedot{0%,100%{opacity:.3;transform:scale(.8)}50%{opacity:1;transform:scale(1.2)}}

/* file explain */
#pane-explain{padding:24px;gap:0}
#explain-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:12px;color:var(--muted);text-align:center}
#explain-placeholder .hint-icon{font-size:40px;opacity:.4}
#explain-placeholder p{font-size:13px;line-height:1.7;max-width:300px}
#explain-content{display:none;flex-direction:column;gap:0;flex:1}
#explain-file-header{display:flex;align-items:center;gap:10px;padding:0 0 16px;border-bottom:1px solid var(--border);margin-bottom:20px}
#explain-file-name{font-family:var(--mono);font-size:13px;font-weight:500;color:var(--accent2);flex:1}
.explain-reload{font-family:var(--mono);font-size:10px;padding:4px 10px;background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:5px;cursor:pointer;transition:all .15s}
.explain-reload:hover{border-color:var(--accent2);color:var(--accent2)}
#explain-body{font-size:13px;line-height:1.85;color:var(--text);flex:1;overflow-y:auto}

/* markdown rendering in explain + chat */
.md-content h1,.md-content h2,.md-content h3{color:var(--text);font-weight:700;margin:12px 0 6px}
.md-content h1{font-size:15px}.md-content h2{font-size:14px}.md-content h3{font-size:13px}
.md-content p{margin:0 0 8px;color:var(--text)}
.md-content strong,.md-content b{color:var(--accent2);font-weight:600}
.md-content em{color:#c4b5fd;font-style:italic}
.md-content ul,.md-content ol{padding-left:18px;margin:4px 0 10px}
.md-content li{margin:3px 0;font-size:12px;line-height:1.6;color:var(--text)}
.md-content code{font-family:var(--mono);font-size:11px;background:var(--surface2);border:1px solid var(--border);padding:1px 5px;border-radius:3px;color:#e2b96a}
.md-content pre{font-family:var(--mono);font-size:11px;background:var(--surface2);border:1px solid var(--border);padding:10px 12px;border-radius:6px;overflow-x:auto;margin:8px 0;color:#e2b96a}
.md-content blockquote{border-left:3px solid var(--accent);padding-left:10px;color:var(--muted);margin:8px 0}
.md-content hr{border:none;border-top:1px solid var(--border);margin:12px 0}
.skeleton{background:linear-gradient(90deg,var(--surface2) 25%,var(--border) 50%,var(--surface2) 75%);background-size:200% 100%;animation:shimmer 1.4s infinite;border-radius:4px;height:14px;margin-bottom:10px}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}

/* chat */
#chat-panel{background:var(--surface);border-left:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden}
#chat-header{padding:14px 16px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px}
#chat-title{font-size:12px;font-weight:700;letter-spacing:.5px;flex:1}
#chat-clear{font-size:10px;padding:3px 8px;background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:4px;cursor:pointer;transition:all .15s;font-family:var(--mono)}
#chat-clear:hover{border-color:var(--accent3);color:var(--accent3)}
.quick-actions{display:flex;flex-wrap:wrap;gap:5px;padding:10px 12px;border-bottom:1px solid var(--border)}
.qa{font-family:var(--mono);font-size:10px;padding:4px 9px;background:var(--surface2);border:1px solid var(--border);color:var(--muted);border-radius:4px;cursor:pointer;transition:all .15s}
.qa:hover{border-color:var(--accent);color:var(--text)}
#chat-messages{flex:1;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:14px}
.chat-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:8px;color:var(--muted);text-align:center;font-size:12px;line-height:1.7}
.msg{display:flex;flex-direction:column;gap:4px}
.msg-who{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase}
.msg-you .msg-who{color:var(--accent)}.msg-ai .msg-who{color:var(--accent2)}
.msg-bubble{font-size:12px;line-height:1.75;padding:10px 12px;border-radius:8px;word-break:break-word}
.msg-you .msg-bubble{background:rgba(108,99,255,.1);border:1px solid rgba(108,99,255,.2);color:var(--text);white-space:pre-wrap}
.msg-ai .msg-bubble{background:var(--surface2);border:1px solid var(--border)}
.cursor-blink{display:inline-block;width:7px;height:13px;background:var(--accent2);animation:blink .7s step-end infinite;vertical-align:text-bottom;border-radius:1px;margin-left:2px}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
#chat-input-row{padding:10px 12px;border-top:1px solid var(--border);display:flex;gap:6px}
#chat-input{flex:1;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:12px;padding:8px 10px;border-radius:7px;resize:none;outline:none;min-height:36px;max-height:100px;transition:border-color .2s;line-height:1.5}
#chat-input:focus{border-color:var(--accent)}
#chat-input::placeholder{color:var(--muted)}
#chat-send{background:var(--accent);color:#fff;border:none;padding:0 14px;border-radius:7px;font-size:16px;cursor:pointer;transition:background .15s;align-self:flex-end;height:36px}
#chat-send:hover{background:#8078ff}
#chat-send:disabled{opacity:.4;cursor:not-allowed}

::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:#353a4d}
</style>
</head>
<body>
<div id="app">

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

  <div id="main">

    <!-- sidebar -->
    <div id="sidebar">
      <div id="sidebar-header">Files</div>
      <input id="file-search" placeholder="search files…" oninput="filterFiles(this.value)">
      <div id="file-list"><div style="padding:16px;font-size:11px;color:var(--muted)">Loading…</div></div>
    </div>

    <!-- centre -->
    <div id="centre">
      <div id="tabs">
        <div class="tab active" onclick="switchTab('overview')">Overview</div>
        <div class="tab" onclick="switchTab('graph')">Dependency Graph</div>
        <div class="tab" onclick="switchTab('arch')">Architecture</div>
        <div class="tab" onclick="switchTab('explain')">File Explain</div>
      </div>
      <div id="tab-content">

        <!-- Overview -->
        <div class="tab-pane active" id="pane-overview">
          <div style="padding:24px;display:flex;flex-direction:column;gap:20px;overflow-y:auto;flex:1">
            <div class="overview-grid">
              <div class="card">
                <div class="card-label">Tech Stack</div>
                <div class="stack-tags" id="stack-tags"><span style="color:var(--muted);font-size:12px">Scanning…</span></div>
              </div>
              <div class="card">
                <div class="card-label">Project Stats</div>
                <div class="stat-row">
                  <div><div class="stat-num" id="stat-files">—</div><div class="stat-lbl">files</div></div>
                  <div><div class="stat-num" id="stat-imports">—</div><div class="stat-lbl">imports</div></div>
                  <div><div class="stat-num" id="stat-stack">—</div><div class="stat-lbl">technologies</div></div>
                </div>
              </div>
              <div class="card" style="grid-column:1/-1">
                <div class="card-label">File Tree</div>
                <pre class="file-tree-pre" id="file-tree-pre">Loading…</pre>
              </div>
            </div>
            <div>
              <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-bottom:12px">Quick Actions</div>
              <div class="action-grid">
                <button class="action-card" onclick="post('runCommand','codelensai.projectOverview')">
                  <div class="action-card-icon">🗺️</div>
                  <div class="action-card-title">Project Overview</div>
                  <div class="action-card-desc">Full onboarding — stack, entry point, key files</div>
                </button>
                <button class="action-card" onclick="switchTab('graph')">
                  <div class="action-card-icon">🕸️</div>
                  <div class="action-card-title">Dependency Graph</div>
                  <div class="action-card-desc">Interactive map of file connections</div>
                </button>
                <button class="action-card" onclick="switchTab('arch')">
                  <div class="action-card-icon">🏗️</div>
                  <div class="action-card-title">Architecture Diagram</div>
                  <div class="action-card-desc">AI-generated layered architecture overview</div>
                </button>
                <button class="action-card" onclick="post('runCommand','codelensai.generateReadme')">
                  <div class="action-card-icon">📝</div>
                  <div class="action-card-title">Generate README</div>
                  <div class="action-card-desc">Auto-write a README from your code</div>
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Dependency Graph -->
        <div class="tab-pane" id="pane-graph">
          <div id="graph-toolbar">
            <input id="graph-search" placeholder="Filter files…" oninput="graphFilterFn(this.value)">
            <div id="graph-stats">loading…</div>
            <button class="graph-btn" onclick="resetGraphView()">Reset view</button>
            <div class="graph-legend">
              <div class="leg"><div class="leg-dot" style="background:#6c63ff"></div>connected</div>
              <div class="leg"><div class="leg-dot" style="background:#00d4aa"></div>selected</div>
              <div class="leg"><div class="leg-dot" style="background:#3a3f50"></div>standalone</div>
            </div>
          </div>
          <canvas id="graph-canvas"></canvas>
          <div id="graph-tooltip"></div>
        </div>

        <!-- Architecture Diagram -->
        <div class="tab-pane" id="pane-arch">
          <div style="padding:20px;display:flex;flex-direction:column;gap:16px;flex:1;overflow:hidden">
            <div id="arch-toolbar">
              <div id="arch-title-text">Architecture Diagram</div>
              <div id="arch-loading"><div class="pulse-dot"></div>Generating…</div>
              <button class="arch-gen-btn" id="arch-gen-btn" onclick="generateArch()">Generate with AI</button>
            </div>
            <div id="arch-placeholder">
              <div class="big-icon">🏗️</div>
              <p>Click <strong>Generate with AI</strong> to create a layered architecture diagram of your project automatically.</p>
            </div>
            <div id="arch-canvas-wrap">
              <div id="arch-svg-container"></div>
            </div>
          </div>
        </div>

        <!-- File Explain -->
        <div class="tab-pane" id="pane-explain">
          <div style="padding:24px;display:flex;flex-direction:column;flex:1;overflow:hidden">
            <div id="explain-placeholder">
              <div class="hint-icon">📂</div>
              <p>Click any file in the sidebar to get a plain-English explanation of what it does.</p>
            </div>
            <div id="explain-content">
              <div id="explain-file-header">
                <span id="explain-file-name"></span>
                <button class="explain-reload" id="explain-reload-btn">↻ Re-explain</button>
              </div>
              <div id="explain-body" class="md-content"></div>
            </div>
          </div>
        </div>

      </div>
    </div>

    <!-- chat -->
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
function post(type, val) {
  if(type==='runCommand') vscode.postMessage({type,command:val});
  else vscode.postMessage({type, ...(val?{file:val}:{})});
}

// ── Markdown renderer (lightweight) ──────────────────
function renderMarkdown(text) {
  let html = text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    // fenced code blocks
    .replace(/\`\`\`[\\w]*\\n([\\s\\S]*?)\`\`\`/g,(_,c)=>\`<pre>\${c.trim()}</pre>\`)
    // inline code
    .replace(/\`([^\`]+)\`/g,(_,c)=>\`<code>\${c}</code>\`)
    // bold
    .replace(/\\*\\*([^*]+)\\*\\*/g,(_,t)=>\`<strong>\${t}</strong>\`)
    // italic
    .replace(/\\*([^*]+)\\*/g,(_,t)=>\`<em>\${t}</em>\`)
    // h3
    .replace(/^### (.+)$/gm,(_,t)=>\`<h3>\${t}</h3>\`)
    // h2
    .replace(/^## (.+)$/gm,(_,t)=>\`<h2>\${t}</h2>\`)
    // h1
    .replace(/^# (.+)$/gm,(_,t)=>\`<h1>\${t}</h1>\`)
    // hr
    .replace(/^---$/gm,'<hr>')
    // unordered list items
    .replace(/^[\\-\\*] (.+)$/gm,(_,t)=>\`<li>\${t}</li>\`)
    // numbered list items
    .replace(/^\\d+\\. (.+)$/gm,(_,t)=>\`<li>\${t}</li>\`)
    // wrap consecutive <li> in <ul>
    .replace(/(<li>.*<\\/li>\\n?)+/gs, m=>\`<ul>\${m}</ul>\`)
    // paragraphs (lines that are not already html tags)
    .replace(/^(?!<[huplo]|<pre|<hr|<block)(.+)$/gm,(_,t)=>t.trim()?\`<p>\${t}</p>\`:'')
    // blockquote
    .replace(/^&gt; (.+)$/gm,(_,t)=>\`<blockquote>\${t}</blockquote>\`);
  return html;
}

// ── Tabs ────────────────────────────────────────────
let activeTab = 'overview';
const TAB_NAMES = ['overview','graph','arch','explain'];
function switchTab(name) {
  activeTab = name;
  document.querySelectorAll('.tab').forEach((t,i)=>t.classList.toggle('active',TAB_NAMES[i]===name));
  document.querySelectorAll('.tab-pane').forEach(p=>p.classList.remove('active'));
  document.getElementById('pane-'+name).classList.add('active');
  if(name==='graph') setTimeout(()=>{resizeGraph();if(!graphReady&&graphData.nodes.length){initGraphPositions();graphReady=true;}},60);
}

// ── File sidebar ────────────────────────────────────
let allFiles=[],activeFile=null;
function renderFiles(files){
  const list=document.getElementById('file-list');
  if(!files.length){list.innerHTML='<div style="padding:16px;font-size:11px;color:var(--muted)">No files found</div>';return;}
  list.innerHTML=files.map(f=>{
    const ext=f.ext||'other';
    return \`<div class="file-item\${activeFile===f.rel?' active':''}" onclick="selectFile('\${esc(f.rel)}')" title="\${esc(f.rel)}">
      <span class="file-ext ext-\${ext}">\${ext||'?'}</span>
      <span style="overflow:hidden;text-overflow:ellipsis">\${esc(f.name)}</span>
    </div>\`;
  }).join('');
}
function filterFiles(q){const f=q.toLowerCase();renderFiles(f?allFiles.filter(x=>x.rel.toLowerCase().includes(f)):allFiles);}
function selectFile(rel){
  activeFile=rel;renderFiles(allFiles);switchTab('explain');
  post('explainFile',rel);
  document.getElementById('explain-placeholder').style.display='none';
  document.getElementById('explain-content').style.display='flex';
  document.getElementById('explain-file-name').textContent=rel;
  document.getElementById('explain-reload-btn').onclick=()=>post('explainFile',rel);
  document.getElementById('explain-body').innerHTML=['60%','80%','45%','70%','55%'].map(w=>
    \`<div class="skeleton" style="width:\${w};margin-bottom:12px"></div>\`).join('');
}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}

// ── Dependency Graph ─────────────────────────────────
let graphData={nodes:[],edges:[]};
let graphFilterText='',selectedNode=null;
let panX=0,panY=0,zoom=1;
let draggingNode=null,isPanning=false,panStart=null,graphReady=false;
const canvas=document.getElementById('graph-canvas');
const gctx=canvas.getContext('2d');
const tooltip=document.getElementById('graph-tooltip');

function resizeGraph(){
  const pane=document.getElementById('pane-graph');
  const tb=document.getElementById('graph-toolbar');
  canvas.width=pane.clientWidth;
  canvas.height=pane.clientHeight-tb.offsetHeight;
}
function resetGraphView(){panX=0;panY=0;zoom=1;initGraphPositions();simTick=0;}

function initGraphPositions(){
  // Use a better initial layout: hub nodes (high degree) in centre, leaves on outside
  const degree={};
  graphData.edges.forEach(e=>{degree[e.from]=(degree[e.from]||0)+1;degree[e.to]=(degree[e.to]||0)+1;});
  const sorted=[...graphData.nodes].sort((a,b)=>(degree[b.id]||0)-(degree[a.id]||0));
  const cx=canvas.width/2,cy=canvas.height/2;
  const count=sorted.length;
  // Distribute using golden angle spiral to avoid overlap
  sorted.forEach((n,i)=>{
    const frac=i/Math.max(count,1);
    const r=60+frac*Math.min(cx,cy)*0.82;
    const angle=i*2.399963; // golden angle in radians
    n.x=cx+Math.cos(angle)*r;
    n.y=cy+Math.sin(angle)*r;
    n.vx=0;n.vy=0;n.fixed=false;
  });
}
function graphFilterFn(q){graphFilterText=q.toLowerCase();}

const EXT_COLORS={ts:'#5ba3f5',tsx:'#5ba3f5',js:'#f0c030',jsx:'#f0c030',py:'#4caf50',css:'#ab77f7',scss:'#ab77f7',html:'#f07070',json:'#4db6ac',md:'#60a0c0'};
function nodeColor(n){
  if(n.id===selectedNode)return'#00d4aa';
  const hasEdge=graphData.edges.some(e=>e.from===n.id||e.to===n.id);
  return hasEdge?(EXT_COLORS[n.ext]||'#6c63ff'):'#3a3f50';
}

let simTick=0;
function simulate(){
  if(simTick>500)return;
  // Use larger repulsion constant with a minimum distance to prevent overlap
  const k=Math.sqrt((canvas.width*canvas.height)/Math.max(graphData.nodes.length,1))*1.4;
  const minDist=40; // prevent nodes getting too close
  graphData.nodes.forEach(n=>{n.vx=0;n.vy=0;});
  for(let i=0;i<graphData.nodes.length;i++){
    for(let j=i+1;j<graphData.nodes.length;j++){
      const a=graphData.nodes[i],b=graphData.nodes[j];
      const dx=b.x-a.x||.01,dy=b.y-a.y||.01;
      const d=Math.sqrt(dx*dx+dy*dy)||1;
      // Strong short-range repulsion
      const rep=d<minDist ? k*k/d*3 : k*k/d*0.6;
      const nx=dx/d,ny=dy/d;
      a.vx-=nx*rep;a.vy-=ny*rep;
      b.vx+=nx*rep;b.vy+=ny*rep;
    }
  }
  graphData.edges.forEach(e=>{
    const a=graphData.nodes.find(n=>n.id===e.from),b=graphData.nodes.find(n=>n.id===e.to);
    if(!a||!b)return;
    const dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy)||1;
    const ideal=120; // ideal edge length
    const f=(d-ideal)/d*0.15;
    a.vx+=dx*f;a.vy+=dy*f;b.vx-=dx*f;b.vy-=dy*f;
  });
  // Centre gravity (weak)
  const cx=canvas.width/2,cy=canvas.height/2;
  graphData.nodes.forEach(n=>{
    if(n.fixed)return;
    n.vx+=(cx-n.x)*0.003;n.vy+=(cy-n.y)*0.003;
    // Damping
    n.vx*=0.85;n.vy*=0.85;
    n.x+=n.vx;n.y+=n.vy;
    // Clamp within canvas
    n.x=Math.max(20,Math.min(canvas.width-20,n.x));
    n.y=Math.max(20,Math.min(canvas.height-20,n.y));
  });
  simTick++;
}

function drawGraph(){
  gctx.clearRect(0,0,canvas.width,canvas.height);
  if(!graphData.nodes.length){
    gctx.fillStyle='#6b7280';gctx.font='13px Syne,sans-serif';
    gctx.textAlign='center';gctx.fillText('No files found',canvas.width/2,canvas.height/2);
    return;
  }
  gctx.save();gctx.translate(panX,panY);gctx.scale(zoom,zoom);
  const vis=graphFilterText?graphData.nodes.filter(n=>n.id.toLowerCase().includes(graphFilterText)):graphData.nodes;
  const visIds=new Set(vis.map(n=>n.id));

  // Edges
  graphData.edges.forEach(e=>{
    if(!visIds.has(e.from)||!visIds.has(e.to))return;
    const a=graphData.nodes.find(n=>n.id===e.from),b=graphData.nodes.find(n=>n.id===e.to);
    if(!a||!b)return;
    const hl=selectedNode&&(e.from===selectedNode||e.to===selectedNode);
    gctx.beginPath();gctx.moveTo(a.x,a.y);gctx.lineTo(b.x,b.y);
    gctx.strokeStyle=hl?'#00d4aa66':'#252a3866';
    gctx.lineWidth=(hl?1.5:.6)/zoom;gctx.stroke();
  });

  // Nodes
  vis.forEach(n=>{
    const sel=n.id===selectedNode,r=sel?9:5.5;
    const col=nodeColor(n);
    if(sel){gctx.beginPath();gctx.arc(n.x,n.y,r+5,0,Math.PI*2);gctx.fillStyle=col+'22';gctx.fill();}
    gctx.beginPath();gctx.arc(n.x,n.y,r,0,Math.PI*2);gctx.fillStyle=col;gctx.fill();
    // Label only if zoomed in enough or selected
    if(zoom>0.55||sel){
      const fs=Math.min(10,10/zoom);
      gctx.font=\`\${sel?'600 ':''}\${fs}px JetBrains Mono,monospace\`;
      gctx.fillStyle=sel?'#e2e4ed':'#9ca3af';gctx.textAlign='center';
      gctx.fillText(n.label,n.x,n.y+r+10/zoom);
    }
  });
  gctx.restore();
  const cnt=vis.length,ec=graphData.edges.filter(e=>visIds.has(e.from)&&visIds.has(e.to)).length;
  document.getElementById('graph-stats').textContent=\`\${cnt} files · \${ec} imports\`;
}

function getNodeAt(mx,my){
  const wx=(mx-panX)/zoom,wy=(my-panY)/zoom;
  return graphData.nodes.find(n=>Math.hypot(n.x-wx,n.y-wy)<14);
}
canvas.addEventListener('mousedown',e=>{
  const n=getNodeAt(e.offsetX,e.offsetY);
  if(n){draggingNode=n;n.fixed=true;selectedNode=n.id;}
  else{isPanning=true;panStart={x:e.offsetX-panX,y:e.offsetY-panY};}
});
canvas.addEventListener('mousemove',e=>{
  if(draggingNode){draggingNode.x=(e.offsetX-panX)/zoom;draggingNode.y=(e.offsetY-panY)/zoom;}
  else if(isPanning){panX=e.offsetX-panStart.x;panY=e.offsetY-panStart.y;}
  const n=getNodeAt(e.offsetX,e.offsetY);
  if(n){
    const deps=graphData.edges.filter(x=>x.from===n.id).map(x=>path_basename(x.to));
    const used=graphData.edges.filter(x=>x.to===n.id).map(x=>path_basename(x.from));
    tooltip.style.display='block';
    tooltip.style.left=(e.clientX+14)+'px';tooltip.style.top=(e.clientY-10)+'px';
    tooltip.innerHTML=\`<div class="tt-name">\${n.id}</div>
      <div class="tt-row">Imports: <span class="tt-hl">\${deps.length?deps.slice(0,5).join(', '):'none'}</span></div>
      <div class="tt-row">Used by: <span class="tt-hl">\${used.length?used.slice(0,5).join(', '):'none'}</span></div>\`;
    canvas.style.cursor='pointer';
  }else{tooltip.style.display='none';canvas.style.cursor=isPanning?'grabbing':'grab';}
});
canvas.addEventListener('mouseup',()=>{if(draggingNode){draggingNode.fixed=false;draggingNode=null;}isPanning=false;});
canvas.addEventListener('click',e=>{const n=getNodeAt(e.offsetX,e.offsetY);if(n){selectedNode=n.id;selectFile(n.id);}});
canvas.addEventListener('wheel',e=>{
  e.preventDefault();
  const f=e.deltaY>0?.88:1.12;
  panX=e.offsetX-(e.offsetX-panX)*f;panY=e.offsetY-(e.offsetY-panY)*f;
  zoom=Math.max(.1,Math.min(zoom*f,6));
},{passive:false});
new ResizeObserver(()=>{resizeGraph();}).observe(document.getElementById('pane-graph'));

function path_basename(p){return p.split(/[\\/\\\\]/).pop();}

function loop(){
  if(activeTab==='graph'||simTick<500)simulate();
  if(activeTab==='graph')drawGraph();
  requestAnimationFrame(loop);
}
loop();

// ── Architecture Diagram ─────────────────────────────
function generateArch(){
  document.getElementById('arch-gen-btn').disabled=true;
  document.getElementById('arch-loading').style.display='flex';
  document.getElementById('arch-placeholder').style.display='none';
  document.getElementById('arch-canvas-wrap').style.display='none';
  vscode.postMessage({type:'genArchDiagram'});
}

function renderArchDiagram(data){
  document.getElementById('arch-loading').style.display='none';
  document.getElementById('arch-gen-btn').disabled=false;
  if(!data){
    document.getElementById('arch-placeholder').style.display='flex';
    document.getElementById('arch-placeholder').querySelector('p').textContent='Could not parse diagram. Try again.';
    return;
  }
  document.getElementById('arch-title-text').textContent=data.title||'Architecture Diagram';
  document.getElementById('arch-canvas-wrap').style.display='flex';

  // Build SVG diagram
  const layers=data.layers||[];
  const connections=data.connections||[];

  // Layout: each layer is a horizontal band
  const svgW=800;
  const layerH=90;
  const gap=40;
  const totalH=layers.length*(layerH+gap)+60;

  let svgParts=[\`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 \${svgW} \${totalH}" width="100%" style="font-family:JetBrains Mono,monospace">\`];

  // Track node positions for connections
  const nodePos={};

  layers.forEach((layer,li)=>{
    const y=30+li*(layerH+gap);
    const nodes=layer.nodes||[];
    const nodeW=Math.min(160,Math.max(100,(svgW-80)/Math.max(nodes.length,1)-16));
    const totalNodesW=nodes.length*(nodeW+12)-12;
    const startX=(svgW-totalNodesW)/2;
    const layerColor=layer.color||'#6c63ff';
    const layerColorDim=layerColor+'22';

    // Layer background
    svgParts.push(\`<rect x="20" y="\${y}" width="\${svgW-40}" height="\${layerH}" rx="10" fill="\${layerColorDim}" stroke="\${layerColor}44" stroke-width="1"/>\`);
    // Layer label
    svgParts.push(\`<text x="30" y="\${y+16}" font-size="9" fill="\${layerColor}" font-weight="600" letter-spacing="1.5" text-transform="uppercase">\${layer.name.toUpperCase()}</text>\`);

    nodes.forEach((node,ni)=>{
      const nx=startX+ni*(nodeW+12);
      const ny=y+24;
      const nh=layerH-34;
      nodePos[node]={cx:nx+nodeW/2,cy:ny+nh/2};
      svgParts.push(\`<rect x="\${nx}" y="\${ny}" width="\${nodeW}" height="\${nh}" rx="7" fill="\${layerColor}18" stroke="\${layerColor}66" stroke-width="1"/>\`);
      // Wrap long names
      const words=node.split(' ');
      if(words.length<=2||node.length<=18){
        svgParts.push(\`<text x="\${nx+nodeW/2}" y="\${ny+nh/2+4}" text-anchor="middle" font-size="11" fill="\${layerColor}" font-weight="500">\${node}</text>\`);
      } else {
        const half=Math.ceil(words.length/2);
        const l1=words.slice(0,half).join(' '),l2=words.slice(half).join(' ');
        svgParts.push(\`<text x="\${nx+nodeW/2}" y="\${ny+nh/2-4}" text-anchor="middle" font-size="10" fill="\${layerColor}" font-weight="500">\${l1}</text>\`);
        svgParts.push(\`<text x="\${nx+nodeW/2}" y="\${ny+nh/2+10}" text-anchor="middle" font-size="10" fill="\${layerColor}" font-weight="500">\${l2}</text>\`);
      }
    });
  });

  // Draw connections
  connections.forEach(conn=>{
    const a=nodePos[conn.from],b=nodePos[conn.to];
    if(!a||!b)return;
    const mx=(a.cx+b.cx)/2,my=(a.cy+b.cy)/2;
    svgParts.push(\`<line x1="\${a.cx}" y1="\${a.cy}" x2="\${b.cx}" y2="\${b.cy}" stroke="#ffffff22" stroke-width="1.5" stroke-dasharray="4 3"/>\`);
    if(conn.label){
      svgParts.push(\`<rect x="\${mx-24}" y="\${my-8}" width="48" height="14" rx="3" fill="#1a1e29"/>\`);
      svgParts.push(\`<text x="\${mx}" y="\${my+3}" text-anchor="middle" font-size="9" fill="#6b7280">\${conn.label}</text>\`);
    }
    // Arrow
    const ang=Math.atan2(b.cy-a.cy,b.cx-a.cx);
    const ar=10,ax=b.cx-Math.cos(ang)*ar,ay=b.cy-Math.sin(ang)*ar;
    svgParts.push(\`<polygon points="\${ax},\${ay} \${ax-Math.cos(ang-.4)*7},\${ay-Math.sin(ang-.4)*7} \${ax-Math.cos(ang+.4)*7},\${ay-Math.sin(ang+.4)*7}" fill="#ffffff33"/>\`);
  });

  svgParts.push('</svg>');
  document.getElementById('arch-svg-container').innerHTML=svgParts.join('');
}

// ── Chat ─────────────────────────────────────────────
let chatStreaming=false,streamBubble=null,streamText='';

function sendChat(text){document.getElementById('chat-input').value=text;doSendChat();}

function doSendChat(){
  const inp=document.getElementById('chat-input');
  const text=inp.value.trim();
  if(!text||chatStreaming)return;
  inp.value='';inp.style.height='auto';
  addChatMsg('you',text);
  document.getElementById('chat-send').disabled=true;
  chatStreaming=true;streamText='';
  vscode.postMessage({type:'chat',text});
}

function addChatMsg(who,text){
  const el=document.getElementById('chat-messages');
  const empty=el.querySelector('.chat-empty');
  if(empty)empty.remove();
  const div=document.createElement('div');
  div.className='msg msg-'+(who==='you'?'you':'ai');
  const bubble=document.createElement('div');
  bubble.className='msg-bubble';
  if(who==='you'){bubble.textContent=text;}
  else{bubble.classList.add('md-content');bubble.innerHTML=renderMarkdown(text);}
  div.innerHTML=\`<div class="msg-who">\${who==='you'?'You':'CodeLens AI'}</div>\`;
  div.appendChild(bubble);
  el.appendChild(div);el.scrollTop=el.scrollHeight;
  return bubble;
}

window.addEventListener('message',e=>{
  const msg=e.data;
  if(msg.type==='projectData'){
    document.getElementById('provider-name').textContent=msg.provider;
    document.getElementById('model-name').textContent=msg.model;
    document.getElementById('stack-tags').innerHTML=msg.stack.length
      ?msg.stack.map(s=>\`<span class="stack-tag">\${esc(s)}</span>\`).join('')
      :'<span style="color:var(--muted);font-size:12px">Unknown</span>';
    document.getElementById('stat-files').textContent=msg.files.length;
    document.getElementById('stat-imports').textContent=msg.graph.edges.length;
    document.getElementById('stat-stack').textContent=msg.stack.length;
    document.getElementById('file-tree-pre').textContent=msg.tree;
    allFiles=msg.files;renderFiles(allFiles);
    graphData=msg.graph;
    graphData.nodes.forEach(n=>{n.x=0;n.y=0;n.vx=0;n.vy=0;n.fixed=false;});
    graphReady=false;simTick=0;
    if(activeTab==='graph'){resizeGraph();initGraphPositions();graphReady=true;}
  }
  else if(msg.type==='noWorkspace'){
    document.getElementById('file-list').innerHTML='<div style="padding:16px;font-size:11px;color:var(--muted)">Open a folder first</div>';
  }
  else if(msg.type==='explainResult'){
    const body=document.getElementById('explain-body');
    body.classList.add('md-content');
    body.innerHTML=renderMarkdown(msg.explanation);
  }
  else if(msg.type==='explainError'){
    document.getElementById('explain-body').innerHTML=\`<span style="color:var(--accent3)">\${esc(msg.error)}</span>\`;
  }
  else if(msg.type==='archDiagramStart'){
    // handled in generateArch()
  }
  else if(msg.type==='archDiagramResult'){
    renderArchDiagram(msg.data);
  }
  else if(msg.type==='archDiagramError'){
    document.getElementById('arch-loading').style.display='none';
    document.getElementById('arch-gen-btn').disabled=false;
    document.getElementById('arch-placeholder').style.display='flex';
    document.getElementById('arch-placeholder').querySelector('p').textContent='Error: '+msg.error;
  }
  else if(msg.type==='chatStreamStart'){
    streamBubble=addChatMsg('ai','');
    const cur=document.createElement('span');
    cur.className='cursor-blink';streamBubble.appendChild(cur);
  }
  else if(msg.type==='chatChunk'){
    streamText+=msg.chunk;
    if(streamBubble){
      const cur=streamBubble.querySelector('.cursor-blink');
      streamBubble.innerHTML=renderMarkdown(streamText);
      streamBubble.classList.add('md-content');
      if(cur)streamBubble.appendChild(cur);
      document.getElementById('chat-messages').scrollTop=99999;
    }
  }
  else if(msg.type==='chatStreamEnd'){
    if(streamBubble){
      const cur=streamBubble.querySelector('.cursor-blink');
      if(cur)cur.remove();
      streamBubble.innerHTML=renderMarkdown(streamText);
      streamBubble.classList.add('md-content');
    }
    streamBubble=null;chatStreaming=false;
    document.getElementById('chat-send').disabled=false;
  }
  else if(msg.type==='chatError'){
    if(streamBubble){streamBubble.style.color='var(--accent3)';streamBubble.textContent='Error: '+msg.error;const cur=streamBubble.querySelector('.cursor-blink');if(cur)cur.remove();}
    chatStreaming=false;document.getElementById('chat-send').disabled=false;
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
exports.DashboardPanel = DashboardPanel;
//# sourceMappingURL=dashboardPanel.js.map