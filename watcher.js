const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const chokidar = require('chokidar');

// --- Pricing ---
const PRICING = {
  'claude-opus-4-6':   { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6': { input: 3.00,  output: 15.00 },
  'claude-haiku-4-5':  { input: 0.80,  output: 4.00 },
};

function getPricing(model) {
  if (!model) return PRICING['claude-sonnet-4-6'];
  for (const [key, val] of Object.entries(PRICING)) {
    if (model.includes(key)) return val;
  }
  return PRICING['claude-sonnet-4-6']; // fallback
}

// --- Session State ---
const sessions = new Map();
const fileOffsets = new Map(); // path -> byte offset
const seenMessageIds = new Map(); // sessionId -> Set of message.id

function getOrCreateSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      sessionId,
      source: '',      // basename of the config dir this session was read from
      projectHash: '',
      cwd: '',
      label: '',
      model: '',
      gitBranch: '',
      status: 'idle',
      tokensIn: 0,
      tokensOut: 0,
      cacheCreationIn: 0,
      cacheReadIn: 0,
      costUSD: 0,
      turnCount: 0,
      activeFiles: [],
      recentLog: [],
      startedAt: null,
      lastEventAt: null,
      lastEventType: '',
      lastContentTypes: [],
      lastTurnInputTotal: 0, // input + cache for context window estimate
      permissionMode: '',
      version: '',
      subagents: {}, // agentId -> { task, status, tokensOut, lastEventAt }
    });
    seenMessageIds.set(sessionId, new Map()); // messageId -> {in, out, cacheCreate, cacheRead}
  }
  return sessions.get(sessionId);
}

function addToRecentLog(session, entry) {
  session.recentLog.push(entry);
  if (session.recentLog.length > 30) {
    session.recentLog = session.recentLog.slice(-30);
  }
}

function extractActiveFiles(content) {
  const files = [];
  if (!Array.isArray(content)) return files;
  for (const block of content) {
    if (block.type === 'tool_use' && block.input) {
      const fp = block.input.file_path || block.input.path || block.input.command;
      if (fp && typeof fp === 'string' && !fp.includes(' ')) {
        files.push(path.basename(fp));
      }
    }
  }
  return files;
}

function processEvent(event, projectHash, source) {
  if (!event || !event.sessionId) return;
  if (event.type === 'file-history-snapshot' || event.type === 'queue-operation' || event.type === 'last-prompt') return;

  if (!event.timestamp) return; // skip events without timestamps (and don't create a phantom session)
  const session = getOrCreateSession(event.sessionId);
  const ts = event.timestamp;

  if (!session.startedAt) session.startedAt = ts;
  session.lastEventAt = ts;
  session.lastEventType = event.type;
  session.projectHash = projectHash;
  session.source = source;

  if (event.cwd && !session.cwd) {
    session.cwd = event.cwd;
    const parts = event.cwd.split('/').filter(Boolean);
    session.label = parts.slice(-2).join('/');
  }
  if (event.gitBranch && !session.gitBranch) {
    session.gitBranch = event.gitBranch;
  }
  if (event.version) session.version = event.version;
  if (event.permissionMode) session.permissionMode = event.permissionMode;

  const msg = event.message || {};
  const content = msg.content;
  const contentTypes = Array.isArray(content)
    ? content.map(c => c.type)
    : (typeof content === 'string' ? ['text'] : []);
  session.lastContentTypes = contentTypes;

  if (event.type === 'assistant' && msg.usage) {
    const msgId = msg.id;
    const usage = msg.usage;
    const seen = seenMessageIds.get(event.sessionId);

    if (msg.model) session.model = msg.model;

    // Track per-message-id usage, only count the delta
    const prev = seen.get(msgId) || { in: 0, out: 0, cacheCreate: 0, cacheRead: 0 };
    const curr = {
      in: usage.input_tokens || 0,
      out: usage.output_tokens || 0,
      cacheCreate: usage.cache_creation_input_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || 0,
    };

    // Add only the difference (later events for same msgId have cumulative values)
    session.tokensIn += Math.max(0, curr.in - prev.in);
    session.tokensOut += Math.max(0, curr.out - prev.out);
    session.cacheCreationIn += Math.max(0, curr.cacheCreate - prev.cacheCreate);
    session.cacheReadIn += Math.max(0, curr.cacheRead - prev.cacheRead);

    seen.set(msgId, curr);

    // Track last turn's total input for context window estimate
    session.lastTurnInputTotal = curr.in + curr.cacheCreate + curr.cacheRead;

    // Recalculate cost
    const pricing = getPricing(session.model);
    session.costUSD =
      (session.tokensIn * pricing.input / 1_000_000) +
      (session.tokensOut * pricing.output / 1_000_000) +
      (session.cacheCreationIn * pricing.input * 0.25 / 1_000_000) +
      (session.cacheReadIn * pricing.input * 0.10 / 1_000_000);

    // Log tool use
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use') {
          addToRecentLog(session, {
            time: ts,
            type: 'tool',
            msg: block.name + (block.input?.file_path ? `: ${path.basename(block.input.file_path)}` : ''),
          });
        } else if (block.type === 'text' && block.text) {
          const snippet = block.text.substring(0, 120);
          addToRecentLog(session, { time: ts, type: 'think', msg: snippet });
        }
      }
      // Track active files
      const newFiles = extractActiveFiles(content);
      if (newFiles.length) {
        const fileSet = new Set([...newFiles, ...session.activeFiles]);
        session.activeFiles = [...fileSet].slice(0, 10);
      }
    }

    // Count turns by unique message IDs with stop_reason
    if (msg.stop_reason) {
      session.turnCount++;
    }
  }

  // --- Subagent tracking ---
  if (event.agentId && !event.agentId.startsWith('acompact')) {
    const aid = event.agentId;
    if (!session.subagents[aid]) {
      session.subagents[aid] = { agentId: aid, task: '', status: 'idle', tokensOut: 0, lastEventAt: null };
    }
    const sub = session.subagents[aid];
    sub.lastEventAt = ts;

    // Derive subagent status
    const subElapsed = Date.now() - new Date(ts).getTime();
    sub.status = subElapsed < 15_000 ? 'thinking' : 'idle';

    // Capture task from first user message
    if (!sub.task && event.type === 'user' && msg.role === 'user') {
      const text = typeof content === 'string' ? content : (Array.isArray(content) ? content.find(c => c.type === 'text')?.text : '');
      if (text) sub.task = text.substring(0, 120);
    }

    // Track subagent output tokens
    if (event.type === 'assistant' && msg.usage && msg.stop_reason) {
      sub.tokensOut += msg.usage.output_tokens || 0;
    }
  }

  if (event.type === 'user' && msg.role === 'user') {
    const text = typeof content === 'string'
      ? content.substring(0, 120)
      : (Array.isArray(content) ? content.find(c => c.type === 'text')?.text?.substring(0, 120) : '');
    if (text) {
      addToRecentLog(session, { time: ts, type: 'user', msg: text });
    }
  }
}

function deriveStatus(session) {
  if (!session.lastEventAt) return 'idle';
  const elapsed = Date.now() - new Date(session.lastEventAt).getTime();

  if (elapsed > 60_000) return 'idle';

  // Check for error in recent log
  const lastLogs = session.recentLog.slice(-3);
  if (lastLogs.some(l => l.type === 'error')) return 'error';

  if (elapsed < 15_000) {
    if (session.lastEventType === 'assistant') {
      if (session.lastContentTypes.includes('tool_use')) return 'thinking';
      if (session.lastContentTypes.includes('text')) return 'waiting';
      if (session.lastContentTypes.includes('thinking')) return 'thinking';
    }
    if (session.lastEventType === 'progress') return 'thinking';
    if (session.lastEventType === 'user') return 'thinking'; // just sent input, waiting for response
  }

  return 'idle';
}

// --- JSONL File Processing ---
function processFile(filePath, source) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return; }
  const offset = fileOffsets.get(filePath) || 0;
  if (stat.size <= offset) return;

  const projectHash = path.basename(path.dirname(filePath));
  const stream = fs.createReadStream(filePath, { start: offset, encoding: 'utf8' });
  let buffer = '';

  stream.on('data', (chunk) => { buffer += chunk; });
  stream.on('end', () => {
    fileOffsets.set(filePath, stat.size);
    const lines = buffer.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        processEvent(event, projectHash, source);
      } catch (e) {
        // Skip malformed lines (partial writes)
      }
    }
  });
}

// --- Express Server ---
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Reject requests whose Host header isn't a loopback address. The server already
// binds to 127.0.0.1, but a malicious website can still reach it via DNS rebinding
// (a hostname it controls that resolves to 127.0.0.1). Checking Host closes that.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
function requireLocalHost(req, res, next) {
  const host = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (!LOCAL_HOSTS.has(host)) return res.status(403).json({ error: 'Forbidden host' });
  next();
}
app.use('/api', requireLocalHost);

app.post('/api/open-folder', express.json(), (req, res) => {
  const folder = req.body && req.body.path;
  if (!folder || typeof folder !== 'string') return res.status(400).json({ error: 'No path' });
  // Only allow directories that belong to a tracked session. `open` on an
  // arbitrary existing file (.app, .command, .terminal) would execute it.
  const knownCwds = new Set([...sessions.values()].map(s => s.cwd).filter(Boolean));
  if (!knownCwds.has(folder)) return res.status(403).json({ error: 'Not a tracked session folder' });
  let stat;
  try { stat = fs.statSync(folder); } catch { return res.status(404).json({ error: 'Folder not found' }); }
  if (!stat.isDirectory()) return res.status(400).json({ error: 'Not a directory' });
  const { execFile } = require('child_process');
  const plat = process.platform;
  if (plat === 'win32') {
    execFile('explorer', [folder.replace(/\//g, '\\')], () => {});
  } else if (plat === 'darwin') {
    execFile('open', [folder], () => {});
  } else {
    execFile('xdg-open', [folder], () => {});
  }
  res.json({ ok: true });
});

app.get('/api/sessions', (req, res) => {
  // Build list with derived status
  const all = [];
  for (const session of sessions.values()) {
    const status = deriveStatus(session);
    // Convert subagents object to sorted array, only include active ones
    const subagentList = Object.values(session.subagents)
      .filter(s => s.status === 'thinking')
      .sort((a, b) => new Date(b.lastEventAt || 0) - new Date(a.lastEventAt || 0));
    all.push({
      ...session,
      status,
      costUSD: Math.round(session.costUSD * 10000) / 10000,
      subagents: subagentList,
    });
  }

  // Active sessions (thinking/waiting/error) always shown individually.
  // Idle sessions: only show the most recent per project label.
  const active = all.filter(s => s.status !== 'idle');
  const idle = all.filter(s => s.status === 'idle');
  // Collect labels that already have an active session
  const activeLabels = new Set(active.map(s => s.label));
  const latestIdleByLabel = new Map();
  for (const s of idle) {
    // Skip idle sessions if that project already has an active session
    if (activeLabels.has(s.label)) continue;
    const existing = latestIdleByLabel.get(s.label);
    if (!existing || new Date(s.lastEventAt || 0) > new Date(existing.lastEventAt || 0)) {
      latestIdleByLabel.set(s.label, s);
    }
  }

  const result = [...active, ...latestIdleByLabel.values()];
  // Sort: active today first (alphabetical), then inactive today (alphabetical)
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  // Mark idle sessions not active today as 'idle-stale'
  for (const s of result) {
    if (s.status === 'idle' && (!s.lastEventAt || new Date(s.lastEventAt) < todayStart)) {
      s.status = 'idle-stale';
    }
  }
  result.sort((a, b) => {
    const aToday = a.lastEventAt && new Date(a.lastEventAt) >= todayStart ? 1 : 0;
    const bToday = b.lastEventAt && new Date(b.lastEventAt) >= todayStart ? 1 : 0;
    if (aToday !== bToday) return bToday - aToday; // active today first
    return (a.label || '').localeCompare(b.label || '');
  });
  res.json(result);
});

// --- Start ---
// Honour Claude Code's own CLAUDE_CONFIG_DIR. Several dirs can be given,
// separated by the platform path delimiter (':' on macOS/Linux, ';' on Windows),
// e.g. CLAUDE_CONFIG_DIR=~/.claude:~/.claude-coralis to watch both.
function expandHome(p) {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}
const CONFIG_DIRS = (process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'))
  .split(path.delimiter)
  .map(d => d.trim())
  .filter(Boolean)
  .map(d => path.resolve(expandHome(d)));

const WATCH_DIRS = [];
for (const dir of CONFIG_DIRS) {
  const projectsDir = path.join(dir, 'projects');
  if (!fs.existsSync(projectsDir)) {
    console.warn(`Warning: ${projectsDir} does not exist, skipping`);
    continue;
  }
  WATCH_DIRS.push({ dir: projectsDir, source: path.basename(dir) });
}
if (WATCH_DIRS.length === 0) {
  console.error('No config directories to watch. Set CLAUDE_CONFIG_DIR to a Claude Code config dir.');
  process.exit(1);
}
const PORT = Number(process.env.PORT) || 3001;
// Loopback only. Session data (prompt snippets, paths, branches) must not be
// readable from the LAN. Set HOST=0.0.0.0 explicitly if you really want that.
const HOST = process.env.HOST || '127.0.0.1';

for (const w of WATCH_DIRS) console.log(`Watching: ${w.dir}`);
console.log(`Dashboard: http://localhost:${PORT}`);

function shouldProcessFile(filePath) {
  return filePath.endsWith('.jsonl') && !path.basename(filePath).includes('compact');
}

// One watcher per projects directory (chokidar v5 needs directory, not glob)
for (const { dir, source } of WATCH_DIRS) {
  const watcher = chokidar.watch(dir, {
    persistent: true,
    ignoreInitial: false,
    depth: 4, // reach projects/hash/session/subagents/*.jsonl
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });
  watcher.on('add', (filePath) => {
    if (shouldProcessFile(filePath)) processFile(filePath, source);
  });
  watcher.on('change', (filePath) => {
    if (shouldProcessFile(filePath)) processFile(filePath, source);
  });
}

const server = app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} already in use. Kill the existing process or use a different port.`);
    process.exit(1);
  }
  throw err;
});
