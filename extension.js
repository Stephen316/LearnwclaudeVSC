const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const HINTS_FILE = '.claude-hints.json';

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
        reason: typeof h.reason === 'string' ? h.reason : '',
      });
    }
  }
  return result;
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
    hoverMessage: new vscode.MarkdownString('**Claude:** ' + (h.reason || '(no reason given)')),
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
    const d = new vscode.Diagnostic(range, h.reason || 'Claude flagged this', vscode.DiagnosticSeverity.Information);
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
      description: h.reason,
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

  context.subscriptions.push(
    decorationType,
    diagnostics,
    vscode.commands.registerCommand('claudeHints.list', showList),
    vscode.commands.registerCommand('claudeHints.clear', clearAll),
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
