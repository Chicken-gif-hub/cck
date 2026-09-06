// Workers API 调用封装：使用 Electron net 模块（自动走系统代理）
// 双域名容灾：主域名网络层失败（status=0，DNS 污染/被墙/超时）自动切换备用域名重试，
// 备用有响应即全会话粘滞（后续请求直接走可用域名）；下次启动仍先试主域名，恢复后自动切回。
const { netRequest } = require('./net-helper');
const store = require('./local-store');

const API_BASES = ['https://cck.bteai.top', 'https://cck.btluo.com'];
let activeIdx = 0;

/** 当前会话活跃域名（检查更新等需拼完整下载链接的调用方使用） */
function getActiveBase() {
	return API_BASES[activeIdx];
}

async function request(method, path, body = null, opts = null) {
	const token = store.get('sessionToken');
	const headers = { 'Content-Type': 'application/json' };
	if (token) headers['Authorization'] = `Bearer ${token}`;

	const doRequest = (base) => netRequest(base + path, {
		method,
		headers,
		body: body && method !== 'GET' ? JSON.stringify(body) : null,
		timeout: (opts && opts.timeout) || 15000, // 默认15s；健康检测等长链路由调用方传 opts.timeout 放宽
	});

	let resp = await doRequest(API_BASES[activeIdx]);
	if (!resp.ok && resp.status === 0) {
		// 主域名网络层不可达 → 试备用；备用有响应（任意 HTTP 状态，含 4xx/5xx）即证明域名可达，切过去
		const retry = await doRequest(API_BASES[1 - activeIdx]);
		if (retry.status !== 0) {
			activeIdx = 1 - activeIdx;
			resp = retry;
		} else {
			return { success: false, error: '网络连接失败，请检查网络', httpStatus: 0 };
		}
	}

	try {
		const data = await resp.json();
		return { ...data, httpStatus: resp.status };
	} catch {
		return { success: false, error: '响应解析失败', httpStatus: resp.status };
	}
}

module.exports = {
	get: (path, opts) => request('GET', path, null, opts),
	post: (path, body, opts) => request('POST', path, body, opts),
	put: (path, body, opts) => request('PUT', path, body, opts),
	del: (path, opts) => request('DELETE', path, null, opts),
	API_BASES,
	getActiveBase,
};
