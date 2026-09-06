// Electron 主进程入口：窗口管理 + IPC handler + 核心模块调度。
// 开源版仅保留账号管理与额度查询链路（客户端启动/设备指纹/环境清理不在开源范围内）。

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const store = require('./lib/local-store');
const api = require('./lib/api-client');
const { checkQuota } = require('./lib/quota-checker');
// 诊断日志落盘：日志保留 7 天、写入前脱敏。
const { initLogger, cckLog, getLogDir, listLogFiles, exportDiagnosticBundle } = require('./lib/cck-logger');

let mainWindow = null;

/** 语义版本比较：a 是否严格大于 b（支持 "1.3.0" / "1.3.0-beta" 等，按数字段逐级比）。
 *  用于更新检查，避免仅判 !== 导致方向反转（如 current 1.3.0 vs latest 1.2.12 误报有更新）。 */
function isNewerVersion(a, b) {
	const pa = String(a || '').split(/[.-]/);
	const pb = String(b || '').split(/[.-]/);
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const na = parseInt(pa[i], 10);
		const nb = parseInt(pb[i], 10);
		const va = isNaN(na) ? 0 : na;
		const vb = isNaN(nb) ? 0 : nb;
		if (va !== vb) return va > vb;
	}
	return false; // 完全相等 → 不算更新
}

function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1100,
		height: 720,
		minWidth: 900,
		minHeight: 600,
		title: 'CCK 账号管理器',
		icon: path.join(__dirname, 'assets', 'icon.ico'),
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webSecurity: true,
		},
	});

	// 开发模式打开 DevTools
	if (process.argv.includes('--dev')) {
		mainWindow.webContents.openDevTools();
	}

	mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

	// 安全：禁止导航到外部页面，禁止打开新窗口
	mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
	mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

	mainWindow.on('closed', () => {
		mainWindow = null;
	});
}

// ========== IPC Handler ==========

// --- 鉴权 ---
ipcMain.handle('auth:get-captcha', async () => {
	return await api.get('/api/auth/captcha');
});

ipcMain.handle('auth:register', async (_, { username, password, confirm_password }) => {
	if (typeof username !== 'string' || typeof password !== 'string') return { success: false, error: '参数无效' };
	const resp = await api.post('/api/auth/register', { username, password, confirm_password });
	if (resp.success) {
		store.set('sessionToken', resp.token);
		store.set('userInfo', resp.user);
	}
	return resp;
});

ipcMain.handle('auth:login', async (_, { username, password }) => {
	if (typeof username !== 'string' || typeof password !== 'string') return { success: false, error: '参数无效' };
	const resp = await api.post('/api/auth/login', { username, password });
	if (resp.success) {
		store.set('sessionToken', resp.token);
		store.set('userInfo', resp.user);
	}
	return resp;
});

ipcMain.handle('auth:logout', async () => {
	await api.post('/api/auth/logout');
	store.delete('sessionToken');
	store.delete('userInfo');
	return { success: true };
});

ipcMain.handle('auth:get-session', async () => {
	const token = store.get('sessionToken');
	const userInfo = store.get('userInfo');
	if (!token) return { success: false, error: '未登录' };
	// 验证 token 有效性
	const resp = await api.get('/api/me');
	if (!resp.success) {
		// token 失效，清除
		store.delete('sessionToken');
		store.delete('userInfo');
		return { success: false, error: resp.error };
	}
	return { success: true, user: resp.user };
});

// --- 账号 ---
ipcMain.handle('accounts:list', async (_, { category } = {}) => {
	return await api.get('/api/accounts?category=' + (category || 'qoder'));
});

ipcMain.handle('accounts:purchase', async (_, { planQuota, category }) => {
	const resp = await api.post('/api/accounts/purchase', { plan_quota: planQuota, category: category || 'qoder' });
	return resp;
});

ipcMain.handle('accounts:my', async () => {
	return await api.get('/api/my-accounts');
});

// 买家主动封禁退款（v1.2.11）：服务端复核死号后按剩余额度退到余额
ipcMain.handle('accounts:ban-refund', async (_, { id }) => {
	return await api.post('/api/my-accounts/ban-refund', { id });
});

// --- 自定义账号（用户自有凭证，仅存本机 DPAPI 加密，不过后端/不占平台库存）---
const customAccounts = require('./lib/custom-accounts');

ipcMain.handle('accounts:custom-list', () => {
	return { success: true, accounts: customAccounts.loadCustomAccounts(store) };
});

// 添加：格式/家族校验 + 去重；verify=true 时在线验证凭证（额度/积分查询成功才入库，
// 可在弹窗取消勾选跳过——离线或暂时网络异常时仍可先录入）
ipcMain.handle('accounts:custom-add', async (_, { category, token, refresh_token, label, user_data, verify }) => {
	const r = customAccounts.addCustomAccount(store, { category, token, refresh_token, label, user_data });
	if (!r.ok) return { success: false, error: r.error };
	if (verify !== false) {
		const q = await checkQuota(r.account.token, r.account.refresh_token, r.account.category);
		if (!q.success) {
			// 校验失败不入库：banned=平台明确拒绝(死号/风控)；其余为查询失败(网络/网关)
			customAccounts.removeCustomAccount(store, r.account.id);
			return { success: false, error: `凭证验证未通过: ${q.error || '查询失败'}`, banned: !!q.banned };
		}
		return { success: true, account: r.account, quota: q.usage || null };
	}
	return { success: true, account: r.account };
});

ipcMain.handle('accounts:custom-remove', (_, { id }) => {
	const r = customAccounts.removeCustomAccount(store, id);
	return r.ok ? { success: true } : { success: false, error: r.error };
});

// --- 额度查询 ---
ipcMain.handle('quota:check', async (_, { token, refresh_token, category }) => {
	return await checkQuota(token, refresh_token, category);
});

// --- 余额兑换 ---
ipcMain.handle('credits:redeem', async (_, { code }) => {
	return await api.post('/api/credits/redeem', { code });
});

// --- 打开外部链接 ---
ipcMain.handle('open-external', async (_, { url }) => {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
			return { success: false, error: '仅允许 http/https 链接' };
		}
		await shell.openExternal(url);
		return { success: true };
	} catch {
		return { success: false, error: '无效的 URL' };
	}
});

// 检查更新：走 api-client（electron.net 走系统代理 + 超时 + 双域名容灾），裸 fetch(undici) 不走代理且无超时会永久卡"检查中"
ipcMain.handle('app:check-update', async () => {
	const { app } = require('electron');
	const currentVersion = app.getVersion();
	// 双保险：api.get 每域名 8s 超时（双域名容灾最坏 16s），外层再 race 18s 兜底，保证 invoke 必定返回
	const timeoutFallback = { hasUpdate: false, current: currentVersion, error: '检查超时，请稍后重试' };
	return await Promise.race([
		(async () => {
			try {
				const resp = await api.get('/api/version', { timeout: 8000 });
				if (resp.httpStatus === 0 || !resp.latest) {
					return { hasUpdate: false, error: `更新检查失败: ${resp.error || 'HTTP ' + resp.httpStatus}` };
				}
				const data = resp;
				// 语义版本比较：仅当线上 latest 严格大于当前版本才算有更新。
				// 旧逻辑用 !== 判断，会导致 current(1.3.0) 与 latest(1.2.12) 不等时误报"有更新"（方向反了）。
				const hasUpdate = isNewerVersion(data.latest, currentVersion);
				// 下载链接固定官方下载站 cck.btluo.com（API 检查走双域名容灾，下载入口统一品牌域名）
				return { hasUpdate, current: currentVersion, latest: data.latest, downloadUrl: 'https://cck.btluo.com' + data.download_url };
			} catch (e) {
				return { hasUpdate: false, error: e.message };
			}
		})(),
		new Promise((r) => setTimeout(() => r(timeoutFallback), 18000)),
	]);
});

// 导出诊断日志 —— 用户反馈异常时, 让开发者能拿到可回溯的现场。
// 导出内容: 近 7 天日志 + environment.json（版本/平台/store 键名）。
// 日志写入前已脱敏（JWT / dt- 设备令牌 / 私钥块 / token|secret|password 类字段一律掩码），不含任何可用凭证。
ipcMain.handle('diag:export-logs', async () => {
	try {
		const result = await dialog.showOpenDialog(mainWindow, {
			title: '选择诊断日志导出位置',
			buttonLabel: '导出到此目录',
			properties: ['openDirectory', 'createDirectory'],
		});
		if (result.canceled || result.filePaths.length === 0) return { success: false, canceled: true };
		const extra = { storeKeys: [] };
		try { extra.storeKeys = Object.keys(store.getAll() || {}); } catch {}
		const bundle = exportDiagnosticBundle(result.filePaths[0], extra);
		if (!bundle || !bundle.ok) {
			cckLog('ipc', '诊断日志导出失败', { error: (bundle && bundle.error) || '未知错误' });
			return { success: false, error: '导出失败: ' + ((bundle && bundle.error) || '未知错误') };
		}
		try { shell.openPath(bundle.dir); } catch {}
		return { success: true, dir: bundle.dir, files: bundle.files };
	} catch (e) {
		cckLog('ipc', '诊断日志导出异常', { error: (e && e.message) || String(e) });
		return { success: false, error: '导出异常: ' + ((e && e.message) || e) };
	}
});

// ========== 应用生命周期 ==========

// 文件锁实现单实例（带 PID 存活检测，防止闪退后永久锁死）
const lockFilePath = path.join(app.getPath('userData'), 'instance.lock');
let lockFile = null;

function isProcessAlive(pid) {
	try {
		// process.kill(pid, 0) throws if process doesn't exist
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// 检查并清理 stale lock
try {
	if (fs.existsSync(lockFilePath)) {
		const stalePid = parseInt(fs.readFileSync(lockFilePath, 'utf8').trim(), 10);
		if (!isNaN(stalePid) && !isProcessAlive(stalePid)) {
			// 进程已死，清理 stale lock
			fs.unlinkSync(lockFilePath);
		} else {
			// 实例已在运行，尝试聚焦窗口后退出
			// 通过命令行将已有窗口激活
			try {
				// 使用 PowerShell 激活已运行实例的窗口
				execSync(`powershell -Command "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate(${stalePid})", { timeout: 3000 }`, { stdio: 'ignore' });
			} catch {}
			app.quit();
			process.exit(0);
		}
	}
} catch (e) {
	// 清理 stale lock 失败，尝试强制删除
	try { fs.unlinkSync(lockFilePath); } catch {}
}

try {
	lockFile = fs.openSync(lockFilePath, 'wx');
} catch (e) {
	// 锁文件仍被占用，退出
	app.quit();
	process.exit(0);
}

fs.writeSync(lockFile, String(process.pid));

app.whenReady().then(() => {
	store.initStore();
	// 诊断日志初始化（须在 store 之后: 日志目录取 electron userData, 与 config.json 同源）
	try {
		initLogger();
		cckLog('app', 'CCK 主进程启动', {
			version: app.getVersion(),
			platform: process.platform, arch: process.arch,
			electron: process.versions.electron, node: process.versions.node,
			logDir: getLogDir(), logFiles: listLogFiles(),
		});
	} catch (e) {
		console.error('[CCK] 诊断日志初始化失败(不阻塞启动):', e && e.message ? e.message : e);
	}
	createWindow();
	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

// 应用退出时删除锁文件
app.on('quit', () => {
	if (lockFile) {
		try {
			fs.closeSync(lockFile);
			fs.unlinkSync(lockFilePath);
		} catch (e) {}
	}
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});
