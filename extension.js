const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const HINTS_FILE = '.claude-hints.json';

// Claude writes each hint as five tiers, least to most help. Difficulty picks
// which tier is shown; Expert shows none, only the highlighted line.
const DIFFICULTIES = [
  { value: 1, label: 'Very easy', detail: 'What is wrong and the direction of the fix' },
  { value: 2, label: 'Easy', detail: 'What is wrong and why' },
  { value: 3, label: 'Medium', detail: 'Names the problem' },
  { value: 4, label: 'Hard', detail: 'Where to look' },
  { value: 5, label: 'Very hard', detail: 'A vague nudge' },
  { value: 6, label: 'Expert', detail: 'Just the line, no text' },
];
const DEFAULT_DIFFICULTY = 3;

let decorationType;
let diagnostics;
let hints = [];
const watchers = new Map();

function readHints() {
  const result = [];
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const hintsPath = path.join(folder.uri.fsPath, HINTS_FILE);
    let raw;
    try {
      raw = fs.readFileSync(hintsPath, 'utf8');
    } catch {
      continue;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!Array.isArray(data)) continue;
    for (const h of data) {
      if (!h || typeof h.file !== 'string' || !Number.isInteger(h.line) || h.line < 1) continue;
      const end = Number.isInteger(h.endLine) && h.endLine >= h.line ? h.endLine : h.line;
      const abs = path.isAbsolute(h.file) ? h.file : path.join(folder.uri.fsPath, h.file);
      result.push({
        uri: vscode.Uri.file(abs),
        start: h.line - 1,
        end: end - 1,
        tiers: tiersOf(h),
      });
    }
  }
  return result;
}

function tiersOf(h) {
  if (Array.isArray(h.hints)) {
    const tiers = h.hints.filter((t) => typeof t === 'string' && t.trim() !== '');
    if (tiers.length > 0) return tiers;
  }
  return typeof h.reason === 'string' && h.reason.trim() !== '' ? [h.reason] : [];
}

function getDifficulty() {
  const value = vscode.workspace.getConfiguration('claudeHints').get('difficulty', DEFAULT_DIFFICULTY);
  return Number.isInteger(value) && value >= 1 && value <= DIFFICULTIES.length ? value : DEFAULT_DIFFICULTY;
}

function setDifficulty(value) {
  return vscode.workspace.getConfiguration('claudeHints').update('difficulty', value, vscode.ConfigurationTarget.Global);
}

function textFor(hint) {
  const difficulty = getDifficulty();
  if (difficulty === DIFFICULTIES.length || hint.tiers.length === 0) return '';
  // Scale rather than index, so hints written with fewer tiers still spread
  // across the whole slider.
  const help = (DIFFICULTIES.length - 1 - difficulty) / (DIFFICULTIES.length - 2);
  const index = Math.round(help * (hint.tiers.length - 1));
  return hint.tiers[index];
}

function clampRange(doc, hint) {
  const last = Math.max(doc.lineCount - 1, 0);
  const start = Math.min(hint.start, last);
  const end = Math.min(hint.end, last);
  return new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
}

function applyToEditor(editor) {
  const mine = hints.filter((h) => h.uri.fsPath === editor.document.uri.fsPath);
  const options = mine.map((h) => ({
    range: clampRange(editor.document, h),
    hoverMessage: new vscode.MarkdownString('**Claude:** ' + (textFor(h) || 'flagged this line')),
  }));
  editor.setDecorations(decorationType, options);
}

function render() {
  for (const editor of vscode.window.visibleTextEditors) {
    applyToEditor(editor);
  }

  diagnostics.clear();
  const byFile = new Map();
  for (const h of hints) {
    const key = h.uri.toString();
    if (!byFile.has(key)) byFile.set(key, { uri: h.uri, items: [] });
    const range = new vscode.Range(h.start, 0, h.end, Number.MAX_SAFE_INTEGER);
    const d = new vscode.Diagnostic(range, textFor(h) || 'Claude flagged this', vscode.DiagnosticSeverity.Information);
    d.source = 'Claude';
    byFile.get(key).items.push(d);
  }
  for (const { uri, items } of byFile.values()) diagnostics.set(uri, items);
}

function refresh() {
  hints = readHints();
  render();
}

// Hints are line numbers from when Claude wrote them. Shift them as the user
// edits so they stay on the same code until the hints file is rewritten.
// VS Code reports content changes bottom-up in pre-edit coordinates, so they
// can be applied one after another.
function shiftForEdit(event) {
  const fsPath = event.document.uri.fsPath;
  let moved = false;
  for (const change of event.contentChanges) {
    const firstLine = change.range.start.line;
    const lastLine = change.range.end.line;
    const delta = (change.text.match(/\n/g) || []).length - (lastLine - firstLine);
    if (delta === 0) continue;
    for (const h of hints) {
      if (h.uri.fsPath !== fsPath) continue;
      const editIsAbove = h.start > lastLine ||
        (h.start === lastLine && (firstLine < lastLine || change.range.end.character === 0));
      if (editIsAbove) {
        h.start += delta;
        h.end += delta;
        moved = true;
      } else if (h.end >= lastLine) {
        h.end = Math.max(h.start, h.end + delta);
        moved = true;
      }
    }
  }
  if (moved) render();
}

function watchFolder(folder, context) {
  const key = folder.uri.toString();
  if (watchers.has(key)) return;
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, HINTS_FILE));
  watcher.onDidCreate(refresh);
  watcher.onDidChange(refresh);
  watcher.onDidDelete(refresh);
  watchers.set(key, watcher);
  context.subscriptions.push(watcher);
}

function unwatchFolder(folder) {
  const key = folder.uri.toString();
  const watcher = watchers.get(key);
  if (!watcher) return;
  watcher.dispose();
  watchers.delete(key);
}

async function showList() {
  if (hints.length === 0) {
    vscode.window.showInformationMessage('No Claude hints right now.');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    hints.map((h) => ({
      label: `${vscode.workspace.asRelativePath(h.uri)}:${h.start + 1}`,
      description: textFor(h),
      hint: h,
    })),
    { placeHolder: 'Jump to a line Claude flagged' }
  );
  if (!picked) return;
  const doc = await vscode.workspace.openTextDocument(picked.hint.uri);
  const editor = await vscode.window.showTextDocument(doc);
  const range = clampRange(doc, picked.hint);
  editor.selection = new vscode.Selection(range.start, range.start);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

async function pickDifficulty() {
  const current = getDifficulty();
  const picked = await vscode.window.showQuickPick(
    DIFFICULTIES.map((d) => ({
      label: d.label,
      description: d.value === current ? '(current)' : '',
      detail: d.detail,
      value: d.value,
    })),
    { placeHolder: 'How much should Claude\'s hints give away?' }
  );
  if (picked) await setDifficulty(picked.value);
}

class DifficultyView {
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = difficultyHtml(view.webview, getDifficulty());
    view.webview.onDidReceiveMessage((message) => {
      if (message && Number.isInteger(message.difficulty)) setDifficulty(message.difficulty);
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) this.sync();
    });
    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  sync() {
    if (this.view) this.view.webview.postMessage({ difficulty: getDifficulty() });
  }
}

function difficultyHtml(webview, difficulty) {
  const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const levels = JSON.stringify(DIFFICULTIES);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { padding: 8px 4px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
  label { display: block; margin-bottom: 6px; }
  input[type=range] { width: 100%; accent-color: var(--vscode-focusBorder); }
  .ticks { display: flex; justify-content: space-between; font-size: 0.85em; opacity: 0.8; }
  .current { margin-top: 10px; font-weight: 600; }
  .detail { margin-top: 2px; opacity: 0.8; }
  .note { margin-top: 12px; font-size: 0.85em; opacity: 0.7; }
</style>
</head>
<body>
  <label for="difficulty">Hint difficulty</label>
  <input id="difficulty" type="range" min="1" max="${DIFFICULTIES.length}" step="1" value="${difficulty}">
  <div class="ticks"><span>${DIFFICULTIES[0].label}</span><span>${DIFFICULTIES[DIFFICULTIES.length - 1].label}</span></div>
  <div class="current" id="current"></div>
  <div class="detail" id="detail"></div>
  <div class="note">Hints never include the solution. Ask Claude for it when you want it.</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const levels = ${levels};
  const slider = document.getElementById('difficulty');
  function show(value) {
    const level = levels.find((l) => l.value === value);
    document.getElementById('current').textContent = level.label;
    document.getElementById('detail').textContent = level.detail;
  }
  slider.addEventListener('input', () => show(Number(slider.value)));
  slider.addEventListener('change', () => vscode.postMessage({ difficulty: Number(slider.value) }));
  window.addEventListener('message', (event) => {
    slider.value = event.data.difficulty;
    show(event.data.difficulty);
  });
  show(${difficulty});
</script>
</body>
</html>`;
}

function clearAll() {
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const hintsPath = path.join(folder.uri.fsPath, HINTS_FILE);
    try {
      fs.writeFileSync(hintsPath, '[]\n');
    } catch {
    }
  }
  refresh();
}

function activate(context) {
  decorationType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    borderColor: new vscode.ThemeColor('editorWarning.foreground'),
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  diagnostics = vscode.languages.createDiagnosticCollection('claude-hints');
  const difficultyView = new DifficultyView();

  context.subscriptions.push(
    decorationType,
    diagnostics,
    vscode.commands.registerCommand('claudeHints.list', showList),
    vscode.commands.registerCommand('claudeHints.clear', clearAll),
    vscode.commands.registerCommand('claudeHints.setDifficulty', pickDifficulty),
    vscode.window.registerWebviewViewProvider('claudeHints.difficultyView', difficultyView),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('claudeHints.difficulty')) return;
      render();
      difficultyView.sync();
    }),
    vscode.window.onDidChangeVisibleTextEditors(render),
    vscode.workspace.onDidChangeTextDocument(shiftForEdit),
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const folder of e.removed) unwatchFolder(folder);
      for (const folder of e.added) watchFolder(folder, context);
      refresh();
    })
  );

  for (const folder of vscode.workspace.workspaceFolders || []) {
    watchFolder(folder, context);
  }

  refresh();
}

function deactivate() {}

module.exports = { activate, deactivate };
