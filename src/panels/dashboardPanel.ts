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
  private _projectDataSent = false;

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

    this._panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          if (!this._projectDataSent) {
            this._projectDataSent = true;
            await this.sendProjectData();
          }
          break;
        case 'chat':           await this.handleChat(msg.text); break;
        case 'clearChat':      this._messages = []; this._panel.webview.postMessage({ type: 'chatCleared' }); break;
        case 'explainFile':    await this.explainFile(msg.file); break;
        case 'genArchDiagram': await this.generateArchDiagram(); break;
        case 'analyzeGithub':  await this.analyzeGithubRepo(msg.url); break;
        case 'switchProvider': await vscode.commands.executeCommand('codelensai.switchProvider'); break;
        case 'runCommand':     await vscode.commands.executeCommand(msg.command); break;
      }
    });

    setTimeout(async () => {
      if (!this._projectDataSent) {
        this._projectDataSent = true;
        await this.sendProjectData();
      }
    }, 2000);
  }

  private async sendProjectData() {
    try {
      const rootPath = getWorkspaceRoot();
      const cfg = this._ai.getProviderConfig();
      const model = this._ai.getModel();
      if (!rootPath) { this._panel.webview.postMessage({ type: 'noWorkspace' }); return; }

      const stack = detectTechStack(rootPath);
      const tree = buildFileTree(rootPath);
      const depNodes = buildDependencyMap(rootPath);

      const graphNodes = depNodes.map(n => ({
        id: n.relativePath,
        label: path.basename(n.relativePath),
        ext: path.extname(n.relativePath).slice(1),
        size: n.size,
      }));

      const graphEdges: { from: string; to: string }[] = [];
      for (const node of depNodes) {
        for (const imp of node.imports) {
          const normalizedImp = imp.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\.\.\//, '');
          const target = depNodes.find(n => {
            const relNorm = n.relativePath.replace(/\\/g, '/');
            const relNoExt = relNorm.replace(/\.[^.]+$/, '');
            if (relNoExt.endsWith(normalizedImp)) { return true; }
            const baseName = path.basename(n.relativePath, path.extname(n.relativePath));
            const impBase = imp.split('/').pop()?.replace(/\.[^.]+$/, '') ?? '';
            if (impBase && baseName === impBase) { return true; }
            const impClean = imp.replace(/^[./]+/, '').replace(/\.[^.]+$/, '');
            if (impClean && relNoExt.endsWith(impClean)) { return true; }
            return false;
          });
          if (target && target.relativePath !== node.relativePath) {
            const exists = graphEdges.some(e => e.from === node.relativePath && e.to === target.relativePath);
            if (!exists) { graphEdges.push({ from: node.relativePath, to: target.relativePath }); }
          }
        }
      }

      const files = getWorkspaceFiles(rootPath, 150).map(f => ({
        name: path.basename(f),
        rel: path.relative(rootPath, f),
        ext: path.extname(f).slice(1),
        size: (() => { try { return require('fs').statSync(f).size; } catch { return 0; } })(),
      }));

      this._panel.webview.postMessage({
        type: 'projectData', rootPath, stack, tree, files,
        graph: { nodes: graphNodes, edges: graphEdges },
        provider: cfg.name, model,
      });
    } catch (e: unknown) {
      this._panel.webview.postMessage({ type: 'projectDataError', error: String(e) });
    }
  }

  private async analyzeGithubRepo(repoUrl: string) {
    this._panel.webview.postMessage({ type: 'githubAnalyzeStart' });
    try {
      const match = repoUrl.match(/github\.com\/([^/]+)\/([^/\s?#]+)/);
      if (!match) { this._panel.webview.postMessage({ type: 'githubAnalyzeError', error: 'Invalid GitHub URL.' }); return; }
      const [, owner, repo] = match;
      const repoName = repo.replace(/\.git$/, '');
      const apiBase = `https://api.github.com/repos/${owner}/${repoName}`;
      const headers: Record<string, string> = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'CodeLens-AI-VSCode' };

      const [repoRes, contentsRes, languagesRes] = await Promise.all([
        fetch(apiBase, { headers }),
        fetch(`${apiBase}/contents`, { headers }),
        fetch(`${apiBase}/languages`, { headers }),
      ]);
      if (!repoRes.ok) {
        if (repoRes.status === 404) { throw new Error(`Repository not found or private.`); }
        if (repoRes.status === 403) { throw new Error('GitHub rate limit hit.'); }
        throw new Error(`GitHub API error: ${repoRes.status}`);
      }
      const repoData = await repoRes.json() as { description: string; stargazers_count: number; forks_count: number; default_branch: string; language: string; topics: string[]; open_issues_count: number; license?: { name: string }; created_at: string; updated_at: string; };
      const contents = contentsRes.ok ? await contentsRes.json() as Array<{ name: string; type: string }> : [];
      const languages = languagesRes.ok ? await languagesRes.json() as Record<string, number> : {};

      let readmeContent = '';
      try { const rr = await fetch(`${apiBase}/readme`, { headers: { ...headers, 'Accept': 'application/vnd.github.v3.raw' } }); if (rr.ok) { readmeContent = (await rr.text()).slice(0, 4000); } } catch { /* */ }

      let fileTree = '';
      try { const tr = await fetch(`${apiBase}/git/trees/${repoData.default_branch}?recursive=1`, { headers }); if (tr.ok) { const td = await tr.json() as { tree: Array<{ path: string; type: string }> }; fileTree = td.tree.filter(i => i.type === 'blob').map(i => i.path).filter(p => !p.includes('node_modules') && !p.includes('.git')).slice(0, 80).join('\n'); } } catch { /* */ }

      const keyFiles: string[] = [];
      const sourceExts = ['.ts', '.js', '.py', '.go', '.rs', '.java', '.jsx', '.tsx'];
      for (const file of (Array.isArray(contents) ? contents : []).filter(f => f.type === 'file' && sourceExts.some(e => f.name.endsWith(e))).slice(0, 3)) {
        try { const fr = await fetch(`${apiBase}/contents/${file.name}`, { headers: { ...headers, 'Accept': 'application/vnd.github.v3.raw' } }); if (fr.ok) { keyFiles.push(`--- ${file.name} ---\n${(await fr.text()).slice(0, 1500)}`); } } catch { /* */ }
      }

      const totalBytes = Object.values(languages).reduce((a, b) => a + b, 0);
      const langBreakdown = Object.entries(languages).sort((a, b) => b[1] - a[1]).map(([l, b]) => `${l}: ${((b / totalBytes) * 100).toFixed(1)}%`).join(', ');
      const prompt = `Analyze this GitHub repository:\nRepo: ${owner}/${repoName}\nDesc: ${repoData.description || 'N/A'}\nStars: ${repoData.stargazers_count} | Forks: ${repoData.forks_count}\nLanguages: ${langBreakdown}\nTopics: ${(repoData.topics || []).join(', ') || 'none'}\nLicense: ${repoData.license?.name || 'None'}\n\nREADME:\n${readmeContent || 'None'}\n\nFile tree:\n${fileTree}\n\nKey files:\n${keyFiles.join('\n\n') || 'N/A'}\n\nProvide:\n**What it does:** summary\n**Tech Stack:** languages/frameworks\n**Architecture:** code structure\n**Key Files:** most important files\n**Getting Started:** how to run\n**Verdict:** quality assessment`;

      this._panel.webview.postMessage({ type: 'githubAnalyzeProgress', message: 'AI is analyzing…' });
      let fullResponse = '';
      await this._ai.stream([{ role: 'user', content: prompt }], 'You are CodeLens AI analyzing a GitHub repo. Be concise and technical. Use markdown.', (chunk) => { fullResponse += chunk; this._panel.webview.postMessage({ type: 'githubAnalyzeChunk', chunk }); });
      this._panel.webview.postMessage({ type: 'githubAnalyzeDone', meta: { name: `${owner}/${repoName}`, description: repoData.description, stars: repoData.stargazers_count, forks: repoData.forks_count, language: repoData.language, url: `https://github.com/${owner}/${repoName}` } });
    } catch (e: unknown) { this._panel.webview.postMessage({ type: 'githubAnalyzeError', error: String(e) }); }
  }

  private async explainFile(relPath: string) {
    const rootPath = getWorkspaceRoot();
    if (!rootPath) { return; }
    const content = readFileSafe(path.join(rootPath, relPath), 30000);
    const imports = content.match(/(?:import|require)\s*.*?['"]([^'"]+)['"]/g)?.slice(0, 10).join('\n') ?? 'none';
    this._panel.webview.postMessage({ type: 'explainStart', file: relPath });
    try {
      const explanation = await this._ai.ask(`Explain this file:\n\nFile: ${relPath}\nImports:\n${imports}\n\nContents:\n${content}`, `You are CodeLens AI. Format:\n**Summary:** one sentence.\n**What it does:**\n- bullets\n**Dependencies:** imports.\n**Used by:** dependents.\n**Notes:** gotchas.`);
      this._panel.webview.postMessage({ type: 'explainResult', file: relPath, explanation });
    } catch (e: unknown) { this._panel.webview.postMessage({ type: 'explainError', file: relPath, error: String(e) }); }
  }

  private async generateArchDiagram() {
    const rootPath = getWorkspaceRoot();
    if (!rootPath) { return; }
    const stack = detectTechStack(rootPath).join(', ');
    const tree = buildFileTree(rootPath);
    this._panel.webview.postMessage({ type: 'archDiagramStart' });
    try {
      const result = await this._ai.ask(`Project Stack: ${stack}\nFile Tree:\n${tree}`, `You are a Senior Software Architect. Create a layered architecture diagram JSON.\nRULES: 3 layers, 2-4 nodes each, real filenames, connections between files.\nReturn ONLY raw JSON, no markdown.\nShape: { "title": "...", "layers": [{ "name": "...", "color": "#hex", "nodes": ["file.ts"] }], "connections": [{ "from": "a.ts", "to": "b.ts", "label": "imports" }] }`, 4096);
      let parsed = null;
      try { const cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim(); const jsonMatch = cleaned.match(/\{[\s\S]*\}/); if (jsonMatch) { parsed = JSON.parse(jsonMatch[0].replace(/,(\s*[\]}])/g, '$1')); } } catch (e) { console.error('Arch parse error:', e); }
      this._panel.webview.postMessage({ type: 'archDiagramResult', data: parsed });
    } catch (e: unknown) { this._panel.webview.postMessage({ type: 'archDiagramError', error: String(e) }); }
  }

  private async handleChat(text: string) {
    this._messages.push({ role: 'user', content: text });
    const rootPath = getWorkspaceRoot();
    const stack = rootPath ? detectTechStack(rootPath).join(', ') : 'unknown';
    const tree = rootPath ? buildFileTree(rootPath) : '';
    const system = `You are CodeLens AI, a codebase assistant. Answer concisely with markdown.\nStack: ${stack}\nTree:\n${tree}`;
    this._panel.webview.postMessage({ type: 'chatStreamStart' });
    let fullResponse = '';
    try {
      await this._ai.stream(this._messages, system, (chunk) => { fullResponse += chunk; this._panel.webview.postMessage({ type: 'chatChunk', chunk }); });
      this._messages.push({ role: 'assistant', content: fullResponse });
      this._panel.webview.postMessage({ type: 'chatStreamEnd' });
    } catch (e: unknown) { this._panel.webview.postMessage({ type: 'chatError', error: String(e) }); }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // getShellHtml() returns the HTML as a plain string built with concatenation.
  // This completely avoids TypeScript template literal escaping issues.
  // NO template literals (`...`) are used inside this method body.
  // ─────────────────────────────────────────────────────────────────────────
  private getShellHtml(): string {
    const css = [
      '@import url(\'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Syne:wght@400;600;700;800&display=swap\');',
      '*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}',
      ':root{--bg:#0d0f14;--surface:#13161e;--surface2:#1a1e29;--border:#252a38;--accent:#6c63ff;--accent2:#00d4aa;--accent3:#ff6b6b;--text:#e2e4ed;--muted:#6b7280;--mono:\'JetBrains Mono\',monospace;--sans:\'Syne\',sans-serif;}',
      'html,body{height:100%;background:var(--bg);color:var(--text);font-family:var(--sans);overflow:hidden}',
      '#app{display:grid;grid-template-rows:52px 1fr;height:100vh}',
      '#topbar{display:flex;align-items:center;gap:12px;background:var(--surface);border-bottom:1px solid var(--border);padding:0 20px}',
      '#logo{font-size:15px;font-weight:800;letter-spacing:-.5px;white-space:nowrap}',
      '#logo span{color:var(--accent)}',
      '#provider-pill{font-family:var(--mono);font-size:11px;background:var(--surface2);border:1px solid var(--border);padding:3px 10px;border-radius:20px;color:var(--muted);cursor:pointer;transition:border-color .2s,color .2s;white-space:nowrap}',
      '#provider-pill:hover{border-color:var(--accent);color:var(--text)}',
      '#provider-pill b{color:var(--accent2);font-weight:500}',
      '.spacer{flex:1}',
      '.top-action{font-family:var(--mono);font-size:11px;padding:5px 14px;background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:6px;cursor:pointer;transition:all .15s;white-space:nowrap}',
      '.top-action:hover{border-color:var(--accent);color:var(--text);background:rgba(108,99,255,.08)}',
      '.top-action.primary{border-color:var(--accent);color:var(--accent)}',
      '#main{display:grid;grid-template-columns:220px 1fr 340px;overflow:hidden}',
      '#sidebar{background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden}',
      '#sidebar-header{padding:14px 16px 10px;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border)}',
      '#file-search{margin:8px;padding:6px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:var(--mono);font-size:11px;outline:none;transition:border-color .2s}',
      '#file-search:focus{border-color:var(--accent)}',
      '#file-search::placeholder{color:var(--muted)}',
      '#file-list{flex:1;overflow-y:auto;padding:0 6px 12px}',
      '.file-item{display:flex;align-items:center;gap:7px;padding:5px 8px;border-radius:5px;cursor:pointer;font-family:var(--mono);font-size:11px;color:var(--muted);transition:background .12s,color .12s;white-space:nowrap;overflow:hidden}',
      '.file-item:hover{background:var(--surface2);color:var(--text)}',
      '.file-item.active{background:rgba(108,99,255,.15);color:var(--accent)}',
      '.file-ext{font-size:9px;padding:1px 5px;border-radius:3px;font-weight:600;flex-shrink:0;text-transform:uppercase}',
      '.ext-ts,.ext-tsx{background:#1a3a5c;color:#5ba3f5}.ext-js,.ext-jsx{background:#3a2e00;color:#f0c030}',
      '.ext-py{background:#1a3a1a;color:#4caf50}.ext-css,.ext-scss{background:#2a1a3a;color:#ab77f7}',
      '.ext-html{background:#3a1a1a;color:#f07070}.ext-json{background:#1a2a2a;color:#4db6ac}',
      '.ext-md{background:#1a2a3a;color:#60a0c0}.ext-other{background:var(--surface2);color:var(--muted)}',
      '#centre{display:flex;flex-direction:column;overflow:hidden}',
      '#tabs{display:flex;align-items:flex-end;background:var(--surface);border-bottom:1px solid var(--border);padding:0 16px;gap:2px}',
      '.tab{padding:12px 18px 10px;font-size:12px;font-weight:600;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;transition:color .15s,border-color .15s;white-space:nowrap}',
      '.tab:hover{color:var(--text)}.tab.active{color:var(--text);border-bottom-color:var(--accent)}',
      '#tab-content{flex:1;overflow:hidden;position:relative}',
      '.tab-pane{position:absolute;inset:0;overflow:auto;display:none}',
      '.tab-pane.active{display:flex;flex-direction:column}',
      '.overview-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}',
      '.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:18px;transition:border-color .2s}',
      '.card:hover{border-color:#353a4d}',
      '.card-label{font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-bottom:12px}',
      '.stack-tags{display:flex;flex-wrap:wrap;gap:6px}',
      '.stack-tag{font-family:var(--mono);font-size:11px;background:rgba(108,99,255,.12);border:1px solid rgba(108,99,255,.25);color:#a89fff;padding:3px 10px;border-radius:20px}',
      '.stat-row{display:flex;gap:24px}',
      '.stat-num{font-size:28px;font-weight:800;color:var(--text);line-height:1}',
      '.stat-lbl{font-size:11px;color:var(--muted)}',
      '.file-tree-pre{font-family:var(--mono);font-size:11px;line-height:1.7;color:var(--muted);white-space:pre;overflow:auto;max-height:260px}',
      '.action-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
      '.action-card{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:14px;cursor:pointer;transition:all .15s;text-align:left;width:100%}',
      '.action-card:hover{border-color:var(--accent);background:rgba(108,99,255,.06);transform:translateY(-1px)}',
      '.action-card-icon{font-size:20px;margin-bottom:8px}',
      '.action-card-title{font-size:12px;font-weight:700;color:var(--text);margin-bottom:3px}',
      '.action-card-desc{font-size:11px;color:var(--muted);line-height:1.5}',
      '#pane-graph{padding:0}',
      '#graph-toolbar{display:flex;align-items:center;gap:10px;padding:10px 16px;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap}',
      '#graph-search{background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:11px;padding:5px 10px;border-radius:6px;outline:none;width:180px;transition:border-color .2s}',
      '#graph-search:focus{border-color:var(--accent)}',
      '#graph-search::placeholder{color:var(--muted)}',
      '#graph-stats{font-family:var(--mono);font-size:11px;color:var(--muted);flex:1}',
      '.graph-legend{display:flex;gap:12px;flex-wrap:wrap}',
      '.leg{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--muted)}',
      '.leg-dot{width:8px;height:8px;border-radius:50%}',
      '.graph-btn{font-family:var(--mono);font-size:10px;padding:4px 10px;background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:5px;cursor:pointer;transition:all .15s}',
      '.graph-btn:hover{border-color:var(--accent2);color:var(--accent2)}',
      '#graph-canvas{flex:1;cursor:grab;display:block;min-height:0}',
      '#graph-canvas:active{cursor:grabbing}',
      '#graph-tooltip{position:fixed;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 13px;font-size:11px;font-family:var(--mono);pointer-events:none;display:none;max-width:280px;z-index:999;box-shadow:0 8px 24px rgba(0,0,0,.4)}',
      '#graph-tooltip .tt-name{font-weight:600;color:var(--text);margin-bottom:4px}',
      '#graph-tooltip .tt-row{color:var(--muted);line-height:1.6}',
      '#graph-tooltip .tt-hl{color:var(--accent2)}',
      '#pane-arch{padding:0}',
      '#arch-toolbar{display:flex;align-items:center;gap:10px;padding:14px 20px;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0}',
      '#arch-title-text{font-size:13px;font-weight:700;color:var(--text);flex:1}',
      '.arch-gen-btn{font-family:var(--mono);font-size:11px;padding:7px 18px;background:var(--accent);color:#fff;border:none;border-radius:7px;cursor:pointer;transition:background .15s}',
      '.arch-gen-btn:hover{background:#8078ff}.arch-gen-btn:disabled{opacity:.5;cursor:not-allowed}',
      '#arch-body{flex:1;overflow:auto;padding:20px;display:flex;flex-direction:column;gap:16px}',
      '#arch-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:14px;color:var(--muted);text-align:center}',
      '#arch-placeholder .big-icon{font-size:48px;opacity:.3}',
      '#arch-placeholder p{font-size:13px;line-height:1.7;max-width:320px}',
      '#arch-svg-container{display:none;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:20px;overflow:auto}',
      '#arch-loading{display:none;align-items:center;gap:10px;font-family:var(--mono);font-size:12px;color:var(--muted)}',
      '.pulse-dot{width:8px;height:8px;border-radius:50%;background:var(--accent2);animation:pulsedot 1.2s ease-in-out infinite}',
      '@keyframes pulsedot{0%,100%{opacity:.3;transform:scale(.8)}50%{opacity:1;transform:scale(1.2)}}',
      '#pane-github{padding:0}',
      '#github-toolbar{display:flex;align-items:center;gap:10px;padding:14px 20px;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0}',
      '#github-toolbar-title{font-size:13px;font-weight:700;color:var(--text);flex:1}',
      '#github-body{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:14px}',
      '#github-input-row{display:flex;gap:8px}',
      '#github-url-input{flex:1;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:12px;padding:9px 12px;border-radius:7px;outline:none;transition:border-color .2s}',
      '#github-url-input:focus{border-color:var(--accent)}',
      '#github-url-input::placeholder{color:var(--muted)}',
      '#github-analyze-btn{font-family:var(--mono);font-size:11px;padding:9px 18px;background:var(--accent);color:#fff;border:none;border-radius:7px;cursor:pointer;transition:background .15s;white-space:nowrap;font-weight:600}',
      '#github-analyze-btn:hover{background:#8078ff}',
      '#github-analyze-btn:disabled{opacity:.5;cursor:not-allowed}',
      '#github-examples{display:flex;flex-wrap:wrap;gap:6px}',
      '.gh-example{font-family:var(--mono);font-size:10px;padding:3px 9px;background:var(--surface2);border:1px solid var(--border);color:var(--muted);border-radius:4px;cursor:pointer;transition:all .15s}',
      '.gh-example:hover{border-color:var(--accent2);color:var(--accent2)}',
      '#github-result{display:none;flex-direction:column;gap:12px}',
      '#github-repo-meta{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:8px}',
      '.gh-meta-name{font-size:14px;font-weight:700}.gh-meta-name a{color:var(--accent2);text-decoration:none}',
      '.gh-meta-name a:hover{text-decoration:underline}',
      '.gh-meta-desc{font-size:12px;color:var(--muted);line-height:1.5}',
      '.gh-meta-stats{display:flex;gap:16px;flex-wrap:wrap}',
      '.gh-stat{font-family:var(--mono);font-size:11px;color:var(--muted)}.gh-stat span{color:var(--text);font-weight:600}',
      '#github-analysis-content{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:16px;font-size:13px;line-height:1.8}',
      '#github-loading{display:none;flex-direction:column;align-items:center;gap:12px;padding:40px 0;color:var(--muted);font-family:var(--mono);font-size:12px}',
      '.gh-spinner{width:24px;height:24px;border:2px solid var(--border);border-top-color:var(--accent2);border-radius:50%;animation:spin .8s linear infinite}',
      '@keyframes spin{to{transform:rotate(360deg)}}',
      '#github-error{display:none;background:rgba(255,107,107,.08);border:1px solid rgba(255,107,107,.3);border-radius:8px;padding:14px;color:var(--accent3);font-size:12px;font-family:var(--mono)}',
      '#explain-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:12px;color:var(--muted);text-align:center}',
      '#explain-placeholder .hint-icon{font-size:40px;opacity:.4}',
      '#explain-placeholder p{font-size:13px;line-height:1.7;max-width:300px}',
      '#explain-content{display:none;flex-direction:column;gap:0;flex:1;overflow:hidden}',
      '#explain-file-header{display:flex;align-items:center;gap:10px;padding:0 0 16px;border-bottom:1px solid var(--border);margin-bottom:20px;flex-shrink:0}',
      '#explain-file-name{font-family:var(--mono);font-size:13px;font-weight:500;color:var(--accent2);flex:1}',
      '.explain-reload{font-family:var(--mono);font-size:10px;padding:4px 10px;background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:5px;cursor:pointer;transition:all .15s}',
      '.explain-reload:hover{border-color:var(--accent2);color:var(--accent2)}',
      '#explain-body{font-size:13px;line-height:1.85;color:var(--text);flex:1;overflow-y:auto}',
      '.md-content h1,.md-content h2,.md-content h3{color:var(--text);font-weight:700;margin:12px 0 6px}',
      '.md-content h1{font-size:15px}.md-content h2{font-size:14px}.md-content h3{font-size:13px}',
      '.md-content p{margin:0 0 8px;color:var(--text)}',
      '.md-content strong,.md-content b{color:var(--accent2);font-weight:600}',
      '.md-content em{color:#c4b5fd;font-style:italic}',
      '.md-content ul,.md-content ol{padding-left:18px;margin:4px 0 10px}',
      '.md-content li{margin:3px 0;font-size:12px;line-height:1.6;color:var(--text)}',
      '.md-content code{font-family:var(--mono);font-size:11px;background:var(--surface2);border:1px solid var(--border);padding:1px 5px;border-radius:3px;color:#e2b96a}',
      '.md-content pre{font-family:var(--mono);font-size:11px;background:var(--surface2);border:1px solid var(--border);padding:10px 12px;border-radius:6px;overflow-x:auto;margin:8px 0;color:#e2b96a}',
      '.md-content blockquote{border-left:3px solid var(--accent);padding-left:10px;color:var(--muted);margin:8px 0}',
      '.md-content hr{border:none;border-top:1px solid var(--border);margin:12px 0}',
      '.skeleton{background:linear-gradient(90deg,var(--surface2) 25%,var(--border) 50%,var(--surface2) 75%);background-size:200% 100%;animation:shimmer 1.4s infinite;border-radius:4px;height:14px;margin-bottom:10px}',
      '@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}',
      '#chat-panel{background:var(--surface);border-left:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden}',
      '#chat-header{padding:14px 16px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px}',
      '#chat-title{font-size:12px;font-weight:700;letter-spacing:.5px;flex:1}',
      '#chat-clear{font-size:10px;padding:3px 8px;background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:4px;cursor:pointer;transition:all .15s;font-family:var(--mono)}',
      '#chat-clear:hover{border-color:var(--accent3);color:var(--accent3)}',
      '.quick-actions{display:flex;flex-wrap:wrap;gap:5px;padding:10px 12px;border-bottom:1px solid var(--border)}',
      '.qa{font-family:var(--mono);font-size:10px;padding:4px 9px;background:var(--surface2);border:1px solid var(--border);color:var(--muted);border-radius:4px;cursor:pointer;transition:all .15s}',
      '.qa:hover{border-color:var(--accent);color:var(--text)}',
      '#chat-messages{flex:1;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:14px}',
      '.chat-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:8px;color:var(--muted);text-align:center;font-size:12px;line-height:1.7}',
      '.msg{display:flex;flex-direction:column;gap:4px}',
      '.msg-who{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase}',
      '.msg-you .msg-who{color:var(--accent)}.msg-ai .msg-who{color:var(--accent2)}',
      '.msg-bubble{font-size:12px;line-height:1.75;padding:10px 12px;border-radius:8px;word-break:break-word}',
      '.msg-you .msg-bubble{background:rgba(108,99,255,.1);border:1px solid rgba(108,99,255,.2);color:var(--text);white-space:pre-wrap}',
      '.msg-ai .msg-bubble{background:var(--surface2);border:1px solid var(--border)}',
      '.cursor-blink{display:inline-block;width:7px;height:13px;background:var(--accent2);animation:blink .7s step-end infinite;vertical-align:text-bottom;border-radius:1px;margin-left:2px}',
      '@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}',
      '#chat-input-row{padding:10px 12px;border-top:1px solid var(--border);display:flex;gap:6px}',
      '#chat-input{flex:1;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:12px;padding:8px 10px;border-radius:7px;resize:none;outline:none;min-height:36px;max-height:100px;transition:border-color .2s;line-height:1.5}',
      '#chat-input:focus{border-color:var(--accent)}',
      '#chat-input::placeholder{color:var(--muted)}',
      '#chat-send{background:var(--accent);color:#fff;border:none;padding:0 14px;border-radius:7px;font-size:16px;cursor:pointer;transition:background .15s;align-self:flex-end;height:36px}',
      '#chat-send:hover{background:#8078ff}',
      '#chat-send:disabled{opacity:.4;cursor:not-allowed}',
      '::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:transparent}',
      '::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}',
      '::-webkit-scrollbar-thumb:hover{background:#353a4d}',
    ].join('\n');

    // The JS is written as a plain string — NO template literals, so no escaping issues.
    // Regex patterns here are real JS regex literals, not escaped through a TS template literal.
    const js = [
      'var _vsc = acquireVsCodeApi();',
      'window.addEventListener("load", function() { _vsc.postMessage({ type: "ready" }); });',
      '',
      'function vscPost(type, val) {',
      '  if (type === "runCommand") { _vsc.postMessage({ type: type, command: val }); }',
      '  else if (type === "explainFile") { _vsc.postMessage({ type: type, file: val }); }',
      '  else if (type === "analyzeGithub") { _vsc.postMessage({ type: type, url: val }); }',
      '  else { _vsc.postMessage({ type: type }); }',
      '}',
      '',
      '// renderMarkdown: uses String.split() for backticks (avoids regex escaping),',
      '// and real JS regex for bold/italic/headings (these are fine in plain JS strings).',
      'var BT1 = String.fromCharCode(96);',
      'var BT3 = BT1 + BT1 + BT1;',
      '',
      'function escHtml(s) {',
      '  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");',
      '}',
      'function esc(s) {',
      '  return escHtml(s).replace(/"/g,"&quot;").replace(/\'/g,"&#39;");',
      '}',
      '',
      'function renderMarkdown(raw) {',
      '  if (!raw) { return ""; }',
      '  var text = escHtml(raw).split("\\r\\n").join("\\n");',
      '  // 1) fenced code blocks',
      '  var fparts = text.split(BT3);',
      '  var staged = "";',
      '  for (var fi = 0; fi < fparts.length; fi++) {',
      '    if (fi % 2 === 0) { staged += fparts[fi]; }',
      '    else { var cl = fparts[fi].split("\\n"); cl.shift(); staged += "<pre>" + cl.join("\\n").trim() + "</pre>"; }',
      '  }',
      '  // 2) inline code',
      '  var iparts = staged.split(BT1);',
      '  staged = "";',
      '  for (var ii = 0; ii < iparts.length; ii++) {',
      '    staged += (ii % 2 === 0) ? iparts[ii] : ("<code>" + iparts[ii] + "</code>");',
      '  }',
      '  // 3) line-by-line',
      '  var lines = staged.split("\\n");',
      '  var html = "";',
      '  var inList = false;',
      '  for (var li = 0; li < lines.length; li++) {',
      '    var t = lines[li].trim();',
      '    if (!t) { if (inList) { html += "</ul>"; inList = false; } continue; }',
      '    if (t.indexOf("<pre>") === 0) { if (inList) { html += "</ul>"; inList = false; } html += t; continue; }',
      '    if (t === "---") { if (inList) { html += "</ul>"; inList = false; } html += "<hr>"; continue; }',
      '    if (t.indexOf("### ") === 0) { if (inList) { html += "</ul>"; inList = false; } html += "<h3>" + t.slice(4) + "</h3>"; continue; }',
      '    if (t.indexOf("## ") === 0)  { if (inList) { html += "</ul>"; inList = false; } html += "<h2>" + t.slice(3) + "</h2>"; continue; }',
      '    if (t.indexOf("# ") === 0)   { if (inList) { html += "</ul>"; inList = false; } html += "<h1>" + t.slice(2) + "</h1>"; continue; }',
      '    if (t.indexOf("&gt; ") === 0){ if (inList) { html += "</ul>"; inList = false; } html += "<blockquote>" + t.slice(5) + "</blockquote>"; continue; }',
      '    if (t.indexOf("- ") === 0 || t.indexOf("* ") === 0) {',
      '      if (!inList) { html += "<ul>"; inList = true; }',
      '      html += "<li>" + t.slice(2) + "</li>"; continue;',
      '    }',
      '    var dotIdx = t.indexOf(". ");',
      '    if (dotIdx > 0 && /^[0-9]+$/.test(t.slice(0, dotIdx))) {',
      '      if (!inList) { html += "<ul>"; inList = true; }',
      '      html += "<li>" + t.slice(dotIdx + 2) + "</li>"; continue;',
      '    }',
      '    if (inList) { html += "</ul>"; inList = false; }',
      '    html += "<p>" + t + "</p>";',
      '  }',
      '  if (inList) { html += "</ul>"; }',
      '  // 4) inline bold/italic',
      '  html = html.replace(/\\*\\*([^*\\n]+)\\*\\*/g, "<strong>$1</strong>");',
      '  html = html.replace(/\\*([^*\\n]+)\\*/g, "<em>$1</em>");',
      '  return html;',
      '}',
      '',
      'var activeTab = "overview";',
      'var TAB_NAMES = ["overview","graph","arch","explain","github"];',
      'function switchTab(name) {',
      '  activeTab = name;',
      '  var tabs = document.querySelectorAll(".tab");',
      '  for (var ti = 0; ti < tabs.length; ti++) { tabs[ti].classList.toggle("active", TAB_NAMES[ti] === name); }',
      '  var panes = document.querySelectorAll(".tab-pane");',
      '  for (var pi = 0; pi < panes.length; pi++) { panes[pi].classList.remove("active"); }',
      '  document.getElementById("pane-" + name).classList.add("active");',
      '  if (name === "graph") { setTimeout(function() { resizeGraph(); if (!graphReady && graphData.nodes.length) { initGraphPositions(); graphReady = true; } }, 60); }',
      '}',
      '',
      'var allFiles = [], activeFile = null;',
      'function renderFiles(files) {',
      '  var list = document.getElementById("file-list");',
      '  if (!files.length) { list.innerHTML = "<div style=\\"padding:16px;font-size:11px;color:var(--muted)\\">No files found</div>"; return; }',
      '  var html = "";',
      '  for (var i = 0; i < files.length; i++) {',
      '    var f = files[i], ext = f.ext || "other";',
      '    html += "<div class=\\"file-item" + (activeFile === f.rel ? " active" : "") + "\\" onclick=\\"selectFile(\'" + esc(f.rel) + "\')\\" title=\\"" + esc(f.rel) + "\\">"',
      '      + "<span class=\\"file-ext ext-" + ext + "\\">" + (ext || "?") + "</span>"',
      '      + "<span style=\\"overflow:hidden;text-overflow:ellipsis\\">" + esc(f.name) + "</span></div>";',
      '  }',
      '  list.innerHTML = html;',
      '}',
      'function filterFiles(q) {',
      '  var f = q.toLowerCase();',
      '  renderFiles(f ? allFiles.filter(function(x) { return x.rel.toLowerCase().indexOf(f) !== -1; }) : allFiles);',
      '}',
      'function selectFile(rel) {',
      '  activeFile = rel; renderFiles(allFiles); switchTab("explain");',
      '  _vsc.postMessage({ type: "explainFile", file: rel });',
      '  document.getElementById("explain-placeholder").style.display = "none";',
      '  document.getElementById("explain-content").style.display = "flex";',
      '  document.getElementById("explain-file-name").textContent = rel;',
      '  document.getElementById("explain-reload-btn").onclick = function() { _vsc.postMessage({ type: "explainFile", file: rel }); };',
      '  var skels = "";',
      '  var ws = ["60%","80%","45%","70%","55%"];',
      '  for (var i = 0; i < ws.length; i++) { skels += "<div class=\\"skeleton\\" style=\\"width:" + ws[i] + ";margin-bottom:12px\\"></div>"; }',
      '  document.getElementById("explain-body").innerHTML = skels;',
      '}',
      '',
      'var graphData = { nodes: [], edges: [] };',
      'var graphFilterText = "", selectedNode = null;',
      'var panX = 0, panY = 0, zoom = 1;',
      'var draggingNode = null, isPanning = false, panStart = null, graphReady = false;',
      'var canvas = document.getElementById("graph-canvas");',
      'var gctx = canvas.getContext("2d");',
      'var tooltip = document.getElementById("graph-tooltip");',
      '',
      'function resizeGraph() {',
      '  var pane = document.getElementById("pane-graph");',
      '  var tb = document.getElementById("graph-toolbar");',
      '  canvas.width = pane.clientWidth;',
      '  canvas.height = pane.clientHeight - tb.offsetHeight;',
      '}',
      'function resetGraphView() { panX = 0; panY = 0; zoom = 1; initGraphPositions(); simTick = 0; }',
      'function initGraphPositions() {',
      '  var degree = {};',
      '  for (var ei = 0; ei < graphData.edges.length; ei++) {',
      '    var e = graphData.edges[ei];',
      '    degree[e.from] = (degree[e.from] || 0) + 1;',
      '    degree[e.to] = (degree[e.to] || 0) + 1;',
      '  }',
      '  var sorted = graphData.nodes.slice().sort(function(a, b) { return (degree[b.id] || 0) - (degree[a.id] || 0); });',
      '  var cx = canvas.width / 2, cy = canvas.height / 2, count = sorted.length;',
      '  for (var ni = 0; ni < sorted.length; ni++) {',
      '    var n = sorted[ni];',
      '    var r = 60 + (ni / Math.max(count, 1)) * Math.min(cx, cy) * 0.82;',
      '    var angle = ni * 2.399963;',
      '    n.x = cx + Math.cos(angle) * r; n.y = cy + Math.sin(angle) * r;',
      '    n.vx = 0; n.vy = 0; n.fixed = false;',
      '  }',
      '}',
      'function graphFilterFn(q) { graphFilterText = q.toLowerCase(); }',
      'var EXT_COLORS = { ts:"#5ba3f5",tsx:"#5ba3f5",js:"#f0c030",jsx:"#f0c030",py:"#4caf50",css:"#ab77f7",scss:"#ab77f7",html:"#f07070",json:"#4db6ac",md:"#60a0c0" };',
      'function nodeColor(n) {',
      '  if (n.id === selectedNode) { return "#00d4aa"; }',
      '  for (var ei = 0; ei < graphData.edges.length; ei++) {',
      '    if (graphData.edges[ei].from === n.id || graphData.edges[ei].to === n.id) { return EXT_COLORS[n.ext] || "#6c63ff"; }',
      '  }',
      '  return "#3a3f50";',
      '}',
      'var simTick = 0;',
      'function simulate() {',
      '  if (simTick > 600) { return; }',
      '  var k = Math.sqrt((canvas.width * canvas.height) / Math.max(graphData.nodes.length, 1)) * 1.4;',
      '  for (var ni = 0; ni < graphData.nodes.length; ni++) { graphData.nodes[ni].vx = 0; graphData.nodes[ni].vy = 0; }',
      '  for (var i = 0; i < graphData.nodes.length; i++) {',
      '    for (var j = i + 1; j < graphData.nodes.length; j++) {',
      '      var a = graphData.nodes[i], b = graphData.nodes[j];',
      '      var dx = b.x - a.x || 0.01, dy = b.y - a.y || 0.01, d = Math.sqrt(dx*dx+dy*dy) || 1;',
      '      var rep = d < 40 ? k*k/d*3 : k*k/d*0.6;',
      '      var nx = dx/d, ny = dy/d;',
      '      a.vx -= nx*rep; a.vy -= ny*rep; b.vx += nx*rep; b.vy += ny*rep;',
      '    }',
      '  }',
      '  for (var ei2 = 0; ei2 < graphData.edges.length; ei2++) {',
      '    var e2 = graphData.edges[ei2], ea = null, eb = null;',
      '    for (var ni2 = 0; ni2 < graphData.nodes.length; ni2++) {',
      '      if (graphData.nodes[ni2].id === e2.from) { ea = graphData.nodes[ni2]; }',
      '      if (graphData.nodes[ni2].id === e2.to) { eb = graphData.nodes[ni2]; }',
      '    }',
      '    if (!ea || !eb) { continue; }',
      '    var edx = eb.x-ea.x, edy = eb.y-ea.y, ed = Math.sqrt(edx*edx+edy*edy) || 1;',
      '    var f = (ed-130)/ed*0.15;',
      '    ea.vx += edx*f; ea.vy += edy*f; eb.vx -= edx*f; eb.vy -= edy*f;',
      '  }',
      '  var cx2 = canvas.width/2, cy2 = canvas.height/2;',
      '  for (var ni3 = 0; ni3 < graphData.nodes.length; ni3++) {',
      '    var n3 = graphData.nodes[ni3];',
      '    if (n3.fixed) { continue; }',
      '    n3.vx += (cx2-n3.x)*0.003; n3.vy += (cy2-n3.y)*0.003;',
      '    n3.vx *= 0.85; n3.vy *= 0.85; n3.x += n3.vx; n3.y += n3.vy;',
      '    n3.x = Math.max(20, Math.min(canvas.width-20, n3.x));',
      '    n3.y = Math.max(20, Math.min(canvas.height-20, n3.y));',
      '  }',
      '  simTick++;',
      '}',
      'function findNode(id) { for (var i = 0; i < graphData.nodes.length; i++) { if (graphData.nodes[i].id === id) { return graphData.nodes[i]; } } return null; }',
      'function drawGraph() {',
      '  gctx.clearRect(0, 0, canvas.width, canvas.height);',
      '  if (!graphData.nodes.length) { gctx.fillStyle="#6b7280"; gctx.font="13px Syne,sans-serif"; gctx.textAlign="center"; gctx.fillText("No files found", canvas.width/2, canvas.height/2); return; }',
      '  gctx.save(); gctx.translate(panX, panY); gctx.scale(zoom, zoom);',
      '  var vis = [];',
      '  for (var ni4 = 0; ni4 < graphData.nodes.length; ni4++) {',
      '    if (!graphFilterText || graphData.nodes[ni4].id.toLowerCase().indexOf(graphFilterText) !== -1) { vis.push(graphData.nodes[ni4]); }',
      '  }',
      '  var visSet = {};',
      '  for (var vi = 0; vi < vis.length; vi++) { visSet[vis[vi].id] = true; }',
      '  for (var ei3 = 0; ei3 < graphData.edges.length; ei3++) {',
      '    var e3 = graphData.edges[ei3];',
      '    if (!visSet[e3.from] || !visSet[e3.to]) { continue; }',
      '    var na = findNode(e3.from), nb = findNode(e3.to); if (!na || !nb) { continue; }',
      '    var hl = selectedNode && (e3.from === selectedNode || e3.to === selectedNode);',
      '    var ang = Math.atan2(nb.y-na.y, nb.x-na.x), nr = 5.5;',
      '    var ex2 = nb.x-Math.cos(ang)*nr, ey2 = nb.y-Math.sin(ang)*nr;',
      '    gctx.beginPath(); gctx.moveTo(na.x,na.y); gctx.lineTo(ex2,ey2);',
      '    gctx.strokeStyle = hl ? "rgba(0,212,170,0.5)" : "rgba(37,42,56,0.7)";',
      '    gctx.lineWidth = (hl ? 1.5 : 0.8) / zoom; gctx.stroke();',
      '    if (hl) {',
      '      gctx.beginPath(); gctx.moveTo(ex2,ey2);',
      '      gctx.lineTo(ex2-Math.cos(ang-0.4)*6/zoom, ey2-Math.sin(ang-0.4)*6/zoom);',
      '      gctx.lineTo(ex2-Math.cos(ang+0.4)*6/zoom, ey2-Math.sin(ang+0.4)*6/zoom);',
      '      gctx.closePath(); gctx.fillStyle="rgba(0,212,170,0.6)"; gctx.fill();',
      '    }',
      '  }',
      '  for (var vi2 = 0; vi2 < vis.length; vi2++) {',
      '    var nv = vis[vi2], sel = nv.id === selectedNode, rv = sel ? 9 : 5.5, col = nodeColor(nv);',
      '    if (sel) { gctx.beginPath(); gctx.arc(nv.x,nv.y,rv+5,0,Math.PI*2); gctx.fillStyle=col+"22"; gctx.fill(); }',
      '    gctx.beginPath(); gctx.arc(nv.x,nv.y,rv,0,Math.PI*2); gctx.fillStyle=col; gctx.fill();',
      '    if (zoom > 0.55 || sel) {',
      '      var fs = Math.min(10, 10/zoom);',
      '      gctx.font = (sel ? "600 " : "") + fs + "px JetBrains Mono,monospace";',
      '      gctx.fillStyle = sel ? "#e2e4ed" : "#9ca3af"; gctx.textAlign = "center";',
      '      gctx.fillText(nv.label, nv.x, nv.y + rv + 10/zoom);',
      '    }',
      '  }',
      '  gctx.restore();',
      '  var ec2 = 0;',
      '  for (var ei4 = 0; ei4 < graphData.edges.length; ei4++) { if (visSet[graphData.edges[ei4].from] && visSet[graphData.edges[ei4].to]) { ec2++; } }',
      '  document.getElementById("graph-stats").textContent = vis.length + " files · " + ec2 + " imports";',
      '}',
      'function getNodeAt(mx, my) {',
      '  var wx = (mx-panX)/zoom, wy = (my-panY)/zoom;',
      '  for (var i = 0; i < graphData.nodes.length; i++) {',
      '    var n = graphData.nodes[i];',
      '    if (Math.sqrt((n.x-wx)*(n.x-wx)+(n.y-wy)*(n.y-wy)) < 14) { return n; }',
      '  }',
      '  return null;',
      '}',
      'canvas.addEventListener("mousedown", function(e) {',
      '  var n = getNodeAt(e.offsetX, e.offsetY);',
      '  if (n) { draggingNode = n; n.fixed = true; selectedNode = n.id; }',
      '  else { isPanning = true; panStart = { x: e.offsetX - panX, y: e.offsetY - panY }; }',
      '});',
      'canvas.addEventListener("mousemove", function(e) {',
      '  if (draggingNode) { draggingNode.x = (e.offsetX-panX)/zoom; draggingNode.y = (e.offsetY-panY)/zoom; }',
      '  else if (isPanning) { panX = e.offsetX - panStart.x; panY = e.offsetY - panStart.y; }',
      '  var n = getNodeAt(e.offsetX, e.offsetY);',
      '  if (n) {',
      '    var deps = [], used = [];',
      '    for (var i = 0; i < graphData.edges.length; i++) {',
      '      if (graphData.edges[i].from === n.id) { deps.push(graphData.edges[i].to.split("/").pop()); }',
      '      if (graphData.edges[i].to === n.id) { used.push(graphData.edges[i].from.split("/").pop()); }',
      '    }',
      '    tooltip.style.display = "block";',
      '    tooltip.style.left = (e.clientX+14) + "px"; tooltip.style.top = (e.clientY-10) + "px";',
      '    tooltip.innerHTML = "<div class=\\"tt-name\\">" + n.id + "</div>"',
      '      + "<div class=\\"tt-row\\">Imports: <span class=\\"tt-hl\\">" + (deps.length ? deps.slice(0,5).join(", ") : "none") + "</span></div>"',
      '      + "<div class=\\"tt-row\\">Used by: <span class=\\"tt-hl\\">" + (used.length ? used.slice(0,5).join(", ") : "none") + "</span></div>";',
      '    canvas.style.cursor = "pointer";',
      '  } else { tooltip.style.display = "none"; canvas.style.cursor = isPanning ? "grabbing" : "grab"; }',
      '});',
      'canvas.addEventListener("mouseup", function() { if (draggingNode) { draggingNode.fixed = false; draggingNode = null; } isPanning = false; });',
      'canvas.addEventListener("click", function(e) { var n = getNodeAt(e.offsetX, e.offsetY); if (n) { selectedNode = n.id; selectFile(n.id); } });',
      'canvas.addEventListener("wheel", function(e) {',
      '  e.preventDefault();',
      '  var f = e.deltaY > 0 ? 0.88 : 1.12;',
      '  panX = e.offsetX - (e.offsetX-panX)*f; panY = e.offsetY - (e.offsetY-panY)*f;',
      '  zoom = Math.max(0.1, Math.min(zoom*f, 6));',
      '}, { passive: false });',
      'new ResizeObserver(function() { resizeGraph(); }).observe(document.getElementById("pane-graph"));',
      'function loop() { if (activeTab==="graph"||simTick<600) { simulate(); } if (activeTab==="graph") { drawGraph(); } requestAnimationFrame(loop); }',
      'loop();',
      '',
      'function generateArch() {',
      '  document.getElementById("arch-gen-btn").disabled = true;',
      '  document.getElementById("arch-loading").style.display = "flex";',
      '  document.getElementById("arch-placeholder").style.display = "none";',
      '  document.getElementById("arch-svg-container").style.display = "none";',
      '  _vsc.postMessage({ type: "genArchDiagram" });',
      '}',
      'function renderArchDiagram(data) {',
      '  document.getElementById("arch-loading").style.display = "none";',
      '  document.getElementById("arch-gen-btn").disabled = false;',
      '  if (!data) { document.getElementById("arch-placeholder").style.display = "flex"; document.getElementById("arch-placeholder").querySelector("p").textContent = "Could not parse. Try again."; return; }',
      '  document.getElementById("arch-title-text").textContent = data.title || "Architecture Diagram";',
      '  document.getElementById("arch-svg-container").style.display = "block";',
      '  var layers = data.layers || [], conns = data.connections || [];',
      '  var P=24,LH=22,NH=44,NP=12,NMN=120,NMX=200,LG=32,LPV=14;',
      '  var svgW = 700;',
      '  for (var li = 0; li < layers.length; li++) { var nc = (layers[li].nodes||[]).length; var needed = nc*(Math.min(NMX,Math.max(NMN,140))+NP)-NP+P*2+40; if (needed > svgW) { svgW = needed; } }',
      '  var layerH = LH+NH+LPV*2, totalH = layers.length*(layerH+LG)-LG+P*2;',
      '  var nodePos = {};',
      '  for (var li2 = 0; li2 < layers.length; li2++) {',
      '    var lnodes = layers[li2].nodes || [], lcount = lnodes.length;',
      '    var avail = svgW-P*2-40;',
      '    var nw = Math.min(NMX, Math.max(NMN, Math.floor((avail-(lcount-1)*NP)/Math.max(lcount,1))));',
      '    var tw = lcount*nw+(lcount-1)*NP, sx = (svgW-tw)/2, lly = P+li2*(layerH+LG);',
      '    for (var ni5 = 0; ni5 < lnodes.length; ni5++) { var nx3 = sx+ni5*(nw+NP), ny3 = lly+LH+LPV; nodePos[lnodes[ni5]] = { cx: nx3+nw/2, cy: ny3+NH/2, x: nx3, y: ny3, w: nw }; }',
      '  }',
      '  var svg = \'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 \' + svgW + \' \' + totalH + \'" width="100%" style="font-family:JetBrains Mono,monospace;min-width:500px">\';',
      '  svg += \'<defs><marker id="ar" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="rgba(255,255,255,0.25)"/></marker></defs>\';',
      '  for (var ci = 0; ci < conns.length; ci++) {',
      '    var conn = conns[ci], ca = nodePos[conn.from], cb = nodePos[conn.to]; if (!ca||!cb) { continue; }',
      '    var mx2 = (ca.cx+cb.cx)/2, my2 = (ca.cy+cb.cy)/2;',
      '    svg += \'<line x1="\' + ca.cx.toFixed(1) + \'" y1="\' + ca.cy.toFixed(1) + \'" x2="\' + cb.cx.toFixed(1) + \'" y2="\' + cb.cy.toFixed(1) + \'" stroke="rgba(255,255,255,0.15)" stroke-width="1.5" stroke-dasharray="5 4" marker-end="url(#ar)"/>\';',
      '    if (conn.label) { var lw2 = conn.label.length*6+12; svg += \'<rect x="\' + (mx2-lw2/2).toFixed(1) + \'" y="\' + (my2-9).toFixed(1) + \'" width="\' + lw2 + \'" height="16" rx="4" fill="#1a1e29" opacity="0.9"/><text x="\' + mx2.toFixed(1) + \'" y="\' + (my2+4).toFixed(1) + \'" text-anchor="middle" font-size="9" fill="#6b7280">\' + conn.label + \'</text>\'; }',
      '  }',
      '  for (var li3 = 0; li3 < layers.length; li3++) {',
      '    var layer = layers[li3], lns = layer.nodes||[], lc = lns.length;',
      '    var avail2 = svgW-P*2-40;',
      '    var lnw = Math.min(NMX, Math.max(NMN, Math.floor((avail2-(lc-1)*NP)/Math.max(lc,1))));',
      '    var lly2 = P+li3*(layerH+LG), color = layer.color||"#6c63ff";',
      '    svg += \'<rect x="\' + P + \'" y="\' + lly2 + \'" width="\' + (svgW-P*2) + \'" height="\' + layerH + \'" rx="12" fill="\' + color + \'1a" stroke="\' + color + \'40" stroke-width="1.5"/>\';',
      '    svg += \'<text x="\' + (P+14) + \'" y="\' + (lly2+16) + \'" font-size="9" fill="\' + color + \'" font-weight="700" letter-spacing="1.5">\' + layer.name.toUpperCase() + \'</text>\';',
      '    for (var ni6 = 0; ni6 < lns.length; ni6++) {',
      '      var pos = nodePos[lns[ni6]]; if (!pos) { continue; }',
      '      var mc = Math.floor(pos.w/7), dn = lns[ni6].length>mc ? lns[ni6].slice(0,mc-1)+"..." : lns[ni6];',
      '      svg += \'<rect x="\' + pos.x.toFixed(1) + \'" y="\' + pos.y.toFixed(1) + \'" width="\' + pos.w + \'" height="\' + NH + \'" rx="8" fill="\' + color + \'20" stroke="\' + color + \'70" stroke-width="1.2"/>\';',
      '      svg += \'<text x="\' + pos.cx.toFixed(1) + \'" y="\' + (pos.cy+4).toFixed(1) + \'" text-anchor="middle" font-size="11" fill="\' + color + \'" font-weight="500">\' + dn + \'</text>\';',
      '    }',
      '  }',
      '  svg += "</svg>";',
      '  document.getElementById("arch-svg-container").innerHTML = svg;',
      '}',
      '',
      'var ghStreaming = false, ghStreamText = "";',
      'function setGhUrl(url) { document.getElementById("github-url-input").value = url; doAnalyzeGithub(); }',
      'function doAnalyzeGithub() {',
      '  var url = document.getElementById("github-url-input").value.trim();',
      '  if (!url || ghStreaming) { return; }',
      '  ghStreaming = true; ghStreamText = "";',
      '  document.getElementById("github-error").style.display = "none";',
      '  document.getElementById("github-result").style.display = "none";',
      '  document.getElementById("github-loading").style.display = "flex";',
      '  document.getElementById("github-analyze-btn").disabled = true;',
      '  _vsc.postMessage({ type: "analyzeGithub", url: url });',
      '}',
      '',
      'var chatStreaming = false, streamBubble = null, streamText = "";',
      'function sendChat(text) { document.getElementById("chat-input").value = text; doSendChat(); }',
      'function doSendChat() {',
      '  var inp = document.getElementById("chat-input"), text = inp.value.trim();',
      '  if (!text || chatStreaming) { return; }',
      '  inp.value = ""; inp.style.height = "auto";',
      '  addChatMsg("you", text);',
      '  document.getElementById("chat-send").disabled = true;',
      '  chatStreaming = true; streamText = "";',
      '  _vsc.postMessage({ type: "chat", text: text });',
      '}',
      'function addChatMsg(who, text) {',
      '  var el = document.getElementById("chat-messages");',
      '  var empty = el.querySelector(".chat-empty"); if (empty) { empty.remove(); }',
      '  var div = document.createElement("div"); div.className = "msg msg-" + (who === "you" ? "you" : "ai");',
      '  var bubble = document.createElement("div"); bubble.className = "msg-bubble";',
      '  if (who === "you") { bubble.textContent = text; }',
      '  else { bubble.classList.add("md-content"); bubble.innerHTML = renderMarkdown(text); }',
      '  div.innerHTML = "<div class=\\"msg-who\\">" + (who === "you" ? "You" : "CodeLens AI") + "</div>";',
      '  div.appendChild(bubble); el.appendChild(div); el.scrollTop = el.scrollHeight;',
      '  return bubble;',
      '}',
      '',
      'window.addEventListener("message", function(e) {',
      '  var msg = e.data;',
      '  if (msg.type === "projectData") {',
      '    document.getElementById("provider-name").textContent = msg.provider || "\\u2014";',
      '    document.getElementById("model-name").textContent = msg.model ? ("\\u00b7 " + msg.model) : "";',
      '    var sh = "";',
      '    if (msg.stack && msg.stack.length) { for (var i = 0; i < msg.stack.length; i++) { sh += "<span class=\\"stack-tag\\">" + esc(msg.stack[i]) + "</span>"; } }',
      '    else { sh = "<span style=\\"color:var(--muted);font-size:12px\\">Unknown</span>"; }',
      '    document.getElementById("stack-tags").innerHTML = sh;',
      '    document.getElementById("stat-files").textContent = msg.files.length;',
      '    document.getElementById("stat-imports").textContent = msg.graph.edges.length;',
      '    document.getElementById("stat-stack").textContent = msg.stack ? msg.stack.length : 0;',
      '    document.getElementById("file-tree-pre").textContent = msg.tree;',
      '    allFiles = msg.files; renderFiles(allFiles);',
      '    graphData = msg.graph;',
      '    for (var ni7 = 0; ni7 < graphData.nodes.length; ni7++) { var nn = graphData.nodes[ni7]; nn.x=0;nn.y=0;nn.vx=0;nn.vy=0;nn.fixed=false; }',
      '    graphReady = false; simTick = 0;',
      '    if (activeTab === "graph") { resizeGraph(); initGraphPositions(); graphReady = true; }',
      '  }',
      '  else if (msg.type === "projectDataError") {',
      '    document.getElementById("file-list").innerHTML = "<div style=\\"padding:16px;font-size:11px;color:var(--accent3)\\">Scan failed: " + esc(msg.error) + "</div>";',
      '    document.getElementById("file-tree-pre").textContent = "Error: " + msg.error;',
      '    document.getElementById("provider-name").textContent = "Error";',
      '  }',
      '  else if (msg.type === "noWorkspace") {',
      '    document.getElementById("file-list").innerHTML = "<div style=\\"padding:16px;font-size:11px;color:var(--muted)\\">Open a folder first</div>";',
      '    document.getElementById("file-tree-pre").textContent = "No workspace open.";',
      '    document.getElementById("stack-tags").innerHTML = "<span style=\\"color:var(--muted);font-size:12px\\">Open a folder first</span>";',
      '    document.getElementById("provider-name").textContent = "\\u2014";',
      '  }',
      '  else if (msg.type === "explainResult") { document.getElementById("explain-body").classList.add("md-content"); document.getElementById("explain-body").innerHTML = renderMarkdown(msg.explanation); }',
      '  else if (msg.type === "explainError") { document.getElementById("explain-body").innerHTML = "<span style=\\"color:var(--accent3)\\">" + esc(msg.error) + "</span>"; }',
      '  else if (msg.type === "archDiagramResult") { renderArchDiagram(msg.data); }',
      '  else if (msg.type === "archDiagramError") { document.getElementById("arch-loading").style.display="none"; document.getElementById("arch-gen-btn").disabled=false; document.getElementById("arch-placeholder").style.display="flex"; document.getElementById("arch-placeholder").querySelector("p").textContent="Error: "+msg.error; }',
      '  else if (msg.type === "githubAnalyzeStart") { document.getElementById("github-loading-msg").textContent = "Fetching repository data\\u2026"; }',
      '  else if (msg.type === "githubAnalyzeProgress") { document.getElementById("github-loading-msg").textContent = msg.message; }',
      '  else if (msg.type === "githubAnalyzeChunk") { ghStreamText += msg.chunk; document.getElementById("github-analysis-content").innerHTML = renderMarkdown(ghStreamText); }',
      '  else if (msg.type === "githubAnalyzeDone") {',
      '    ghStreaming = false;',
      '    document.getElementById("github-loading").style.display = "none";',
      '    document.getElementById("github-analyze-btn").disabled = false;',
      '    document.getElementById("github-result").style.display = "flex";',
      '    var m = msg.meta;',
      '    document.getElementById("github-repo-meta").innerHTML =',
      '      "<div class=\\"gh-meta-name\\"><a href=\\"" + m.url + "\\" target=\\"_blank\\">" + esc(m.name) + "</a></div>"',
      '      + (m.description ? "<div class=\\"gh-meta-desc\\">" + esc(m.description) + "</div>" : "")',
      '      + "<div class=\\"gh-meta-stats\\">"',
      '      + "<div class=\\"gh-stat\\">&#11088; <span>" + m.stars.toLocaleString() + "</span></div>"',
      '      + "<div class=\\"gh-stat\\">&#x1F374; <span>" + m.forks.toLocaleString() + "</span></div>"',
      '      + (m.language ? "<div class=\\"gh-stat\\">&#x1F4BB; <span>" + esc(m.language) + "</span></div>" : "")',
      '      + "</div>";',
      '    document.getElementById("github-analysis-content").innerHTML = renderMarkdown(ghStreamText);',
      '  }',
      '  else if (msg.type === "githubAnalyzeError") { ghStreaming=false; document.getElementById("github-loading").style.display="none"; document.getElementById("github-analyze-btn").disabled=false; document.getElementById("github-error").style.display="block"; document.getElementById("github-error").textContent="Error: "+msg.error; }',
      '  else if (msg.type === "chatStreamStart") { streamBubble=addChatMsg("ai",""); var cur=document.createElement("span"); cur.className="cursor-blink"; streamBubble.appendChild(cur); }',
      '  else if (msg.type === "chatChunk") {',
      '    streamText += msg.chunk;',
      '    if (streamBubble) { var c2=streamBubble.querySelector(".cursor-blink"); streamBubble.innerHTML=renderMarkdown(streamText); streamBubble.classList.add("md-content"); if(c2){streamBubble.appendChild(c2);} document.getElementById("chat-messages").scrollTop=99999; }',
      '  }',
      '  else if (msg.type === "chatStreamEnd") {',
      '    if (streamBubble) { var c3=streamBubble.querySelector(".cursor-blink"); if(c3){c3.remove();} streamBubble.innerHTML=renderMarkdown(streamText); streamBubble.classList.add("md-content"); }',
      '    streamBubble=null; chatStreaming=false; document.getElementById("chat-send").disabled=false;',
      '  }',
      '  else if (msg.type === "chatError") { if(streamBubble){streamBubble.style.color="var(--accent3)";streamBubble.textContent="Error: "+msg.error;var c4=streamBubble.querySelector(".cursor-blink");if(c4){c4.remove();}} chatStreaming=false; document.getElementById("chat-send").disabled=false; }',
      '  else if (msg.type === "chatCleared") { document.getElementById("chat-messages").innerHTML="<div class=\\"chat-empty\\"><div style=\\"font-size:32px;opacity:.3\\">&#x1F4AC;</div><div>Ask anything about<br>your codebase</div></div>"; }',
      '});',
    ].join('\n');

    const html = [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="UTF-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      '<title>CodeLens AI</title>',
      '<style>' + css + '</style>',
      '</head>',
      '<body>',
      '<div id="app">',
      '  <div id="topbar">',
      '    <div id="logo">Code<span>Lens</span> AI</div>',
      '    <div id="provider-pill" onclick="vscPost(\'switchProvider\')">',
      '      <b id="provider-name">Loading&#8230;</b> <span id="model-name"></span>',
      '    </div>',
      '    <div class="spacer"></div>',
      '    <button class="top-action" onclick="vscPost(\'runCommand\',\'codelensai.projectOverview\')">I\'m Lost</button>',
      '    <button class="top-action" onclick="vscPost(\'runCommand\',\'codelensai.generateReadme\')">Gen README</button>',
      '    <button class="top-action primary" onclick="vscPost(\'runCommand\',\'codelensai.setApiKey\')">API Key</button>',
      '  </div>',
      '  <div id="main">',
      '    <div id="sidebar">',
      '      <div id="sidebar-header">Files</div>',
      '      <input id="file-search" placeholder="search files&#8230;" oninput="filterFiles(this.value)">',
      '      <div id="file-list"><div style="padding:16px;font-size:11px;color:var(--muted)">Loading&#8230;</div></div>',
      '    </div>',
      '    <div id="centre">',
      '      <div id="tabs">',
      '        <div class="tab active" onclick="switchTab(\'overview\')">Overview</div>',
      '        <div class="tab" onclick="switchTab(\'graph\')">Dependency Graph</div>',
      '        <div class="tab" onclick="switchTab(\'arch\')">Architecture</div>',
      '        <div class="tab" onclick="switchTab(\'explain\')">File Explain</div>',
      '        <div class="tab" onclick="switchTab(\'github\')">&#x1F419; GitHub</div>',
      '      </div>',
      '      <div id="tab-content">',
      '        <div class="tab-pane active" id="pane-overview">',
      '          <div style="padding:24px;display:flex;flex-direction:column;gap:20px;overflow-y:auto;flex:1">',
      '            <div class="overview-grid">',
      '              <div class="card"><div class="card-label">Tech Stack</div><div class="stack-tags" id="stack-tags"><span style="color:var(--muted);font-size:12px">Scanning&#8230;</span></div></div>',
      '              <div class="card"><div class="card-label">Project Stats</div><div class="stat-row">',
      '                <div><div class="stat-num" id="stat-files">&#8212;</div><div class="stat-lbl">files</div></div>',
      '                <div><div class="stat-num" id="stat-imports">&#8212;</div><div class="stat-lbl">imports</div></div>',
      '                <div><div class="stat-num" id="stat-stack">&#8212;</div><div class="stat-lbl">technologies</div></div>',
      '              </div></div>',
      '              <div class="card" style="grid-column:1/-1"><div class="card-label">File Tree</div><pre class="file-tree-pre" id="file-tree-pre">Loading&#8230;</pre></div>',
      '            </div>',
      '            <div>',
      '              <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-bottom:12px">Quick Actions</div>',
      '              <div class="action-grid">',
      '                <button class="action-card" onclick="vscPost(\'runCommand\',\'codelensai.projectOverview\')"><div class="action-card-icon">&#x1F5FA;&#xFE0F;</div><div class="action-card-title">Project Overview</div><div class="action-card-desc">Full onboarding &#8212; stack, entry point, key files</div></button>',
      '                <button class="action-card" onclick="switchTab(\'graph\')"><div class="action-card-icon">&#x1F578;&#xFE0F;</div><div class="action-card-title">Dependency Graph</div><div class="action-card-desc">Interactive map of file connections</div></button>',
      '                <button class="action-card" onclick="switchTab(\'arch\')"><div class="action-card-icon">&#x1F3D7;&#xFE0F;</div><div class="action-card-title">Architecture Diagram</div><div class="action-card-desc">AI-generated layered architecture overview</div></button>',
      '                <button class="action-card" onclick="switchTab(\'github\')"><div class="action-card-icon">&#x1F419;</div><div class="action-card-title">Analyze GitHub Repo</div><div class="action-card-desc">Paste any public GitHub URL for instant analysis</div></button>',
      '              </div>',
      '            </div>',
      '          </div>',
      '        </div>',
      '        <div class="tab-pane" id="pane-graph">',
      '          <div id="graph-toolbar">',
      '            <input id="graph-search" placeholder="Filter files&#8230;" oninput="graphFilterFn(this.value)">',
      '            <div id="graph-stats">loading&#8230;</div>',
      '            <button class="graph-btn" onclick="resetGraphView()">Reset view</button>',
      '            <div class="graph-legend">',
      '              <div class="leg"><div class="leg-dot" style="background:#6c63ff"></div>connected</div>',
      '              <div class="leg"><div class="leg-dot" style="background:#00d4aa"></div>selected</div>',
      '              <div class="leg"><div class="leg-dot" style="background:#3a3f50"></div>standalone</div>',
      '            </div>',
      '          </div>',
      '          <canvas id="graph-canvas"></canvas>',
      '          <div id="graph-tooltip"></div>',
      '        </div>',
      '        <div class="tab-pane" id="pane-arch">',
      '          <div id="arch-toolbar">',
      '            <div id="arch-title-text">Architecture Diagram</div>',
      '            <div id="arch-loading"><div class="pulse-dot"></div>Generating&#8230;</div>',
      '            <button class="arch-gen-btn" id="arch-gen-btn" onclick="generateArch()">Generate with AI</button>',
      '          </div>',
      '          <div id="arch-body">',
      '            <div id="arch-placeholder"><div class="big-icon">&#x1F3D7;&#xFE0F;</div><p>Click <strong>Generate with AI</strong> to create a layered architecture diagram.</p></div>',
      '            <div id="arch-svg-container"></div>',
      '          </div>',
      '        </div>',
      '        <div class="tab-pane" id="pane-explain">',
      '          <div style="padding:24px;display:flex;flex-direction:column;flex:1;overflow:hidden">',
      '            <div id="explain-placeholder"><div class="hint-icon">&#x1F4C2;</div><p>Click any file in the sidebar to get a plain-English explanation.</p></div>',
      '            <div id="explain-content">',
      '              <div id="explain-file-header"><span id="explain-file-name"></span><button class="explain-reload" id="explain-reload-btn">&#8635; Re-explain</button></div>',
      '              <div id="explain-body" class="md-content"></div>',
      '            </div>',
      '          </div>',
      '        </div>',
      '        <div class="tab-pane" id="pane-github">',
      '          <div id="github-toolbar"><div id="github-toolbar-title">&#x1F419; GitHub Repo Analyzer</div></div>',
      '          <div id="github-body">',
      '            <div id="github-input-row">',
      '              <input id="github-url-input" placeholder="https://github.com/owner/repo" onkeydown="if(event.key===\'Enter\')doAnalyzeGithub()">',
      '              <button id="github-analyze-btn" onclick="doAnalyzeGithub()">Analyze</button>',
      '            </div>',
      '            <div style="font-size:11px;color:var(--muted)">Try an example:</div>',
      '            <div id="github-examples">',
      '              <span class="gh-example" onclick="setGhUrl(\'https://github.com/facebook/react\')">facebook/react</span>',
      '              <span class="gh-example" onclick="setGhUrl(\'https://github.com/microsoft/vscode\')">microsoft/vscode</span>',
      '              <span class="gh-example" onclick="setGhUrl(\'https://github.com/vercel/next.js\')">vercel/next.js</span>',
      '              <span class="gh-example" onclick="setGhUrl(\'https://github.com/fastapi/fastapi\')">fastapi/fastapi</span>',
      '              <span class="gh-example" onclick="setGhUrl(\'https://github.com/expressjs/express\')">expressjs/express</span>',
      '            </div>',
      '            <div id="github-error"></div>',
      '            <div id="github-loading"><div class="gh-spinner"></div><span id="github-loading-msg">Fetching repository data&#8230;</span></div>',
      '            <div id="github-result">',
      '              <div id="github-repo-meta"></div>',
      '              <div id="github-analysis-content" class="md-content"></div>',
      '            </div>',
      '          </div>',
      '        </div>',
      '      </div>',
      '    </div>',
      '    <div id="chat-panel">',
      '      <div id="chat-header"><div id="chat-title">ASK YOUR CODE</div><button id="chat-clear" onclick="vscPost(\'clearChat\')">Clear</button></div>',
      '      <div class="quick-actions">',
      '        <button class="qa" onclick="sendChat(\'Give me a project overview\')">Overview</button>',
      '        <button class="qa" onclick="sendChat(\'What is the entry point?\')">Entry point</button>',
      '        <button class="qa" onclick="sendChat(\'What are the main dependencies?\')">Dependencies</button>',
      '        <button class="qa" onclick="sendChat(\'How does data flow through this app?\')">Data flow</button>',
      '      </div>',
      '      <div id="chat-messages"><div class="chat-empty"><div style="font-size:32px;opacity:.3">&#x1F4AC;</div><div>Ask anything about<br>your codebase</div></div></div>',
      '      <div id="chat-input-row">',
      '        <textarea id="chat-input" placeholder="What does auth.js do?" rows="1"',
      '          onkeydown="if(event.key===\'Enter\'&&!event.shiftKey){event.preventDefault();doSendChat()}"',
      '          oninput="this.style.height=\'auto\';this.style.height=Math.min(this.scrollHeight,100)+\'px\'"></textarea>',
      '        <button id="chat-send" onclick="doSendChat()">&#8593;</button>',
      '      </div>',
      '    </div>',
      '  </div>',
      '</div>',
      '<script>',
      js,
      '<\/script>',
      '</body>',
      '</html>',
    ].join('\n');

    return html;
  }
}
