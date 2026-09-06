// kiro-context.js — Kiro IDE（AWS CodeWhisperer，VS Code fork）额度查询支持（开源版）。
// 开源版仅保留只读查询链路（凭证注入/设备身份/上下文清理不在开源范围内）。
//
// 登录态与额度接口说明：
//   1. 登录态: 主凭证存储在 ~/.aws/sso/cache/kiro-auth-token.json（accessToken / refreshToken /
//      profileArn / expiresAt / authMethod / provider）；state.vscdb 另有 kiro.kiroAgent 键缓存
//      使用量与 profile 信息，但主认证走 token 文件。
//   2. 额度: q.<region>.amazonaws.com /getUsageLimits（usageBreakdownList 月度 credits 口径）；
//      state.vscdb kiro.kiroAgent → kiro.resourceNotifications.usageState 为本地缓存副本。
//   3. Token 刷新: POST prod.us-east-1.auth.desktop.kiro.dev/refreshToken，
//      响应含新 accessToken / refreshToken / expiresIn / profileArn。
//
// 失败不抛出（调用方 try/catch，内部防御）。

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const KIRO_REFRESH_URL = 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken';
const KIRO_USAGE_API_TEMPLATE = 'https://q.{region}.amazonaws.com/getUsageLimits';
const KIRO_DEFAULT_REGION = 'us-east-1';
const KIRO_UA_PREFIX = 'KiroIDE';

// state.vscdb 中 Kiro 插件存储键
const KIRO_VSCDB_KEY = 'kiro.kiroAgent';

/** Kiro 应用数据目录（VS Code fork 标准布局） */
function kiroAppDataPath() {
	switch (process.platform) {
		case 'darwin': return path.join(os.homedir(), 'Library', 'Application Support', 'Kiro');
		case 'win32': return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Kiro');
		default: return path.join(os.homedir(), '.config', 'Kiro');
	}
}

/** Kiro 认证 token 文件路径（AWS SSO cache 目录） */
function kiroAuthTokenPath() {
	const home = os.homedir();
	return path.join(home, '.aws', 'sso', 'cache', 'kiro-auth-token.json');
}

/**
 * 从 profileArn 提取 AWS region（arn:aws:codewhisperer:<region>:...）
 * 无 region 或解析失败返回默认 us-east-1
 */
function extractRegionFromProfileArn(profileArn) {
	if (!profileArn || typeof profileArn !== 'string') return KIRO_DEFAULT_REGION;
	const m = profileArn.match(/^arn:aws:codewhisperer:([^:]+):/);
	return m ? m[1] : KIRO_DEFAULT_REGION;
}

/** 读取 Kiro 认证 token 文件（{accessToken, refreshToken, profileArn, expiresAt, authMethod, provider}） */
function readKiroAuthFile(tokenPath) {
	const p = tokenPath || kiroAuthTokenPath();
	try {
		if (!fs.existsSync(p)) return null;
		const raw = fs.readFileSync(p, 'utf8');
		const data = JSON.parse(raw);
		return data && typeof data === 'object' ? data : null;
	} catch {
		return null;
	}
}

/** 从 state.vscdb 读取 Kiro 插件存储 JSON（kiro.kiroAgent 键） */
async function readKiroVscdbStorage(appdataPath) {
	const { readPlainItem } = require('./vscdb-secret');
	const home = appdataPath || kiroAppDataPath();
	const raw = await readPlainItem(home, KIRO_VSCDB_KEY);
	if (!raw) return null;
	try {
		const data = JSON.parse(raw);
		return data && typeof data === 'object' ? data : null;
	} catch {
		return null;
	}
}

/** 从 JWT accessToken 中提取用户标识（不验签，仅做同账号判定） */
function extractKiroAccountId(accessToken) {
	if (!accessToken || typeof accessToken !== 'string') return null;
	// Kiro accessToken 为 JWT（OAuth 标准）
	if (!accessToken.startsWith('eyJ') || accessToken.split('.').length !== 3) {
		// 非 JWT 形态，用 token 前 32 位哈希作为标识
		return 'k_' + crypto.createHash('sha256').update(accessToken.slice(0, 64)).digest('hex').slice(0, 16);
	}
	try {
		const parts = accessToken.split('.');
		const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
		// 优先 sub（用户唯一标识），其次 username / email
		const sub = payload.sub || payload.username || payload.email;
		return sub ? String(sub) : null;
	} catch {
		return null;
	}
}

/**
 * 本地 token 文件与账号凭证是否同账号（基于 accessToken 中的 sub）。
 * IDE 启动后客户端会自动续期回写（比手动录入的凭证新鲜）；额度检测用它兜底。
 */
async function kiroAuthAccountMatches(appdataPath, accessToken) {
	const local = readKiroAuthFile();
	if (!local || !local.accessToken) return { matches: false, localAccess: null, localRefresh: null };
	const aId = extractKiroAccountId(accessToken);
	const bId = extractKiroAccountId(local.accessToken);
	if (!aId && !bId) {
		return { matches: local.accessToken === accessToken, localAccess: local.accessToken === accessToken ? local.accessToken : null, localRefresh: local.refreshToken || null };
	}
	return { matches: !!aId && aId === bId, localAccess: aId === bId ? local.accessToken : null, localRefresh: aId === bId ? local.refreshToken : null };
}

/**
 * 刷新 Kiro access token（prod.us-east-1.auth.desktop.kiro.dev/refreshToken）。
 * 本函数只返回新凭证，不写任何本地文件。
 */
async function refreshKiroToken(refreshToken, opts = {}, _fetchImpl) {
	const doFetch = _fetchImpl || (async (url, o) => {
		const { netRequest } = require('./net-helper');
		return netRequest(url, o);
	});
	try {
		const body = { refreshToken: String(refreshToken || '') };
		const headers = {
			'Content-Type': 'application/json',
			'Accept': 'application/json',
			'User-Agent': opts.userAgent || `${KIRO_UA_PREFIX}-1.0.0-unknown`,
		};
		const resp = await doFetch(KIRO_REFRESH_URL, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			timeout: 15000,
		});
		if (!resp.ok) {
			if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
				const data = await resp.json().catch(() => ({}));
				return { success: false, banned: true, error: String(data.message || data.error || `HTTP ${resp.status}`) };
			}
			return { success: false, error: `刷新通道不可用(HTTP ${resp.status})` };
		}
		const data = await resp.json().catch(() => ({}));
		if (!data.accessToken) {
			return { success: false, error: '刷新响应缺少 accessToken 字段' };
		}
		return {
			success: true,
			token: data.accessToken,
			refresh_token: data.refreshToken || refreshToken,
			profileArn: data.profileArn || null,
			expiresIn: data.expiresIn || null,
		};
	} catch (e) {
		return { success: false, error: e && e.message ? e.message : String(e) };
	}
}

/**
 * 请求 Kiro 额度 API（GET /getUsageLimits）。
 * profileArn 用于构造 URL 和查询参数；region 从 profileArn 提取，失败回退 us-east-1。
 */
async function fetchKiroUsage(accessToken, profileArn, _fetchImpl) {
	const doFetch = _fetchImpl || (async (url, o) => {
		const { netRequest } = require('./net-helper');
		return netRequest(url, o);
	});
	const region = extractRegionFromProfileArn(profileArn);
	const baseUrl = KIRO_USAGE_API_TEMPLATE.replace('{region}', region);
	const params = new URLSearchParams({
		origin: 'AI_EDITOR',
		resourceType: 'AGENTIC_REQUEST',
	});
	if (profileArn) params.set('profileArn', profileArn);
	const url = baseUrl + '?' + params.toString();
	const headers = {
		'Authorization': `Bearer ${accessToken}`,
		'Accept': 'application/json',
		'User-Agent': `${KIRO_UA_PREFIX}-1.0.0-unknown`,
	};
	try {
		return await doFetch(url, { method: 'GET', headers, timeout: 15000 });
	} catch (e) {
		return { ok: false, status: 0, error: e.message };
	}
}

/**
 * 解析 Kiro 额度响应（usageBreakdownList 中 CREDIT 类型条目）。
 * 支持服务端响应（usageBreakdownList）和本地缓存（usageBreakdowns）两种形态。
 * @returns {{usage: {used, remaining, total, percentage, unit, plan_tier_name}} | {error: string}}
 */
function parseKiroUsageData(data) {
	if (!data || typeof data !== 'object') return { error: '响应为空' };
	// 兼容服务端响应（usageBreakdownList）与本地缓存（usageBreakdowns）
	const breakdowns = Array.isArray(data.usageBreakdownList) ? data.usageBreakdownList
		: Array.isArray(data.usageBreakdowns) ? data.usageBreakdowns
		: null;
	if (!breakdowns) {
		// 尝试从本地缓存的嵌套结构中查找
		const usageState = data['kiro.resourceNotifications.usageState'] || data.usageState;
		if (usageState && Array.isArray(usageState.usageBreakdowns)) {
			return parseKiroUsageData(usageState);
		}
		return { error: '缺少 usageBreakdownList / usageBreakdowns 字段' };
	}
	// 找到 CREDIT 类型的条目
	const creditEntry = breakdowns.find((b) => b && b.type === 'CREDIT') || breakdowns[0];
	if (!creditEntry) return { error: '无 CREDIT 类型用量条目' };
	const used = Number(creditEntry.currentUsage);
	const limit = Number(creditEntry.usageLimit);
	if (!Number.isFinite(used) || !Number.isFinite(limit)) {
		return { error: '用量或限额字段无效' };
	}
	const remaining = Math.max(0, limit - used);
	const percentage = limit > 0 ? Math.round((used / limit) * 1000) / 10 : 0;
	// 套餐名：subscriptionInfo.subscriptionTitle（服务端响应有，本地缓存可能没有）
	let planName = null;
	const subInfo = data.subscriptionInfo;
	if (subInfo && subInfo.subscriptionTitle) {
		planName = subInfo.subscriptionTitle;
	} else if (creditEntry.displayName) {
		planName = creditEntry.displayName;
	}
	return {
		usage: {
			used: Math.round(used * 100) / 100,
			remaining: Math.round(remaining * 100) / 100,
			total: limit,
			percentage,
			unit: 'credits',
			plan_tier_name: planName,
		},
	};
}

module.exports = {
	KIRO_REFRESH_URL,
	KIRO_USAGE_API_TEMPLATE,
	KIRO_DEFAULT_REGION,
	KIRO_VSCDB_KEY,
	kiroAppDataPath,
	kiroAuthTokenPath,
	extractRegionFromProfileArn,
	readKiroAuthFile,
	readKiroVscdbStorage,
	extractKiroAccountId,
	kiroAuthAccountMatches,
	refreshKiroToken,
	fetchKiroUsage,
	parseKiroUsageData,
};
