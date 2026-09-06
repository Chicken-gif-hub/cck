// cursor-context.js — Cursor IDE（Anysphere，VS Code fork）额度查询支持：
// DashboardService RPC（美分口径）+ 旧版 /auth/usage 降级 + token 刷新 + 本地登录态副本兜底。
// 开源版仅保留只读查询链路（凭证注入/设备指纹/上下文清理不在开源范围内）。
//
// 约定：Cursor oauth/token 刷新响应只回 access_token/id_token（不轮换 refresh token），
// 链内刷新不会作废本地 IDE 持有的同一 refresh token → 刷新安全。

const path = require('path');
const os = require('os');

const CURSOR_API_BASE = 'https://api2.cursor.sh';
const CURSOR_USAGE_RPC_PATH = '/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
const CURSOR_LEGACY_USAGE_PATH = '/auth/usage';
const CURSOR_REFRESH_URL = 'https://api2.cursor.sh/oauth/token';
const CURSOR_CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB';
const CURSOR_UA = 'cursor/2.6.22';

// state.vscdb 明文登录键
const CURSOR_AUTH_KEYS = {
	accessToken: 'cursorAuth/accessToken',
	refreshToken: 'cursorAuth/refreshToken',
	cachedEmail: 'cursorAuth/cachedEmail',
	cachedSignUpType: 'cursorAuth/cachedSignUpType',
};

/** Cursor 应用数据目录（VS Code fork 标准布局） */
function cursorAppDataPath() {
	switch (process.platform) {
		case 'darwin': return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor');
		case 'win32': return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Cursor');
		default: return path.join(os.homedir(), '.config', 'Cursor');
	}
}

/** 解析 Cursor accessToken JWT payload（WorkOS/Auth0 签发，不验签） */
function parseCursorJwt(token) {
	if (!token || typeof token !== 'string' || !token.startsWith('eyJ')) return null;
	try {
		const parts = token.split('.');
		if (parts.length !== 3) return null;
		const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
		return payload && typeof payload === 'object' ? payload : null;
	} catch {
		return null;
	}
}

/** JWT sub（WorkOS 用户 ID，跨 token 刷新稳定）— 本地副本同账号判定用 */
function extractCursorSub(token) {
	const sub = parseCursorJwt(token)?.sub;
	return typeof sub === 'string' && sub ? sub : null;
}

/** 读取本地登录态（{accessToken, refreshToken, email}；无库/无键返回 null） */
async function readCursorAuth(appdataPath) {
	const { readPlainItem } = require('./vscdb-secret');
	const home = appdataPath || cursorAppDataPath();
	const accessToken = await readPlainItem(home, CURSOR_AUTH_KEYS.accessToken);
	if (!accessToken) return null;
	const refreshToken = await readPlainItem(home, CURSOR_AUTH_KEYS.refreshToken);
	const email = await readPlainItem(home, CURSOR_AUTH_KEYS.cachedEmail);
	return { accessToken, refreshToken: refreshToken || null, email: email || null };
}

/**
 * 本地 state.vscdb 与账号凭证是否同账号（JWT sub 一致才算本地活副本）。
 * 启动过 IDE 后客户端自动续期回写 access_token（比库存凭证新鲜）；额度检测用它兜底。
 */
async function cursorAuthAccountMatches(appdataPath, token) {
	const local = await readCursorAuth(appdataPath);
	if (!local || !local.accessToken) return { matches: false, localAccess: null };
	const a = extractCursorSub(token);
	const b = extractCursorSub(local.accessToken);
	if (!a && !b) {
		return { matches: local.accessToken === token, localAccess: local.accessToken === token ? local.accessToken : null };
	}
	return { matches: !!a && a === b, localAccess: a === b ? local.accessToken : null };
}

/**
 * DashboardService RPC 请求（Connect-Protocol-Version 头）。
 * @param {string} rpcPath - GetCurrentPeriodUsage / GetPlanInfo
 */
async function fetchCursorRpc(rpcPath, token, opts = {}, _fetchImpl) {
	const doFetch = _fetchImpl || (async (url, o) => {
		const { netRequest } = require('./net-helper');
		return netRequest(url, o);
	});
	const headers = {
		'Authorization': `Bearer ${token}`,
		'Content-Type': 'application/json',
		'Connect-Protocol-Version': '1',
		'User-Agent': opts.userAgent || CURSOR_UA,
	};
	if (opts.clientVersion) headers['x-cursor-client-version'] = opts.clientVersion;
	return doFetch(CURSOR_API_BASE + rpcPath, { method: 'POST', headers, body: '{}', timeout: 15000 });
}

/** 旧版 /auth/usage 请求（按模型请求数口径，企业/旧计费账号降级用） */
async function fetchCursorLegacyUsage(token, _fetchImpl) {
	const doFetch = _fetchImpl || (async (url, o) => {
		const { netRequest } = require('./net-helper');
		return netRequest(url, o);
	});
	return doFetch(CURSOR_API_BASE + CURSOR_LEGACY_USAGE_PATH, {
		headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json', 'User-Agent': CURSOR_UA },
		timeout: 15000,
	});
}

/** Cursor token 刷新（oauth/token；响应只回 access_token/id_token → refresh token 不轮换，链内刷新安全） */
async function refreshCursorToken(refreshToken, _fetchImpl) {
	const doFetch = _fetchImpl || (async (url, o) => {
		const { netRequest } = require('./net-helper');
		return netRequest(url, o);
	});
	try {
		const resp = await doFetch(CURSOR_REFRESH_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json',
				'User-Agent': CURSOR_UA,
			},
			body: JSON.stringify({
				grant_type: 'refresh_token',
				client_id: CURSOR_CLIENT_ID,
				refresh_token: refreshToken,
			}),
			timeout: 15000,
		});
		if (!resp.ok) {
			if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
				const data = await resp.json().catch(() => ({}));
				return { success: false, error: String(data.error || `HTTP ${resp.status}`) };
			}
			return { success: false, error: `刷新通道不可用(HTTP ${resp.status})` };
		}
		const data = await resp.json();
		if (data.shouldLogout === true) {
			return { success: false, error: 'refresh token 已失效(shouldLogout)' };
		}
		if (!data.access_token) {
			return { success: false, error: '刷新响应缺少 access_token 字段' };
		}
		return {
			success: true,
			token: data.access_token,
			id_token: typeof data.id_token === 'string' ? data.id_token : undefined,
		};
	} catch (e) {
		return { success: false, error: e && e.message ? e.message : String(e) };
	}
}

/**
 * DashboardService/GetCurrentPeriodUsage 响应 → 渲染端口径 usage。
 * planUsage.remaining/limit 单位 cents（消耗型，月度计费周期重置）；limit 缺失时只回 remaining。
 * @returns {{usage: {used, remaining, total, percentage, unit, plan_tier_name}} | {error: string}}
 */
function parseCursorUsageData(data) {
	if (!data || typeof data !== 'object') return { error: '响应为空' };
	const plan = data.planUsage && typeof data.planUsage === 'object' ? data.planUsage : null;
	if (!plan) return { error: '缺少 planUsage 字段' };
	const remaining = Number(plan.remaining);
	if (!Number.isFinite(remaining)) return { error: 'planUsage.remaining 缺失' };
	const usage = { used: null, remaining, total: null, percentage: null, unit: 'credits', plan_tier_name: null };
	const limit = Number(plan.limit);
	if (Number.isFinite(limit) && limit > 0) {
		usage.total = limit;
		usage.used = Math.max(0, Math.round((limit - remaining) * 100) / 100);
		usage.percentage = Math.round((usage.used / limit) * 1000) / 10;
	}
	return { usage };
}

/** 旧版 /auth/usage 响应 → 渲染端口径（{model: {numRequests, maxRequestUsage}}；total 取各模型上限最大值） */
function parseCursorLegacyUsageData(data) {
	if (!data || typeof data !== 'object') return { error: '响应为空' };
	let used = 0, total = 0, entries = 0;
	for (const [k, v] of Object.entries(data)) {
		if (k === 'startOfMonth' || !v || typeof v !== 'object') continue;
		const n = Number(v.numRequests);
		const m = Number(v.maxRequestUsage);
		if (Number.isFinite(n)) { used += n; entries++; }
		if (Number.isFinite(m)) total = Math.max(total, m);
	}
	if (!entries) return { error: '无用量条目' };
	const remaining = Math.max(0, total - used);
	return {
		usage: {
			used,
			remaining,
			total: total > 0 ? total : null,
			percentage: total > 0 ? Math.round((used / total) * 1000) / 10 : null,
			unit: 'credits',
			plan_tier_name: null,
		},
	};
}

module.exports = {
	CURSOR_API_BASE,
	CURSOR_USAGE_RPC_PATH,
	CURSOR_LEGACY_USAGE_PATH,
	CURSOR_REFRESH_URL,
	CURSOR_CLIENT_ID,
	CURSOR_AUTH_KEYS,
	cursorAppDataPath,
	parseCursorJwt,
	extractCursorSub,
	readCursorAuth,
	cursorAuthAccountMatches,
	fetchCursorRpc,
	fetchCursorLegacyUsage,
	refreshCursorToken,
	parseCursorUsageData,
	parseCursorLegacyUsageData,
};
