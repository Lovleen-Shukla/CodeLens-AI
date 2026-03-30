import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as child_process from 'child_process';
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
      'codelensai.dashboard', 'CodeLens AI', vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    DashboardPanel.currentPanel = new DashboardPanel(panel, context, ai);
    panel.onDidDispose(() => { DashboardPanel.currentPanel = undefined; });
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, ai: AIClient) {
    this._panel = panel; this._context = context; this._ai = ai;
    this._panel.webview.html = this.getShellHtml();
    this._panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          if (!this._projectDataSent) { this._projectDataSent = true; await this.sendProjectData(); }
          break;
        case 'chat':            await this.handleChat(msg.text); break;
        case 'clearChat':       this._messages = []; this._panel.webview.postMessage({ type: 'chatCleared' }); break;
        case 'explainFile':     await this.explainFileInDashboard(msg.file); break;
        case 'genArchDiagram':  await this.generateArchDiagram(); break;
        case 'analyzeGithub':   await this.analyzeGithubRepo(msg.url); break;
        case 'cloneAndAnalyze': await this.cloneAndAnalyze(msg.url); break;
        case 'switchProvider':  await vscode.commands.executeCommand('codelensai.switchProvider'); break;
        case 'runCommand':      await vscode.commands.executeCommand(msg.command); break;
      }
    });
    setTimeout(async () => { if (!this._projectDataSent) { this._projectDataSent = true; await this.sendProjectData(); } }, 2000);
  }

  // ── Project data ─────────────────────────────────────────────────────────
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
        id: n.relativePath, label: path.basename(n.relativePath),
        ext: path.extname(n.relativePath).slice(1), size: n.size,
      }));
      const graphEdges: { from: string; to: string }[] = [];
      for (const node of depNodes) {
        for (const imp of node.imports) {
          const ni = imp.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\.\.\//, '');
          const target = depNodes.find(n => {
            const r = n.relativePath.replace(/\\/g, '/').replace(/\.[^.]+$/, '');
            if (r.endsWith(ni)) { return true; }
            const base = path.basename(n.relativePath, path.extname(n.relativePath));
            const impBase = imp.split('/').pop()?.replace(/\.[^.]+$/, '') ?? '';
            if (impBase && base === impBase) { return true; }
            const ic = imp.replace(/^[./]+/, '').replace(/\.[^.]+$/, '');
            if (ic && r.endsWith(ic)) { return true; }
            return false;
          });
          if (target && target.relativePath !== node.relativePath) {
            const exists = graphEdges.some(e => e.from === node.relativePath && e.to === target.relativePath);
            if (!exists) { graphEdges.push({ from: node.relativePath, to: target.relativePath }); }
          }
        }
      }
      const files = getWorkspaceFiles(rootPath, 150).map(f => ({
        name: path.basename(f), rel: path.relative(rootPath, f),
        ext: path.extname(f).slice(1),
        size: (() => { try { return require('fs').statSync(f).size; } catch { return 0; } })(),
      }));
      this._panel.webview.postMessage({
        type: 'projectData', rootPath, stack, tree, files,
        graph: { nodes: graphNodes, edges: graphEdges },
        provider: cfg.name, model,
      });
    } catch (e: unknown) { this._panel.webview.postMessage({ type: 'projectDataError', error: String(e) }); }
  }

  // ── Clone ─────────────────────────────────────────────────────────────────
  private async cloneAndAnalyze(repoUrl: string) {
    this._panel.webview.postMessage({ type: 'cloneProgress', message: 'Checking git...' });
    try {
      await this.runCmd('git --version');
      const match = repoUrl.match(/github\.com\/([^/]+)\/([^/\s?#]+)/);
      if (!match) { throw new Error('Invalid GitHub URL.'); }
      const [, owner, repo] = match;
      const repoName = repo.replace(/\.git$/, '');
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
        openLabel: `Clone ${repoName} here`,
      });
      if (!picked || !picked[0]) { this._panel.webview.postMessage({ type: 'cloneCancelled' }); return; }
      const repoDir = path.join(picked[0].fsPath, repoName);
      if (fs.existsSync(repoDir)) {
        const c = await vscode.window.showWarningMessage(`"${repoName}" already exists.`, 'Open existing', 'Cancel');
        if (c === 'Open existing') { await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(repoDir), { forceNewWindow: false }); this._panel.webview.postMessage({ type: 'cloneDone', repoName }); }
        else { this._panel.webview.postMessage({ type: 'cloneCancelled' }); }
        return;
      }
      this._panel.webview.postMessage({ type: 'cloneProgress', message: `Cloning ${owner}/${repoName}...` });
      await this.runCmd(`git clone --depth 1 "https://github.com/${owner}/${repoName}.git" "${repoDir}"`);
      const oc = await vscode.window.showInformationMessage(`Cloned ${owner}/${repoName}!`, 'Open here', 'New window', 'Skip');
      if (oc === 'Open here') { await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(repoDir), { forceNewWindow: false }); }
      else if (oc === 'New window') { await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(repoDir), { forceNewWindow: true }); }
      this._panel.webview.postMessage({ type: 'cloneDone', repoName });
    } catch (e: unknown) { this._panel.webview.postMessage({ type: 'cloneError', error: String(e) }); }
  }

  private runCmd(cmd: string): Promise<string> {
    return new Promise((res, rej) => { child_process.exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => { if (err) { rej(new Error(stderr || err.message)); } else { res(stdout); } }); });
  }

  // ── GitHub Analyze ────────────────────────────────────────────────────────
  private async analyzeGithubRepo(repoUrl: string) {
    this._panel.webview.postMessage({ type: 'githubAnalyzeStart' });
    try {
      const m = repoUrl.match(/github\.com\/([^/]+)\/([^/\s?#]+)/);
      if (!m) { this._panel.webview.postMessage({ type: 'githubAnalyzeError', error: 'Invalid URL.' }); return; }
      const [, owner, repo] = m;
      const rn = repo.replace(/\.git$/, '');
      const base = `https://api.github.com/repos/${owner}/${rn}`;
      const hdr: Record<string, string> = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'CodeLens-AI' };
      this._panel.webview.postMessage({ type: 'githubAnalyzeProgress', message: 'Fetching metadata...' });
      const [rR, cR, lR] = await Promise.all([fetch(base, { headers: hdr }), fetch(`${base}/contents`, { headers: hdr }), fetch(`${base}/languages`, { headers: hdr })]);
      if (!rR.ok) { throw new Error(rR.status === 404 ? 'Not found or private.' : rR.status === 403 ? 'Rate limit hit.' : `API error ${rR.status}`); }
      const rd = await rR.json() as { description: string; stargazers_count: number; forks_count: number; default_branch: string; language: string; topics: string[]; open_issues_count: number; watchers_count: number; size: number; license?: { name: string }; fork: boolean; allow_forking: boolean; visibility: string; };
      const contents = cR.ok ? await cR.json() as Array<{ name: string; type: string }> : [];
      const languages = lR.ok ? await lR.json() as Record<string, number> : {};
      let readme = ''; try { const rr = await fetch(`${base}/readme`, { headers: { ...hdr, 'Accept': 'application/vnd.github.v3.raw' } }); if (rr.ok) { readme = (await rr.text()).slice(0, 5000); } } catch { /* */ }
      let fileTree = ''; let totalFiles = 0;
      try { const tr = await fetch(`${base}/git/trees/${rd.default_branch}?recursive=1`, { headers: hdr }); if (tr.ok) { const td = await tr.json() as { tree: Array<{ path: string; type: string }> }; const b = td.tree.filter(i => i.type === 'blob').filter(p => !p.path.includes('node_modules')); totalFiles = b.length; fileTree = b.slice(0, 100).map(i => i.path).join('\n'); } } catch { /* */ }
      const kf: string[] = [];
      for (const f of (Array.isArray(contents) ? contents : []).filter(f => f.type === 'file' && ['.ts','.js','.py','.go','.rs','.java','.jsx','.tsx'].some(e => f.name.endsWith(e))).slice(0, 4)) {
        try { const fr = await fetch(`${base}/contents/${f.name}`, { headers: { ...hdr, 'Accept': 'application/vnd.github.v3.raw' } }); if (fr.ok) { kf.push(`--- ${f.name} ---\n${(await fr.text()).slice(0, 2000)}`); } } catch { /* */ }
      }
      const tb = Object.values(languages).reduce((a, b) => a + b, 0);
      const lb = Object.entries(languages).sort((a, b) => b[1] - a[1]).map(([l, b]) => `${l}: ${((b / tb) * 100).toFixed(1)}%`).join(', ');
      this._panel.webview.postMessage({ type: 'githubAnalyzeProgress', message: 'AI analyzing...' });
      const prompt = `Analyze this GitHub repository:\nRepo: ${owner}/${rn}\nDesc: ${rd.description||'N/A'}\nStars: ${rd.stargazers_count} | Forks: ${rd.forks_count} | Issues: ${rd.open_issues_count}\nLanguages: ${lb}\nTopics: ${(rd.topics||[]).join(', ')||'none'}\nFiles: ~${totalFiles} | Size: ${(rd.size/1024).toFixed(1)}MB\nLicense: ${rd.license?.name||'None'}\n\nREADME:\n${readme||'None'}\n\nFile Tree:\n${fileTree}\n\nKey Source Files:\n${kf.join('\n\n')||'N/A'}\n\nSections: ## What It Does | ## Tech Stack | ## Architecture | ## Key Files | ## Getting Started | ## Code Quality | ## Verdict`;
      let full = '';
      await this._ai.stream([{ role: 'user', content: prompt }], 'You are CodeLens AI analyzing a GitHub repo. Use markdown.', (chunk) => { full += chunk; this._panel.webview.postMessage({ type: 'githubAnalyzeChunk', chunk }); });
      this._panel.webview.postMessage({ type: 'githubAnalyzeDone', meta: { name: `${owner}/${rn}`, description: rd.description, stars: rd.stargazers_count, forks: rd.forks_count, issues: rd.open_issues_count, language: rd.language, url: `https://github.com/${owner}/${rn}`, license: rd.license?.name, topics: rd.topics||[], size: rd.size, totalFiles, allowForking: rd.allow_forking, isFork: rd.fork, visibility: rd.visibility, defaultBranch: rd.default_branch, cloneUrl: `https://github.com/${owner}/${rn}.git` } });
    } catch (e: unknown) { this._panel.webview.postMessage({ type: 'githubAnalyzeError', error: String(e) }); }
  }

  // ── Explain file (dashboard inline) ──────────────────────────────────────
  private async explainFileInDashboard(relPath: string) {
    const rootPath = getWorkspaceRoot(); if (!rootPath) { return; }
    const content = readFileSafe(path.join(rootPath, relPath), 30000);
    const imports = content.match(/(?:import|require)\s*.*?['"]([^'"]+)['"]/g)?.slice(0, 10).join('\n') ?? 'none';
    this._panel.webview.postMessage({ type: 'explainStart', file: relPath });
    try {
      const explanation = await this._ai.ask(`Explain this file:\n\nFile: ${relPath}\nImports:\n${imports}\n\nContents:\n${content}`, `You are CodeLens AI. Format:\n**Summary:** one sentence.\n**What it does:**\n- bullets\n**Dependencies:** imports.\n**Used by:** dependents.\n**Notes:** gotchas.`);
      this._panel.webview.postMessage({ type: 'explainResult', file: relPath, explanation });
    } catch (e: unknown) { this._panel.webview.postMessage({ type: 'explainError', file: relPath, error: String(e) }); }
  }

  // ── Architecture Diagram ──────────────────────────────────────────────────
  private async generateArchDiagram() {
    const rootPath = getWorkspaceRoot(); if (!rootPath) { return; }
    const stack = detectTechStack(rootPath).join(', ');
    const tree = buildFileTree(rootPath);
    this._panel.webview.postMessage({ type: 'archDiagramStart' });
    try {
      const result = await this._ai.ask(`Project Stack: ${stack}\nFile Tree:\n${tree}`, `You are a Senior Software Architect. Output ONLY a raw JSON object (no markdown, no backticks, no explanation text). Start with { end with }.\nChoose 2-6 layers based on the actual project. Use real filenames.\nFormat: {"title":"...","layers":[{"name":"...","color":"#hexcolor","nodes":["real/file.ext"]}],"connections":[{"from":"file.ext","to":"other.ext","label":"imports"}]}\nGood colors: #ff6b6b #f0c030 #4caf50 #00acd7 #5ba3f5 #ab77f7`, 4096);
      let parsed = null; let parseError = '';
      try { const t = result.trim(); if (t.startsWith('{')) { parsed = JSON.parse(t); } } catch { /* */ }
      if (!parsed) { try { const mx = result.match(/\{[\s\S]*\}/); if (mx) { parsed = JSON.parse(mx[0].replace(/,(\s*[}\]])/g, '$1').replace(/[\u0000-\u001F]/g, ' ')); } else { parseError = 'No JSON found.'; } } catch (e2) { parseError = String(e2).slice(0, 100); } }
      this._panel.webview.postMessage({ type: 'archDiagramResult', data: parsed, parseError: parsed ? null : (parseError || 'Parse failed — try again.') });
    } catch (e: unknown) { this._panel.webview.postMessage({ type: 'archDiagramError', error: String(e) }); }
  }

  // ── Chat ──────────────────────────────────────────────────────────────────
  private async handleChat(text: string) {
    this._messages.push({ role: 'user', content: text });
    const rootPath = getWorkspaceRoot();
    const stack = rootPath ? detectTechStack(rootPath).join(', ') : 'unknown';
    const tree = rootPath ? buildFileTree(rootPath) : '';
    this._panel.webview.postMessage({ type: 'chatStreamStart' });
    let full = '';
    try {
      await this._ai.stream(this._messages, `You are CodeLens AI.\nStack: ${stack}\nTree:\n${tree}`, (chunk) => { full += chunk; this._panel.webview.postMessage({ type: 'chatChunk', chunk }); });
      this._messages.push({ role: 'assistant', content: full });
      this._panel.webview.postMessage({ type: 'chatStreamEnd' });
    } catch (e: unknown) { this._panel.webview.postMessage({ type: 'chatError', error: String(e) }); }
  }

  // ── HTML ──────────────────────────────────────────────────────────────────
  private getShellHtml(): string {
    const css = [
      '@import url(\'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Syne:wght@400;600;700;800&display=swap\');',
      '*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}',
      ':root{--bg:#0d0f14;--surface:#13161e;--surface2:#1a1e29;--border:#252a38;--accent:#6c63ff;--accent2:#00d4aa;--accent3:#ff6b6b;--text:#e2e4ed;--muted:#6b7280;--mono:\'JetBrains Mono\',monospace;--sans:\'Syne\',sans-serif;}',
      'html,body{height:100%;background:var(--bg);color:var(--text);font-family:var(--sans);overflow:hidden}',
      '#app{display:grid;grid-template-rows:52px 1fr;height:100vh}',
      '#topbar{display:flex;align-items:center;gap:12px;background:var(--surface);border-bottom:1px solid var(--border);padding:0 20px}',
      '#logo{font-size:15px;font-weight:800;letter-spacing:-.5px;white-space:nowrap}#logo span{color:var(--accent)}',
      '#provider-pill{font-family:var(--mono);font-size:11px;background:var(--surface2);border:1px solid var(--border);padding:3px 10px;border-radius:20px;color:var(--muted);cursor:pointer;transition:border-color .2s,color .2s;white-space:nowrap}',
      '#provider-pill:hover{border-color:var(--accent);color:var(--text)}#provider-pill b{color:var(--accent2);font-weight:500}',
      '.spacer{flex:1}',
      '.top-action{font-family:var(--mono);font-size:11px;padding:5px 14px;background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:6px;cursor:pointer;transition:all .15s;white-space:nowrap}',
      '.top-action:hover{border-color:var(--accent);color:var(--text);background:rgba(108,99,255,.08)}.top-action.primary{border-color:var(--accent);color:var(--accent)}',
      '#main{display:grid;grid-template-columns:220px 1fr 340px;overflow:hidden}',
      '#sidebar{background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden}',
      '#sidebar-header{padding:14px 16px 10px;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border)}',
      '#file-search{margin:8px;padding:6px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:var(--mono);font-size:11px;outline:none;transition:border-color .2s}',
      '#file-search:focus{border-color:var(--accent)}#file-search::placeholder{color:var(--muted)}',
      '#file-list{flex:1;overflow-y:auto;padding:0 6px 12px}',
      '.file-item{display:flex;align-items:center;gap:7px;padding:5px 8px;border-radius:5px;cursor:pointer;font-family:var(--mono);font-size:11px;color:var(--muted);transition:background .12s,color .12s;white-space:nowrap;overflow:hidden}',
      '.file-item:hover{background:var(--surface2);color:var(--text)}.file-item.active{background:rgba(108,99,255,.15);color:var(--accent)}',
      '.file-ext{font-size:9px;padding:1px 5px;border-radius:3px;font-weight:600;flex-shrink:0;text-transform:uppercase}',
      '.ext-ts,.ext-tsx{background:#1a3a5c;color:#5ba3f5}.ext-js,.ext-jsx{background:#3a2e00;color:#f0c030}.ext-py{background:#1a3a1a;color:#4caf50}',
      '.ext-css,.ext-scss{background:#2a1a3a;color:#ab77f7}.ext-html{background:#3a1a1a;color:#f07070}.ext-json{background:#1a2a2a;color:#4db6ac}',
      '.ext-md{background:#1a2a3a;color:#60a0c0}.ext-other{background:var(--surface2);color:var(--muted)}',
      '#centre{display:flex;flex-direction:column;overflow:hidden}',
      '#tabs{display:flex;align-items:flex-end;background:var(--surface);border-bottom:1px solid var(--border);padding:0 16px;gap:2px}',
      '.tab{padding:12px 18px 10px;font-size:12px;font-weight:600;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;transition:color .15s,border-color .15s;white-space:nowrap}',
      '.tab:hover{color:var(--text)}.tab.active{color:var(--text);border-bottom-color:var(--accent)}',
      '#tab-content{flex:1;overflow:hidden;position:relative}',
      '.tab-pane{position:absolute;inset:0;overflow:auto;display:none}.tab-pane.active{display:flex;flex-direction:column}',
      '.overview-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}',
      '.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:18px;transition:border-color .2s}.card:hover{border-color:#353a4d}',
      '.card-label{font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-bottom:12px}',
      '.stack-tags{display:flex;flex-wrap:wrap;gap:6px}',
      '.stack-tag{font-family:var(--mono);font-size:11px;background:rgba(108,99,255,.12);border:1px solid rgba(108,99,255,.25);color:#a89fff;padding:3px 10px;border-radius:20px}',
      '.stat-row{display:flex;gap:24px}.stat-num{font-size:28px;font-weight:800;color:var(--text);line-height:1}.stat-lbl{font-size:11px;color:var(--muted)}',
      '.file-tree-pre{font-family:var(--mono);font-size:11px;line-height:1.7;color:var(--muted);white-space:pre;overflow:auto;max-height:260px}',
      '.action-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}',
      '.action-card{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:14px;cursor:pointer;transition:all .15s;text-align:left;width:100%}',
      '.action-card:hover{border-color:var(--accent);background:rgba(108,99,255,.06);transform:translateY(-1px)}',
      '.action-card-icon{font-size:20px;margin-bottom:8px}.action-card-title{font-size:12px;font-weight:700;color:var(--text);margin-bottom:3px}',
      '.action-card-desc{font-size:11px;color:var(--muted);line-height:1.5}',
      // Graph
      '#pane-graph{padding:0}',
      '#graph-toolbar{display:flex;align-items:center;gap:10px;padding:10px 16px;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap}',
      '#graph-search{background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:11px;padding:6px 12px;border-radius:6px;outline:none;width:200px;transition:border-color .2s}',
      '#graph-search:focus{border-color:var(--accent)}#graph-search::placeholder{color:var(--muted)}',
      '#graph-stats{font-family:var(--mono);font-size:11px;color:var(--muted);flex:1}',
      '.graph-legend{display:flex;gap:14px;flex-wrap:wrap;align-items:center}',
      '.leg{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--muted)}.leg-dot{width:10px;height:10px;border-radius:50%}',
      '.graph-btn{font-family:var(--mono);font-size:10px;padding:5px 12px;background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:5px;cursor:pointer;transition:all .15s}',
      '.graph-btn:hover{border-color:var(--accent2);color:var(--accent2)}',
      '#graph-canvas{flex:1;cursor:grab;display:block;width:100%;min-height:0;background:radial-gradient(ellipse at 50% 40%,#0f1420 0%,var(--bg) 100%)}',
      '#graph-canvas:active{cursor:grabbing}',
      '#graph-tooltip{position:fixed;background:#1a1e29;border:1px solid var(--border);border-radius:10px;padding:12px 15px;font-size:11px;font-family:var(--mono);pointer-events:none;display:none;max-width:300px;z-index:999;box-shadow:0 12px 40px rgba(0,0,0,.6)}',
      '#graph-tooltip .tt-name{font-weight:700;color:var(--text);margin-bottom:6px;font-size:12px;word-break:break-all}',
      '#graph-tooltip .tt-row{color:var(--muted);line-height:1.8}.tt-hl{color:var(--accent2)}',
      '#graph-tooltip .tt-badge{display:inline-block;background:rgba(108,99,255,.15);border:1px solid rgba(108,99,255,.3);color:#a89fff;padding:1px 7px;border-radius:10px;font-size:10px;margin:2px 3px 2px 0}',
      // Arch
      '#pane-arch{padding:0}',
      '#arch-toolbar{display:flex;align-items:center;gap:8px;padding:10px 16px;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap}',
      '#arch-title-text{font-size:13px;font-weight:700;color:var(--text);flex:1}',
      '.arch-gen-btn{font-family:var(--mono);font-size:11px;padding:8px 18px;background:var(--accent);color:#fff;border:none;border-radius:7px;cursor:pointer;transition:background .15s;font-weight:600}',
      '.arch-gen-btn:hover{background:#8078ff}.arch-gen-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.arch-zoom-btn{font-family:var(--mono);font-size:14px;width:28px;height:28px;background:var(--surface2);border:1px solid var(--border);color:var(--muted);border-radius:5px;cursor:pointer;transition:all .15s;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}',
      '.arch-zoom-btn:hover{border-color:var(--accent2);color:var(--accent2)}',
      '#arch-loading{display:none;align-items:center;gap:10px;font-family:var(--mono);font-size:12px;color:var(--muted)}',
      '.pulse-dot{width:8px;height:8px;border-radius:50%;background:var(--accent2);animation:pulsedot 1.2s ease-in-out infinite}',
      '@keyframes pulsedot{0%,100%{opacity:.3;transform:scale(.8)}50%{opacity:1;transform:scale(1.2)}}',
      '#arch-body{flex:1;overflow:hidden;display:flex;flex-direction:column}',
      '#arch-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:14px;color:var(--muted);text-align:center}',
      '#arch-placeholder .big-icon{font-size:48px;opacity:.3}#arch-placeholder p{font-size:13px;line-height:1.7;max-width:340px}',
      '#arch-svg-wrap{flex:1;overflow:auto;padding:20px;display:none}',
      '#arch-svg-container{transform-origin:top left;display:inline-block;min-width:100%}',
      '#arch-fs-overlay{display:none;position:fixed;inset:0;background:var(--bg);z-index:9999;flex-direction:column}',
      '#arch-fs-toolbar{padding:10px 20px;background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-shrink:0}',
      '#arch-fs-body{flex:1;overflow:auto;padding:24px}',
      '#arch-fs-content{transform-origin:top left;display:inline-block;min-width:100%}',
      // GitHub
      '#pane-github{padding:0}',
      '#github-toolbar{display:flex;align-items:center;gap:10px;padding:14px 20px;background:var(--surface);border-bottom:1px solid var(--border);flex-shrink:0}',
      '#github-toolbar-title{font-size:13px;font-weight:700;color:var(--text);flex:1}',
      '#github-body{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:14px}',
      '#github-input-section{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:10px}',
      '#github-input-row{display:flex;gap:8px}',
      '#github-url-input{flex:1;background:var(--bg);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:12px;padding:10px 14px;border-radius:7px;outline:none;transition:border-color .2s}',
      '#github-url-input:focus{border-color:var(--accent)}#github-url-input::placeholder{color:var(--muted)}',
      '.gh-btn{font-family:var(--mono);font-size:11px;padding:10px 16px;border:none;border-radius:7px;cursor:pointer;transition:all .15s;font-weight:700;white-space:nowrap}',
      '.gh-btn.analyze{background:var(--accent);color:#fff}.gh-btn.analyze:hover{background:#8078ff}',
      '.gh-btn.clone{background:rgba(0,212,170,.12);border:1px solid rgba(0,212,170,.3);color:var(--accent2)}.gh-btn.clone:hover{background:rgba(0,212,170,.22)}',
      '.gh-btn:disabled{opacity:.5;cursor:not-allowed}',
      '#github-examples{display:flex;flex-wrap:wrap;gap:6px}',
      '.gh-example{font-family:var(--mono);font-size:10px;padding:4px 10px;background:var(--surface);border:1px solid var(--border);color:var(--muted);border-radius:5px;cursor:pointer;transition:all .15s}',
      '.gh-example:hover{border-color:var(--accent2);color:var(--accent2)}',
      '#github-result{display:none;flex-direction:column;gap:14px}',
      '#github-repo-header{background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:20px;display:flex;flex-direction:column;gap:12px}',
      '.gh-repo-title{font-size:16px;font-weight:800}.gh-repo-title a{color:var(--accent2);text-decoration:none}.gh-repo-title a:hover{text-decoration:underline}',
      '.gh-repo-desc{font-size:13px;color:var(--muted);line-height:1.6}',
      '.gh-stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:10px}',
      '.gh-stat-card{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 14px;text-align:center}',
      '.gh-stat-card .val{font-size:18px;font-weight:800;color:var(--text);font-family:var(--mono)}.gh-stat-card .lbl{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-top:2px}',
      '.gh-topics{display:flex;flex-wrap:wrap;gap:6px}',
      '.gh-topic{font-family:var(--mono);font-size:10px;padding:3px 10px;background:rgba(108,99,255,.12);border:1px solid rgba(108,99,255,.25);color:#a89fff;border-radius:20px}',
      '.gh-actions-row{display:flex;gap:8px;flex-wrap:wrap}',
      '.gh-action-btn{font-family:var(--mono);font-size:11px;padding:8px 14px;border-radius:7px;cursor:pointer;transition:all .15s;text-decoration:none;display:inline-flex;align-items:center;gap:6px;font-weight:600;border:none}',
      '.gh-action-btn.primary{background:var(--accent);color:#fff}.gh-action-btn.primary:hover{background:#8078ff}',
      '.gh-action-btn.secondary{background:var(--surface);border:1px solid var(--border);color:var(--muted)}.gh-action-btn.secondary:hover{border-color:var(--accent2);color:var(--accent2)}',
      '.gh-action-btn.green{background:rgba(0,212,170,.12);border:1px solid rgba(0,212,170,.3);color:var(--accent2)}.gh-action-btn.green:hover{background:rgba(0,212,170,.2)}',
      '#github-analysis-content{background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:20px;font-size:13px;line-height:1.85}',
      '#github-loading{display:none;flex-direction:column;align-items:center;gap:14px;padding:50px 0;color:var(--muted);font-family:var(--mono);font-size:12px}',
      '.gh-spinner{width:28px;height:28px;border:2.5px solid var(--border);border-top-color:var(--accent2);border-radius:50%;animation:spin .7s linear infinite}',
      '@keyframes spin{to{transform:rotate(360deg)}}',
      '#github-error{display:none;background:rgba(255,107,107,.08);border:1px solid rgba(255,107,107,.3);border-radius:8px;padding:16px;color:var(--accent3);font-size:12px;font-family:var(--mono)}',
      '#clone-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9998;align-items:center;justify-content:center}',
      '#clone-modal{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:30px;min-width:320px;max-width:460px;display:flex;flex-direction:column;gap:16px;box-shadow:0 24px 80px rgba(0,0,0,.5)}',
      '#clone-modal h3{font-size:15px;font-weight:800;color:var(--text)}.clone-msg{font-family:var(--mono);font-size:12px;color:var(--muted);line-height:1.7}',
      '.clone-bar{height:4px;border-radius:2px;background:var(--border);overflow:hidden}.clone-bar-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));animation:fillbar 2s ease-in-out infinite alternate}',
      '@keyframes fillbar{0%{width:20%}100%{width:90%}}',
      // Explain
      '#explain-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:12px;color:var(--muted);text-align:center}',
      '#explain-placeholder .hint-icon{font-size:40px;opacity:.4}#explain-placeholder p{font-size:13px;line-height:1.7;max-width:300px}',
      '#explain-content{display:none;flex-direction:column;gap:0;flex:1;overflow:hidden}',
      '#explain-file-header{display:flex;align-items:center;gap:10px;padding:0 0 16px;border-bottom:1px solid var(--border);margin-bottom:20px;flex-shrink:0}',
      '#explain-file-name{font-family:var(--mono);font-size:13px;font-weight:500;color:var(--accent2);flex:1}',
      '.explain-reload{font-family:var(--mono);font-size:10px;padding:4px 10px;background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:5px;cursor:pointer;transition:all .15s}',
      '.explain-reload:hover{border-color:var(--accent2);color:var(--accent2)}',
      '#explain-body{font-size:13px;line-height:1.85;color:var(--text);flex:1;overflow-y:auto}',
      // Markdown
      '.md-content h1,.md-content h2,.md-content h3{color:var(--text);font-weight:700;margin:14px 0 7px}',
      '.md-content h1{font-size:16px}.md-content h2{font-size:14px;border-bottom:1px solid var(--border);padding-bottom:6px}.md-content h3{font-size:13px;color:var(--accent2)}',
      '.md-content p{margin:0 0 10px;color:var(--text);line-height:1.75}',
      '.md-content strong,.md-content b{color:var(--accent2);font-weight:600}.md-content em{color:#c4b5fd;font-style:italic}',
      '.md-content ul,.md-content ol{padding-left:20px;margin:4px 0 12px}.md-content li{margin:4px 0;font-size:12px;line-height:1.7;color:var(--text)}',
      '.md-content code{font-family:var(--mono);font-size:11px;background:rgba(108,99,255,.1);border:1px solid rgba(108,99,255,.2);padding:1px 6px;border-radius:4px;color:#c4b5fd}',
      '.md-content pre{font-family:var(--mono);font-size:11px;background:var(--surface2);border:1px solid var(--border);padding:12px 14px;border-radius:8px;overflow-x:auto;margin:10px 0;color:#e2b96a;line-height:1.6}',
      '.md-content blockquote{border-left:3px solid var(--accent);padding:6px 12px;color:var(--muted);margin:8px 0;background:rgba(108,99,255,.04);border-radius:0 6px 6px 0}',
      '.md-content hr{border:none;border-top:1px solid var(--border);margin:14px 0}',
      '.skeleton{background:linear-gradient(90deg,var(--surface2) 25%,var(--border) 50%,var(--surface2) 75%);background-size:200% 100%;animation:shimmer 1.4s infinite;border-radius:4px;height:14px;margin-bottom:10px}',
      '@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}',
      // Chat
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
      '.msg{display:flex;flex-direction:column;gap:4px}.msg-who{font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase}',
      '.msg-you .msg-who{color:var(--accent)}.msg-ai .msg-who{color:var(--accent2)}',
      '.msg-bubble{font-size:12px;line-height:1.75;padding:10px 12px;border-radius:8px;word-break:break-word}',
      '.msg-you .msg-bubble{background:rgba(108,99,255,.1);border:1px solid rgba(108,99,255,.2);color:var(--text);white-space:pre-wrap}',
      '.msg-ai .msg-bubble{background:var(--surface2);border:1px solid var(--border)}',
      '.cursor-blink{display:inline-block;width:7px;height:13px;background:var(--accent2);animation:blink .7s step-end infinite;vertical-align:text-bottom;border-radius:1px;margin-left:2px}',
      '@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}',
      '#chat-input-row{padding:10px 12px;border-top:1px solid var(--border);display:flex;gap:6px}',
      '#chat-input{flex:1;background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:12px;padding:8px 10px;border-radius:7px;resize:none;outline:none;min-height:36px;max-height:100px;transition:border-color .2s;line-height:1.5}',
      '#chat-input:focus{border-color:var(--accent)}#chat-input::placeholder{color:var(--muted)}',
      '#chat-send{background:var(--accent);color:#fff;border:none;padding:0 14px;border-radius:7px;font-size:16px;cursor:pointer;transition:background .15s;align-self:flex-end;height:36px}',
      '#chat-send:hover{background:#8078ff}#chat-send:disabled{opacity:.4;cursor:not-allowed}',
      '::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:transparent}',
      '::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}::-webkit-scrollbar-thumb:hover{background:#353a4d}',
    ].join('\n');

    const js = [
      'var _vsc=acquireVsCodeApi();',
      'window.addEventListener("load",function(){_vsc.postMessage({type:"ready"});});',
      'function vscPost(t,v){if(t==="runCommand"){_vsc.postMessage({type:t,command:v});}else if(t==="explainFile"){_vsc.postMessage({type:t,file:v});}else if(t==="analyzeGithub"){_vsc.postMessage({type:t,url:v});}else{_vsc.postMessage({type:t});}}',
      '',
      '// ── Markdown ──────────────────────────────────────────────',
      'var BT1=String.fromCharCode(96);var BT3=BT1+BT1+BT1;',
      'function escHtml(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}',
      'function esc(s){return escHtml(s).replace(/"/g,"&quot;").replace(/\'/g,"&#39;");}',
      'function renderMarkdown(raw){',
      '  if(!raw){return"";}',
      '  var text=escHtml(raw).split("\\r\\n").join("\\n");',
      '  var fp=text.split(BT3);var st="";',
      '  for(var fi=0;fi<fp.length;fi++){if(fi%2===0){st+=fp[fi];}else{var cl=fp[fi].split("\\n");cl.shift();st+="<pre>"+cl.join("\\n").trim()+"</pre>";}}',
      '  var ip=st.split(BT1);st="";',
      '  for(var ii=0;ii<ip.length;ii++){st+=(ii%2===0)?ip[ii]:("<code>"+ip[ii]+"</code>");}',
      '  var lines=st.split("\\n");var html="";var inL=false;',
      '  for(var li=0;li<lines.length;li++){var t=lines[li].trim();',
      '    if(!t){if(inL){html+="</ul>";inL=false;}continue;}',
      '    if(t.indexOf("<pre>")===0){if(inL){html+="</ul>";inL=false;}html+=t;continue;}',
      '    if(t==="---"){if(inL){html+="</ul>";inL=false;}html+="<hr>";continue;}',
      '    if(t.indexOf("### ")===0){if(inL){html+="</ul>";inL=false;}html+="<h3>"+t.slice(4)+"</h3>";continue;}',
      '    if(t.indexOf("## ")===0){if(inL){html+="</ul>";inL=false;}html+="<h2>"+t.slice(3)+"</h2>";continue;}',
      '    if(t.indexOf("# ")===0){if(inL){html+="</ul>";inL=false;}html+="<h1>"+t.slice(2)+"</h1>";continue;}',
      '    if(t.indexOf("&gt; ")===0){if(inL){html+="</ul>";inL=false;}html+="<blockquote>"+t.slice(5)+"</blockquote>";continue;}',
      '    if(t.indexOf("- ")===0||t.indexOf("* ")===0){if(!inL){html+="<ul>";inL=true;}html+="<li>"+t.slice(2)+"</li>";continue;}',
      '    var di=t.indexOf(". ");if(di>0&&/^[0-9]+$/.test(t.slice(0,di))){if(!inL){html+="<ul>";inL=true;}html+="<li>"+t.slice(di+2)+"</li>";continue;}',
      '    if(inL){html+="</ul>";inL=false;}html+="<p>"+t+"</p>";',
      '  }',
      '  if(inL){html+="</ul>";}',
      '  html=html.replace(/\\*\\*([^*\\n]+)\\*\\*/g,"<strong>$1</strong>");',
      '  html=html.replace(/\\*([^*\\n]+)\\*/g,"<em>$1</em>");',
      '  return html;',
      '}',
      '',
      '// ── Tabs ──────────────────────────────────────────────────',
      'var activeTab="overview";var TAB_NAMES=["overview","graph","arch","explain","github"];',
      'function switchTab(name){',
      '  activeTab=name;',
      '  var tabs=document.querySelectorAll(".tab");',
      '  for(var ti=0;ti<tabs.length;ti++){tabs[ti].classList.toggle("active",TAB_NAMES[ti]===name);}',
      '  var panes=document.querySelectorAll(".tab-pane");',
      '  for(var pi=0;pi<panes.length;pi++){panes[pi].classList.remove("active");}',
      '  document.getElementById("pane-"+name).classList.add("active");',
      '  // KEY: trigger graph resize+init when graph tab becomes visible',
      '  if(name==="graph"){',
      '    setTimeout(function(){',
      '      gResize();',
      '      if(!gReady&&graphData.nodes.length>0){gInitPos();}',
      '    },60);',
      '  }',
      '}',
      '',
      '// ── Sidebar ──────────────────────────────────────────────',
      'var allFiles=[],activeFile=null;',
      'function renderFiles(files){',
      '  var list=document.getElementById("file-list");',
      '  if(!files.length){list.innerHTML="<div style=\\"padding:16px;font-size:11px;color:var(--muted)\\">No files found</div>";return;}',
      '  var html="";',
      '  for(var i=0;i<files.length;i++){var f=files[i],ext=f.ext||"other";',
      '    html+="<div class=\\"file-item"+(activeFile===f.rel?" active":"")+"\\" onclick=\\"selectFile(\'"+esc(f.rel)+"\')\\" title=\\""+esc(f.rel)+"\\">"',
      '      +"<span class=\\"file-ext ext-"+ext+"\\">"+(ext||"?")+"</span>"',
      '      +"<span style=\\"overflow:hidden;text-overflow:ellipsis\\">"+esc(f.name)+"</span></div>";',
      '  }',
      '  list.innerHTML=html;',
      '}',
      'function filterFiles(q){var f=q.toLowerCase();renderFiles(f?allFiles.filter(function(x){return x.rel.toLowerCase().indexOf(f)!==-1;}):allFiles);}',
      'function selectFile(rel){',
      '  activeFile=rel;renderFiles(allFiles);switchTab("explain");',
      '  _vsc.postMessage({type:"explainFile",file:rel});',
      '  document.getElementById("explain-placeholder").style.display="none";',
      '  document.getElementById("explain-content").style.display="flex";',
      '  document.getElementById("explain-file-name").textContent=rel;',
      '  document.getElementById("explain-reload-btn").onclick=function(){_vsc.postMessage({type:"explainFile",file:rel});};',
      '  var skels="";var ws=["60%","80%","45%","70%","55%"];',
      '  for(var i=0;i<ws.length;i++){skels+="<div class=\\"skeleton\\" style=\\"width:"+ws[i]+";margin-bottom:12px\\"></div>";}',
      '  document.getElementById("explain-body").innerHTML=skels;',
      '}',
      '',
      // ── DEPENDENCY GRAPH (full section, all vars prefixed g to avoid collision) ──
      'var graphData={nodes:[],edges:[]};',
      'var graphFilter="",selNode=null;',
      'var gpanX=0,gpanY=0,gzoom=1;',
      'var gDrag=null,gIsPan=false,gPanStart=null,gReady=false,gSimTick=0;',
      'var gCanvas=document.getElementById("graph-canvas");',
      'var gCtx=gCanvas.getContext("2d");',
      'var gTip=document.getElementById("graph-tooltip");',
      'var GEC={ts:"#5ba3f5",tsx:"#5ba3f5",js:"#f0c030",jsx:"#f0c030",py:"#4caf50",go:"#00acd7",rs:"#f46623",css:"#ab77f7",scss:"#ab77f7",html:"#f07070",json:"#4db6ac",md:"#60a0c0"};',
      'function gR(n){return Math.max(5,Math.min(14,5+(n._deg||0)*.9));}',
      'function gCol(n){if(n.id===selNode){return"#00d4aa";}return(n._deg||0)>0?(GEC[n.ext]||"#6c63ff"):"#3a3f50";}',
      '',
      '// KEY FIX: spread nodes to Fibonacci positions BEFORE first simulate',
      'function gInitPos(){',
      '  if(gCanvas.width<10||gCanvas.height<10){return false;}',
      '  gReady=true;gSimTick=0;',
      '  var W=gCanvas.width,H=gCanvas.height,cx=W/2,cy=H/2;',
      '  var n=graphData.nodes.length;if(!n){return true;}',
      '  var sorted=graphData.nodes.slice().sort(function(a,b){return(b._deg||0)-(a._deg||0);});',
      '  var golden=Math.PI*(3-Math.sqrt(5));',
      '  for(var i=0;i<sorted.length;i++){',
      '    var nd=sorted[i];',
      '    var hub=Math.min((nd._deg||0)/Math.max(sorted[0]._deg||1,1),1);',
      '    var maxR=Math.min(cx,cy)*.80;',
      '    var r=maxR*(.18+.82*(1-hub*.65));',
      '    var angle=i*golden;',
      '    nd.x=cx+Math.cos(angle)*r;',
      '    nd.y=cy+Math.sin(angle)*r;',
      '    nd.vx=0;nd.vy=0;nd.fixed=false;',
      '  }',
      '  return true;',
      '}',
      '',
      'function gResize(){',
      '  var pane=document.getElementById("pane-graph");',
      '  var tb=document.getElementById("graph-toolbar");',
      '  var W=pane.clientWidth,H=pane.clientHeight-tb.offsetHeight;',
      '  if(W>10&&H>10){gCanvas.width=W;gCanvas.height=H;}',
      '  if(!gReady&&gCanvas.width>10){gInitPos();}',
      '}',
      '',
      'function gResetView(){',
      '  gpanX=0;gpanY=0;gzoom=1;selNode=null;gReady=false;',
      '  for(var i=0;i<graphData.nodes.length;i++){graphData.nodes[i].x=0;graphData.nodes[i].y=0;graphData.nodes[i].vx=0;graphData.nodes[i].vy=0;graphData.nodes[i].fixed=false;}',
      '  setTimeout(function(){gResize();if(!gReady){gInitPos();}},30);',
      '}',
      '',
      'function gFilterFn(q){graphFilter=q.toLowerCase();}',
      '',
      'function gSimulate(){',
      '  if(!gReady||gSimTick>800){return;}',
      '  var W=gCanvas.width,H=gCanvas.height;',
      '  var k=Math.sqrt((W*H)/Math.max(graphData.nodes.length,1))*1.2;',
      '  var i,j,n;',
      '  for(i=0;i<graphData.nodes.length;i++){graphData.nodes[i].vx=0;graphData.nodes[i].vy=0;}',
      '  for(i=0;i<graphData.nodes.length;i++){',
      '    for(j=i+1;j<graphData.nodes.length;j++){',
      '      var a=graphData.nodes[i],b=graphData.nodes[j];',
      '      var dx=b.x-a.x,dy=b.y-a.y;',
      '      if(Math.abs(dx)<0.5&&Math.abs(dy)<0.5){dx=.5-Math.random();dy=.5-Math.random();}',
      '      var d=Math.sqrt(dx*dx+dy*dy);',
      '      var minD=gR(a)+gR(b)+22;',
      '      var rep=Math.min(k*k/(d||1),k*3);',
      '      if(d<minD){rep=Math.min(k*k/minD*4,k*5);}',
      '      var ux=dx/(d||1),uy=dy/(d||1);',
      '      a.vx-=ux*rep;a.vy-=uy*rep;b.vx+=ux*rep;b.vy+=uy*rep;',
      '    }',
      '  }',
      '  for(var ei=0;ei<graphData.edges.length;ei++){',
      '    var e=graphData.edges[ei],na=null,nb=null;',
      '    for(i=0;i<graphData.nodes.length;i++){if(graphData.nodes[i].id===e.from){na=graphData.nodes[i];}if(graphData.nodes[i].id===e.to){nb=graphData.nodes[i];}}',
      '    if(!na||!nb){continue;}',
      '    var exd=nb.x-na.x,eyd=nb.y-na.y,ed=Math.sqrt(exd*exd+eyd*eyd)||1;',
      '    var ideal=90+gR(na)+gR(nb);var ef=(ed-ideal)/ed*.1;',
      '    na.vx+=exd*ef;na.vy+=eyd*ef;nb.vx-=exd*ef;nb.vy-=eyd*ef;',
      '  }',
      '  var cx=W/2,cy=H/2;',
      '  for(i=0;i<graphData.nodes.length;i++){',
      '    n=graphData.nodes[i];if(n.fixed){continue;}',
      '    n.vx+=(cx-n.x)*.0025;n.vy+=(cy-n.y)*.0025;',
      '    n.vx*=.85;n.vy*=.85;n.x+=n.vx;n.y+=n.vy;',
      '    var pad=gR(n)+3;n.x=Math.max(pad,Math.min(W-pad,n.x));n.y=Math.max(pad,Math.min(H-pad,n.y));',
      '  }',
      '  gSimTick++;',
      '}',
      '',
      'function gFindN(id){for(var i=0;i<graphData.nodes.length;i++){if(graphData.nodes[i].id===id){return graphData.nodes[i];}}return null;}',
      '',
      'function gDraw(){',
      '  gCtx.clearRect(0,0,gCanvas.width,gCanvas.height);',
      '  if(!gReady||!graphData.nodes.length){gCtx.fillStyle="#6b7280";gCtx.font="13px Syne,sans-serif";gCtx.textAlign="center";gCtx.fillText(graphData.nodes.length?"Initialising…":"No files found",gCanvas.width/2,gCanvas.height/2);return;}',
      '  gCtx.save();gCtx.translate(gpanX,gpanY);gCtx.scale(gzoom,gzoom);',
      '  var vis=[];for(var ni=0;ni<graphData.nodes.length;ni++){var n=graphData.nodes[ni];if(!graphFilter||n.id.toLowerCase().indexOf(graphFilter)!==-1){vis.push(n);}}',
      '  var vs={};for(var vi=0;vi<vis.length;vi++){vs[vis[vi].id]=true;}',
      '  var sc={};if(selNode){for(var ei=0;ei<graphData.edges.length;ei++){var se=graphData.edges[ei];if(se.from===selNode){sc[se.to]="out";}else if(se.to===selNode){sc[se.from]="in";}}}',
      // edges
      '  for(var ei=0;ei<graphData.edges.length;ei++){',
      '    var e=graphData.edges[ei];if(!vs[e.from]||!vs[e.to]){continue;}',
      '    var na=gFindN(e.from),nb=gFindN(e.to);if(!na||!nb){continue;}',
      '    var hl=selNode&&(e.from===selNode||e.to===selNode);',
      '    var dim=selNode&&!hl;',
      '    var ang=Math.atan2(nb.y-na.y,nb.x-na.x);',
      '    var rA=gR(na),rB=gR(nb);',
      '    var sx=na.x+Math.cos(ang)*rA,sy=na.y+Math.sin(ang)*rA;',
      '    var ex=nb.x-Math.cos(ang)*(rB+5),ey=nb.y-Math.sin(ang)*(rB+5);',
      '    if(hl){var g=gCtx.createLinearGradient(sx,sy,ex,ey);if(e.from===selNode){g.addColorStop(0,"rgba(108,99,255,.95)");g.addColorStop(1,"rgba(0,212,170,.95)");}else{g.addColorStop(0,"rgba(0,212,170,.65)");g.addColorStop(1,"rgba(108,99,255,.95)");}gCtx.beginPath();gCtx.moveTo(sx,sy);gCtx.lineTo(ex,ey);gCtx.strokeStyle=g;gCtx.lineWidth=2.5/gzoom;gCtx.globalAlpha=1;gCtx.stroke();gCtx.beginPath();gCtx.moveTo(ex,ey);gCtx.lineTo(ex-Math.cos(ang-.38)*9/gzoom,ey-Math.sin(ang-.38)*9/gzoom);gCtx.lineTo(ex-Math.cos(ang+.38)*9/gzoom,ey-Math.sin(ang+.38)*9/gzoom);gCtx.closePath();gCtx.fillStyle=e.from===selNode?"#00d4aa":"#6c63ff";gCtx.fill();}',
      '    else{gCtx.beginPath();gCtx.moveTo(sx,sy);gCtx.lineTo(ex,ey);gCtx.strokeStyle=dim?"rgba(255,255,255,.03)":"rgba(255,255,255,.1)";gCtx.lineWidth=.9/gzoom;gCtx.globalAlpha=1;gCtx.stroke();}',
      '  }',
      // nodes
      '  for(var vi=0;vi<vis.length;vi++){',
      '    var nv=vis[vi];var sel=nv.id===selNode;var dimN=selNode&&!sel&&!sc[nv.id];',
      '    var r=gR(nv);var col=gCol(nv);',
      '    gCtx.globalAlpha=dimN?.12:1;',
      '    if(sel){gCtx.beginPath();gCtx.arc(nv.x,nv.y,r+10,0,Math.PI*2);gCtx.fillStyle="rgba(0,212,170,.07)";gCtx.fill();gCtx.beginPath();gCtx.arc(nv.x,nv.y,r+5,0,Math.PI*2);gCtx.fillStyle="rgba(0,212,170,.18)";gCtx.fill();}else if((nv._deg||0)>4){gCtx.beginPath();gCtx.arc(nv.x,nv.y,r+6,0,Math.PI*2);gCtx.fillStyle=(GEC[nv.ext]||"#6c63ff")+"20";gCtx.fill();}',
      '    var gr=gCtx.createRadialGradient(nv.x-r*.3,nv.y-r*.3,r*.05,nv.x,nv.y,r*1.1);',
      '    if(sel){gr.addColorStop(0,"rgba(200,255,245,.97)");gr.addColorStop(.4,"rgba(0,212,170,.92)");gr.addColorStop(1,"rgba(0,80,60,.55)");}',
      '    else{var rc=parseInt(col.slice(1,3),16)||100;var gc2=parseInt(col.slice(3,5),16)||100;var bc=parseInt(col.slice(5,7),16)||100;gr.addColorStop(0,"rgba("+(rc+90)+","+(gc2+90)+","+(bc+90)+",.97)");gr.addColorStop(.4,"rgba("+rc+","+gc2+","+bc+",.88)");gr.addColorStop(1,"rgba("+(rc>>1)+","+(gc2>>1)+","+(bc>>1)+",.5)");}',
      '    gCtx.beginPath();gCtx.arc(nv.x,nv.y,r,0,Math.PI*2);gCtx.fillStyle=gr;gCtx.fill();',
      '    var sg=gCtx.createRadialGradient(nv.x-r*.35,nv.y-r*.35,0,nv.x,nv.y,r);sg.addColorStop(0,"rgba(255,255,255,.5)");sg.addColorStop(.3,"rgba(255,255,255,.1)");sg.addColorStop(1,"rgba(255,255,255,0)");gCtx.beginPath();gCtx.arc(nv.x,nv.y,r,0,Math.PI*2);gCtx.fillStyle=sg;gCtx.fill();',
      '    gCtx.beginPath();gCtx.ellipse(nv.x+r*.1,nv.y+r+2,r*.6,r*.16,0,0,Math.PI*2);gCtx.fillStyle="rgba(0,0,0,.2)";gCtx.fill();',
      '    if(gzoom>.4||sel||sc[nv.id]){var fs=Math.max(8,Math.min(11,10/gzoom));gCtx.font=(sel?"700 ":((nv._deg||0)>3?"600 ":""))+fs+"px JetBrains Mono,monospace";gCtx.textAlign="center";gCtx.fillStyle="rgba(13,15,20,.85)";gCtx.fillText(nv.label,nv.x+.5,nv.y+r+fs+2.5);gCtx.fillStyle=sel?"#00d4aa":(sc[nv.id]?"#e2e4ed":((nv._deg||0)>3?col:"#9ca3af"));gCtx.fillText(nv.label,nv.x,nv.y+r+fs+2);}',
      '    gCtx.globalAlpha=1;',
      '  }',
      '  gCtx.restore();',
      '  var ec=0;for(var ei=0;ei<graphData.edges.length;ei++){if(vs[graphData.edges[ei].from]&&vs[graphData.edges[ei].to]){ec++;}}',
      '  document.getElementById("graph-stats").textContent=vis.length+" files \\u00b7 "+ec+" imports";',
      '}',
      '',
      'function gNodeAt(mx,my){var wx=(mx-gpanX)/gzoom,wy=(my-gpanY)/gzoom;for(var i=graphData.nodes.length-1;i>=0;i--){var n=graphData.nodes[i],r=gR(n)+5;if((n.x-wx)*(n.x-wx)+(n.y-wy)*(n.y-wy)<r*r){return n;}}return null;}',
      '',
      'gCanvas.addEventListener("mousedown",function(e){var n=gNodeAt(e.offsetX,e.offsetY);if(n){gDrag=n;n.fixed=true;selNode=n.id;}else{selNode=null;gIsPan=true;gPanStart={x:e.offsetX-gpanX,y:e.offsetY-gpanY};}});',
      'gCanvas.addEventListener("mousemove",function(e){if(gDrag){gDrag.x=(e.offsetX-gpanX)/gzoom;gDrag.y=(e.offsetY-gpanY)/gzoom;}else if(gIsPan){gpanX=e.offsetX-gPanStart.x;gpanY=e.offsetY-gPanStart.y;}var n=gNodeAt(e.offsetX,e.offsetY);if(n){var deps=[],used=[];for(var i=0;i<graphData.edges.length;i++){if(graphData.edges[i].from===n.id){deps.push(graphData.edges[i].to.split("/").pop());}if(graphData.edges[i].to===n.id){used.push(graphData.edges[i].from.split("/").pop());}}gTip.style.display="block";gTip.style.left=(e.clientX+16)+"px";gTip.style.top=(e.clientY-12)+"px";var col=GEC[n.ext]||"#6c63ff";var dB=deps.slice(0,7).map(function(d){return"<span class=\'tt-badge\'>"+d+"</span>";}).join("");var uB=used.slice(0,7).map(function(d){return"<span class=\'tt-badge\'>"+d+"</span>";}).join("");gTip.innerHTML="<div class=\'tt-name\' style=\'color:"+col+"\'>"+n.id+"</div>"+"<div class=\'tt-row\'><span style=\'color:var(--muted)\'>Type: </span><span class=\'tt-hl\'>"+(n.ext||"?").toUpperCase()+"</span></div>"+"<div class=\'tt-row\'><span style=\'color:var(--muted)\'>Connections: </span><span class=\'tt-hl\'>"+(n._deg||0)+"</span></div>"+(deps.length?"<div style=\'margin-top:7px;color:var(--muted);font-size:10px\'>IMPORTS</div><div>"+dB+(deps.length>7?"…":"")+"</div>":"")+(used.length?"<div style=\'margin-top:7px;color:var(--muted);font-size:10px\'>USED BY</div><div>"+uB+(used.length>7?"…":"")+"</div>":"");gCanvas.style.cursor="pointer";}else{gTip.style.display="none";gCanvas.style.cursor=gIsPan?"grabbing":"grab";}});',
      'gCanvas.addEventListener("mouseup",function(){if(gDrag){gDrag.fixed=false;gDrag=null;}gIsPan=false;});',
      'gCanvas.addEventListener("dblclick",function(e){var n=gNodeAt(e.offsetX,e.offsetY);if(n){n.fixed=!n.fixed;}});',
      'gCanvas.addEventListener("wheel",function(e){e.preventDefault();var f=e.deltaY>0?.88:1.12;gpanX=e.offsetX-(e.offsetX-gpanX)*f;gpanY=e.offsetY-(e.offsetY-gpanY)*f;gzoom=Math.max(.05,Math.min(gzoom*f,10));},{passive:false});',
      'new ResizeObserver(function(){gResize();}).observe(document.getElementById("pane-graph"));',
      '',
      '// Main loop',
      'function loop(){gSimulate();if(activeTab==="graph"){gDraw();}requestAnimationFrame(loop);}',
      'loop();',
      '',
      // ── Architecture ──
      'var archScale=1;',
      'function generateArch(){document.getElementById("arch-gen-btn").disabled=true;document.getElementById("arch-loading").style.display="flex";document.getElementById("arch-placeholder").style.display="none";document.getElementById("arch-svg-wrap").style.display="none";_vsc.postMessage({type:"genArchDiagram"});}',
      'function archZoom(f){archScale=Math.max(.2,Math.min(archScale*f,5));document.getElementById("arch-svg-container").style.transform="scale("+archScale+")";}',
      'function archFit(){archScale=1;document.getElementById("arch-svg-container").style.transform="scale(1)";}',
      'function archFullscreen(){var src=document.getElementById("arch-svg-container").innerHTML;document.getElementById("arch-fs-content").innerHTML=src;document.getElementById("arch-fs-title").textContent=document.getElementById("arch-title-text").textContent;archFsScale=1;document.getElementById("arch-fs-content").style.transform="scale(1)";document.getElementById("arch-fs-scale-val").textContent="100%";document.getElementById("arch-fs-overlay").style.display="flex";}',
      'function closeArchFs(){document.getElementById("arch-fs-overlay").style.display="none";}',
      'var archFsScale=1;',
      'function archFsZoom(f){archFsScale=Math.max(.2,Math.min(archFsScale*f,5));document.getElementById("arch-fs-content").style.transform="scale("+archFsScale+")";document.getElementById("arch-fs-scale-val").textContent=Math.round(archFsScale*100)+"%";}',
      'function archFsFit(){archFsScale=1;document.getElementById("arch-fs-content").style.transform="scale(1)";document.getElementById("arch-fs-scale-val").textContent="100%";}',
      'document.addEventListener("keydown",function(e){if(e.key==="Escape"){closeArchFs();}});',
      '',
      'function renderArchDiagram(data){',
      '  document.getElementById("arch-loading").style.display="none";document.getElementById("arch-gen-btn").disabled=false;',
      '  if(!data){document.getElementById("arch-placeholder").style.display="flex";document.getElementById("arch-placeholder").querySelector("p").textContent="Could not parse. Try again.";return;}',
      '  document.getElementById("arch-title-text").textContent=data.title||"Architecture";',
      '  document.getElementById("arch-svg-wrap").style.display="block";',
      '  archScale=1;document.getElementById("arch-svg-container").style.transform="scale(1)";',
      '  var layers=data.layers||[],conns=data.connections||[];',
      '  var PAD=32,LH=28,NH=56,NG=14,LG=40,LPV=18,CAH=50;',
      '  var maxN=0;for(var li=0;li<layers.length;li++){if((layers[li].nodes||[]).length>maxN){maxN=(layers[li].nodes||[]).length;}}',
      '  var NMN=140,NMX=230;var svgW=Math.max(780,PAD*2+maxN*(NMX+NG)-NG+40);',
      '  var layerH=LH+NH+LPV*2;var totalH=PAD+layers.length*layerH+(layers.length-1)*(LG+CAH)+PAD;',
      '  var nodePos={};var layerYs=[];var currentY=PAD;',
      '  for(var li2=0;li2<layers.length;li2++){layerYs.push(currentY);var lnds=layers[li2].nodes||[],lc=lnds.length;var avail=svgW-PAD*2-40;var nw=Math.min(NMX,Math.max(NMN,Math.floor((avail-(lc-1)*NG)/Math.max(lc,1))));var tw=lc*nw+(lc-1)*NG,sx=(svgW-tw)/2;var ny=currentY+LH+LPV;for(var ni5=0;ni5<lnds.length;ni5++){var nx3=sx+ni5*(nw+NG);nodePos[lnds[ni5]]={cx:nx3+nw/2,cy:ny+NH/2,x:nx3,y:ny,w:nw,h:NH};}currentY+=layerH;if(li2<layers.length-1){currentY+=LG+CAH;}}',
      '  var svg=\'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 \'+svgW+\' \'+totalH+\'" width="\'+svgW+\'" style="font-family:JetBrains Mono,monospace;display:block">\';',
      '  svg+=\'<defs><filter id="blur2"><feGaussianBlur stdDeviation="3"/></filter><marker id="arr" markerWidth="10" markerHeight="10" refX="9" refY="3.5" orient="auto"><path d="M0,0 L0,7 L10,3.5 z" fill="rgba(255,255,255,0.35)"/></marker>\';',
      '  for(var li3=0;li3<layers.length;li3++){var lc3=layers[li3].color||"#6c63ff";svg+=\'<linearGradient id="lg\'+li3+\'" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:\'+lc3+\';stop-opacity:0.18"/><stop offset="100%" style="stop-color:\'+lc3+\';stop-opacity:0.08"/></linearGradient><linearGradient id="ng\'+li3+\'" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:\'+lc3+\';stop-opacity:0.32"/><stop offset="100%" style="stop-color:\'+lc3+\';stop-opacity:0.12"/></linearGradient>\';}',
      '  svg+=\'</defs>\';',
      '  for(var li4=0;li4<layers.length;li4++){var layer=layers[li4],ly=layerYs[li4],lcolor=layer.color||"#6c63ff";svg+=\'<rect x="\'+( PAD+4)+\'" y="\'+( ly+4)+\'" width="\'+( svgW-PAD*2)+\'" height="\'+layerH+\'" rx="14" fill="rgba(0,0,0,0.3)" filter="url(#blur2)"/><rect x="\'+PAD+\'" y="\'+ly+\'" width="\'+( svgW-PAD*2)+\'" height="\'+layerH+\'" rx="14" fill="url(#lg\'+li4+\')" stroke="\'+lcolor+\'" stroke-width="1.5" stroke-opacity="0.5"/><rect x="\'+PAD+\'" y="\'+( ly+14)+\'" width="4" height="\'+( layerH-28)+\'" rx="2" fill="\'+lcolor+\'" opacity="0.8"/><text x="\'+( PAD+20)+\'" y="\'+( ly+19)+\'" font-size="10" fill="\'+lcolor+\'" font-weight="800" letter-spacing="2.5" opacity="0.9">\'+(layer.name||"").toUpperCase()+"</text>";var lnds4=layer.nodes||[];for(var ni6=0;ni6<lnds4.length;ni6++){var pos=nodePos[lnds4[ni6]];if(!pos){continue;}var fullN=lnds4[ni6];var shortN=fullN.split("/").pop()||fullN;var folderN=fullN.indexOf("/")>-1?fullN.substring(0,fullN.lastIndexOf("/")).split("/").pop():"";svg+=\'<rect x="\'+( pos.x+3)+\'" y="\'+( pos.y+3)+\'" width="\'+pos.w+\'" height="\'+pos.h+\'" rx="10" fill="rgba(0,0,0,0.25)" filter="url(#blur2)"/><rect x="\'+pos.x+\'" y="\'+pos.y+\'" width="\'+pos.w+\'" height="\'+pos.h+\'" rx="10" fill="url(#ng\'+li4+\')" stroke="\'+lcolor+\'" stroke-width="1.5" stroke-opacity="0.7"/><rect x="\'+( pos.x+6)+\'" y="\'+( pos.y+1)+\'" width="\'+( pos.w-12)+\'" height="2" rx="1" fill="rgba(255,255,255,0.15)"/>\';var ix=pos.x+12,iy=pos.cy-10;svg+=\'<rect x="\'+ix+\'" y="\'+iy+\'" width="14" height="17" rx="2" fill="\'+lcolor+\'" opacity="0.25"/><polygon points="\'+( ix+9)+\',\'+iy+" "+( ix+14)+\',\'+( iy+5)+" "+( ix+14)+\',\'+iy+\'" fill="\'+lcolor+\'" opacity="0.5"/>\';if(folderN){svg+=\'<text x="\'+( pos.x+30)+\'" y="\'+( pos.cy-5)+\'" font-size="9" fill="\'+lcolor+\'" opacity="0.6" font-weight="500">\'+folderN+"/</text>";}svg+=\'<text x="\'+( pos.x+30)+\'" y="\'+( pos.cy+(folderN?9:3))+\'" font-size="12" fill="\'+lcolor+\'" font-weight="700" dominant-baseline="middle">\'+shortN+"</text>";}',
      '    if(li4<layers.length-1){var arrX=svgW/2,arrY1=ly+layerH+8,arrY2=arrY1+LG+CAH-16;svg+=\'<path d="M \'+arrX+\' \'+arrY1+\' C \'+arrX+\' \'+( arrY1+20)+\' \'+arrX+\' \'+( arrY2-20)+\' \'+arrX+\' \'+arrY2+\'" stroke="\'+lcolor+\'" stroke-width="1.5" fill="none" stroke-dasharray="6 4" opacity="0.5" marker-end="url(#arr)"/>\';var cLabel="calls";for(var cj=0;cj<conns.length;cj++){var cn=conns[cj];var fim=false,tin=false;for(var cli=0;cli<(layers[li4].nodes||[]).length;cli++){if(layers[li4].nodes[cli]===cn.from){fim=true;}}for(var nli=0;nli<(layers[li4+1].nodes||[]).length;nli++){if(layers[li4+1].nodes[nli]===cn.to){tin=true;}}if(fim&&tin&&cn.label){cLabel=cn.label;break;}}var arrMid=(arrY1+arrY2)/2;svg+=\'<rect x="\'+( arrX-30)+\'" y="\'+( arrMid-9)+\'" width="60" height="18" rx="9" fill="#1a1e29" stroke="rgba(255,255,255,0.1)" stroke-width="1" opacity="0.95"/><text x="\'+arrX+\'" y="\'+( arrMid+1)+\'" text-anchor="middle" font-size="9" fill="#6b7280" font-weight="600" letter-spacing="0.5">\'+cLabel+"</text>";}',
      '  }',
      '  svg+="</svg>";document.getElementById("arch-svg-container").innerHTML=svg;',
      '}',
      '',
      // ── GitHub ──
      'var ghStreaming=false,ghStreamText="";',
      'function setGhUrl(url){document.getElementById("github-url-input").value=url;}',
      'function doAnalyzeGithub(){var url=document.getElementById("github-url-input").value.trim();if(!url||ghStreaming){return;}ghStreaming=true;ghStreamText="";document.getElementById("github-error").style.display="none";document.getElementById("github-result").style.display="none";document.getElementById("github-loading").style.display="flex";document.getElementById("github-analyze-btn").disabled=true;document.getElementById("github-clone-btn").disabled=true;_vsc.postMessage({type:"analyzeGithub",url:url});}',
      'function doCloneAndAnalyze(){var url=document.getElementById("github-url-input").value.trim();if(!url){return;}showCloneModal("Preparing...");_vsc.postMessage({type:"cloneAndAnalyze",url:url});}',
      'function showCloneModal(msg){document.getElementById("clone-overlay").style.display="flex";document.getElementById("clone-modal-msg").textContent=msg;}',
      'function hideCloneModal(){document.getElementById("clone-overlay").style.display="none";}',
      '',
      // ── Chat ──
      'var chatStreaming=false,streamBubble=null,streamText="";',
      'function sendChat(text){document.getElementById("chat-input").value=text;doSendChat();}',
      'function doSendChat(){var inp=document.getElementById("chat-input"),text=inp.value.trim();if(!text||chatStreaming){return;}inp.value="";inp.style.height="auto";addChatMsg("you",text);document.getElementById("chat-send").disabled=true;chatStreaming=true;streamText="";_vsc.postMessage({type:"chat",text:text});}',
      'function addChatMsg(who,text){var el=document.getElementById("chat-messages");var empty=el.querySelector(".chat-empty");if(empty){empty.remove();}var div=document.createElement("div");div.className="msg msg-"+(who==="you"?"you":"ai");var bubble=document.createElement("div");bubble.className="msg-bubble";if(who==="you"){bubble.textContent=text;}else{bubble.classList.add("md-content");bubble.innerHTML=renderMarkdown(text);}div.innerHTML="<div class=\\"msg-who\\">"+(who==="you"?"You":"CodeLens AI")+"</div>";div.appendChild(bubble);el.appendChild(div);el.scrollTop=el.scrollHeight;return bubble;}',
      '',
      // ── Message handler ──
      'window.addEventListener("message",function(e){',
      '  var msg=e.data;',
      '  if(msg.type==="projectData"){',
      '    document.getElementById("provider-name").textContent=msg.provider||"\\u2014";',
      '    document.getElementById("model-name").textContent=msg.model?("\\u00b7 "+msg.model):"";',
      '    var sh="";if(msg.stack&&msg.stack.length){for(var i=0;i<msg.stack.length;i++){sh+="<span class=\\"stack-tag\\">"+esc(msg.stack[i])+"</span>";}}else{sh="<span style=\\"color:var(--muted);font-size:12px\\">Unknown</span>";}',
      '    document.getElementById("stack-tags").innerHTML=sh;',
      '    document.getElementById("stat-files").textContent=msg.files.length;',
      '    document.getElementById("stat-imports").textContent=msg.graph.edges.length;',
      '    document.getElementById("stat-stack").textContent=msg.stack?msg.stack.length:0;',
      '    document.getElementById("file-tree-pre").textContent=msg.tree;',
      '    allFiles=msg.files;renderFiles(allFiles);',
      '    graphData=msg.graph;',
      '    for(var ni7=0;ni7<graphData.nodes.length;ni7++){var nn=graphData.nodes[ni7];nn.x=0;nn.y=0;nn.vx=0;nn.vy=0;nn.fixed=false;nn._deg=0;}',
      '    for(var de=0;de<graphData.edges.length;de++){var dfe=graphData.edges[de];for(var dni=0;dni<graphData.nodes.length;dni++){if(graphData.nodes[dni].id===dfe.from){graphData.nodes[dni]._deg=(graphData.nodes[dni]._deg||0)+1;}if(graphData.nodes[dni].id===dfe.to){graphData.nodes[dni]._deg=(graphData.nodes[dni]._deg||0)+1;}}}',
      '    gReady=false;gSimTick=0;',
      '    if(activeTab==="graph"){gResize();gInitPos();}',
      '  }',
      '  else if(msg.type==="projectDataError"){document.getElementById("file-list").innerHTML="<div style=\\"padding:16px;font-size:11px;color:var(--accent3)\\">Scan failed: "+esc(msg.error)+"</div>";document.getElementById("provider-name").textContent="Error";}',
      '  else if(msg.type==="noWorkspace"){document.getElementById("file-list").innerHTML="<div style=\\"padding:16px;font-size:11px;color:var(--muted)\\">Open a folder first</div>";document.getElementById("file-tree-pre").textContent="No workspace open.";document.getElementById("stack-tags").innerHTML="<span style=\\"color:var(--muted);font-size:12px\\">Open a folder first</span>";document.getElementById("provider-name").textContent="\\u2014";}',
      '  else if(msg.type==="explainResult"){document.getElementById("explain-body").classList.add("md-content");document.getElementById("explain-body").innerHTML=renderMarkdown(msg.explanation);}',
      '  else if(msg.type==="explainError"){document.getElementById("explain-body").innerHTML="<span style=\\"color:var(--accent3)\\">"+esc(msg.error)+"</span>";}',
      '  else if(msg.type==="archDiagramStart"){document.getElementById("arch-loading").style.display="flex";document.getElementById("arch-gen-btn").disabled=true;document.getElementById("arch-placeholder").style.display="none";document.getElementById("arch-svg-wrap").style.display="none";}',
      '  else if(msg.type==="archDiagramResult"){document.getElementById("arch-loading").style.display="none";document.getElementById("arch-gen-btn").disabled=false;if(msg.data){renderArchDiagram(msg.data);}else{document.getElementById("arch-placeholder").style.display="flex";document.getElementById("arch-placeholder").querySelector("p").textContent=msg.parseError||"Could not generate diagram. Try again.";}}',
      '  else if(msg.type==="archDiagramError"){document.getElementById("arch-loading").style.display="none";document.getElementById("arch-gen-btn").disabled=false;document.getElementById("arch-placeholder").style.display="flex";document.getElementById("arch-placeholder").querySelector("p").textContent="Error: "+msg.error;}',
      '  else if(msg.type==="githubAnalyzeStart"){document.getElementById("github-loading-msg").textContent="Connecting...";}',
      '  else if(msg.type==="githubAnalyzeProgress"){document.getElementById("github-loading-msg").textContent=msg.message;}',
      '  else if(msg.type==="githubAnalyzeChunk"){ghStreamText+=msg.chunk;document.getElementById("github-analysis-content").innerHTML=renderMarkdown(ghStreamText);}',
      '  else if(msg.type==="githubAnalyzeDone"){ghStreaming=false;document.getElementById("github-loading").style.display="none";document.getElementById("github-analyze-btn").disabled=false;document.getElementById("github-clone-btn").disabled=false;document.getElementById("github-result").style.display="flex";var m=msg.meta;var statsHtml="<div class=\'gh-stats-grid\'><div class=\'gh-stat-card\'><div class=\'val\'>"+(m.stars>=1000?(m.stars/1000).toFixed(1)+"k":m.stars)+"</div><div class=\'lbl\'>Stars</div></div><div class=\'gh-stat-card\'><div class=\'val\'>"+m.forks+"</div><div class=\'lbl\'>Forks</div></div><div class=\'gh-stat-card\'><div class=\'val\'>"+m.issues+"</div><div class=\'lbl\'>Issues</div></div><div class=\'gh-stat-card\'><div class=\'val\'>"+m.totalFiles+"</div><div class=\'lbl\'>Files</div></div><div class=\'gh-stat-card\'><div class=\'val\'>"+(m.size>=1024?(m.size/1024).toFixed(1)+"MB":m.size+"KB")+"</div><div class=\'lbl\'>Size</div></div></div>";var topicsHtml="";if(m.topics&&m.topics.length){topicsHtml="<div class=\'gh-topics\'>";for(var ti=0;ti<m.topics.length;ti++){topicsHtml+="<span class=\'gh-topic\'>"+esc(m.topics[ti])+"</span>";}topicsHtml+="</div>";}var actHtml="<div class=\'gh-actions-row\'><a href=\'"+m.url+"\' class=\'gh-action-btn primary\' target=\'_blank\'>&#x1F4BB; View on GitHub</a>"+(m.allowForking?"<span class=\'gh-action-btn green\' onclick=\'doCloneAndAnalyze()\' style=\'cursor:pointer\'>&#x1F504; Clone &amp; Open</span>":"")+"<a href=\'"+m.url+"/fork\' class=\'gh-action-btn secondary\' target=\'_blank\'>&#x1F374; Fork</a><a href=\'"+m.url+"/archive/refs/heads/"+m.defaultBranch+".zip\' class=\'gh-action-btn secondary\' target=\'_blank\'>&#x1F4E6; ZIP</a></div>";document.getElementById("github-repo-header").innerHTML="<div class=\'gh-repo-title\'><a href=\'"+m.url+"\' target=\'_blank\'>"+esc(m.name)+"</a></div>"+(m.description?"<div class=\'gh-repo-desc\'>"+esc(m.description)+"</div>":"")+statsHtml+topicsHtml+actHtml;document.getElementById("github-analysis-content").innerHTML=renderMarkdown(ghStreamText);}',
      '  else if(msg.type==="githubAnalyzeError"){ghStreaming=false;document.getElementById("github-loading").style.display="none";document.getElementById("github-analyze-btn").disabled=false;document.getElementById("github-clone-btn").disabled=false;document.getElementById("github-error").style.display="block";document.getElementById("github-error").textContent="Error: "+msg.error;}',
      '  else if(msg.type==="cloneProgress"){showCloneModal(msg.message);}',
      '  else if(msg.type==="cloneDone"){hideCloneModal();document.getElementById("github-error").style.display="block";document.getElementById("github-error").style.background="rgba(0,212,170,.08)";document.getElementById("github-error").style.borderColor="rgba(0,212,170,.3)";document.getElementById("github-error").style.color="var(--accent2)";document.getElementById("github-error").textContent="\\u2705 Cloned "+esc(msg.repoName)+" successfully!";}',
      '  else if(msg.type==="cloneError"){hideCloneModal();document.getElementById("github-error").style.display="block";document.getElementById("github-error").style.background="rgba(255,107,107,.08)";document.getElementById("github-error").style.borderColor="rgba(255,107,107,.3)";document.getElementById("github-error").style.color="var(--accent3)";document.getElementById("github-error").textContent="Clone failed: "+msg.error;}',
      '  else if(msg.type==="cloneCancelled"){hideCloneModal();}',
      '  else if(msg.type==="chatStreamStart"){streamBubble=addChatMsg("ai","");var cur=document.createElement("span");cur.className="cursor-blink";streamBubble.appendChild(cur);}',
      '  else if(msg.type==="chatChunk"){streamText+=msg.chunk;if(streamBubble){var c2=streamBubble.querySelector(".cursor-blink");streamBubble.innerHTML=renderMarkdown(streamText);streamBubble.classList.add("md-content");if(c2){streamBubble.appendChild(c2);}document.getElementById("chat-messages").scrollTop=99999;}}',
      '  else if(msg.type==="chatStreamEnd"){if(streamBubble){var c3=streamBubble.querySelector(".cursor-blink");if(c3){c3.remove();}streamBubble.innerHTML=renderMarkdown(streamText);streamBubble.classList.add("md-content");}streamBubble=null;chatStreaming=false;document.getElementById("chat-send").disabled=false;}',
      '  else if(msg.type==="chatError"){if(streamBubble){streamBubble.style.color="var(--accent3)";streamBubble.textContent="Error: "+msg.error;var c4=streamBubble.querySelector(".cursor-blink");if(c4){c4.remove();}}chatStreaming=false;document.getElementById("chat-send").disabled=false;}',
      '  else if(msg.type==="chatCleared"){document.getElementById("chat-messages").innerHTML="<div class=\\"chat-empty\\"><div style=\\"font-size:32px;opacity:.3\\">&#x1F4AC;</div><div>Ask anything about<br>your codebase</div></div>";}',
      '});',
    ].join('\n');

    const html = [
      '<!DOCTYPE html><html lang="en"><head>',
      '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
      '<title>CodeLens AI</title><style>' + css + '</style></head>',
      '<body><div id="app">',
      '<div id="topbar">',
      '  <div id="logo">Code<span>Lens</span> AI</div>',
      '  <div id="provider-pill" onclick="vscPost(\'switchProvider\')"><b id="provider-name">Loading&#8230;</b> <span id="model-name"></span></div>',
      '  <div class="spacer"></div>',
      '  <button class="top-action" onclick="vscPost(\'runCommand\',\'codelensai.projectOverview\')">I\'m Lost</button>',
      '  <button class="top-action" onclick="vscPost(\'runCommand\',\'codelensai.generateReadme\')">Gen README</button>',
      '  <button class="top-action primary" onclick="vscPost(\'runCommand\',\'codelensai.setApiKey\')">API Key</button>',
      '</div>',
      '<div id="main">',
      '  <div id="sidebar">',
      '    <div id="sidebar-header">Files</div>',
      '    <input id="file-search" placeholder="search files&#8230;" oninput="filterFiles(this.value)">',
      '    <div id="file-list"><div style="padding:16px;font-size:11px;color:var(--muted)">Loading&#8230;</div></div>',
      '  </div>',
      '  <div id="centre">',
      '    <div id="tabs">',
      '      <div class="tab active" onclick="switchTab(\'overview\')">Overview</div>',
      '      <div class="tab" onclick="switchTab(\'graph\')">Dependency Graph</div>',
      '      <div class="tab" onclick="switchTab(\'arch\')">Architecture</div>',
      '      <div class="tab" onclick="switchTab(\'explain\')">File Explain</div>',
      '      <div class="tab" onclick="switchTab(\'github\')">&#x1F419; GitHub</div>',
      '    </div>',
      '    <div id="tab-content">',
      // Overview
      '      <div class="tab-pane active" id="pane-overview"><div style="padding:24px;display:flex;flex-direction:column;gap:20px;overflow-y:auto;flex:1">',
      '        <div class="overview-grid">',
      '          <div class="card"><div class="card-label">Tech Stack</div><div class="stack-tags" id="stack-tags"><span style="color:var(--muted);font-size:12px">Scanning&#8230;</span></div></div>',
      '          <div class="card"><div class="card-label">Project Stats</div><div class="stat-row"><div><div class="stat-num" id="stat-files">&#8212;</div><div class="stat-lbl">files</div></div><div><div class="stat-num" id="stat-imports">&#8212;</div><div class="stat-lbl">imports</div></div><div><div class="stat-num" id="stat-stack">&#8212;</div><div class="stat-lbl">technologies</div></div></div></div>',
      '          <div class="card" style="grid-column:1/-1"><div class="card-label">File Tree</div><pre class="file-tree-pre" id="file-tree-pre">Loading&#8230;</pre></div>',
      '        </div>',
      '        <div><div style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-bottom:12px">Quick Actions</div>',
      '        <div class="action-grid">',
      '          <button class="action-card" onclick="vscPost(\'runCommand\',\'codelensai.projectOverview\')"><div class="action-card-icon">&#x1F5FA;&#xFE0F;</div><div class="action-card-title">Project Overview</div><div class="action-card-desc">Full onboarding — stack, entry point, key files</div></button>',
      '          <button class="action-card" onclick="switchTab(\'graph\')"><div class="action-card-icon">&#x1F578;&#xFE0F;</div><div class="action-card-title">Dependency Graph</div><div class="action-card-desc">Interactive map of file connections</div></button>',
      '          <button class="action-card" onclick="switchTab(\'arch\')"><div class="action-card-icon">&#x1F3D7;&#xFE0F;</div><div class="action-card-title">Architecture Diagram</div><div class="action-card-desc">AI-generated layered architecture</div></button>',
      '          <button class="action-card" onclick="switchTab(\'github\')"><div class="action-card-icon">&#x1F419;</div><div class="action-card-title">GitHub Analyzer</div><div class="action-card-desc">Analyze or clone any public GitHub repo</div></button>',
      '        </div></div>',
      '      </div></div>',
      // Graph
      '      <div class="tab-pane" id="pane-graph">',
      '        <div id="graph-toolbar">',
      '          <input id="graph-search" placeholder="&#x1F50D; Filter files&#8230;" oninput="gFilterFn(this.value)">',
      '          <div id="graph-stats">loading&#8230;</div>',
      '          <button class="graph-btn" onclick="gResetView()">&#x1F504; Reset</button>',
      '          <div class="graph-legend"><div class="leg"><div class="leg-dot" style="background:#5ba3f5"></div>.ts</div><div class="leg"><div class="leg-dot" style="background:#f0c030"></div>.js</div><div class="leg"><div class="leg-dot" style="background:#4caf50"></div>.py</div><div class="leg"><div class="leg-dot" style="background:#ab77f7"></div>.css</div><div class="leg"><div class="leg-dot" style="background:#3a3f50"></div>standalone</div></div>',
      '          <span style="font-family:var(--mono);font-size:10px;color:var(--muted)">Scroll=zoom &#183; Click=select &#183; Drag=move &#183; Dblclick=pin</span>',
      '        </div>',
      '        <canvas id="graph-canvas"></canvas>',
      '        <div id="graph-tooltip"></div>',
      '      </div>',
      // Arch
      '      <div class="tab-pane" id="pane-arch">',
      '        <div id="arch-toolbar">',
      '          <div id="arch-title-text">Architecture Diagram</div>',
      '          <div id="arch-loading"><div class="pulse-dot"></div>Generating&#8230;</div>',
      '          <button class="arch-zoom-btn" onclick="archZoom(1.25)">+</button>',
      '          <button class="arch-zoom-btn" onclick="archZoom(.8)">&#8722;</button>',
      '          <button class="arch-zoom-btn" onclick="archFit()">&#x25A1;</button>',
      '          <button class="arch-zoom-btn" onclick="archFullscreen()">&#x26F6;</button>',
      '          <button class="arch-gen-btn" id="arch-gen-btn" onclick="generateArch()">&#x2728; Generate with AI</button>',
      '        </div>',
      '        <div id="arch-body">',
      '          <div id="arch-placeholder"><div class="big-icon">&#x1F3D7;&#xFE0F;</div><p>Click <strong>Generate with AI</strong> to build a dynamic architecture diagram. AI picks the right layer count for your project.</p></div>',
      '          <div id="arch-svg-wrap"><div id="arch-svg-container"></div></div>',
      '        </div>',
      '      </div>',
      // Explain
      '      <div class="tab-pane" id="pane-explain">',
      '        <div style="padding:24px;display:flex;flex-direction:column;flex:1;overflow:hidden">',
      '          <div id="explain-placeholder"><div class="hint-icon">&#x1F4C2;</div><p>Click any file in the sidebar to get an AI explanation.</p></div>',
      '          <div id="explain-content"><div id="explain-file-header"><span id="explain-file-name"></span><button class="explain-reload" id="explain-reload-btn">&#8635; Re-explain</button></div><div id="explain-body" class="md-content"></div></div>',
      '        </div>',
      '      </div>',
      // GitHub
      '      <div class="tab-pane" id="pane-github">',
      '        <div id="github-toolbar"><div id="github-toolbar-title">&#x1F419; GitHub Repo Analyzer</div></div>',
      '        <div id="github-body">',
      '          <div id="github-input-section"><div id="github-input-row"><input id="github-url-input" placeholder="https://github.com/owner/repo" onkeydown="if(event.key===\'Enter\')doAnalyzeGithub()"><button id="github-analyze-btn" class="gh-btn analyze" onclick="doAnalyzeGithub()">&#x1F50D; Analyze</button><button id="github-clone-btn" class="gh-btn clone" onclick="doCloneAndAnalyze()">&#x1F504; Clone &amp; Open</button></div>',
      '          <div style="font-size:11px;color:var(--muted);font-weight:600">Examples:</div>',
      '          <div id="github-examples"><span class="gh-example" onclick="setGhUrl(\'https://github.com/facebook/react\')">facebook/react</span><span class="gh-example" onclick="setGhUrl(\'https://github.com/microsoft/vscode\')">microsoft/vscode</span><span class="gh-example" onclick="setGhUrl(\'https://github.com/vercel/next.js\')">vercel/next.js</span><span class="gh-example" onclick="setGhUrl(\'https://github.com/fastapi/fastapi\')">fastapi/fastapi</span><span class="gh-example" onclick="setGhUrl(\'https://github.com/django/django\')">django/django</span></div>',
      '          </div>',
      '          <div id="github-error"></div>',
      '          <div id="github-loading"><div class="gh-spinner"></div><span id="github-loading-msg">Connecting&#8230;</span></div>',
      '          <div id="github-result"><div id="github-repo-header"></div><div id="github-analysis-content" class="md-content"></div></div>',
      '        </div>',
      '      </div>',
      '    </div>',
      '  </div>',
      // Chat
      '  <div id="chat-panel">',
      '    <div id="chat-header"><div id="chat-title">ASK YOUR CODE</div><button id="chat-clear" onclick="vscPost(\'clearChat\')">Clear</button></div>',
      '    <div class="quick-actions"><button class="qa" onclick="sendChat(\'Give me a project overview\')">Overview</button><button class="qa" onclick="sendChat(\'What is the entry point?\')">Entry point</button><button class="qa" onclick="sendChat(\'What are the main dependencies?\')">Dependencies</button><button class="qa" onclick="sendChat(\'How does data flow?\')">Data flow</button></div>',
      '    <div id="chat-messages"><div class="chat-empty"><div style="font-size:32px;opacity:.3">&#x1F4AC;</div><div>Ask anything about<br>your codebase</div></div></div>',
      '    <div id="chat-input-row"><textarea id="chat-input" placeholder="What does auth.js do?" rows="1" onkeydown="if(event.key===\'Enter\'&&!event.shiftKey){event.preventDefault();doSendChat()}" oninput="this.style.height=\'auto\';this.style.height=Math.min(this.scrollHeight,100)+\'px\'"></textarea><button id="chat-send" onclick="doSendChat()">&#8593;</button></div>',
      '  </div>',
      '</div></div>',
      // Clone modal
      '<div id="clone-overlay"><div id="clone-modal"><h3>&#x1F504; Cloning Repository</h3><div class="clone-bar"><div class="clone-bar-fill"></div></div><div class="clone-msg" id="clone-modal-msg">Preparing&#8230;</div><div style="font-size:11px;color:var(--muted);font-family:var(--mono)">Pick a folder when prompted. VS Code opens after clone.</div></div></div>',
      // Arch fullscreen overlay
      '<div id="arch-fs-overlay"><div id="arch-fs-toolbar"><span style="font-weight:800;font-size:13px;color:var(--text)" id="arch-fs-title">Architecture</span><div class="spacer"></div><button class="arch-zoom-btn" onclick="archFsZoom(1.25)">+</button><button class="arch-zoom-btn" onclick="archFsZoom(.8)">&#8722;</button><button class="arch-zoom-btn" onclick="archFsFit()">&#x25A1;</button><span id="arch-fs-scale-val" style="font-family:var(--mono);font-size:11px;color:var(--muted);min-width:40px;text-align:center">100%</span><button class="arch-zoom-btn" onclick="closeArchFs()" style="color:var(--accent3);border-color:var(--accent3);width:auto;padding:0 10px;font-size:12px">&#x2715; Close</button></div><div id="arch-fs-body"><div id="arch-fs-content"></div></div></div>',
      '<script>' + js + '<\/script>',
      '</body></html>',
    ].join('\n');

    return html;
  }
}
