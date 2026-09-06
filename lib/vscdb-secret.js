// vscdb-secret.js — VSCode 系客户端 state.vscdb 只读访问模块（开源版）。
// 这些客户端把状态存在 %APPDATA%\<name>\User\globalStorage\state.vscdb（SQLite ItemTable）里，
// 部分键（如 Cursor 的 cursorAuth/*）为明文字符串，可只读解析用于本地额度查询。
// 开源版仅保留只读查询能力（加密 secret 写入/登录态注入不在开源范围内）。
//
// 读库用 sql.js（纯 wasm，Electron 33 无 node:sqlite）：只读主库文件字节，
// 不做任何写回。

const fs = require('fs');
const path = require('path');

// sql.js 惰性加载（只在真正读 vscdb 时初始化 wasm，避免拖慢启动）
let _SQL = null;
async function getSqlJs() {
	if (_SQL) return _SQL;
	const initSqlJs = require('sql.js');
	const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
	const wasmBinary = new Uint8Array(fs.readFileSync(wasmPath));
	_SQL = await initSqlJs({ wasmBinary });
	return _SQL;
}

/** vscdb 路径 */
function vscdbPath(appdataPath) {
	return path.join(appdataPath, 'User', 'globalStorage', 'state.vscdb');
}

/** 读取明文 ItemTable 键（Cursor cursorAuth/*；不存在/库缺失返回 null） */
async function readPlainItem(appdataPath, key) {
	const dbPath = vscdbPath(appdataPath);
	if (!fs.existsSync(dbPath)) return null;
	const SQL = await getSqlJs();
	const db = new SQL.Database(fs.readFileSync(dbPath));
	try {
		const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ?');
		stmt.bind([key]);
		let value = null;
		if (stmt.step()) value = String(stmt.get()[0]);
		stmt.free();
		return value;
	} finally {
		db.close();
	}
}

module.exports = { vscdbPath, getSqlJs, readPlainItem };
