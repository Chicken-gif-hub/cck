// 共享网络请求工具：使用 Electron net 模块（自动走系统代理）
const { net } = require('electron');

/**
 * 使用 Electron net 模块发起新请求（自动走系统代理，解决 Clash/V2Ray 问题）
 * @param {string} url - 完整 URL
 * @param {object} options - { method, headers, body, timeout }
 * @returns {Promise<{ok: boolean, status: number, json: function, text: function}>}
 */
async function netRequest(url, options = {}) {
	const method = options.method || 'GET';
	const headers = options.headers || {};
	const body = options.body || null;
	const timeoutMs = options.timeout || 15000;

	return new Promise((resolve) => {
		const req = net.request({ method, url });

		const timer = setTimeout(() => {
			req.abort();
			resolve({ ok: false, status: 0, json: async () => ({}), text: async () => '' });
		}, timeoutMs);

		let responseData = '';

		req.on('response', (response) => {
			response.on('data', (chunk) => { responseData += chunk.toString(); });
			response.on('end', () => {
				clearTimeout(timer);
				resolve({
					ok: response.statusCode >= 200 && response.statusCode < 300,
					status: response.statusCode,
					json: async () => JSON.parse(responseData),
					text: async () => responseData,
				});
			});
		});

		req.on('error', () => {
			clearTimeout(timer);
			resolve({ ok: false, status: 0, json: async () => ({}), text: async () => '' });
		});

		for (const [key, value] of Object.entries(headers)) {
			req.setHeader(key, value);
		}

		if (body) {
			req.write(typeof body === 'string' ? body : JSON.stringify(body));
		}

		req.end();
	});
}

module.exports = { netRequest };
