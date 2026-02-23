import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentState } from './types.js';
import { getProjectDirPath } from './agentManager.js';
import { startFileWatching, readNewLines } from './fileWatcher.js';

let jsonlFile: string | null = null;
let isActive = false;
const editorDisposables: vscode.Disposable[] = [];
let activeToolId: string | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let editDebounceTimer: ReturnType<typeof setTimeout> | null = null;

const IDLE_TIMEOUT_MS = 4000;
const EDIT_DEBOUNCE_MS = 500;

function generateToolId(): string {
    return 'toolu_ag_' + Math.random().toString(36).substr(2, 12);
}

function writeLog(data: Record<string, unknown>): void {
    if (!jsonlFile) return;
    try {
        fs.appendFileSync(jsonlFile, JSON.stringify(data) + '\n', 'utf8');
    } catch (e) {
        console.log(`[Antigravity Bridge] Write error: ${e}`);
    }
}

function endCurrentTool(): void {
    if (activeToolId) {
        writeLog({
            type: 'user',
            message: {
                content: [
                    { type: 'tool_result', tool_use_id: activeToolId }
                ]
            }
        });
        activeToolId = null;
    }
}

function startTool(toolName: string, input: Record<string, unknown>): void {
    endCurrentTool();
    const id = generateToolId();
    activeToolId = id;
    writeLog({
        type: 'assistant',
        message: {
            content: [
                {
                    type: 'tool_use',
                    id,
                    name: toolName,
                    input,
                }
            ]
        }
    });
}

function markIdle(): void {
    endCurrentTool();
    writeLog({
        type: 'system',
        subtype: 'turn_duration',
    });
}

function resetIdleTimer(): void {
    if (idleTimer) {
        clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
        markIdle();
    }, IDLE_TIMEOUT_MS);
}

/**
 * Start the Antigravity Bridge as a registered agent inside Pixel Agents.
 * Call this AFTER the webview is ready and project scan has seeded.
 */
export function startAntigravityBridge(
    agentId: number,
    agents: Map<number, AgentState>,
    fileWatchers: Map<number, fs.FSWatcher>,
    pollingTimers: Map<number, ReturnType<typeof setInterval>>,
    waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
    permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
    webview: vscode.Webview | undefined,
    persistAgents: () => void,
): void {
    if (isActive) return;

    const projectDir = getProjectDirPath();
    if (!projectDir) {
        console.log('[Antigravity Bridge] No project dir found, skipping');
        return;
    }

    // Ensure the directory exists
    if (!fs.existsSync(projectDir)) {
        fs.mkdirSync(projectDir, { recursive: true });
    }

    // Create a distinctive JSONL file
    const sessionId = `antigravity-live-${Date.now()}`;
    jsonlFile = path.join(projectDir, `${sessionId}.jsonl`);

    // Write initial user message
    writeLog({
        type: 'user',
        message: {
            content: '🚀 Antigravity agent connected'
        }
    });

    console.log(`[Antigravity Bridge] JSONL created: ${jsonlFile}`);

    // Create a pseudo-terminal for the Antigravity agent
    const pty: vscode.Pseudoterminal = {
        onDidWrite: new vscode.EventEmitter<string>().event,
        open: () => { /* noop */ },
        close: () => { /* noop */ },
    };
    const terminal = vscode.window.createTerminal({
        name: 'Antigravity Agent',
        pty,
        isTransient: true,
    });

    // Register agent state
    const agent: AgentState = {
        id: agentId,
        terminalRef: terminal,
        projectDir,
        jsonlFile,
        fileOffset: 0,
        lineBuffer: '',
        activeToolIds: new Set(),
        activeToolStatuses: new Map(),
        activeToolNames: new Map(),
        activeSubagentToolIds: new Map(),
        activeSubagentToolNames: new Map(),
        isWaiting: false,
        permissionSent: false,
        hadToolsInTurn: false,
    };

    agents.set(agentId, agent);
    persistAgents();

    // Notify webview about the new agent
    webview?.postMessage({ type: 'agentCreated', id: agentId });
    console.log(`[Antigravity Bridge] Agent ${agentId} registered`);

    // Start file watching so Pixel Agents reads our JSONL
    startFileWatching(agentId, jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
    readNewLines(agentId, agents, waitingTimers, permissionTimers, webview);

    isActive = true;

    // --- Listen to real editor events ---

    // 1. Active file changed → Read
    editorDisposables.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (!editor) return;
            if (editor.document.uri.scheme !== 'file') return;
            const filePath = editor.document.uri.fsPath;
            if (jsonlFile && filePath === jsonlFile) return;
            if (filePath.endsWith('.jsonl')) return;

            startTool('Read', { file_path: filePath });
            resetIdleTimer();
        })
    );

    // 2. File saved → Write
    editorDisposables.push(
        vscode.workspace.onDidSaveTextDocument((doc) => {
            if (doc.uri.scheme !== 'file') return;
            const filePath = doc.uri.fsPath;
            if (jsonlFile && filePath === jsonlFile) return;
            if (filePath.endsWith('.jsonl')) return;

            startTool('Write', { file_path: filePath });
            resetIdleTimer();
        })
    );

    // 3. File content changed → Edit (debounced)
    editorDisposables.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
            if (event.contentChanges.length === 0) return;
            if (event.document.uri.scheme !== 'file') return;
            const filePath = event.document.uri.fsPath;
            if (jsonlFile && filePath === jsonlFile) return;
            if (filePath.endsWith('.jsonl')) return;

            // Debounce edits so we don't spam on every keystroke
            if (editDebounceTimer) {
                clearTimeout(editDebounceTimer);
            }
            editDebounceTimer = setTimeout(() => {
                startTool('Edit', { file_path: filePath });
                resetIdleTimer();
            }, EDIT_DEBOUNCE_MS);
        })
    );

    // 4. Terminal activity → Bash
    editorDisposables.push(
        vscode.window.onDidOpenTerminal((t) => {
            if (t.name === 'Antigravity Agent') return;
            startTool('Bash', { command: `Terminal: ${t.name}` });
            resetIdleTimer();
        })
    );

    // Fire initial Read if a file is open
    if (vscode.window.activeTextEditor) {
        const filePath = vscode.window.activeTextEditor.document.uri.fsPath;
        if (!filePath.endsWith('.jsonl')) {
            startTool('Read', { file_path: filePath });
            resetIdleTimer();
        }
    }

    console.log('[Antigravity Bridge] Editor listeners attached ✅');
}

export function stopAntigravityBridge(): void {
    if (!isActive) return;

    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
    if (editDebounceTimer) {
        clearTimeout(editDebounceTimer);
        editDebounceTimer = null;
    }

    endCurrentTool();
    markIdle();

    for (const d of editorDisposables) {
        d.dispose();
    }
    editorDisposables.length = 0;

    jsonlFile = null;
    isActive = false;
    console.log('[Antigravity Bridge] Stopped');
}
