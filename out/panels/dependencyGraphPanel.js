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
exports.DependencyGraphPanel = void 0;
const vscode = __importStar(require("vscode"));
const contextBuilder_1 = require("../utils/contextBuilder");
class DependencyGraphPanel {
    static show(context) {
        if (DependencyGraphPanel.currentPanel) {
            DependencyGraphPanel.currentPanel._panel.reveal();
            return;
        }
        const panel = vscode.window.createWebviewPanel('codelensai.depGraph', 'File Dependency Graph', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
        DependencyGraphPanel.currentPanel = new DependencyGraphPanel(panel);
        panel.onDidDispose(() => { DependencyGraphPanel.currentPanel = undefined; });
    }
    constructor(panel) {
        this._panel = panel;
        this._panel.webview.html = this.getLoadingHtml();
        this.loadGraph();
    }
    async loadGraph() {
        const rootPath = (0, contextBuilder_1.getWorkspaceRoot)();
        if (!rootPath) {
            this._panel.webview.html = `<body style="color:white;padding:20px">Open a workspace first.</body>`;
            return;
        }
        const nodes = (0, contextBuilder_1.buildDependencyMap)(rootPath);
        const graphData = {
            nodes: nodes.map(n => ({ id: n.relativePath, label: n.relativePath.split('/').pop() ?? n.relativePath, path: n.relativePath, size: n.size })),
            edges: [],
        };
        for (const node of nodes) {
            for (const imp of node.imports) {
                // Resolve relative import to a file in the map
                const target = nodes.find(n => n.relativePath.replace(/\.[^.]+$/, '') ===
                    imp.replace(/^\.\//, '').replace(/^\.\.\//, ''));
                if (target) {
                    graphData.edges.push({ from: node.relativePath, to: target.relativePath });
                }
            }
        }
        this._panel.webview.html = this.getGraphHtml(JSON.stringify(graphData));
    }
    getLoadingHtml() {
        return `<html><body style="background:#1e1e1e;color:#ccc;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif">
      <div>Scanning project files...</div></body></html>`;
    }
    getGraphHtml(graphDataJson) {
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #1e1e1e; color: #d4d4d4; font-family: 'Segoe UI', sans-serif; height: 100vh; overflow: hidden; display: flex; flex-direction: column; }
  #toolbar { padding: 8px 12px; background: #252526; border-bottom: 1px solid #3e3e3e; display: flex; align-items: center; gap: 12px; font-size: 12px; }
  #toolbar h2 { font-size: 13px; font-weight: 500; color: #ccc; flex: 1; }
  #search { background: #3c3c3c; border: 1px solid #555; color: #ccc; padding: 4px 8px; border-radius: 4px; font-size: 12px; width: 180px; }
  #canvas { flex: 1; cursor: grab; }
  #canvas:active { cursor: grabbing; }
  #tooltip { position: fixed; background: #252526; border: 1px solid #555; padding: 8px 10px; border-radius: 6px; font-size: 11px; pointer-events: none; display: none; max-width: 260px; }
  #legend { padding: 6px 12px; background: #252526; border-top: 1px solid #3e3e3e; font-size: 11px; color: #888; display: flex; gap: 16px; }
  .leg { display: flex; align-items: center; gap: 4px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; }
</style>
</head>
<body>
<div id="toolbar">
  <h2>📁 File Dependency Graph</h2>
  <input id="search" placeholder="Search files..." oninput="filterGraph(this.value)">
  <span id="stats" style="color:#888"></span>
</div>
<canvas id="canvas"></canvas>
<div id="tooltip"></div>
<div id="legend">
  <div class="leg"><div class="dot" style="background:#4ec9b0"></div> Selected</div>
  <div class="leg"><div class="dot" style="background:#569cd6"></div> File node</div>
  <div class="leg"><div class="dot" style="background:#808080"></div> No imports</div>
  <div class="leg">Drag to pan · Scroll to zoom · Click to highlight</div>
</div>
<script>
const DATA = ${graphDataJson};

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('tooltip');
const statsEl = document.getElementById('stats');

let nodes = DATA.nodes.map((n, i) => ({ ...n, x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null }));
let edges = DATA.edges;
let selectedId = null;
let filterText = '';

// Layout
let panX = 0, panY = 0, zoom = 1;
let dragging = null, dragStart = null, isPanning = false, panStart = null;

function resize() {
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
  if (nodes.length && nodes[0].x === 0) initPositions();
}

function initPositions() {
  const cx = canvas.width / 2, cy = canvas.height / 2;
  const r = Math.min(cx, cy) * 0.7;
  nodes.forEach((n, i) => {
    const angle = (i / nodes.length) * Math.PI * 2;
    n.x = cx + Math.cos(angle) * r * (0.5 + Math.random() * 0.5);
    n.y = cy + Math.sin(angle) * r * (0.5 + Math.random() * 0.5);
  });
}

// Force simulation
function simulate() {
  const k = Math.sqrt((canvas.width * canvas.height) / (nodes.length || 1));
  nodes.forEach(n => { n.vx = 0; n.vy = 0; });

  // Repulsion
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[j].x - nodes[i].x || 0.1;
      const dy = nodes[j].y - nodes[i].y || 0.1;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (k * k) / d * 0.5;
      nodes[i].vx -= (dx / d) * f;
      nodes[i].vy -= (dy / d) * f;
      nodes[j].vx += (dx / d) * f;
      nodes[j].vy += (dy / d) * f;
    }
  }

  // Attraction along edges
  edges.forEach(e => {
    const a = nodes.find(n => n.id === e.from);
    const b = nodes.find(n => n.id === e.to);
    if (!a || !b) return;
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (d * d) / k * 0.3;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    a.vx += fx; a.vy += fy;
    b.vx -= fx; b.vy -= fy;
  });

  // Center gravity
  const cx = canvas.width / 2, cy = canvas.height / 2;
  nodes.forEach(n => {
    n.vx += (cx - n.x) * 0.005;
    n.vy += (cy - n.y) * 0.005;
  });

  nodes.forEach(n => {
    if (n.fixed) return;
    n.x += n.vx * 0.4;
    n.y += n.vy * 0.4;
  });
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(panX, panY);
  ctx.scale(zoom, zoom);

  const visibleNodes = filterText
    ? nodes.filter(n => n.id.toLowerCase().includes(filterText))
    : nodes;
  const visibleIds = new Set(visibleNodes.map(n => n.id));

  // Edges
  edges.forEach(e => {
    if (!visibleIds.has(e.from) || !visibleIds.has(e.to)) return;
    const a = nodes.find(n => n.id === e.from);
    const b = nodes.find(n => n.id === e.to);
    if (!a || !b) return;
    const isHighlighted = selectedId && (e.from === selectedId || e.to === selectedId);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = isHighlighted ? '#4ec9b0' : '#4a4a4a';
    ctx.lineWidth = isHighlighted ? 1.5 / zoom : 0.8 / zoom;
    ctx.globalAlpha = isHighlighted ? 0.9 : 0.5;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Arrowhead
    if (isHighlighted) {
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const r = 8;
      const ax = b.x - Math.cos(angle) * r;
      const ay = b.y - Math.sin(angle) * r;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - Math.cos(angle - 0.4) * 6, ay - Math.sin(angle - 0.4) * 6);
      ctx.lineTo(ax - Math.cos(angle + 0.4) * 6, ay - Math.sin(angle + 0.4) * 6);
      ctx.fillStyle = '#4ec9b0';
      ctx.fill();
    }
  });

  // Nodes
  visibleNodes.forEach(n => {
    const hasEdge = edges.some(e => e.from === n.id || e.to === n.id);
    const isSelected = n.id === selectedId;
    const r = isSelected ? 9 : 7;
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fillStyle = isSelected ? '#4ec9b0' : hasEdge ? '#569cd6' : '#6a6a6a';
    ctx.fill();
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 3, 0, Math.PI * 2);
      ctx.strokeStyle = '#4ec9b0';
      ctx.lineWidth = 1.5 / zoom;
      ctx.globalAlpha = 0.4;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Label
    ctx.fillStyle = isSelected ? '#4ec9b0' : '#ccc';
    ctx.font = \`\${(isSelected ? 12 : 10) / zoom}px 'Segoe UI', sans-serif\`;
    ctx.textAlign = 'center';
    ctx.fillText(n.label, n.x, n.y + r + 12 / zoom);
  });

  ctx.restore();
  statsEl.textContent = \`\${visibleNodes.length} files · \${edges.length} imports\`;
}

function filterGraph(text) {
  filterText = text.toLowerCase();
}

// Interaction
function getNodeAt(mx, my) {
  const wx = (mx - panX) / zoom, wy = (my - panY) / zoom;
  return nodes.find(n => Math.hypot(n.x - wx, n.y - wy) < 12);
}

canvas.addEventListener('mousedown', e => {
  const n = getNodeAt(e.offsetX, e.offsetY);
  if (n) {
    dragging = n; n.fixed = true;
    selectedId = n.id;
  } else {
    isPanning = true;
    panStart = { x: e.offsetX - panX, y: e.offsetY - panY };
  }
});

canvas.addEventListener('mousemove', e => {
  if (dragging) {
    dragging.x = (e.offsetX - panX) / zoom;
    dragging.y = (e.offsetY - panY) / zoom;
  } else if (isPanning) {
    panX = e.offsetX - panStart.x;
    panY = e.offsetY - panStart.y;
  }

  const n = getNodeAt(e.offsetX, e.offsetY);
  if (n) {
    const deps = edges.filter(e => e.from === n.id).map(e => e.to);
    const usedBy = edges.filter(e => e.to === n.id).map(e => e.from);
    tooltip.style.display = 'block';
    tooltip.style.left = (e.clientX + 14) + 'px';
    tooltip.style.top = (e.clientY - 10) + 'px';
    tooltip.innerHTML = \`<b>\${n.id}</b><br>
      Imports: \${deps.length ? deps.map(d => d.split('/').pop()).join(', ') : 'none'}<br>
      Used by: \${usedBy.length ? usedBy.map(d => d.split('/').pop()).join(', ') : 'none'}\`;
  } else {
    tooltip.style.display = 'none';
  }
});

canvas.addEventListener('mouseup', () => {
  if (dragging) { dragging.fixed = false; dragging = null; }
  isPanning = false;
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const factor = e.deltaY > 0 ? 0.9 : 1.1;
  const mx = e.offsetX, my = e.offsetY;
  panX = mx - (mx - panX) * factor;
  panY = my - (my - panY) * factor;
  zoom *= factor;
  zoom = Math.max(0.2, Math.min(zoom, 4));
}, { passive: false });

new ResizeObserver(resize).observe(canvas);
resize();

let tick = 0;
function loop() {
  if (tick < 300) { simulate(); tick++; }
  draw();
  requestAnimationFrame(loop);
}
loop();
</script>
</body>
</html>`;
    }
}
exports.DependencyGraphPanel = DependencyGraphPanel;
//# sourceMappingURL=dependencyGraphPanel.js.map