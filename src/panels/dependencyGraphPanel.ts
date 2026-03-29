import * as vscode from 'vscode';
import * as path from 'path';
import { getWorkspaceRoot, buildDependencyMap } from '../utils/contextBuilder';

export class DependencyGraphPanel {
  static currentPanel?: DependencyGraphPanel;
  private readonly _panel: vscode.WebviewPanel;

  static show(context: vscode.ExtensionContext) {
    if (DependencyGraphPanel.currentPanel) {
      DependencyGraphPanel.currentPanel._panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'codelensai.depGraph',
      'File Dependency Graph',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    DependencyGraphPanel.currentPanel = new DependencyGraphPanel(panel);
    panel.onDidDispose(() => { DependencyGraphPanel.currentPanel = undefined; });
  }

  private constructor(panel: vscode.WebviewPanel) {
    this._panel = panel;
    this._panel.webview.html = this.getLoadingHtml();
    this.loadGraph();
  }

  private async loadGraph() {
    const rootPath = getWorkspaceRoot();
    if (!rootPath) {
      this._panel.webview.html = '<body style="color:#ccc;padding:20px;background:#0d0f14;font-family:sans-serif">Open a workspace first.</body>';
      return;
    }

    const nodes = buildDependencyMap(rootPath);

    const graphData = {
      nodes: nodes.map(n => ({
        id: n.relativePath.replace(/\\/g, '/'),
        label: path.basename(n.relativePath),
        ext: path.extname(n.relativePath).slice(1),
        path: n.relativePath.replace(/\\/g, '/'),
        size: n.size,
      })),
      edges: [] as Array<{ from: string; to: string }>,
    };

    for (const node of nodes) {
      const currentFileDir = path.dirname(node.relativePath);
      const sourceId = node.relativePath.replace(/\\/g, '/');

      for (const imp of node.imports) {
        const resolvedRelative = path.join(currentFileDir, imp).replace(/\\/g, '/');
        const target = nodes.find(n => {
          const projectPath = n.relativePath.replace(/\\/g, '/').replace(/\.[^.]+$/, '');
          return projectPath === resolvedRelative || projectPath.endsWith(resolvedRelative);
        });
        if (target) {
          const targetId = target.relativePath.replace(/\\/g, '/');
          if (targetId !== sourceId && !graphData.edges.some(e => e.from === sourceId && e.to === targetId)) {
            graphData.edges.push({ from: sourceId, to: targetId });
          }
        }
      }
    }

    this._panel.webview.html = this.getGraphHtml(JSON.stringify(graphData));
  }

  private getLoadingHtml(): string {
    return '<html><body style="background:#0d0f14;color:#ccc;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif"><div>Scanning project files...</div></body></html>';
  }

  // ALL JS written as plain string array - zero TypeScript template literal escaping issues
  private getGraphHtml(graphDataJson: string): string {
    const css = [
      '*{box-sizing:border-box;margin:0;padding:0}',
      ':root{--bg:#0d0f14;--surface:#13161e;--surface2:#1a1e29;--border:#252a38;--accent:#6c63ff;--accent2:#00d4aa;--accent3:#ff6b6b;--text:#e2e4ed;--muted:#6b7280;--mono:\'JetBrains Mono\',monospace;}',
      'body{background:var(--bg);color:var(--text);font-family:\'Segoe UI\',sans-serif;height:100vh;overflow:hidden;display:flex;flex-direction:column}',
      '#toolbar{padding:10px 16px;background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;flex-shrink:0}',
      '#toolbar h2{font-size:13px;font-weight:700;color:var(--text);flex:1;letter-spacing:-.3px}',
      '#search{background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:6px 12px;border-radius:6px;font-size:11px;width:200px;outline:none;font-family:var(--mono);transition:border-color .2s}',
      '#search:focus{border-color:var(--accent)}#search::placeholder{color:var(--muted)}',
      '.tbtn{font-family:var(--mono);font-size:10px;padding:5px 12px;background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:5px;cursor:pointer;transition:all .15s}',
      '.tbtn:hover{border-color:var(--accent2);color:var(--accent2)}',
      '#stats{font-family:var(--mono);font-size:11px;color:var(--muted)}',
      '#canvas{flex:1;cursor:grab;display:block;width:100%;min-height:0}',
      '#canvas:active{cursor:grabbing}',
      '#tooltip{position:fixed;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px 15px;font-size:11px;font-family:var(--mono);pointer-events:none;display:none;max-width:300px;z-index:999;box-shadow:0 12px 40px rgba(0,0,0,.6)}',
      '#tooltip .tt-name{font-weight:700;color:var(--text);margin-bottom:6px;font-size:12px}',
      '#tooltip .tt-row{color:var(--muted);line-height:1.8}',
      '#tooltip .tt-hl{color:var(--accent2)}',
      '#tooltip .tt-badge{display:inline-block;background:rgba(108,99,255,.15);border:1px solid rgba(108,99,255,.3);color:#a89fff;padding:1px 7px;border-radius:10px;font-size:10px;margin-right:4px;margin-bottom:3px}',
      '#legend{padding:8px 16px;background:var(--surface);border-top:1px solid var(--border);font-size:10px;color:var(--muted);display:flex;gap:16px;align-items:center;flex-shrink:0;flex-wrap:wrap}',
      '.leg{display:flex;align-items:center;gap:5px}',
      '.dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}',
    ].join('\n');

    // JS written as plain string array — safe from TS template literal escaping
    const js = [
      'var DATA = ' + graphDataJson + ';',
      '',
      'var EXT_COLORS={ts:"#5ba3f5",tsx:"#5ba3f5",js:"#f0c030",jsx:"#f0c030",py:"#4caf50",go:"#00acd7",rs:"#f46623",css:"#ab77f7",scss:"#ab77f7",html:"#f07070",json:"#4db6ac",md:"#60a0c0"};',
      'var EXT_BG={ts:"rgba(91,163,245,.12)",tsx:"rgba(91,163,245,.12)",js:"rgba(240,192,48,.1)",jsx:"rgba(240,192,48,.1)",py:"rgba(76,175,80,.1)",go:"rgba(0,172,215,.1)",css:"rgba(171,119,247,.1)",scss:"rgba(171,119,247,.1)",html:"rgba(240,112,112,.1)",json:"rgba(77,182,172,.1)",md:"rgba(96,160,192,.1)"};',
      '',
      'var canvas=document.getElementById("canvas");',
      'var ctx=canvas.getContext("2d");',
      'var tooltip=document.getElementById("tooltip");',
      'var statsEl=document.getElementById("stats");',
      '',
      '// Pre-compute degrees',
      'var degree={};',
      'for(var di=0;di<DATA.edges.length;di++){',
      '  var de=DATA.edges[di];',
      '  degree[de.from]=(degree[de.from]||0)+1;',
      '  degree[de.to]=(degree[de.to]||0)+1;',
      '}',
      '',
      'var nodes=DATA.nodes.map(function(n){return Object.assign({},n,{x:0,y:0,vx:0,vy:0,fixed:false,_deg:degree[n.id]||0});});',
      'var edges=DATA.edges;',
      'var selectedId=null,filterText="";',
      'var panX=0,panY=0,zoom=1;',
      'var dragging=null,isPanning=false,panStart=null;',
      'var positionsReady=false;',
      '',
      'function getNodeRadius(n){return Math.max(5,Math.min(14,5+(n._deg||0)*0.8));}',
      'function getNodeColor(n){if(n.id===selectedId){return "#00d4aa";} return EXT_COLORS[n.ext]||"#6c63ff";}',
      'function getNodeBg(n){return EXT_BG[n.ext]||"rgba(108,99,255,.1)";}',
      '',
      '// KEY FIX: only init positions when canvas has real dimensions',
      'function tryInitPositions(){',
      '  if(positionsReady){return;}',
      '  if(canvas.width<10||canvas.height<10){return;}',
      '  positionsReady=true;',
      '  var sorted=nodes.slice().sort(function(a,b){return (b._deg||0)-(a._deg||0);});',
      '  var cx=canvas.width/2,cy=canvas.height/2,count=sorted.length;',
      '  for(var ni=0;ni<sorted.length;ni++){',
      '    var n=sorted[ni];',
      '    var t=ni/Math.max(count-1,1);',
      '    var r=80+t*Math.min(cx,cy)*0.78;',
      '    var angle=ni*2.399963;',
      '    n.x=cx+Math.cos(angle)*r;',
      '    n.y=cy+Math.sin(angle)*r;',
      '    n.vx=0;n.vy=0;',
      '  }',
      '}',
      '',
      'function resize(){',
      '  var newW=canvas.offsetWidth,newH=canvas.offsetHeight;',
      '  if(newW>0&&newH>0){canvas.width=newW;canvas.height=newH;}',
      '  tryInitPositions();',
      '}',
      '',
      'function resetView(){panX=0;panY=0;zoom=1;positionsReady=false;tryInitPositions();simTick=0;}',
      'function filterGraph(text){filterText=text.toLowerCase();}',
      '',
      'var simTick=0;',
      'function simulate(){',
      '  if(simTick>800||!positionsReady){return;}',
      '  var k=Math.sqrt((canvas.width*canvas.height)/Math.max(nodes.length,1))*1.6;',
      '  for(var ni=0;ni<nodes.length;ni++){nodes[ni].vx=0;nodes[ni].vy=0;}',
      '  // Repulsion',
      '  for(var i=0;i<nodes.length;i++){',
      '    for(var j=i+1;j<nodes.length;j++){',
      '      var a=nodes[i],b=nodes[j];',
      '      var dx=b.x-a.x||0.01,dy=b.y-a.y||0.01,d=Math.sqrt(dx*dx+dy*dy)||1;',
      '      var minD=getNodeRadius(a)+getNodeRadius(b)+20;',
      '      var rep=d<minD?k*k/d*4:k*k/d*0.5;',
      '      var nx=dx/d,ny=dy/d;',
      '      a.vx-=nx*rep;a.vy-=ny*rep;b.vx+=nx*rep;b.vy+=ny*rep;',
      '    }',
      '  }',
      '  // Attraction along edges',
      '  for(var ei=0;ei<edges.length;ei++){',
      '    var e=edges[ei],ea=null,eb=null;',
      '    for(var ni2=0;ni2<nodes.length;ni2++){',
      '      if(nodes[ni2].id===e.from){ea=nodes[ni2];}',
      '      if(nodes[ni2].id===e.to){eb=nodes[ni2];}',
      '    }',
      '    if(!ea||!eb){continue;}',
      '    var edx=eb.x-ea.x,edy=eb.y-ea.y,ed=Math.sqrt(edx*edx+edy*edy)||1;',
      '    var ideal=120+getNodeRadius(ea)+getNodeRadius(eb);',
      '    var ef=(ed-ideal)/ed*0.12;',
      '    ea.vx+=edx*ef;ea.vy+=edy*ef;eb.vx-=edx*ef;eb.vy-=edy*ef;',
      '  }',
      '  // Center gravity',
      '  var cx=canvas.width/2,cy=canvas.height/2;',
      '  for(var ni3=0;ni3<nodes.length;ni3++){',
      '    var n=nodes[ni3];',
      '    if(n.fixed){continue;}',
      '    n.vx+=(cx-n.x)*0.002;n.vy+=(cy-n.y)*0.002;',
      '    n.vx*=0.88;n.vy*=0.88;n.x+=n.vx;n.y+=n.vy;',
      '    n.x=Math.max(30,Math.min(canvas.width-30,n.x));',
      '    n.y=Math.max(30,Math.min(canvas.height-30,n.y));',
      '  }',
      '  simTick++;',
      '}',
      '',
      'function findNode(id){for(var i=0;i<nodes.length;i++){if(nodes[i].id===id){return nodes[i];}}return null;}',
      '',
      'function draw(){',
      '  ctx.clearRect(0,0,canvas.width,canvas.height);',
      '  if(!positionsReady||!nodes.length){',
      '    ctx.fillStyle="#6b7280";ctx.font="13px Segoe UI,sans-serif";',
      '    ctx.textAlign="center";',
      '    ctx.fillText(nodes.length?"Initializing layout...":"No files found",canvas.width/2,canvas.height/2);',
      '    return;',
      '  }',
      '  ctx.save();ctx.translate(panX,panY);ctx.scale(zoom,zoom);',
      '  var vis=[];',
      '  for(var ni=0;ni<nodes.length;ni++){',
      '    if(!filterText||nodes[ni].id.toLowerCase().indexOf(filterText)!==-1){vis.push(nodes[ni]);}',
      '  }',
      '  var visSet={};for(var vi=0;vi<vis.length;vi++){visSet[vis[vi].id]=true;}',
      '  // Connected nodes to selected',
      '  var selConn={};',
      '  if(selectedId){for(var si=0;si<edges.length;si++){var se=edges[si];if(se.from===selectedId){selConn[se.to]="out";}else if(se.to===selectedId){selConn[se.from]="in";}}}',
      '',
      '  // Draw edges',
      '  for(var ei=0;ei<edges.length;ei++){',
      '    var e=edges[ei];',
      '    if(!visSet[e.from]||!visSet[e.to]){continue;}',
      '    var na=findNode(e.from),nb=findNode(e.to);if(!na||!nb){continue;}',
      '    var hl=selectedId&&(e.from===selectedId||e.to===selectedId);',
      '    var dimmed=selectedId&&!hl;',
      '    var ang=Math.atan2(nb.y-na.y,nb.x-na.x);',
      '    var rA=getNodeRadius(na),rB=getNodeRadius(nb);',
      '    var sx=na.x+Math.cos(ang)*rA,sy=na.y+Math.sin(ang)*rA;',
      '    var ex=nb.x-Math.cos(ang)*(rB+4),ey=nb.y-Math.sin(ang)*(rB+4);',
      '    if(hl){',
      '      var grad=ctx.createLinearGradient(sx,sy,ex,ey);',
      '      if(e.from===selectedId){grad.addColorStop(0,"rgba(108,99,255,0.9)");grad.addColorStop(1,"rgba(0,212,170,0.9)");}',
      '      else{grad.addColorStop(0,"rgba(0,212,170,0.6)");grad.addColorStop(1,"rgba(108,99,255,0.9)");}',
      '      ctx.beginPath();ctx.moveTo(sx,sy);ctx.lineTo(ex,ey);',
      '      ctx.strokeStyle=grad;ctx.lineWidth=2/zoom;ctx.globalAlpha=1;ctx.stroke();',
      '      // Arrowhead',
      '      ctx.beginPath();ctx.moveTo(ex,ey);',
      '      ctx.lineTo(ex-Math.cos(ang-0.35)*8/zoom,ey-Math.sin(ang-0.35)*8/zoom);',
      '      ctx.lineTo(ex-Math.cos(ang+0.35)*8/zoom,ey-Math.sin(ang+0.35)*8/zoom);',
      '      ctx.closePath();ctx.fillStyle=e.from===selectedId?"#00d4aa":"#6c63ff";ctx.fill();',
      '    } else {',
      '      ctx.beginPath();ctx.moveTo(sx,sy);ctx.lineTo(ex,ey);',
      '      ctx.strokeStyle=dimmed?"rgba(37,42,56,0.25)":"rgba(37,42,56,0.65)";',
      '      ctx.lineWidth=0.8/zoom;ctx.globalAlpha=1;ctx.stroke();',
      '    }',
      '  }',
      '',
      '  // Draw nodes',
      '  for(var vi2=0;vi2<vis.length;vi2++){',
      '    var nv=vis[vi2];',
      '    var sel=nv.id===selectedId;',
      '    var dimN=selectedId&&!sel&&!selConn[nv.id];',
      '    var rv=getNodeRadius(nv);',
      '    var col=getNodeColor(nv);',
      '    var bg=getNodeBg(nv);',
      '    ctx.globalAlpha=dimN?0.18:1.0;',
      '    // Glow / halo',
      '    if(sel){',
      '      ctx.beginPath();ctx.arc(nv.x,nv.y,rv+9,0,Math.PI*2);ctx.fillStyle="rgba(0,212,170,0.1)";ctx.fill();',
      '      ctx.beginPath();ctx.arc(nv.x,nv.y,rv+5,0,Math.PI*2);ctx.fillStyle="rgba(0,212,170,0.2)";ctx.fill();',
      '    } else if((nv._deg||0)>3){',
      '      ctx.beginPath();ctx.arc(nv.x,nv.y,rv+5,0,Math.PI*2);ctx.fillStyle=bg;ctx.fill();',
      '    }',
      '    // Main circle',
      '    ctx.beginPath();ctx.arc(nv.x,nv.y,rv,0,Math.PI*2);',
      '    ctx.fillStyle=sel?"#00d4aa":((nv._deg||0)>0?col:"#3a3f50");ctx.fill();',
      '    // Inner highlight',
      '    ctx.beginPath();ctx.arc(nv.x-rv*0.25,nv.y-rv*0.25,rv*0.35,0,Math.PI*2);',
      '    ctx.fillStyle="rgba(255,255,255,0.2)";ctx.fill();',
      '    // Label',
      '    if(zoom>0.45||sel||selConn[nv.id]){',
      '      var fs=Math.max(8,Math.min(11,10/zoom));',
      '      var fw=sel?"700 ":((nv._deg||0)>3?"600 ":"");',
      '      ctx.font=fw+fs+"px JetBrains Mono,monospace";',
      '      ctx.textAlign="center";',
      '      // shadow',
      '      ctx.fillStyle="rgba(13,15,20,0.8)";ctx.fillText(nv.label,nv.x+0.5,nv.y+rv+fs+1.5);',
      '      ctx.fillStyle=sel?"#00d4aa":(selConn[nv.id]?"#e2e4ed":((nv._deg||0)>3?col:"#9ca3af"));',
      '      ctx.fillText(nv.label,nv.x,nv.y+rv+fs+1);',
      '    }',
      '    ctx.globalAlpha=1.0;',
      '  }',
      '  ctx.restore();',
      '  var vc=0;for(var ei2=0;ei2<edges.length;ei2++){if(visSet[edges[ei2].from]&&visSet[edges[ei2].to]){vc++;}}',
      '  statsEl.textContent=vis.length+" files \\u00b7 "+vc+" imports";',
      '}',
      '',
      'function getNodeAt(mx,my){',
      '  var wx=(mx-panX)/zoom,wy=(my-panY)/zoom;',
      '  for(var i=nodes.length-1;i>=0;i--){',
      '    var n=nodes[i];var r=getNodeRadius(n)+5;',
      '    if(Math.sqrt((n.x-wx)*(n.x-wx)+(n.y-wy)*(n.y-wy))<r){return n;}',
      '  }',
      '  return null;',
      '}',
      '',
      'canvas.addEventListener("mousedown",function(e){',
      '  var n=getNodeAt(e.offsetX,e.offsetY);',
      '  if(n){dragging=n;n.fixed=true;selectedId=n.id;}',
      '  else{selectedId=null;isPanning=true;panStart={x:e.offsetX-panX,y:e.offsetY-panY};}',
      '});',
      'canvas.addEventListener("mousemove",function(e){',
      '  if(dragging){dragging.x=(e.offsetX-panX)/zoom;dragging.y=(e.offsetY-panY)/zoom;}',
      '  else if(isPanning){panX=e.offsetX-panStart.x;panY=e.offsetY-panStart.y;}',
      '  var n=getNodeAt(e.offsetX,e.offsetY);',
      '  if(n){',
      '    var deps=[],used=[];',
      '    for(var i=0;i<edges.length;i++){',
      '      if(edges[i].from===n.id){deps.push(edges[i].to.split("/").pop());}',
      '      if(edges[i].to===n.id){used.push(edges[i].from.split("/").pop());}',
      '    }',
      '    tooltip.style.display="block";',
      '    tooltip.style.left=(e.clientX+16)+"px";tooltip.style.top=(e.clientY-12)+"px";',
      '    var col=EXT_COLORS[n.ext]||"#6c63ff";',
      '    var dBadges=deps.slice(0,6).map(function(d){return "<span class=\'tt-badge\'>"+d+"</span>";}).join("");',
      '    var uBadges=used.slice(0,6).map(function(d){return "<span class=\'tt-badge\'>"+d+"</span>";}).join("");',
      '    tooltip.innerHTML="<div class=\'tt-name\' style=\'color:"+col+"\'>"+n.id+"</div>"',
      '      +"<div class=\'tt-row\'><span style=\'color:var(--muted)\'>Type: </span><span class=\'tt-hl\'>"+(n.ext||"?").toUpperCase()+"</span></div>"',
      '      +"<div class=\'tt-row\'><span style=\'color:var(--muted)\'>Connections: </span><span class=\'tt-hl\'>"+(n._deg||0)+"</span></div>"',
      '      +(deps.length?"<div style=\'margin-top:6px;color:var(--muted);font-size:10px\'>IMPORTS</div><div>"+dBadges+(deps.length>6?"<span style=\'color:var(--muted)\'>+more</span>":"")+"</div>":"")',
      '      +(used.length?"<div style=\'margin-top:6px;color:var(--muted);font-size:10px\'>USED BY</div><div>"+uBadges+(used.length>6?"<span style=\'color:var(--muted)\'>+more</span>":"")+"</div>":"");',
      '    canvas.style.cursor="pointer";',
      '  } else {tooltip.style.display="none";canvas.style.cursor=isPanning?"grabbing":"grab";}',
      '});',
      'canvas.addEventListener("mouseup",function(){if(dragging){dragging.fixed=false;dragging=null;}isPanning=false;});',
      'canvas.addEventListener("dblclick",function(e){var n=getNodeAt(e.offsetX,e.offsetY);if(n){n.fixed=!n.fixed;}});',
      'canvas.addEventListener("wheel",function(e){',
      '  e.preventDefault();',
      '  var f=e.deltaY>0?0.88:1.12;',
      '  panX=e.offsetX-(e.offsetX-panX)*f;panY=e.offsetY-(e.offsetY-panY)*f;',
      '  zoom=Math.max(0.08,Math.min(zoom*f,8));',
      '},{passive:false});',
      '',
      '// ResizeObserver triggers resize → tryInitPositions when canvas becomes visible',
      'new ResizeObserver(function(){resize();}).observe(canvas);',
      'resize();',
      '',
      'function loop(){simulate();draw();requestAnimationFrame(loop);}',
      'loop();',
    ].join('\n');

    const html = [
      '<!DOCTYPE html><html><head>',
      '<meta charset="UTF-8">',
      '<style>' + css + '</style>',
      '</head><body>',
      '<div id="toolbar">',
      '  <h2>&#x1F4C1; File Dependency Graph</h2>',
      '  <input id="search" placeholder="&#x1F50D; Filter files..." oninput="filterGraph(this.value)">',
      '  <span id="stats"></span>',
      '  <button class="tbtn" onclick="resetView()">&#x1F504; Reset</button>',
      '</div>',
      '<canvas id="canvas"></canvas>',
      '<div id="tooltip"></div>',
      '<div id="legend">',
      '  <div class="leg"><div class="dot" style="background:#5ba3f5"></div>.ts/.tsx</div>',
      '  <div class="leg"><div class="dot" style="background:#f0c030"></div>.js/.jsx</div>',
      '  <div class="leg"><div class="dot" style="background:#4caf50"></div>.py</div>',
      '  <div class="leg"><div class="dot" style="background:#ab77f7"></div>.css/.scss</div>',
      '  <div class="leg"><div class="dot" style="background:#f07070"></div>.html</div>',
      '  <div class="leg"><div class="dot" style="background:#4db6ac"></div>.json</div>',
      '  <div class="leg"><div class="dot" style="background:#3a3f50"></div>standalone</div>',
      '  <span style="margin-left:auto;font-size:10px">Scroll=zoom &#183; Click=select &#183; Drag=move &#183; Dblclick=pin</span>',
      '</div>',
      '<script>' + js + '<\/script>',
      '</body></html>',
    ].join('\n');

    return html;
  }
}
