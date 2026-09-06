// codex-context.js — OpenAI Codex CLI 额度查询支持：wham/usage 只读探测 + 本地 auth.json 同账号副本兜底 + 解析。
// 开源版仅保留只读查询链路（凭证注入/设备身份/上下文清理不在开源范围内）。
//
// 约定：OpenAI OAuth 刷新会轮换 refresh token —— 本模块一律不主动刷新，
// 防止作废本地 CLI 持有的同一 refresh token。token 过期时改用本地 auth.json 的
// 同账号实时副本兜底（CLI 自动续期回写过的新 access_token，比库存凭证新鲜）。

const fs = require('fs');
const path = require('path');
const os = require('os');

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Codex CLI 主目录（CODEX_HOME 环境变量可重定位，官方同语义） */
function codexHomeDir() {
	if (process.env.CODEX_HOME && path.isAbsolute(process.env.CODEX_HOME)) return process.env.CODEX_HOME;
	return path.join(os.homedir(), '.codex');
}

/** 解析 Codex access_token JWT payload（auth.openai.com 签发，不验签） */
function parseCodexJwt(token) {
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

/** 从 access_token JWT 提取 chatgpt_account_id（wham/usage 的 ChatGPT-Account-Id 头 + auth.json tokens.account_id） */
function extractCodexAccountId(token) {
	const auth = parseCodexJwt(token)?.['https://api.openai.com/auth'];
	const id = auth && typeof auth === 'object' ? auth.chatgpt_account_id : null;
	return typeof id === 'string' && id ? id : null;
}

/** 读取 auth.json（不存在/损坏/非对象返回 null） */
function readCodexAuth(homeDir) {
	const authPath = path.join(homeDir || codexHomeDir(), 'auth.json');
	try {
		const data = JSON.parse(fs.readFileSync(authPath, 'utf8'));
		return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
	} catch {
		return null;
	}
}

/**
 * 本地 auth.json 与账号凭证是否同账号（chatgpt_account_id 一致才算本地活副本）。
 * 启动过 CLI 后本地 auth.json 即实时凭证（CLI 自动续期回写）；额度检测用它兜底。
 */
function codexAuthAccountMatches(homeDir, token) {
	const local = readCodexAuth(homeDir);
	const localAccess = local && local.tokens && typeof local.tokens.access_token === 'string' ? local.tokens.access_token : null;
	if (!localAccess) return { matches: false, localAccess: null };
	const a = extractCodexAccountId(token);
	const b = extractCodexAccountId(localAccess);
	if (!a && !b) {
		// 均无 account_id 声明（异常 JWT）：按 token 字面比对
		return { matches: localAccess === token, localAccess: localAccess === token ? localAccess : null };
	}
	return { matches: !!a && a === b, localAccess: a === b ? localAccess : null };
}

/** wham/usage 请求（官方 CLI/CodexBar 同款头） */
async function fetchCodexUsage(token, accountId, _fetchImpl) {
	const doFetch = _fetchImpl || (async (url, opts) => {
		const { netRequest } = require('./net-helper');
		return netRequest(url, opts);
	});
	return doFetch(CODEX_USAGE_URL, {
		headers: {
			'Authorization': `Bearer ${token}`,
			'Accept': 'application/json',
			'Content-Type': 'application/json',
			'User-Agent': CODEX_UA,
			'Origin': 'https://chatgpt.com',
			'Referer': 'https://chatgpt.com/',
			...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
		},
		timeout: 15000,
	});
}

/** plan_type → 展示套餐名 */
function mapCodexPlanType(planType) {
	const t = String(planType || '').toLowerCase();
	const names = {
		guest: 'Guest', free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro',
		free_workspace: 'Free Workspace', team: 'Team', business: 'Business',
		education: 'Edu', edu: 'Edu', quorum: 'Quorum', k12: 'K12', enterprise: 'Enterprise',
	};
	return names[t] || (t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Free');
}

/**
 * wham/usage 响应 → 渲染端口径 usage。
 * credits.unlimited → 999999/Infinity；has_credits+balance → balance*100；订阅账号 → remaining=null。
 * @returns {{usage: {used, remaining, total, percentage, unit, plan_tier_name}} | {error: string}}
 */
function parseCodexUsageData(data) {
	if (!data || typeof data !== 'object') return { error: '响应为空' };
	const rl = data.rate_limit && typeof data.rate_limit === 'object' ? data.rate_limit : {};
	const credits = data.credits && typeof data.credits === 'object' ? data.credits : {};
	const hasWindow = !!(rl.primary_window || rl.five_hour || rl.secondary_window || rl.weekly);
	if (!hasWindow && credits.has_credits !== true && credits.unlimited !== true) {
		return { error: '缺少 rate_limit/credits 字段' };
	}
	const planName = mapCodexPlanType(data.plan_type);
	if (credits.unlimited === true) {
		return { usage: { used: 0, remaining: Infinity, total: 999999, percentage: 0, unit: 'credits', plan_tier_name: planName } };
	}
	const balance = Number(credits.balance);
	if (credits.has_credits === true && Number.isFinite(balance)) {
		const scaled = Math.round(balance * 100);
		return { usage: { used: 0, remaining: scaled, total: scaled, percentage: 0, unit: 'credits', plan_tier_name: planName } };
	}
	// 订阅账号（Plus/Pro 等百分比窗口）→ 额度不可查（仅套餐展示）
	return { usage: { used: null, remaining: null, total: null, percentage: null, unit: 'credits', plan_tier_name: planName } };
}

module.exports = {
	CODEX_USAGE_URL,
	codexHomeDir,
	parseCodexJwt,
	extractCodexAccountId,
	readCodexAuth,
	codexAuthAccountMatches,
	fetchCodexUsage,
	mapCodexPlanType,
	parseCodexUsageData,
};
