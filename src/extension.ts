import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface AgentState {
	id: number;
	terminalRef: vscode.Terminal;
	projectDir: string;
	jsonlFile: string;
	fileOffset: number;
	lineBuffer: string;
	activeToolIds: Set<string>;
	activeToolStatuses: Map<string, string>;
	activeToolNames: Map<string, string>;
	activeSubagentToolIds: Map<string, Set<string>>; // parentToolId → active sub-tool IDs
	isWaiting: boolean;
	permissionSent: boolean;
}

interface PersistedAgent {
	id: number;
	terminalName: string;
	jsonlFile: string;
	projectDir: string;
}

class ArcadiaViewProvider implements vscode.WebviewViewProvider {
	private nextAgentId = 1;
	private nextTerminalIndex = 1;
	private agents = new Map<number, AgentState>();
	private webviewView: vscode.WebviewView | undefined;

	// Per-agent timers
	private fileWatchers = new Map<number, fs.FSWatcher>();
	private pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
	private waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
	private jsonlPollTimers = new Map<number, ReturnType<typeof setInterval>>();
	private permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

	// Tools exempt from permission-wait detection (they legitimately go silent)
	private static PERMISSION_EXEMPT_TOOLS = new Set(['Task', 'AskUserQuestion']);

	// /clear detection: project-level scan for new JSONL files
	private activeAgentId: number | null = null;
	private knownJsonlFiles = new Set<string>();
	private projectScanTimer: ReturnType<typeof setInterval> | null = null;

	constructor(private readonly context: vscode.ExtensionContext) {}

	private get extensionUri(): vscode.Uri {
		return this.context.extensionUri;
	}

	resolveWebviewView(webviewView: vscode.WebviewView) {
		this.webviewView = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = getWebviewContent(webviewView.webview, this.extensionUri);

		webviewView.webview.onDidReceiveMessage((message) => {
			if (message.type === 'openClaude') {
				this.launchNewTerminal();
			} else if (message.type === 'focusAgent') {
				const agent = this.agents.get(message.id);
				if (agent) {
					agent.terminalRef.show();
				}
			} else if (message.type === 'closeAgent') {
				const agent = this.agents.get(message.id);
				if (agent) {
					agent.terminalRef.dispose();
				}
			} else if (message.type === 'webviewReady') {
				this.restoreAgents();
				this.sendExistingAgents();
			} else if (message.type === 'openSessionsFolder') {
				const projectDir = this.getProjectDirPath();
				if (projectDir && fs.existsSync(projectDir)) {
					vscode.env.openExternal(vscode.Uri.file(projectDir));
				}
			}
		});

		vscode.window.onDidChangeActiveTerminal((terminal) => {
			this.activeAgentId = null;
			if (!terminal) { return; }
			for (const [id, agent] of this.agents) {
				if (agent.terminalRef === terminal) {
					this.activeAgentId = id;
					webviewView.webview.postMessage({ type: 'agentSelected', id });
					break;
				}
			}
		});

		vscode.window.onDidCloseTerminal((closed) => {
			for (const [id, agent] of this.agents) {
				if (agent.terminalRef === closed) {
					if (this.activeAgentId === id) {
						this.activeAgentId = null;
					}
					this.removeAgent(id);
					webviewView.webview.postMessage({ type: 'agentClosed', id });
				}
			}
		});
	}

	private launchNewTerminal() {
		const idx = this.nextTerminalIndex++;
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const terminal = vscode.window.createTerminal({
			name: `Claude Code #${idx}`,
			cwd,
		});
		terminal.show();

		const sessionId = crypto.randomUUID();
		terminal.sendText(`claude --session-id ${sessionId}`);

		const projectDir = this.getProjectDirPath(cwd);
		if (!projectDir) {
			console.log(`[Arcadia] No project dir, cannot track agent`);
			return;
		}

		// Pre-register expected JSONL file so project scan won't treat it as a /clear file
		const expectedFile = path.join(projectDir, `${sessionId}.jsonl`);
		this.knownJsonlFiles.add(expectedFile);

		// Create agent immediately (before JSONL file exists)
		const id = this.nextAgentId++;
		const agent: AgentState = {
			id,
			terminalRef: terminal,
			projectDir,
			jsonlFile: expectedFile,
			fileOffset: 0,
			lineBuffer: '',
			activeToolIds: new Set(),
			activeToolStatuses: new Map(),
			activeToolNames: new Map(),
			activeSubagentToolIds: new Map(),
			isWaiting: false,
			permissionSent: false,
		};

		this.agents.set(id, agent);
		this.activeAgentId = id;
		this.persistAgents();
		console.log(`[Arcadia] Agent ${id}: created for terminal ${terminal.name}`);
		this.webviewView?.webview.postMessage({ type: 'agentCreated', id });

		this.ensureProjectScan(projectDir);

		// Poll for the specific JSONL file to appear
		const pollTimer = setInterval(() => {
			try {
				if (fs.existsSync(agent.jsonlFile)) {
					console.log(`[Arcadia] Agent ${id}: found JSONL file ${path.basename(agent.jsonlFile)}`);
					clearInterval(pollTimer);
					this.jsonlPollTimers.delete(id);
					this.startFileWatching(id, agent.jsonlFile);
					this.readNewLines(id);
				}
			} catch { /* file may not exist yet */ }
		}, 1000);
		this.jsonlPollTimers.set(id, pollTimer);
	}

	private ensureProjectScan(projectDir: string) {
		if (this.projectScanTimer) { return; }
		// Seed with all existing JSONL files so we only react to truly new ones
		try {
			const files = fs.readdirSync(projectDir)
				.filter(f => f.endsWith('.jsonl'))
				.map(f => path.join(projectDir, f));
			for (const f of files) {
				this.knownJsonlFiles.add(f);
			}
		} catch { /* dir may not exist yet */ }

		this.projectScanTimer = setInterval(() => {
			this.scanForNewJsonlFiles(projectDir);
		}, 1000);
	}

	private scanForNewJsonlFiles(projectDir: string) {
		let files: string[];
		try {
			files = fs.readdirSync(projectDir)
				.filter(f => f.endsWith('.jsonl'))
				.map(f => path.join(projectDir, f));
		} catch { return; }

		for (const file of files) {
			if (!this.knownJsonlFiles.has(file)) {
				this.knownJsonlFiles.add(file);
				if (this.activeAgentId !== null) {
					console.log(`[Arcadia] New JSONL detected: ${path.basename(file)}, reassigning to agent ${this.activeAgentId}`);
					this.reassignAgentToFile(this.activeAgentId, file);
				}
			}
		}
	}

	private reassignAgentToFile(agentId: number, newFilePath: string) {
		const agent = this.agents.get(agentId);
		if (!agent) { return; }

		// Stop old file watching
		this.fileWatchers.get(agentId)?.close();
		this.fileWatchers.delete(agentId);
		const pt = this.pollingTimers.get(agentId);
		if (pt) { clearInterval(pt); }
		this.pollingTimers.delete(agentId);

		// Clear activity
		this.cancelWaitingTimer(agentId);
		this.cancelPermissionTimer(agentId);
		this.clearAgentActivity(agentId);

		// Swap to new file
		agent.jsonlFile = newFilePath;
		agent.fileOffset = 0;
		agent.lineBuffer = '';
		this.persistAgents();

		// Start watching new file
		this.startFileWatching(agentId, newFilePath);
		this.readNewLines(agentId);
	}

	private startFileWatching(agentId: number, filePath: string) {
		// Primary: fs.watch
		try {
			const watcher = fs.watch(filePath, () => {
				this.readNewLines(agentId);
			});
			this.fileWatchers.set(agentId, watcher);
		} catch (e) {
			console.log(`[Arcadia] fs.watch failed for agent ${agentId}: ${e}`);
		}

		// Backup: poll every 2s
		const interval = setInterval(() => {
			if (!this.agents.has(agentId)) { clearInterval(interval); return; }
			this.readNewLines(agentId);
		}, 2000);
		this.pollingTimers.set(agentId, interval);
	}

	private removeAgent(agentId: number) {
		const agent = this.agents.get(agentId);
		if (!agent) { return; }

		// Stop JSONL poll timer
		const jpTimer = this.jsonlPollTimers.get(agentId);
		if (jpTimer) { clearInterval(jpTimer); }
		this.jsonlPollTimers.delete(agentId);

		// Stop file watching
		this.fileWatchers.get(agentId)?.close();
		this.fileWatchers.delete(agentId);
		const pt = this.pollingTimers.get(agentId);
		if (pt) { clearInterval(pt); }
		this.pollingTimers.delete(agentId);

		// Cancel timers
		this.cancelWaitingTimer(agentId);
		this.cancelPermissionTimer(agentId);

		// Remove from maps
		this.agents.delete(agentId);
		this.persistAgents();
	}

	private persistAgents() {
		const persisted: PersistedAgent[] = [];
		for (const agent of this.agents.values()) {
			persisted.push({
				id: agent.id,
				terminalName: agent.terminalRef.name,
				jsonlFile: agent.jsonlFile,
				projectDir: agent.projectDir,
			});
		}
		this.context.workspaceState.update('arcadia.agents', persisted);
	}

	private restoreAgents() {
		const persisted = this.context.workspaceState.get<PersistedAgent[]>('arcadia.agents', []);
		if (persisted.length === 0) { return; }

		const liveTerminals = vscode.window.terminals;
		let maxId = 0;
		let maxIdx = 0;
		let restoredProjectDir: string | null = null;

		for (const p of persisted) {
			const terminal = liveTerminals.find(t => t.name === p.terminalName);
			if (!terminal) { continue; }

			const agent: AgentState = {
				id: p.id,
				terminalRef: terminal,
				projectDir: p.projectDir,
				jsonlFile: p.jsonlFile,
				fileOffset: 0,
				lineBuffer: '',
				activeToolIds: new Set(),
				activeToolStatuses: new Map(),
				activeToolNames: new Map(),
				activeSubagentToolIds: new Map(),
				isWaiting: false,
				permissionSent: false,
			};

			this.agents.set(p.id, agent);
			this.knownJsonlFiles.add(p.jsonlFile);
			console.log(`[Arcadia] Restored agent ${p.id} → terminal "${p.terminalName}"`);

			if (p.id > maxId) { maxId = p.id; }
			// Extract terminal index from name like "Claude Code #3"
			const match = p.terminalName.match(/#(\d+)$/);
			if (match) {
				const idx = parseInt(match[1], 10);
				if (idx > maxIdx) { maxIdx = idx; }
			}

			restoredProjectDir = p.projectDir;

			// Start file watching if JSONL exists, skipping to end of file
			try {
				if (fs.existsSync(p.jsonlFile)) {
					const stat = fs.statSync(p.jsonlFile);
					agent.fileOffset = stat.size;
					this.startFileWatching(p.id, p.jsonlFile);
				} else {
					// Poll for the file to appear
					const pollTimer = setInterval(() => {
						try {
							if (fs.existsSync(agent.jsonlFile)) {
								console.log(`[Arcadia] Restored agent ${p.id}: found JSONL file`);
								clearInterval(pollTimer);
								this.jsonlPollTimers.delete(p.id);
								const stat = fs.statSync(agent.jsonlFile);
								agent.fileOffset = stat.size;
								this.startFileWatching(p.id, agent.jsonlFile);
							}
						} catch { /* file may not exist yet */ }
					}, 1000);
					this.jsonlPollTimers.set(p.id, pollTimer);
				}
			} catch { /* ignore errors during restore */ }
		}

		// Advance counters past restored IDs
		if (maxId >= this.nextAgentId) {
			this.nextAgentId = maxId + 1;
		}
		if (maxIdx >= this.nextTerminalIndex) {
			this.nextTerminalIndex = maxIdx + 1;
		}

		// Re-persist cleaned-up list (removes entries whose terminals are gone)
		this.persistAgents();

		// Start project scan for /clear detection
		if (restoredProjectDir) {
			this.ensureProjectScan(restoredProjectDir);
		}
	}

	private sendExistingAgents() {
		if (!this.webviewView) { return; }
		const agentIds: number[] = [];
		for (const id of this.agents.keys()) {
			agentIds.push(id);
		}
		agentIds.sort((a, b) => a - b);
		this.webviewView.webview.postMessage({
			type: 'existingAgents',
			agents: agentIds,
		});

		this.sendCurrentAgentStatuses();
	}

	private sendCurrentAgentStatuses() {
		if (!this.webviewView) { return; }
		for (const [agentId, agent] of this.agents) {
			// Re-send active tools
			for (const [toolId, status] of agent.activeToolStatuses) {
				this.webviewView.webview.postMessage({
					type: 'agentToolStart',
					id: agentId,
					toolId,
					status,
				});
			}
			// Re-send waiting status
			if (agent.isWaiting) {
				this.webviewView.webview.postMessage({
					type: 'agentStatus',
					id: agentId,
					status: 'waiting',
				});
			}
		}
	}

	// --- Transcript JSONL reading ---

	private getProjectDirPath(cwd?: string): string | null {
		const workspacePath = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspacePath) { return null; }
		const dirName = workspacePath.replace(/[:\\/]/g, '-');
		return path.join(os.homedir(), '.claude', 'projects', dirName);
	}

	private readNewLines(agentId: number) {
		const agent = this.agents.get(agentId);
		if (!agent) { return; }
		try {
			const stat = fs.statSync(agent.jsonlFile);
			if (stat.size <= agent.fileOffset) { return; }

			const buf = Buffer.alloc(stat.size - agent.fileOffset);
			const fd = fs.openSync(agent.jsonlFile, 'r');
			fs.readSync(fd, buf, 0, buf.length, agent.fileOffset);
			fs.closeSync(fd);
			agent.fileOffset = stat.size;

			const text = agent.lineBuffer + buf.toString('utf-8');
			const lines = text.split('\n');
			agent.lineBuffer = lines.pop() || '';

			const hasLines = lines.some(l => l.trim());
			if (hasLines) {
				// New data arriving — cancel permission timer (data flowing means not stuck on permission)
				this.cancelPermissionTimer(agentId);
				if (agent.permissionSent) {
					agent.permissionSent = false;
					this.webviewView?.webview.postMessage({ type: 'agentToolPermissionClear', id: agentId });
				}
			}

			for (const line of lines) {
				if (!line.trim()) { continue; }
				this.processTranscriptLine(agentId, line);
			}
		} catch (e) {
			console.log(`[Arcadia] Read error for agent ${agentId}: ${e}`);
		}
	}

	private clearAgentActivity(agentId: number) {
		const agent = this.agents.get(agentId);
		if (!agent) { return; }
		agent.activeToolIds.clear();
		agent.activeToolStatuses.clear();
		agent.activeToolNames.clear();
		agent.activeSubagentToolIds.clear();
		agent.isWaiting = false;
		agent.permissionSent = false;
		this.cancelPermissionTimer(agentId);
		this.webviewView?.webview.postMessage({ type: 'agentToolsClear', id: agentId });
		this.webviewView?.webview.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
	}

	private cancelWaitingTimer(agentId: number) {
		const timer = this.waitingTimers.get(agentId);
		if (timer) {
			clearTimeout(timer);
			this.waitingTimers.delete(agentId);
		}
	}

	private startWaitingTimer(agentId: number, delayMs: number) {
		this.cancelWaitingTimer(agentId);
		const timer = setTimeout(() => {
			this.waitingTimers.delete(agentId);
			const agent = this.agents.get(agentId);
			if (agent) {
				agent.isWaiting = true;
			}
			this.webviewView?.webview.postMessage({
				type: 'agentStatus',
				id: agentId,
				status: 'waiting',
			});
		}, delayMs);
		this.waitingTimers.set(agentId, timer);
	}

	private cancelPermissionTimer(agentId: number) {
		const timer = this.permissionTimers.get(agentId);
		if (timer) {
			clearTimeout(timer);
			this.permissionTimers.delete(agentId);
		}
	}

	private startPermissionTimer(agentId: number) {
		this.cancelPermissionTimer(agentId);
		const timer = setTimeout(() => {
			this.permissionTimers.delete(agentId);
			const agent = this.agents.get(agentId);
			if (!agent) { return; }

			// Only flag if there are still active non-exempt tools
			let hasNonExempt = false;
			for (const toolId of agent.activeToolIds) {
				const toolName = agent.activeToolNames.get(toolId);
				if (!ArcadiaViewProvider.PERMISSION_EXEMPT_TOOLS.has(toolName || '')) {
					hasNonExempt = true;
					break;
				}
			}

			if (hasNonExempt) {
				agent.permissionSent = true;
				console.log(`[Arcadia] Agent ${agentId}: possible permission wait detected`);
				this.webviewView?.webview.postMessage({
					type: 'agentToolPermission',
					id: agentId,
				});
			}
		}, 5000);
		this.permissionTimers.set(agentId, timer);
	}

	private processTranscriptLine(agentId: number, line: string) {
		const agent = this.agents.get(agentId);
		if (!agent) { return; }
		try {
			const record = JSON.parse(line);

			if (record.type === 'assistant' && Array.isArray(record.message?.content)) {
				const blocks = record.message.content as Array<{
					type: string; id?: string; name?: string; input?: Record<string, unknown>;
				}>;
				const hasToolUse = blocks.some(b => b.type === 'tool_use');

				if (hasToolUse) {
					this.cancelWaitingTimer(agentId);
					agent.isWaiting = false;
					this.webviewView?.webview.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
					let hasNonExemptTool = false;
					for (const block of blocks) {
						if (block.type === 'tool_use' && block.id) {
							const toolName = block.name || '';
							const status = this.formatToolStatus(toolName, block.input || {});
							console.log(`[Arcadia] Agent ${agentId} tool start: ${block.id} ${status}`);
							agent.activeToolIds.add(block.id);
							agent.activeToolStatuses.set(block.id, status);
							agent.activeToolNames.set(block.id, toolName);
							if (!ArcadiaViewProvider.PERMISSION_EXEMPT_TOOLS.has(toolName)) {
								hasNonExemptTool = true;
							}
							this.webviewView?.webview.postMessage({
								type: 'agentToolStart',
								id: agentId,
								toolId: block.id,
								status,
							});
						}
					}
					if (hasNonExemptTool) {
						this.startPermissionTimer(agentId);
					}
				} else {
					const hasText = blocks.some(b => b.type === 'text');
					if (hasText) {
						this.startWaitingTimer(agentId, 2000);
					}
				}
			} else if (record.type === 'progress') {
				this.processProgressRecord(agentId, record);
			} else if (record.type === 'user') {
				const content = record.message?.content;
				if (Array.isArray(content)) {
					const blocks = content as Array<{ type: string; tool_use_id?: string }>;
					const hasToolResult = blocks.some(b => b.type === 'tool_result');
					if (hasToolResult) {
						for (const block of blocks) {
							if (block.type === 'tool_result' && block.tool_use_id) {
								console.log(`[Arcadia] Agent ${agentId} tool done: ${block.tool_use_id}`);
								const completedToolId = block.tool_use_id;
								// If the completed tool was a Task, clear its subagent tools
								if (agent.activeToolNames.get(completedToolId) === 'Task') {
									agent.activeSubagentToolIds.delete(completedToolId);
									this.webviewView?.webview.postMessage({
										type: 'subagentClear',
										id: agentId,
										parentToolId: completedToolId,
									});
								}
								agent.activeToolIds.delete(completedToolId);
								agent.activeToolStatuses.delete(completedToolId);
								agent.activeToolNames.delete(completedToolId);
								const toolId = completedToolId;
								setTimeout(() => {
									this.webviewView?.webview.postMessage({
										type: 'agentToolDone',
										id: agentId,
										toolId,
									});
								}, 300);
							}
						}
					} else {
						this.cancelWaitingTimer(agentId);
						this.clearAgentActivity(agentId);
					}
				} else if (typeof content === 'string' && content.trim()) {
					this.cancelWaitingTimer(agentId);
					this.clearAgentActivity(agentId);
				}
			} else if (record.type === 'system' && record.subtype === 'turn_duration') {
				this.cancelWaitingTimer(agentId);
				agent.isWaiting = true;
				this.webviewView?.webview.postMessage({
					type: 'agentStatus',
					id: agentId,
					status: 'waiting',
				});
			}
		} catch {
			// Ignore malformed lines
		}
	}

	private processProgressRecord(agentId: number, record: Record<string, unknown>) {
		const agent = this.agents.get(agentId);
		if (!agent) { return; }

		const parentToolId = record.parentToolUseID as string | undefined;
		if (!parentToolId) { return; }

		// Verify parent is an active Task tool
		if (agent.activeToolNames.get(parentToolId) !== 'Task') { return; }

		const data = record.data as Record<string, unknown> | undefined;
		const msg = data?.message as Record<string, unknown> | undefined;
		if (!msg) { return; }

		const msgType = msg.type as string;
		const innerMsg = msg.message as Record<string, unknown> | undefined;
		const content = innerMsg?.content;
		if (!Array.isArray(content)) { return; }

		if (msgType === 'assistant') {
			for (const block of content) {
				if (block.type === 'tool_use' && block.id) {
					const toolName = block.name || '';
					const status = this.formatToolStatus(toolName, block.input || {});
					console.log(`[Arcadia] Agent ${agentId} subagent tool start: ${block.id} ${status} (parent: ${parentToolId})`);

					// Track sub-tool
					let subTools = agent.activeSubagentToolIds.get(parentToolId);
					if (!subTools) {
						subTools = new Set();
						agent.activeSubagentToolIds.set(parentToolId, subTools);
					}
					subTools.add(block.id);

					this.webviewView?.webview.postMessage({
						type: 'subagentToolStart',
						id: agentId,
						parentToolId,
						toolId: block.id,
						status,
					});
				}
			}
		} else if (msgType === 'user') {
			for (const block of content) {
				if (block.type === 'tool_result' && block.tool_use_id) {
					console.log(`[Arcadia] Agent ${agentId} subagent tool done: ${block.tool_use_id} (parent: ${parentToolId})`);

					// Remove from tracking
					const subTools = agent.activeSubagentToolIds.get(parentToolId);
					if (subTools) {
						subTools.delete(block.tool_use_id);
					}

					const toolId = block.tool_use_id;
					setTimeout(() => {
						this.webviewView?.webview.postMessage({
							type: 'subagentToolDone',
							id: agentId,
							parentToolId,
							toolId,
						});
					}, 300);
				}
			}
		}
	}

	private formatToolStatus(toolName: string, input: Record<string, unknown>): string {
		const base = (p: unknown) => typeof p === 'string' ? path.basename(p) : '';
		switch (toolName) {
			case 'Read': return `Reading ${base(input.file_path)}`;
			case 'Edit': return `Editing ${base(input.file_path)}`;
			case 'Write': return `Writing ${base(input.file_path)}`;
			case 'Bash': {
				const cmd = (input.command as string) || '';
				return `Running: ${cmd.length > 30 ? cmd.slice(0, 30) + '\u2026' : cmd}`;
			}
			case 'Glob': return 'Searching files';
			case 'Grep': return 'Searching code';
			case 'WebFetch': return 'Fetching web content';
			case 'WebSearch': return 'Searching the web';
			case 'Task': {
				const desc = typeof input.description === 'string' ? input.description : '';
				return desc ? `Subtask: ${desc.length > 40 ? desc.slice(0, 40) + '\u2026' : desc}` : 'Running subtask';
			}
			case 'AskUserQuestion': return 'Waiting for your answer';
			case 'EnterPlanMode': return 'Planning';
			case 'NotebookEdit': return `Editing notebook`;
			default: return `Using ${toolName}`;
		}
	}

	dispose() {
		for (const id of [...this.agents.keys()]) {
			this.removeAgent(id);
		}
		if (this.projectScanTimer) {
			clearInterval(this.projectScanTimer);
			this.projectScanTimer = null;
		}
	}
}

let providerInstance: ArcadiaViewProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
	const provider = new ArcadiaViewProvider(context);
	providerInstance = provider;

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider('arcadia.panelView', provider)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('arcadia.showPanel', () => {
			vscode.commands.executeCommand('arcadia.panelView.focus');
		})
	);
}

function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const distPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
	const indexPath = vscode.Uri.joinPath(distPath, 'index.html').fsPath;

	let html = fs.readFileSync(indexPath, 'utf-8');

	html = html.replace(/(href|src)="\.\/([^"]+)"/g, (_match, attr, filePath) => {
		const fileUri = vscode.Uri.joinPath(distPath, filePath);
		const webviewUri = webview.asWebviewUri(fileUri);
		return `${attr}="${webviewUri}"`;
	});

	return html;
}

export function deactivate() {
	providerInstance?.dispose();
}
