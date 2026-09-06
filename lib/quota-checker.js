// CCK 账号管理器 - 额度查询模块
// 支持 QoderWork CN (openapi.qoder.com.cn)、Qoder CN IDE (qodercn，同账号体系，v3/user/status 门禁端点)、
// Qoder 国际版 (openapi.qoder.sh)、
// Trae CN / TRAE SOLO CN (api.trae.cn)、CodeBuddy CN / WorkBuddy (copilot.tencent.com 计费接口查真实积分)、
// CodeBuddy 国际版 (www.codebuddy.ai 同协议计费接口，X-Domain=www.codebuddy.ai)、
// 千问办公 (gateway.qwenwork.cn account-context 汇总口径，复用 qwenwork-context)、
// Codex CLI (chatgpt.com wham/usage 只读探测，复用 codex-context)、
// Cursor IDE (api2.cursor.sh DashboardService RPC 美分口径，复用 cursor-context)
// Kiro IDE (q.{region}.amazonaws.com GetUsageLimits 月度 credits 口径，复用 kiro-context)
// 使用 Electron net 模块（自动走系统代理）

const { netRequest } = require('./net-helper');

const QODER_API_BASE = 'https://openapi.qoder.com.cn';
const QODER_USAGE_PATH = '/api/v1/me/usage';
const QODER_REFRESH_PATH = '/api/v1/deviceToken/refresh';
const QODER_UA = 'QoderWork';

const QODER_INTL_API_BASE = 'https://openapi.qoder.sh';
const QODER_INTL_UA = 'Qoder';

const QODER_CN_STATUS_PATH = '/api/v3/user/status'; // Qoder CN IDE 官方门禁端点（剩余额度/白名单/套餐/昵称）

const TRAE_API_BASE = 'https://api.trae.cn';
const TRAE_USAGE_PATH = '/trae/api/v2/pay/ide_user_ent_usage';

// Trae 国际版（trae_intl）: SG 网关全区域通用为主，US 网关兜底；fast requests 口径
const TRAE_INTL_API_BASE_SG = 'https://api-sg-central.trae.ai';
const TRAE_INTL_API_BASE_US = 'https://ug-normal.us.trae.ai';
const TRAE_INTL_USAGE_PATH = '/trae/api/v1/pay/user_current_entitlement_list';
const TRAE_INTL_EXCHANGE_PATH = '/cloudide/api/v3/trae/oauth/ExchangeToken';
const TRAE_INTL_EXCHANGE_HOSTS = ['https://api.trae.ai', 'https://api.marscode.com', 'https://www.trae.ai', 'https://www.marscode.com'];
const TRAE_INTL_CLIENT_ID = 'ono9krqynydwx5';

const CODEBUDDY_API_BASE = 'https://copilot.tencent.com';
const CODEBUDDY_DOMAIN = 'www.codebuddy.cn';
const WORKBUDDY_DOMAIN = 'www.workbuddy.cn';
// CodeBuddy 国际版: www.codebuddy.ai 同协议不同域名（X-Domain 同步切换）
const CODEBUDDY_INTL_API_BASE = 'https://www.codebuddy.ai';
const CODEBUDDY_INTL_DOMAIN = 'www.codebuddy.ai';

/** 刷新 device token（QoderWork CN / Qoder 国际版共用，仅 base 与 UA 不同） */
async function refreshDeviceToken(token, refreshToken, apiBase = QODER_API_BASE, ua = QODER_UA) {
	try {
		const resp = await netRequest(apiBase + QODER_REFRESH_PATH, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': ua },
			body: JSON.stringify({ refresh_token: refreshToken }),
			timeout: 20000,
		});
		if (!resp.ok) return { success: false, error: `Token 刷新失败: HTTP ${resp.status}` };
		const data = await resp.json();
		const newToken = data.device_token || data.token;
		if (!newToken) return { success: false, error: '刷新响应无 token 字段' };
		return { success: true, token: newToken, refresh_token: data.refresh_token || refreshToken };
	} catch (err) {
		return { success: false, error: `Token 刷新异常: ${err.message}` };
	}
}

/**
 * Qoder CN IDE(qodercn) 额度检测：GET /api/v3/user/status（IDE isQuotaExceeded 门禁同源数据）。
 * quota=剩余可用积分（单一数值，total=remaining 口径）；whitelistStatus 非 PASS → IDE 端强制登出，账号不可售。
 * 与服务端 src/lib/quota.js checkQoderCnStatus 保持同构（含 401 刷新重试）。
 */
async function checkQoderCnStatus(token, refreshToken) {
	try {
		let resp = await netRequest(QODER_API_BASE + QODER_CN_STATUS_PATH, {
			headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
			timeout: 20000,
		});
		// token 过期：刷新后重试（与 qoder 默认路径同一刷新端点）
		if ((resp.status === 401 || resp.status === 403) && refreshToken) {
			const refreshed = await refreshDeviceToken(token, refreshToken);
			if (!refreshed.success) {
				return { success: false, banned: true, error: `Token 已过期且刷新失败: ${refreshed.error}` };
			}
			resp = await netRequest(QODER_API_BASE + QODER_CN_STATUS_PATH, {
				headers: { 'Authorization': `Bearer ${refreshed.token}`, 'Accept': 'application/json' },
				timeout: 20000,
			});
		}
		if (resp.status === 401 || resp.status === 403) {
			return { success: false, banned: true, error: 'Token 无效或已过期 (Qoder CN IDE)' };
		}
		if (!resp.ok) return { success: false, error: `额度查询失败: HTTP ${resp.status}` };
		const data = await resp.json();
		if (data.whitelistStatus !== 'PASS') {
			// 白名单未过 = 平台强制登出（IDE 门禁端点），账号无法登录 → 按封禁提示
			return { success: false, banned: true, error: `IDE 白名单未通过(whitelistStatus=${data.whitelistStatus ?? 'null'})，账号无法登录 IDE` };
		}
		const remaining = Number(data.quota);
		if (!Number.isFinite(remaining)) {
			return { success: false, error: 'v3/user/status 响应缺少 quota 字段' };
		}
		return {
			success: true,
			usage: { used: 0, remaining, total: remaining, percentage: 0, unit: 'credits', plan_tier_name: data.userTag || data.plan || null },
		};
	} catch (err) {
		return { success: false, error: `额度查询异常: ${err.message}` };
	}
}

/** 查询账号额度（token 过期时自动刷新，支持多分类）
 *  失败返回含 banned 标志: true = 凭证被平台明确拒绝（401/403 吊销、刷新链死亡、
 *  qodercn 白名单未过、Trae 401 死 token）→ 渲染端按「账号已被封禁，无法使用」醒目提示；
 *  false/缺省 = 网络异常等临时失败 → 维持灰色「查询失败」提示，避免误报封禁。 */
async function checkQuota(token, refreshToken, category = 'qoder') {
	// Trae CN / TRAE SOLO CN 使用不同的 API
	if (category === 'trae_cn' || category === 'trae_solo') {
		return checkTraeQuota(token, category);
	}
	// Trae 国际版: SG/US 网关 + ExchangeToken 链内续期（fast requests 口径，与服务端 checkTraeIntlQuota 同构）
	if (category === 'trae_intl') {
		return checkTraeIntlQuota(token, refreshToken);
	}
	// CodeBuddy CN / WorkBuddy / CodeBuddy 国际版: 计费接口查真实积分（积分制；不调 refresh 防止 Keycloak 轮换作废凭证）
	if (category === 'codebuddy_cn' || category === 'workbuddy' || category === 'codebuddy_intl') {
		const isWb = category === 'workbuddy';
		const isIntl = category === 'codebuddy_intl';
		return checkCodebuddyQuota(
			token,
			isIntl ? 'CodeBuddy' : isWb ? 'WorkBuddy' : 'CodeBuddy',
			isIntl ? CODEBUDDY_INTL_DOMAIN : isWb ? WORKBUDDY_DOMAIN : CODEBUDDY_DOMAIN,
			isIntl ? CODEBUDDY_INTL_API_BASE : CODEBUDDY_API_BASE,
		);
	}
	// Qoder CN IDE(qodercn): v3/user/status 一次拿到剩余额度(quota)+白名单(whitelistStatus)
	if (category === 'qodercn') {
		return checkQoderCnStatus(token, refreshToken);
	}
	// 千问办公(qwenwork): account-context 一次拿额度+套餐（积分制月度刷新；401 链内 deviceToken 续期）
	if (category === 'qwenwork') {
		return checkQwenworkQuota(token, refreshToken);
	}
	// Codex CLI(codex): wham/usage 只读探测（不主动刷新——OpenAI 轮换 refresh token，刷新即作废
	// 买家本地 CLI 持有的同一 RT）；401 用本地 auth.json 同账号实时副本兜底）
	if (category === 'codex') {
		return checkCodexQuota(token, refreshToken);
	}
	// Cursor(cursor): GetCurrentPeriodUsage RPC（美分口径）；刷新不轮换 RT → 链内刷新安全
	if (category === 'cursor') {
		return checkCursorQuota(token, refreshToken);
	}
	// Kiro(kiro): GetUsageLimits 月度 credits 口径（usageBreakdownList CREDIT 条目）；
	// 刷新轮换 RT → 同账号本地实时副本优先兜底（IDE 续期回写的新鲜凭证），再走链内刷新重试
	if (category === 'kiro') {
		return checkKiroQuota(token, refreshToken);
	}
	// QoderWork CN / Qoder 国际版使用同一套 API（仅 base 与 UA 不同）
	const isIntl = category === 'qoder_intl';
	const apiBase = isIntl ? QODER_INTL_API_BASE : QODER_API_BASE;
	const ua = isIntl ? QODER_INTL_UA : QODER_UA;
	try {
		const resp = await netRequest(apiBase + QODER_USAGE_PATH, {
			headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': ua, 'Accept': 'application/json' },
			timeout: 20000,
		});

		if (resp.status === 401 || resp.status === 403) {
			if (refreshToken) {
				const refreshed = await refreshDeviceToken(token, refreshToken, apiBase, ua);
				if (!refreshed.success) {
					return { success: false, banned: true, error: `Token 已过期且刷新失败: ${refreshed.error}` };
				}
				return await checkQuotaWithToken(refreshed.token, apiBase, ua);
			}
			return { success: false, banned: true, error: 'Token 无效或已过期' };
		}

		if (!resp.ok) return { success: false, error: `额度查询失败: HTTP ${resp.status}` };

		const usage = await resp.json();
		return parseQuota(usage);
	} catch (err) {
		return { success: false, error: `额度查询异常: ${err.message}` };
	}
}

/**
 * 千问办公(qwenwork)额度检测：account-context 汇总口径（复用 qwenwork-context 的请求/解析，
 * 与服务端 checkQwenworkQuota 同构）。401/403 → deviceToken 续期后重试；续期失败按封禁口径
 * （刷新链死亡 = 平台明确拒绝）。
 */
async function checkQwenworkQuota(token, refreshToken) {
	const { fetchQwenworkAccountContext, refreshQwenworkToken, parseQwenworkQuotaContext } = require('./qwenwork-context');
	try {
		const ctx = await fetchQwenworkAccountContext(token);
		if (!ctx.success && (ctx.status === 401 || ctx.status === 403)) {
			if (refreshToken) {
				const refreshed = await refreshQwenworkToken(refreshToken);
				if (!refreshed.success) {
					return { success: false, banned: true, error: `千问办公 Token 已过期且刷新失败: ${refreshed.error}` };
				}
				const retry = await fetchQwenworkAccountContext(refreshed.token);
				if (!retry.success) {
					return { success: false, banned: !!(retry.status === 401 || retry.status === 403), error: retry.error || `千问办公续期后仍被拒(HTTP ${retry.status})` };
				}
				return finishQwenworkQuota(retry, refreshed);
			}
			return { success: false, banned: true, error: `千问办公 token 无效或已过期: HTTP ${ctx.status}` };
		}
		if (!ctx.success) {
			return { success: false, error: `千问办公额度查询失败: ${ctx.error || '网关不可用'}` };
		}
		return finishQwenworkQuota(ctx);
	} catch (err) {
		return { success: false, error: `千问办公额度查询异常: ${err.message}` };
	}
}

/** account-context 成功响应 → 渲染端口径 usage（含续期后的新凭证回传） */
function finishQwenworkQuota(ctx, refreshed) {
	const parsed = parseQwenworkQuotaContext(ctx.ctx || { user: ctx.user, plan: ctx.plan, quota: ctx.quota });
	if (parsed.error) return { success: false, error: parsed.error };
	const result = { success: true, usage: parsed.usage };
	if (parsed.plan_expires_at) result.plan_expires_at = parsed.plan_expires_at;
	if (refreshed) {
		result.new_token = refreshed.token;
		result.new_refresh_token = refreshed.refresh_token;
	}
	return result;
}

/**
 * Codex CLI(codex) 额度查询：chatgpt.com/backend-api/wham/usage 只读探测（官方 CLI/CodexBar 同款端点）。
 * 不主动刷新：OpenAI 刷新即轮换 refresh token，桌面端刷新会作废买家本地 CLI 持有的同一 RT
 * （codex-context 头部约定「服务端/桌面端探测一律不主动刷新」）。买家启动过 CLI 后本地 auth.json
 * 即实时凭证（CLI 自动续期回写）→ 401 时用本地同账号副本兜底重试；两把均过期 → fail-soft
 * （非封禁口径：启动一次 CLI 自续期后可复查）。
 */
async function checkCodexQuota(token, refreshToken) {
	const { fetchCodexUsage, parseCodexUsageData, codexAuthAccountMatches, extractCodexAccountId } = require('./codex-context');
	try {
		let accountId = extractCodexAccountId(token);
		let resp = await fetchCodexUsage(token, accountId);
		if (resp.status === 401 || resp.status === 403) {
			// 本地同账号实时副本兜底（CLI 续期回写过的新 access_token，比库存凭证新鲜）
			const match = codexAuthAccountMatches(null, token);
			if (match.matches && match.localAccess && match.localAccess !== token) {
				resp = await fetchCodexUsage(match.localAccess, extractCodexAccountId(match.localAccess) || accountId);
			}
			if (resp.status === 401 || resp.status === 403) {
				return { success: false, error: 'Codex token 已过期（启动一次 Codex CLI 会自动续期，之后可再查询）' };
			}
		}
		if (!resp.ok) return { success: false, error: `Codex 额度查询失败: HTTP ${resp.status}` };
		const data = await resp.json();
		const parsed = parseCodexUsageData(data);
		if (parsed.error) return { success: false, error: `Codex 响应异常: ${parsed.error}` };
		return { success: true, usage: parsed.usage };
	} catch (err) {
		return { success: false, error: `Codex 额度查询异常: ${err.message}` };
	}
}

/**
 * Cursor IDE(cursor) 额度查询：api2.cursor.sh DashboardService/GetCurrentPeriodUsage（美分口径，
 * 与服务端 checkCursorQuota 同构）。Cursor 刷新不轮换 refresh token → 链内续期安全：
 * 401/403 先用本地同账号实时副本（IDE 续期回写，比库存凭证新鲜）兜底，再走 oauth/token 刷新重试；
 * refresh token 被服务端明确拒绝（shouldLogout/invalid_grant）按封禁口径，通道不可用 fail-soft。
 * 企业/旧计费账号（无 planUsage）降级 /auth/usage（按模型请求数口径）。
 */
async function checkCursorQuota(token, refreshToken) {
	const {
		fetchCursorRpc, fetchCursorLegacyUsage, parseCursorUsageData, parseCursorLegacyUsageData,
		cursorAuthAccountMatches, refreshCursorToken, CURSOR_USAGE_RPC_PATH,
	} = require('./cursor-context');
	try {
		let resp = await fetchCursorRpc(CURSOR_USAGE_RPC_PATH, token);
		let effToken = token;
		if (resp.status === 401 || resp.status === 403) {
			// 本地同账号实时副本兜底（买家启动过 IDE 后客户端自动续期回写的新鲜 access_token）
			const match = await cursorAuthAccountMatches(null, token);
			if (match.matches && match.localAccess && match.localAccess !== token) {
				resp = await fetchCursorRpc(CURSOR_USAGE_RPC_PATH, match.localAccess);
				if (resp.status !== 401 && resp.status !== 403) effToken = match.localAccess;
			}
		}
		if ((resp.status === 401 || resp.status === 403) && refreshToken) {
			// 链内 oauth/token 刷新（refresh token 不轮换，不会作废买家本地 IDE 持有的同一 RT）
			const refreshed = await refreshCursorToken(refreshToken);
			if (refreshed.success) {
				resp = await fetchCursorRpc(CURSOR_USAGE_RPC_PATH, refreshed.token);
				if (resp.status !== 401 && resp.status !== 403) effToken = refreshed.token;
			} else if (/已失效|invalid_grant|unauthorized|forbidden|HTTP 40[0-3]/i.test(refreshed.error)) {
				return { success: false, banned: true, error: `Cursor token 已过期且刷新失败: ${refreshed.error}` };
			}
		}
		if (resp.status === 401 || resp.status === 403) {
			return { success: false, banned: !!refreshToken, error: 'Cursor token 无效或已过期' };
		}
		if (!resp.ok) return { success: false, error: `Cursor 额度查询失败: HTTP ${resp.status}` };
		const data = await resp.json().catch(() => null);
		const parsed = parseCursorUsageData(data);
		if (parsed.error) {
			// 企业/旧计费账号降级 /auth/usage（numRequests 口径；失败回落原错误）
			const legacy = await fetchCursorLegacyUsage(effToken);
			if (legacy.ok) {
				const legacyParsed = parseCursorLegacyUsageData(await legacy.json().catch(() => null));
				if (!legacyParsed.error) return { success: true, usage: legacyParsed.usage };
			}
			return { success: false, error: `Cursor 响应异常: ${parsed.error}` };
		}
		return { success: true, usage: parsed.usage };
	} catch (err) {
		return { success: false, error: `Cursor 额度查询异常: ${err.message}` };
	}
}

/**
 * Kiro IDE(kiro) 额度查询：q.{region}.amazonaws.com/getUsageLimits 月度 credits 口径
 * （与服务端 checkKiroQuota 同构）。Kiro 刷新轮换 refresh token → 同账号本地实时副本
 * （IDE 续期回写的新鲜 access_token）优先兜底，再走链内刷新重试；刷新失败按封禁口径
 * （服务端明确拒绝 = 死号），通道不可用 fail-soft。profileArn 从 user_data 或 JWT 提取。
 */
async function checkKiroQuota(token, refreshToken, opts) {
	const { fetchKiroUsage, parseKiroUsageData, kiroAuthAccountMatches, refreshKiroToken, extractRegionFromProfileArn } = require('./kiro-context');
	try {
		// profileArn 优先从 opts.user_data 提取，其次从 JWT claims
		let profileArn = '';
		if (opts && opts.user_data) {
			try {
				const ud = typeof opts.user_data === 'string' ? JSON.parse(opts.user_data) : opts.user_data;
				profileArn = ud?.profileArn || '';
			} catch {}
		}
		let resp = await fetchKiroUsage(token, profileArn);
		let effToken = token;
		if (resp.status === 401 || resp.status === 403) {
			// 本地同账号实时副本兜底（买家启动过 IDE 后客户端自动续期回写的新鲜 access_token）
			const match = await kiroAuthAccountMatches(null, token);
			if (match.matches && match.localAccess && match.localAccess !== token) {
				resp = await fetchKiroUsage(match.localAccess, profileArn);
				if (resp.status !== 401 && resp.status !== 403) effToken = match.localAccess;
			}
		}
		if ((resp.status === 401 || resp.status === 403) && refreshToken && !(opts && opts.noRefresh)) {
			// 链内刷新（Kiro 刷新轮换 RT → 桌面端刷新后需同步回写 token 文件，否则买家本地 IDE 持有的旧 RT 失效）
			const refreshed = await refreshKiroToken(refreshToken);
			if (refreshed.success) {
				resp = await fetchKiroUsage(refreshed.token, refreshed.profileArn || profileArn);
				if (resp.status !== 401 && resp.status !== 403) {
					effToken = refreshed.token;
					profileArn = refreshed.profileArn || profileArn;
				}
			} else if (refreshed.banned) {
				return { success: false, banned: true, error: `Kiro token 已过期且刷新失败: ${refreshed.error}` };
			}
		}
		if (resp.status === 401 || resp.status === 403) {
			return { success: false, banned: !!refreshToken, error: 'Kiro token 无效或已过期' };
		}
		if (!resp.ok) return { success: false, error: `Kiro 额度查询失败: HTTP ${resp.status}` };
		const data = await resp.json().catch(() => null);
		const parsed = parseKiroUsageData(data);
		if (parsed.error) return { success: false, error: `Kiro 响应异常: ${parsed.error}` };
		const result = { success: true, usage: parsed.usage };
		// 检测链内续期的新凭证回写（与服务端 sold-monitor 同构）
		if (effToken !== token) {
			result.new_token = effToken;
		}
		return result;
	} catch (err) {
		return { success: false, error: `Kiro 额度查询异常: ${err.message}` };
	}
}

/** 解析 CodeBuddy / WorkBuddy JWT payload（不验签，仅读取 iss/sub 等声明；两种 token 互通，按签发域区分） */
function parseCbJwt(token) {
	if (!token || typeof token !== 'string' || !token.startsWith('eyJ')) return null;
	try {
		const parts = token.split('.');
		if (parts.length !== 3) return null;
		const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
		return payload && typeof payload === 'object' ? payload : null;
	} catch { return null; }
}

/**
 * CodeBuddy CN / WorkBuddy / CodeBuddy 国际版 额度查询。
 * CN 与 WB 同 copilot.tencent.com 后端；国际版走 www.codebuddy.ai 同协议端点（X-Domain 同步切换）。
 * 优先调计费接口汇总真实积分（官方客户端 getPersonalUsage 同款请求，只读、不触碰 refresh）；
 * 企业账号（无个人资源）或计费接口异常时回退 /v2/accounts 仅校验有效性（valid_only，额度字段 null）。
 */
async function checkCodebuddyQuota(token, label = 'CodeBuddy', domain = CODEBUDDY_DOMAIN, apiBase = CODEBUDDY_API_BASE) {
	// 域名/端点以 JWT 实际签发方为准（CN/WB token 互通可能与其库存分类标注不一致；国际版独立后端）
	const jwt = parseCbJwt(token);
	const iss = typeof jwt?.iss === 'string' ? jwt.iss : '';
	const effDomain = iss.includes('workbuddy.cn') ? WORKBUDDY_DOMAIN
		: iss.includes('codebuddy.ai') ? CODEBUDDY_INTL_DOMAIN
		: iss.includes('codebuddy.cn') ? CODEBUDDY_DOMAIN : domain;
	const effBase = iss.includes('codebuddy.ai') ? CODEBUDDY_INTL_API_BASE : apiBase;
	// 1) 计费接口：真实积分
	try {
		const resp = await netRequest(effBase + '/v2/billing/meter/get-user-resource', {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${token}`,
				'Content-Type': 'application/json',
				'Accept': 'application/json',
				'Accept-Language': 'zh',
				'X-Domain': effDomain,
				...(jwt?.sub ? { 'X-User-Id': jwt.sub } : {}),
			},
			body: JSON.stringify({ PageNumber: 1, PageSize: 100, ProductCode: 'p_tcaca', Status: [0, 3], OnlyValidPeriod: true }),
			timeout: 20000,
		});
		if (resp.status === 401 || resp.status === 403) {
			return { success: false, banned: true, error: `${label} token 无效或已吊销: HTTP 401` };
		}
		if (resp.ok) {
			const data = await resp.json().catch(() => null);
			const accounts = data?.data?.Response?.Data?.Accounts;
			if (Array.isArray(accounts) && accounts.length > 0) {
				let total = 0, left = 0;
				for (const r of accounts) {
					total += Number(r.CycleCapacitySizePrecise) || 0;
					left += Number(r.CycleCapacityRemainPrecise) || 0;
				}
				const used = total - left;
				return {
					success: true,
					usage: { used, remaining: left, total, percentage: total > 0 ? Math.round((used / total) * 100) : 0, unit: '积分' },
				};
			}
			// 有效但无个人资源（企业账号）→ 回退有效性校验
		}
	} catch (err) {
		// 计费接口异常 → 回退有效性校验
	}
	// 2) 回退：仅校验 token 有效性（额度字段 null，渲染端按 valid_only 显示"积分制"）
	try {
		const resp = await netRequest(effBase + '/v2/accounts', {
			headers: {
				'Authorization': `Bearer ${token}`,
				'X-Domain': effDomain,
				'Accept': 'application/json',
			},
			timeout: 20000,
		});
		if (resp.status === 401 || resp.status === 403) {
			return { success: false, banned: true, error: `${label} token 无效或已吊销: HTTP 401` };
		}
		if (!resp.ok) return { success: false, error: `${label} 校验失败: HTTP ${resp.status}` };
		return {
			success: true,
			valid_only: true, // 渲染端凭此显示"积分制"而非具体额度
			usage: { used: null, remaining: null, total: null, percentage: 0, unit: '积分' },
		};
	} catch (err) {
		return { success: false, error: `${label} 校验异常: ${err.message}` };
	}
}

/** Trae CN / TRAE SOLO CN 额度查询 (Cloud-IDE-JWT 认证)
 *  req_source（官方客户端 G$e 枚举）：1=IDE、2=Lite(Work/SOLO)。服务端按来源过滤积分包：
 *  IDE 只返回通用积分包；Lite(2) 返回通用+Work 专属全部包（09-05 修复，与服务端 quota.js 同口径）。 */
async function checkTraeQuota(token, category = 'trae_cn') {
	try {
		const resp = await netRequest(TRAE_API_BASE + TRAE_USAGE_PATH, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Cloud-IDE-JWT ${token}`,
			},
			body: JSON.stringify({ require_usage: true, req_source: category === 'trae_solo' ? 2 : 1 }),
			timeout: 20000,
		});
		// 401 = token 失效且刷新链已死（服务端 my-accounts 拉取时 refreshTraeTokensOnFetch 已尽力续期）→ 按封禁提示
		if (resp.status === 401) return { success: false, banned: true, error: 'Trae token 已失效 (HTTP 401)' };
		if (!resp.ok) return { success: false, error: `Trae 额度查询失败: HTTP ${resp.status}` };
		const data = await resp.json();
		if (data.code && data.code !== 0) {
			return { success: false, error: `Trae 额度查询错误: ${data.message || data.code}` };
		}
		return parseTraeQuota(data);
	} catch (err) {
		return { success: false, error: `Trae 额度查询异常: ${err.message}` };
	}
}

/** 用指定 token 查询额度并解析结果 */
async function checkQuotaWithToken(token, apiBase = QODER_API_BASE, ua = QODER_UA) {
	const resp = await netRequest(apiBase + QODER_USAGE_PATH, {
		headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': ua, 'Accept': 'application/json' },
		timeout: 20000,
	});
	if (!resp.ok) return { success: false, error: `刷新后额度查询仍失败: HTTP ${resp.status}` };
	const usage = await resp.json();
	return parseQuota(usage);
}

/** Trae 国际版 ExchangeToken 续期（无设备绑定，ClientSecret 恒 '-'；返回形状对齐 refreshDeviceToken） */
async function exchangeTraeIntlToken(token, refreshToken) {
	for (const host of TRAE_INTL_EXCHANGE_HOSTS) {
		try {
			const resp = await netRequest(host + TRAE_INTL_EXCHANGE_PATH, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Accept': 'application/json',
					...(token ? { 'x-cloudide-token': token } : {}),
				},
				body: JSON.stringify({ ClientID: TRAE_INTL_CLIENT_ID, RefreshToken: refreshToken, ClientSecret: '-', UserID: '' }),
				timeout: 20000,
			});
			if (!resp.ok) continue;
			const data = await resp.json().catch(() => ({}));
			const err = data?.ResponseMetadata?.Error;
			if (err) {
				// 服务端明确拒绝（refresh token 失效）→ 永久失败；网络/超时不在此列
				return { success: false, banned: true, error: `${err.Code}: ${err.Message}` };
			}
			if (data?.Result?.Token) {
				return { success: true, token: data.Result.Token, refresh_token: data.Result.RefreshToken || refreshToken };
			}
		} catch {
			// 网络异常 → 换下一个候选主机
		}
	}
	// 全部候选失败且无服务端结论 → 临时故障，不得据此判死号
	return { success: false, error: 'Trae 国际版 Token 续期通道不可达（稍后重试）' };
}

/** Trae 国际版额度查询 — SG 网关为主（鉴权结论权威），非鉴权失败 US 网关兜底；fast requests 口径 */
async function checkTraeIntlQuota(token, refreshToken) {
	let usage = await fetchTraeIntlUsage(token);
	if (usage.authFailed && refreshToken) {
		const ex = await exchangeTraeIntlToken(token, refreshToken);
		if (!ex.success) {
			return { success: false, banned: !!ex.banned, error: ex.error };
		}
		usage = await fetchTraeIntlUsage(ex.token);
		if (usage.authFailed) {
			// 续期成功但新 token 仍被拒 → 服务端状态异常，临时故障不判封禁
			return { success: false, error: `Trae 国际版续期后仍被拒(HTTP ${usage.status})，稍后重试` };
		}
	} else if (usage.authFailed) {
		// 无 refresh_token 无法仲裁（401 可能只是 JWT 自然过期）→ 不判封禁
		return { success: false, error: `Trae 国际版 token 已过期且缺少 refresh_token(HTTP ${usage.status})` };
	}
	if (!usage.ok) {
		return { success: false, error: `Trae 国际版额度查询失败: ${usage.error || '网关不可用'}` };
	}
	const parsed = parseTraeIntlEntitlements(usage.data);
	if (!parsed) {
		return { success: false, error: 'Trae 国际版响应缺少权益数据(user_entitlement_pack_list)' };
	}
	return {
		success: true,
		usage: {
			used: parsed.used,
			remaining: parsed.remaining,
			total: parsed.total,
			percentage: parsed.total > 0 ? Math.round((parsed.used / parsed.total) * 100) : 0,
			unit: 'fast requests',
			plan_tier_name: parsed.plan_name || null,
		},
	};
}

/** 请求 Trae 国际版 usage 端点（SG 主用/US 兜底）；401/403 只信 SG 网关结论 */
async function fetchTraeIntlUsage(token) {
	const headers = {
		'Content-Type': 'application/json',
		'Accept': 'application/json',
		'Authorization': `Cloud-IDE-JWT ${token}`,
		'Origin': 'https://www.trae.ai',
		'Referer': 'https://www.trae.ai/',
	};
	let primaryErr = null;
	try {
		const resp = await netRequest(TRAE_INTL_API_BASE_SG + TRAE_INTL_USAGE_PATH, {
			method: 'POST',
			headers,
			body: JSON.stringify({ require_usage: true }),
			timeout: 20000,
		});
		if (resp.ok) {
			const data = await resp.json().catch(() => null);
			if (data && typeof data === 'object') return { ok: true, data };
			primaryErr = 'SG 网关响应解析失败';
		} else if (resp.status === 401 || resp.status === 403) {
			return { authFailed: true, status: resp.status };
		} else {
			primaryErr = `HTTP ${resp.status}`;
		}
	} catch (err) {
		primaryErr = err.message;
	}
	try {
		const resp = await netRequest(TRAE_INTL_API_BASE_US + TRAE_INTL_USAGE_PATH, {
			method: 'POST',
			headers,
			body: JSON.stringify({ require_usage: true }),
			timeout: 20000,
		});
		if (resp.ok) {
			const data = await resp.json().catch(() => null);
			if (data && typeof data === 'object') return { ok: true, data };
		}
		// US 网关的 401 不可作为权威结论（区域不匹配会误判）→ 按临时故障处理
		return { error: `SG 网关 ${primaryErr}，US 网关 HTTP ${resp.status}` };
	} catch (err) {
		return { error: `SG 网关 ${primaryErr}，US 网关 ${err.message}` };
	}
}

/** 解析 Trae 国际版权益响应（fast requests 口径，与服务端 parseTraeIntlEntitlements 同构）
 *  主套餐包(product_type≠2)与加油包(product_type=2)的限额/用量分别累加；-1 不限量按 999999 计 */
function parseTraeIntlEntitlements(data) {
	let payload = data;
	for (const key of ['Result', 'result', 'Data', 'data']) {
		const wrapped = payload?.[key];
		if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped) && Array.isArray(wrapped.user_entitlement_pack_list)) {
			payload = wrapped;
			break;
		}
	}
	const packs = payload && Array.isArray(payload.user_entitlement_pack_list) ? payload.user_entitlement_pack_list : null;
	// null = 响应结构异常 → 检测失败复查；空数组 = 本月权益已用尽/无分配 → 按 0 额度处理（与服务端同口径）
	if (!packs) return null;
	if (packs.length === 0) return { total: 0, used: 0, remaining: 0, plan_name: 'Free' };
	const firstFinite = (...vals) => {
		for (const v of vals) {
			const n = Number(v);
			if (Number.isFinite(n)) return n;
		}
		return 0;
	};
	let limit = 0, extraLimit = 0, used = 0, extraUsed = 0;
	let planName = '';
	for (const pack of packs) {
		const base = pack?.entitlement_base_info || pack?.entitlementBaseInfo || {};
		const usage = pack?.usage || pack?.user_usage || pack?.userUsage || {};
		const quota = base.quota || pack?.quota || {};
		const rawLimit = firstFinite(quota.premium_model_fast_request_limit, quota.premiumModelFastRequestLimit, quota.fast_request_limit, quota.fastRequestLimit);
		const packLimit = rawLimit < 0 ? 999999 : rawLimit;
		const isAddOn = base.product_type === 2;
		const packUsed = isAddOn
			? firstFinite(usage.premium_model_fast_amount, usage.premium_model_fast_request_usage, usage.premiumModelFastAmount, usage.premiumModelFastRequestUsage, usage.fast_request_usage, usage.fastRequestUsage)
			: firstFinite(usage.premium_model_fast_request_usage, usage.premium_model_fast_amount, usage.premiumModelFastAmount, usage.premiumModelFastRequestUsage, usage.fast_request_usage, usage.fastRequestUsage, usage.used_amount, usage.usedAmount);
		if (isAddOn) {
			extraLimit += packLimit;
			extraUsed += packUsed;
		} else {
			limit += packLimit;
			used += packUsed;
			const desc = typeof pack.display_desc === 'string' ? pack.display_desc.replace(/\s*plan$/i, '').trim() : '';
			if (!planName) planName = desc || (base.product_id === 0 ? 'Free' : 'Pro');
		}
	}
	return { total: limit + extraLimit, used: used + extraUsed, remaining: Math.max(0, limit + extraLimit - (used + extraUsed)), plan_name: planName };
}

/** 解析额度响应（CN 区域 snake_case: user_quota / add_on_quota） */
function parseQuota(usage) {
	const userQuota = usage.user_quota || usage.userQuota || {};
	const addOnQuota = usage.add_on_quota || usage.addOnQuota || {};
	const totalCredits = (userQuota.total || 0) + (addOnQuota.total || 0);
	const remainingCredits = (userQuota.remaining || 0) + (addOnQuota.remaining || 0);
	const usedCredits = (userQuota.used || 0) + (addOnQuota.used || 0);

	return {
		success: true,
		usage: {
			used: usedCredits,
			remaining: remainingCredits,
			total: totalCredits,
			percentage: totalCredits > 0 ? Math.round((usedCredits / totalCredits) * 100) : 0,
			unit: userQuota.unit || 'credits',
			// 套餐信息（me/usage 实测字段）：plan_tier=free/pro、plan_tier_name=Free/Pro
			plan_tier: usage.plan_tier || null,
			plan_tier_name: usage.plan_tier_name || null,
		},
	};
}

/** 解析 Trae CN 额度响应 (与客户端 VOe 函数一致)
 *  credits_amount = 已使用量, credits_limit = 总限额
 *  remaining = credits_limit - credits_amount
 *  特殊: credits_limit === -1 表示无限额度 */
function parseTraeQuota(data) {
	const packs = data.user_entitlement_pack_list || [];
	let total = 0, used = 0, remaining = 0;
	let hasUnlimited = false, hasCredits = false;
	for (const pack of packs) {
		const limit = pack?.entitlement_base_info?.quota?.credits_limit;
		const amount = pack?.usage?.credits_amount ?? 0;
		if (limit === -1) {
			hasCredits = true;
			hasUnlimited = true;
		} else if (typeof limit === 'number' && limit > 0) {
			hasCredits = true;
			total += limit;
			remaining += Math.max(limit - amount, 0);
		}
		if (typeof limit === 'number' && limit !== 0) {
			used += amount;
		}
	}
	if (!hasCredits) {
		return { success: true, usage: { used: 0, remaining: 0, total: 0, percentage: 0, unit: 'credits' } };
	}
	const finalTotal = hasUnlimited ? Infinity : total;
	const finalRemaining = hasUnlimited ? Infinity : remaining;
	const percentage = (hasUnlimited || finalTotal === 0) ? 0 : Math.round((used / finalTotal) * 100);
	return {
		success: true,
		usage: {
			used: Math.round(used * 10) / 10,
			remaining: hasUnlimited ? Infinity : Math.round(finalRemaining * 10) / 10,
			total: finalTotal,
			percentage,
			unit: 'credits',
		},
	};
}

module.exports = { checkQuota };
