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
exports.ExplainPanel = void 0;
const vscode = __importStar(require("vscode"));
/**
 * ExplainPanel — shows AI code explanations in a beautiful dedicated webview.
 * Call ExplainPanel.show(context, title, code, lang) to open/update it.
 * Call ExplainPanel.stream(chunk) to append streaming content.
 */
class ExplainPanel {
    static show(context, title, code, lang) {
        if (ExplainPanel.currentPanel) {
            ExplainPanel.currentPanel._panel.reveal(vscode.ViewColumn.Beside);
            ExplainPanel.currentPanel._reset(title, code, lang);
            return ExplainPanel.currentPanel;
        }
        const panel = vscode.window.createWebviewPanel('codelensai.explain', 'CodeLens AI — Explain', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
        const ep = new ExplainPanel(panel, title, code, lang);
        ExplainPanel.currentPanel = ep;
        panel.onDidDispose(() => { ExplainPanel.currentPanel = undefined; });
        return ep;
    }
    constructor(panel, title, code, lang) {
        this._panel = panel;
        this._panel.webview.html = this._buildHtml(title, code, lang);
    }
    _reset(title, code, lang) {
        this._panel.webview.html = this._buildHtml(title, code, lang);
    }
    /** Append a streaming chunk to the explanation area */
    stream(chunk) {
        this._panel.webview.postMessage({ type: 'chunk', chunk });
    }
    /** Mark streaming as done */
    done() {
        this._panel.webview.postMessage({ type: 'done' });
    }
    /** Show an error */
    error(msg) {
        this._panel.webview.postMessage({ type: 'error', msg });
    }
    _buildHtml(title, code, lang) {
        // Escape for safe injection into HTML
        const safeCode = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeTitle = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeLang = (lang || 'code').replace(/[^a-zA-Z0-9]/g, '');
        const css = [
            '@import url(\'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Syne:wght@400;600;700;800&display=swap\');',
            '*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}',
            ':root{--bg:#0d0f14;--surface:#13161e;--surface2:#1a1e29;--border:#252a38;--accent:#6c63ff;--accent2:#00d4aa;--accent3:#ff6b6b;--text:#e2e4ed;--muted:#6b7280;--mono:\'JetBrains Mono\',monospace;--sans:\'Syne\',sans-serif;}',
            'html,body{height:100%;background:var(--bg);color:var(--text);font-family:var(--sans);overflow:hidden}',
            '#app{display:grid;grid-template-rows:auto 1fr;height:100vh;overflow:hidden}',
            // Header
            '#header{background:var(--surface);border-bottom:2px solid var(--border);padding:16px 24px;display:flex;align-items:center;gap:14px;flex-shrink:0}',
            '#header-icon{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}',
            '#header-text{flex:1;overflow:hidden}',
            '#header-title{font-size:14px;font-weight:800;color:var(--text);letter-spacing:-.3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
            '#header-sub{font-size:11px;color:var(--muted);font-family:var(--mono);margin-top:2px}',
            '#header-badge{font-family:var(--mono);font-size:10px;padding:4px 12px;background:linear-gradient(135deg,rgba(108,99,255,.2),rgba(0,212,170,.15));border:1px solid var(--accent);color:var(--accent2);border-radius:20px;white-space:nowrap;flex-shrink:0}',
            // Body split
            '#body{display:grid;grid-template-columns:1fr 1.7fr;overflow:hidden}',
            // Code panel
            '#code-panel{background:var(--surface2);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden}',
            '#code-header{padding:10px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-shrink:0}',
            '#code-header .lang-badge{font-family:var(--mono);font-size:9px;padding:2px 8px;border-radius:4px;background:var(--surface);border:1px solid var(--border);color:var(--muted);text-transform:uppercase;letter-spacing:1px}',
            '#code-header .label{font-size:11px;font-weight:700;color:var(--muted);letter-spacing:1px;text-transform:uppercase;flex:1}',
            '#code-scroll{flex:1;overflow:auto;padding:0}',
            'pre#code-block{font-family:var(--mono);font-size:11.5px;line-height:1.75;color:#cdd6f4;padding:20px;white-space:pre;tab-size:2;counter-reset:line}',
            // Line numbers approach
            '.code-line{display:table-row}',
            '.line-num{display:table-cell;color:#3a3f50;font-size:10px;padding-right:16px;text-align:right;user-select:none;min-width:28px;vertical-align:top}',
            '.line-content{display:table-cell;color:#cdd6f4}',
            // Explanation panel
            '#explain-panel{display:flex;flex-direction:column;overflow:hidden}',
            '#explain-header{padding:10px 20px;border-bottom:1px solid var(--border);font-size:11px;font-weight:700;color:var(--muted);letter-spacing:1px;text-transform:uppercase;flex-shrink:0;display:flex;align-items:center;gap:8px}',
            '.stream-dot{width:7px;height:7px;border-radius:50%;background:var(--accent2);animation:pulse 1s ease-in-out infinite;display:none}',
            '.stream-dot.active{display:inline-block}',
            '@keyframes pulse{0%,100%{opacity:.3;transform:scale(.8)}50%{opacity:1;transform:scale(1.2)}}',
            '#explain-scroll{flex:1;overflow-y:auto;padding:24px}',
            '#explain-content{font-size:13px;line-height:1.85;color:var(--text)}',
            // Markdown
            '#explain-content h1,#explain-content h2,#explain-content h3{color:var(--text);font-weight:800;margin:18px 0 8px;font-family:var(--sans)}',
            '#explain-content h1{font-size:16px;border-bottom:2px solid var(--border);padding-bottom:8px}',
            '#explain-content h2{font-size:14px;color:var(--accent2);border-left:3px solid var(--accent2);padding-left:10px}',
            '#explain-content h3{font-size:13px;color:var(--accent)}',
            '#explain-content p{margin:0 0 12px;line-height:1.8}',
            '#explain-content strong,#explain-content b{color:var(--accent2);font-weight:700}',
            '#explain-content em{color:#c4b5fd;font-style:italic}',
            '#explain-content ul,#explain-content ol{padding-left:20px;margin:6px 0 14px}',
            '#explain-content li{margin:5px 0;font-size:13px;line-height:1.7}',
            '#explain-content code{font-family:var(--mono);font-size:11.5px;background:rgba(108,99,255,.12);border:1px solid rgba(108,99,255,.25);padding:2px 7px;border-radius:5px;color:#c4b5fd}',
            '#explain-content pre{font-family:var(--mono);font-size:11.5px;background:var(--surface2);border:1px solid var(--border);padding:14px 16px;border-radius:8px;overflow-x:auto;margin:10px 0;color:#e2b96a;line-height:1.65;border-left:3px solid var(--accent)}',
            '#explain-content blockquote{border-left:3px solid var(--accent);padding:8px 14px;color:var(--muted);margin:10px 0;background:rgba(108,99,255,.05);border-radius:0 8px 8px 0}',
            '#explain-content hr{border:none;border-top:1px solid var(--border);margin:16px 0}',
            // Table styles for markdown tables
            '#explain-content table{width:100%;border-collapse:collapse;margin:12px 0;font-size:12px;font-family:var(--mono)}',
            '#explain-content th{background:var(--surface2);border:1px solid var(--border);padding:8px 12px;text-align:left;color:var(--accent2);font-size:11px;font-weight:700;letter-spacing:.5px}',
            '#explain-content td{border:1px solid var(--border);padding:7px 12px;color:var(--text);vertical-align:top;line-height:1.6}',
            '#explain-content tr:nth-child(even) td{background:rgba(255,255,255,.02)}',
            '#explain-content tr:hover td{background:rgba(108,99,255,.05)}',
            // Loading skeleton
            '.skeleton{background:linear-gradient(90deg,var(--surface2) 25%,var(--border) 50%,var(--surface2) 75%);background-size:200% 100%;animation:shimmer 1.4s infinite;border-radius:5px;height:14px;margin-bottom:12px}',
            '@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}',
            // Error
            '#error-box{display:none;background:rgba(255,107,107,.08);border:1px solid rgba(255,107,107,.3);border-radius:8px;padding:16px;color:var(--accent3);font-size:12px;font-family:var(--mono);margin:20px}',
            // Scrollbar
            '::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:transparent}',
            '::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}::-webkit-scrollbar-thumb:hover{background:#353a4d}',
        ].join('\n');
        const js = [
            'var BT1 = String.fromCharCode(96);',
            'var BT3 = BT1+BT1+BT1;',
            'function escHtml(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}',
            '',
            '// Full markdown renderer including tables',
            'function renderMarkdown(raw){',
            '  if(!raw){return "";}',
            '  var text=raw.split("\\r\\n").join("\\n");',
            '  // Fenced code blocks',
            '  var fparts=escHtml(text).split(BT3);var staged="";',
            '  for(var fi=0;fi<fparts.length;fi++){',
            '    if(fi%2===0){staged+=fparts[fi];}',
            '    else{var cl=fparts[fi].split("\\n");var lang=cl.shift()||"";staged+="<pre><code>"+cl.join("\\n").trim()+"</code></pre>";}',
            '  }',
            '  // Inline code',
            '  var iparts=staged.split(BT1);staged="";',
            '  for(var ii=0;ii<iparts.length;ii++){staged+=(ii%2===0)?iparts[ii]:("<code>"+iparts[ii]+"</code>");}',
            '  // Tables',
            '  var lines=staged.split("\\n");',
            '  var result=[]; var i=0;',
            '  while(i<lines.length){',
            '    var line=lines[i];',
            '    // Detect table: line has | and next line is separator',
            '    if(line.indexOf("|")!==-1&&i+1<lines.length&&/^[|\\- :]+$/.test(lines[i+1].replace(/[^|\\-: ]/g,""))){',
            '      var tableHtml="<table>";',
            '      // Header row',
            '      var hcells=line.split("|").filter(function(c,ci,arr){return ci>0&&ci<arr.length-1;});',
            '      tableHtml+="<tr>";for(var hi=0;hi<hcells.length;hi++){tableHtml+="<th>"+hcells[hi].trim()+"</th>";}tableHtml+="</tr>";',
            '      i+=2;// skip header and separator',
            '      while(i<lines.length&&lines[i].indexOf("|")!==-1){',
            '        var dcells=lines[i].split("|").filter(function(c,ci,arr){return ci>0&&ci<arr.length-1;});',
            '        tableHtml+="<tr>";for(var di=0;di<dcells.length;di++){tableHtml+="<td>"+dcells[di].trim()+"</td>";}tableHtml+="</tr>";',
            '        i++;',
            '      }',
            '      tableHtml+="</table>";',
            '      result.push(tableHtml);',
            '    } else { result.push(line); i++; }',
            '  }',
            '  staged=result.join("\\n");',
            '  // Line-by-line block elements',
            '  var lines2=staged.split("\\n");var html="";var inList=false;',
            '  for(var li=0;li<lines2.length;li++){',
            '    var t=lines2[li].trim();',
            '    if(!t){if(inList){html+="</ul>";inList=false;}continue;}',
            '    if(t.indexOf("<pre>")===0||t.indexOf("<table>")===0){if(inList){html+="</ul>";inList=false;}html+=t;continue;}',
            '    if(t==="---"){if(inList){html+="</ul>";inList=false;}html+="<hr>";continue;}',
            '    if(t.indexOf("### ")===0){if(inList){html+="</ul>";inList=false;}html+="<h3>"+t.slice(4)+"</h3>";continue;}',
            '    if(t.indexOf("## ")===0){if(inList){html+="</ul>";inList=false;}html+="<h2>"+t.slice(3)+"</h2>";continue;}',
            '    if(t.indexOf("# ")===0){if(inList){html+="</ul>";inList=false;}html+="<h1>"+t.slice(2)+"</h1>";continue;}',
            '    if(t.indexOf("&gt; ")===0){if(inList){html+="</ul>";inList=false;}html+="<blockquote>"+t.slice(5)+"</blockquote>";continue;}',
            '    if(t.indexOf("- ")===0||t.indexOf("* ")===0){if(!inList){html+="<ul>";inList=true;}html+="<li>"+t.slice(2)+"</li>";continue;}',
            '    var dotI=t.indexOf(". ");',
            '    if(dotI>0&&/^[0-9]+$/.test(t.slice(0,dotI))){if(!inList){html+="<ul>";inList=true;}html+="<li>"+t.slice(dotI+2)+"</li>";continue;}',
            '    if(inList){html+="</ul>";inList=false;}',
            '    html+="<p>"+t+"</p>";',
            '  }',
            '  if(inList){html+="</ul>";}',
            '  html=html.replace(/\\*\\*([^*\\n]+)\\*\\*/g,"<strong>$1</strong>");',
            '  html=html.replace(/\\*([^*\\n]+)\\*/g,"<em>$1</em>");',
            '  return html;',
            '}',
            '',
            'var fullText="";var isDone=false;',
            'var contentEl=document.getElementById("explain-content");',
            'var dotEl=document.getElementById("stream-dot");',
            'var errEl=document.getElementById("error-box");',
            '',
            '// Remove loading skeletons once first chunk arrives',
            'var firstChunk=true;',
            '',
            'window.addEventListener("message",function(e){',
            '  var msg=e.data;',
            '  if(msg.type==="chunk"){',
            '    if(firstChunk){',
            '      contentEl.innerHTML="";',
            '      firstChunk=false;',
            '      if(dotEl){dotEl.classList.add("active");}',
            '    }',
            '    fullText+=msg.chunk;',
            '    contentEl.innerHTML=renderMarkdown(fullText);',
            '    document.getElementById("explain-scroll").scrollTop=99999;',
            '  } else if(msg.type==="done"){',
            '    isDone=true;',
            '    contentEl.innerHTML=renderMarkdown(fullText);',
            '    if(dotEl){dotEl.classList.remove("active");}',
            '    var hdr=document.getElementById("explain-hdr-label");',
            '    if(hdr){hdr.textContent="EXPLANATION";}',
            '  } else if(msg.type==="error"){',
            '    if(dotEl){dotEl.classList.remove("active");}',
            '    contentEl.innerHTML="";',
            '    errEl.style.display="block";',
            '    errEl.textContent="Error: "+msg.msg;',
            '  }',
            '});',
        ].join('\n');
        // Build code display with line numbers
        const lines = code.split('\n');
        const lineHtml = lines.map((line, i) => {
            const safeLineContent = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return `<div class="code-line"><span class="line-num">${i + 1}</span><span class="line-content">${safeLineContent || ' '}</span></div>`;
        }).join('');
        // Loading skeletons
        const skels = [80, 95, 70, 88, 60, 92, 75, 50].map(w => `<div class="skeleton" style="width:${w}%"></div>`).join('');
        const html = [
            '<!DOCTYPE html><html lang="en"><head>',
            '<meta charset="UTF-8">',
            '<meta name="viewport" content="width=device-width,initial-scale=1">',
            '<title>CodeLens AI — Explain</title>',
            '<style>' + css + '</style>',
            '</head><body><div id="app">',
            // Header
            '<div id="header">',
            '  <div id="header-icon">&#x2728;</div>',
            '  <div id="header-text">',
            '    <div id="header-title">' + safeTitle + '</div>',
            '    <div id="header-sub">AI Code Explanation &#x2022; ' + safeLang.toUpperCase() + '</div>',
            '  </div>',
            '  <div id="header-badge">CodeLens AI</div>',
            '</div>',
            // Body
            '<div id="body">',
            // Left: code
            '  <div id="code-panel">',
            '    <div id="code-header">',
            '      <span class="label">Source Code</span>',
            '      <span class="lang-badge">' + safeLang + '</span>',
            '    </div>',
            '    <div id="code-scroll">',
            '      <pre id="code-block"><table style="border-spacing:0;width:100%">',
            lineHtml,
            '      </table></pre>',
            '    </div>',
            '  </div>',
            // Right: explanation
            '  <div id="explain-panel">',
            '    <div id="explain-header">',
            '      <span id="explain-hdr-label">ANALYZING CODE&#8230;</span>',
            '      <span id="stream-dot" class="stream-dot active"></span>',
            '    </div>',
            '    <div id="explain-scroll">',
            '      <div id="explain-content">',
            skels,
            '      </div>',
            '      <div id="error-box"></div>',
            '    </div>',
            '  </div>',
            '</div></div>',
            '<script>' + js + '<\/script>',
            '</body></html>',
        ].join('\n');
        return html;
    }
}
exports.ExplainPanel = ExplainPanel;
//# sourceMappingURL=explainPanel.js.map