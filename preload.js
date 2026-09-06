// preload.js：通过 contextBridge 暴露安全的 IPC 接口给渲染进程。
// sandbox: true 时只能用 contextBridge，不能用 require。
// 开源版仅暴露账号管理与额度查询接口（客户端启动/设备指纹/环境清理不在开源范围内）。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
	// 鉴权
	auth: {
		getCaptcha: () => ipcRenderer.invoke('auth:get-captcha'),
		register: (username, password, confirm_password) =>
			ipcRenderer.invoke('auth:register', { username, password, confirm_password }),
		login: (username, password) =>
			ipcRenderer.invoke('auth:login', { username, password }),
		logout: () => ipcRenderer.invoke('auth:logout'),
		getSession: () => ipcRenderer.invoke('auth:get-session'),
	},

	// 账号
	accounts: {
		list: (category) => ipcRenderer.invoke('accounts:list', { category }),
		purchase: (planQuota, category) => ipcRenderer.invoke('accounts:purchase', { planQuota, category }),
		my: () => ipcRenderer.invoke('accounts:my'),
		banRefund: (id) => ipcRenderer.invoke('accounts:ban-refund', { id }),
		// 自定义账号（用户自有凭证，仅存本机，不过后端）
		customList: () => ipcRenderer.invoke('accounts:custom-list'),
		customAdd: (input) => ipcRenderer.invoke('accounts:custom-add', input),
		customRemove: (id) => ipcRenderer.invoke('accounts:custom-remove', { id }),
	},

	// 额度查询
	quota: {
		check: (token, refresh_token, category) => ipcRenderer.invoke('quota:check', { token, refresh_token, category }),
	},

	// 余额兑换
	credits: {
		redeem: (code) => ipcRenderer.invoke('credits:redeem', { code }),
	},

	// 打开外部链接
	openExternal: (url) => ipcRenderer.invoke('open-external', { url }),

	// 检查客户端更新（顶层暴露，渲染端调用 electronAPI.checkUpdate()）
	checkUpdate: () => ipcRenderer.invoke('app:check-update'),

	// 诊断日志：一键导出近 7 天脱敏现场日志
	diag: {
		exportLogs: () => ipcRenderer.invoke('diag:export-logs'),
	},
});
