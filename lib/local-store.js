// 本地配置存储：用 JSON 文件持久化到 userData 目录。
// 敏感值（sessionToken / customAccounts 凭证）用 Electron safeStorage（Windows DPAPI）加密存储。
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

let store = {};
let storePath = '';

// 需要加密的键：字符串直接加密；非字符串先 JSON.stringify 再加密（get 一律返回字符串，由调用方解析）
const SENSITIVE_KEYS = new Set(['sessionToken', 'customAccounts']);

function initStore() {
	const userData = app.getPath('userData');
	storePath = path.join(userData, 'config.json');
	try {
		store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
	} catch {
		store = {};
	}
}

function save() {
	try {
		// 原子写入：先写临时文件再 rename
		const tmpPath = storePath + '.tmp';
		fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2));
		fs.renameSync(tmpPath, storePath);
	} catch (err) {
		console.error('保存配置失败:', err);
	}
}

/** 加密敏感值（字符串；非字符串先序列化） */
function encryptValue(value) {
	try {
		if (safeStorage.isEncryptionAvailable()) {
			const plaintext = typeof value === 'string' ? value : JSON.stringify(value);
			return { __enc: 1, d: safeStorage.encryptString(plaintext).toString('base64') };
		}
	} catch { /* safeStorage 不可用时回退明文 */ }
	return value;
}

/** 解密敏感值 */
function decryptValue(stored) {
	if (stored && typeof stored === 'object' && stored.__enc === 1) {
		try {
			return safeStorage.decryptString(Buffer.from(stored.d, 'base64'));
		} catch {
			return null;
		}
	}
	return stored;
}

module.exports = {
	initStore,
	get(key, defaultValue = null) {
		if (!(key in store)) return defaultValue;
		// 敏感键需要解密（返回字符串；customAccounts 由 custom-accounts.js 解析为数组）
		if (SENSITIVE_KEYS.has(key)) return decryptValue(store[key]) ?? defaultValue;
		return store[key];
	},
	set(key, value) {
		// 敏感键加密后存储
		if (SENSITIVE_KEYS.has(key)) {
			store[key] = encryptValue(value);
		} else {
			store[key] = value;
		}
		save();
	},
	delete(key) {
		delete store[key];
		save();
	},
	getAll() {
		return { ...store };
	},
};
