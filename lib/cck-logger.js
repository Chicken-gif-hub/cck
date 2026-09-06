// CCK 主进程诊断日志（2026-09 新增）
//
// 背景（「很多用户反馈闪退/启动后没登录」却查不下去的直接原因）:
//   此前全部诊断信息只走 console.log('[CCK] ...')，Electron 打包后主进程 stdout 无处可去，
//   %APPDATA%\qodercck 下没有任何持久化日志。09-04 本机取证时无法回溯 13:31:20Z 那次启动
//   是否由 CCK 发起、exe 解析到哪一步失败、杀进程是否生效，只能靠客户端侧文件 mtime 反推。
//
// 对策: 落盘到 <userData>\logs\cck-YYYYMMDD.log，按天滚动、保留 7 天，同步追加。
//   全链路 try/catch 吞错 —— 日志本身绝不能成为新的故障源（写盘失败即静默降级为仅 stdout）。
//
// 安全: 本应用日志会随「导出诊断日志」交给用户/客服，因此写入前强制脱敏 ——
//   JWT、dt- 设备令牌、PEM 私钥整体替换；对象里键名含 token/secret/private/password/key 的值
//   只保留前 6 字符 + 长度，便于判断"有没有值/多长"而不泄露内容。

const fs = require('fs');
const path = require('path');
const os = require('os');

const KEEP_DAYS = 7;
const MAX_LINE = 4000; // 单行截断，防大对象撑爆日志文件
const LOG_FILE_RE = /^cck-(\d{8})\.log$/;

let logDir = '';
let inited = false;
let disabled = false;

// ========== 脱敏 ==========

/** 整体替换的敏感串（JWT / Qoder 设备令牌 / PEM 私钥） */
const WHOLE_REDACT = [
	/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/g,
	/\bdt-[A-Za-z0-9_-]{6,}\b/g,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** 键名命中即脱敏的字段（保留前 6 字符 + 长度，够判断"有没有值"） */
const SENSITIVE_KEY_RE = /(token|secret|private|password|passwd|credential|authinfo|key)/i;

function maskValue(v) {
	const s = typeof v === 'string' ? v : JSON.stringify(v);
	if (!s) return s;
	return `${s.slice(0, 6)}…(${s.length})`;
}

/** 递归脱敏对象（只处理普通对象/数组，深度上限 6，防循环引用） */
function redactDeep(value, depth) {
	depth = depth || 0;
	if (depth > 6) return '[depth-limit]';
	if (value === null || value === undefined) return value;
	if (typeof value === 'string') {
		let s = value;
		for (const re of WHOLE_REDACT) s = s.replace(re, '[REDACTED]');
		return s;
	}
	if (typeof value !== 'object') return value;
	if (Array.isArray(value)) return value.slice(0, 40).map(v => redactDeep(v, depth + 1));
	const out = {};
	for (const [k, v] of Object.entries(value)) {
		if (SENSITIVE_KEY_RE.test(k)) out[k] = maskValue(v);
		else out[k] = redactDeep(v, depth + 1);
	}
	return out;
}

/** 字符串整体脱敏 */
function redactString(s) {
	let out = String(s == null ? '' : s);
	for (const re of WHOLE_REDACT) out = out.replace(re, '[REDACTED]');
	return out;
}

// ========== 落盘 ==========

/** 默认日志目录：优先 Electron userData，回退 %APPDATA%\qodercck（非 Electron 环境/测试用） */
function defaultLogDir() {
	try {
		const { app } = require('electron');
		if (app && typeof app.getPath === 'function') {
			const ud = app.getPath('userData');
			if (ud) return path.join(ud, 'logs');
		}
	} catch { /* 非 Electron 环境（脚本/测试）*/ }
	const appdata = process.env.APPDATA || path.join(os.homedir() || '', 'AppData', 'Roaming');
	return path.join(appdata, 'qodercck', 'logs');
}

function ensureInit() {
	if (inited) return logDir;
	inited = true;
	try {
		if (!logDir) logDir = defaultLogDir();
		fs.mkdirSync(logDir, { recursive: true });
		pruneOldLogs(KEEP_DAYS);
	} catch {
		disabled = true;
	}
	return logDir;
}

/** 初始化日志（main.js 在 app ready 后用 userData\logs 调用一次） */
function initLogger(dir) {
	try {
		if (dir) logDir = dir;
		inited = false;
		disabled = false;
		ensureInit();
		cckLog('logger', '诊断日志已启用', { dir: logDir, keepDays: KEEP_DAYS });
	} catch { /* 静默 */ }
	return logDir;
}

function dayStamp(d) {
	const p = (n) => String(n).padStart(2, '0');
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function pruneOldLogs(keepDays) {
	try {
		if (!logDir) return 0;
		const cutoff = Date.now() - (keepDays || KEEP_DAYS) * 86400000;
		let n = 0;
		for (const name of fs.readdirSync(logDir)) {
			const m = LOG_FILE_RE.exec(name);
			if (!m) continue;
			const s = m[1];
			const t = new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8))).getTime();
			if (Number.isFinite(t) && t < cutoff) {
				try { fs.unlinkSync(path.join(logDir, name)); n++; } catch { /* 占用中，跳过 */ }
			}
		}
		return n;
	} catch { return 0; }
}

/**
 * 写一条诊断日志（同时回显 stdout，便于开发模式在终端/DevTools 看）
 * @param {string} scope 作用域标签，如 'launch' / 'proc' / 'wipe' / 'inject' / 'health'
 * @param {string} message 人类可读描述
 * @param {*} [data] 附加结构化数据（自动脱敏）
 */
function cckLog(scope, message, data) {
	const redactedMsg = redactString(message);
	try {
		if (data === undefined) console.log(`[CCK][${scope}] ${redactedMsg}`);
		else console.log(`[CCK][${scope}] ${redactedMsg}`, typeof data === 'string' ? redactString(data) : redactDeep(data));
	} catch { /* stdout 不可用 */ }
	if (disabled) return;
	try {
		ensureInit();
		if (disabled) return;
		let extra = '';
		if (data !== undefined) {
			try {
				extra = ' ' + (typeof data === 'string' ? redactString(data) : JSON.stringify(redactDeep(data)));
			} catch { extra = ' [unserializable]'; }
		}
		let line = `${new Date().toISOString()} [${scope}] ${redactedMsg}${extra}\n`;
		if (line.length > MAX_LINE) line = `${line.slice(0, MAX_LINE)}…[truncated]\n`;
		fs.appendFileSync(path.join(logDir, `cck-${dayStamp(new Date())}.log`), line, 'utf8');
	} catch { /* 落盘失败不影响主流程 */ }
}

// ========== 导出诊断 ==========

function getLogDir() { return ensureInit() || ''; }

/** 列出日志文件（按名字倒序 = 最新在前） */
function listLogFiles() {
	const dir = ensureInit();
	if (!dir) return [];
	try {
		return fs.readdirSync(dir)
			.filter(n => LOG_FILE_RE.test(n))
			.map(n => {
				const st = fs.statSync(path.join(dir, n));
				return { name: n, size: st.size, mtime: st.mtime.toISOString() };
			})
			.sort((a, b) => (a.name < b.name ? 1 : -1));
	} catch { return []; }
}

/**
 * 导出诊断包到指定目录：复制全部日志 + 写 environment.json（环境摘要，不含任何凭证）
 * @param {string} targetDir 用户通过对话框选定的目录
 * @param {object} [extra] 调用方附加的环境摘要（如各客户端 exe 解析报告）
 * @returns {{ok:boolean, dir?:string, files?:string[], error?:string}}
 */
function exportDiagnosticBundle(targetDir, extra) {
	try {
		if (!targetDir) return { ok: false, error: '未指定导出目录' };
		const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
		const outDir = path.join(targetDir, `CCK诊断日志-${stamp}`);
		fs.mkdirSync(outDir, { recursive: true });
		const files = [];
		for (const f of listLogFiles()) {
			try {
				fs.copyFileSync(path.join(logDir, f.name), path.join(outDir, f.name));
				files.push(f.name);
			} catch { /* 单个文件失败不中断 */ }
		}
		const env = {
			exportedAt: new Date().toISOString(),
			cckVersion: (() => { try { return require('../package.json').version; } catch { return 'unknown'; } })(),
			platform: `${process.platform} ${os.release()}`,
			arch: process.arch,
			electron: process.versions ? process.versions.electron : '',
			node: process.versions ? process.versions.node : '',
			logDir,
			logFiles: files,
		};
		if (extra && typeof extra === 'object') Object.assign(env, extra);
		fs.writeFileSync(path.join(outDir, 'environment.json'), JSON.stringify(env, null, 2), 'utf8');
		files.push('environment.json');
		cckLog('logger', '诊断包已导出', { dir: outDir, files: files.length });
		return { ok: true, dir: outDir, files };
	} catch (e) {
		return { ok: false, error: (e && e.message) || String(e) };
	}
}

module.exports = {
	initLogger,
	cckLog,
	getLogDir,
	listLogFiles,
	exportDiagnosticBundle,
	pruneOldLogs,
	redactString,
	redactDeep,
};
