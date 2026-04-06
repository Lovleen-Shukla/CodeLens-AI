# dependencyGraphPanel.ts — Fullscreen Button Fix

The `openFullscreen()` function exists and works correctly.
The bug is simply that the button to call it was accidentally removed from the toolbar HTML.

## Fix 1 — Add Fullscreen button to the toolbar

In the `html` array at the bottom of `_graphHtml()`, find:

```javascript
'  <button class="tb-btn" onclick="showKbdHints()" title="Shortcuts (?)">&#x2328; Keys</button>',
'</div>',
```

Change to:

```javascript
'  <button class="tb-btn" onclick="showKbdHints()" title="Shortcuts (?)">&#x2328; Keys</button>',
'  <button class="tb-btn" onclick="openFullscreen()" title="Fullscreen (F)" style="border-color:var(--accent);color:var(--accent)">&#x26F6; Fullscreen</button>',
'</div>',
```

## Fix 2 — Add F key to keyboard hints modal

In the `html` array, find:

```javascript
'    <div class="krow"><kbd>R</kbd><span>Reset layout</span></div>',
```

Change to:

```javascript
'    <div class="krow"><kbd>F</kbd><span>Toggle fullscreen</span></div>',
'    <div class="krow"><kbd>R</kbd><span>Reset layout</span></div>',
```

That's it. Both changes are in the HTML string array at the very bottom of `_graphHtml()`.
The JS logic for fullscreen (openFullscreen, closeFullscreen, fsFit, fsDoZoom etc.) is all correct and untouched.
