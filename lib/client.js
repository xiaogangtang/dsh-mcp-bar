/**
 * MCP Bar —— 浏览器半区。
 *
 * 两个入口共用同一个 controller：
 *   - `conversation.input.dock`：输入框上方的常驻状态栏
 *   - `main` + `sidebar.panellist`：完整管理面板（列表 / 新建 / 编辑 / 详情）
 *
 * 数据全部通过同源 `POST /mcp-bar/api` 走宿主半区；这里不直接读写配置文件。
 */
window.__ModuleLoader__.load({
	id: "dsh-mcp-bar",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		const API_PATH = "/mcp-bar/api";
		const PANEL_ID = "mcp-bar";
		const DOCK_ID = "mcp-bar-status";
		const STYLE_ID = "dsh-mcp-bar-style";
		const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
		const DEFAULT_TIMEOUT = 60000;
		const MIN_TIMEOUT = 1000;
		const MAX_TIMEOUT = 1800000;
		const POLL_MS = 5000;
		const NOTICE_MS = 6000;

		const JSON_EXAMPLE = `{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "timeoutMs": 60000
    }
  }
}`;

		//#region 样式
		const CSS = `
.mcpbar-root {
	--mcpbar-accent: var(--dsw-alias-state-business-primary, #4d6bfe);
	--mcpbar-success: var(--dsw-alias-state-success-primary, #16a34a);
	--mcpbar-warn: var(--dsw-alias-state-warn-primary, #d97706);
	--mcpbar-error: var(--dsw-alias-state-error-primary, #dc2626);
	--mcpbar-bg: var(--dsw-alias-bg-base, #ffffff);
	--mcpbar-layer: var(--dsw-alias-bg-layer-1, #f7f8fa);
	--mcpbar-layer-2: var(--dsw-alias-bg-layer-2, #f0f1f4);
	--mcpbar-layer-3: var(--dsw-alias-bg-layer-3, #e9eaee);
	--mcpbar-border: var(--dsw-alias-border-l2, #e3e5e9);
	--mcpbar-border-soft: var(--dsw-alias-border-l3, #edeef1);
	--mcpbar-text: var(--dsw-alias-label-primary, #1b1d22);
	--mcpbar-text-2: var(--dsw-alias-label-secondary, #5f6470);
	--mcpbar-text-3: var(--dsw-alias-label-tertiary, #8b909b);
	--mcpbar-mono: var(--dsw-font-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace);
	--mcpbar-radius: var(--dsw-radius-lg, 12px);
	box-sizing: border-box;
	display: flex;
	flex-direction: column;
	min-height: 0;
	height: 100%;
	background: var(--mcpbar-bg);
	color: var(--mcpbar-text);
	font-family: var(--dsw-font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif);
	font-size: 13px;
	line-height: 1.5;
	-webkit-font-smoothing: antialiased;
}
.mcpbar-root * { box-sizing: border-box; }
.mcpbar-root button { font-family: inherit; }
.mcpbar-root code, .mcpbar-root pre { font-family: var(--mcpbar-mono); }

/* ---------- 输入框上方状态栏 ---------- */
.mcpbar-dock {
	display: flex;
	flex: none;
	align-items: center;
	gap: 8px;
	width: 100%;
	height: 34px;
	margin: 0;
	padding: 0 10px;
	border: 1px solid var(--dsw-alias-border-l2, #e3e5e9);
	border-radius: 10px;
	background: var(--dsw-alias-bg-layer-1, #f7f8fa);
	color: var(--dsw-alias-label-secondary, #5f6470);
	font-size: 12px;
	line-height: 1;
	text-align: left;
	cursor: pointer;
	overflow: hidden;
	transition: background .15s ease, border-color .15s ease, color .15s ease;
}
.mcpbar-dock:hover {
	background: var(--dsw-alias-bg-layer-2, #f0f1f4);
	border-color: var(--dsw-alias-border-l3, #d9dbe0);
	color: var(--dsw-alias-label-primary, #1b1d22);
}
.mcpbar-dock:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #4d6bfe); outline-offset: 1px; }
.mcpbar-dock-icon {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 20px;
	height: 20px;
	border-radius: 6px;
	background: var(--dsw-alias-bg-base, #fff);
	border: 1px solid var(--dsw-alias-border-l3, #e3e5e9);
	color: var(--dsw-alias-label-secondary, #5f6470);
	flex: none;
}
.mcpbar-dock-label { font-weight: 600; letter-spacing: .02em; color: var(--dsw-alias-label-primary, #1b1d22); flex: none; }
.mcpbar-dock-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.mcpbar-dock[data-tone="error"] .mcpbar-dock-meta { color: var(--mcpbar-error); }
.mcpbar-dock[data-tone="pending"] .mcpbar-dock-meta { color: var(--mcpbar-warn); }
.mcpbar-dock-spacer { flex: 1; }
.mcpbar-dock-action {
	display: inline-flex;
	align-items: center;
	gap: 2px;
	flex: none;
	color: var(--dsw-alias-label-tertiary, #8b909b);
	font-size: 11.5px;
}
.mcpbar-dock:hover .mcpbar-dock-action { color: var(--dsw-alias-label-secondary, #5f6470); }

/* ---------- 面板骨架 ---------- */
.mcpbar-main { height: 100%; }
.mcpbar-overlay-backdrop {
	position: fixed;
	inset: 0;
	z-index: 1200;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 24px;
	background: rgba(15, 17, 22, .38);
	backdrop-filter: blur(2px);
	animation: mcpbar-fade .16s ease;
}
.mcpbar-overlay-panel {
	width: min(900px, 100%);
	height: min(780px, 88vh);
	border: 1px solid var(--mcpbar-border);
	border-radius: 18px;
	background: var(--mcpbar-bg);
	box-shadow: 0 24px 80px rgba(10, 12, 16, .28);
	overflow: hidden;
	animation: mcpbar-rise .18s ease;
}
.mcpbar-head {
	display: flex;
	align-items: flex-start;
	gap: 12px;
	flex: none;
	padding: 20px 28px 14px;
}
[data-platform="darwin"] .mcpbar-head { padding-top: calc(20px + var(--dsh-frame-top-clearance, 0px)); }
.mcpbar-back {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 30px;
	height: 30px;
	margin-top: 2px;
	border: 1px solid var(--mcpbar-border);
	border-radius: 8px;
	background: var(--mcpbar-layer);
	color: var(--mcpbar-text-2);
	cursor: pointer;
	flex: none;
}
.mcpbar-back:hover { background: var(--mcpbar-layer-2); color: var(--mcpbar-text); }
.mcpbar-head-main { flex: 1; min-width: 0; }
.mcpbar-titleline { display: flex; align-items: center; gap: 10px; min-width: 0; }
.mcpbar-logo {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 30px;
	height: 30px;
	border-radius: 9px;
	background: color-mix(in srgb, var(--mcpbar-accent) 10%, transparent);
	color: var(--mcpbar-accent);
	flex: none;
}
.mcpbar-title {
	margin: 0;
	font-size: 19px;
	line-height: 1.3;
	font-weight: 600;
	letter-spacing: -.01em;
	color: var(--mcpbar-text);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.mcpbar-scope {
	flex: none;
	padding: 2px 8px;
	border: 1px solid var(--mcpbar-border);
	border-radius: 999px;
	background: var(--mcpbar-layer);
	color: var(--mcpbar-text-3);
	font-size: 11px;
	line-height: 1.6;
}
.mcpbar-sub { margin: 6px 0 0; color: var(--mcpbar-text-2); font-size: 12.5px; }
.mcpbar-head-actions { display: flex; align-items: center; gap: 8px; flex: none; padding-top: 4px; }
.mcpbar-body { flex: 1; min-height: 0; overflow: auto; padding: 0 28px 28px; scrollbar-width: thin; }
.mcpbar-content { width: 100%; max-width: 980px; margin: 0 auto; }

/* ---------- 通用控件 ---------- */
.mcpbar-btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 6px;
	height: 32px;
	padding: 0 12px;
	border: 1px solid var(--mcpbar-border);
	border-radius: 8px;
	background: var(--mcpbar-bg);
	color: var(--mcpbar-text);
	font-size: 12.5px;
	font-weight: 500;
	white-space: nowrap;
	cursor: pointer;
	transition: background .15s ease, border-color .15s ease, opacity .15s ease;
}
.mcpbar-btn:hover:not(:disabled) { background: var(--mcpbar-layer); }
.mcpbar-btn:disabled { opacity: .55; cursor: default; }
.mcpbar-btn-primary {
	border-color: var(--mcpbar-accent);
	background: var(--mcpbar-accent);
	color: #fff;
}
.mcpbar-btn-primary:hover:not(:disabled) { background: var(--mcpbar-accent); filter: brightness(1.06); }
.mcpbar-btn-danger { border-color: color-mix(in srgb, var(--mcpbar-error) 45%, transparent); color: var(--mcpbar-error); }
.mcpbar-btn-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--mcpbar-error) 8%, transparent); }
.mcpbar-btn-ghost { border-color: transparent; background: transparent; color: var(--mcpbar-text-2); }
.mcpbar-btn-ghost:hover:not(:disabled) { background: var(--mcpbar-layer); }
.mcpbar-btn-sm { height: 27px; padding: 0 9px; font-size: 12px; border-radius: 7px; }
.mcpbar-icon-btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 28px;
	height: 28px;
	border: 0;
	border-radius: 7px;
	background: transparent;
	color: var(--mcpbar-text-3);
	cursor: pointer;
	flex: none;
	transition: background .15s ease, color .15s ease;
}
.mcpbar-icon-btn:hover:not(:disabled) { background: var(--mcpbar-layer-2); color: var(--mcpbar-text); }
.mcpbar-icon-btn:disabled { opacity: .45; cursor: default; }
.mcpbar-icon-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--mcpbar-error) 9%, transparent); color: var(--mcpbar-error); }
.mcpbar-search { position: relative; display: flex; align-items: center; }
.mcpbar-search > svg { position: absolute; left: 9px; color: var(--mcpbar-text-3); pointer-events: none; }
.mcpbar-search input {
	width: 210px;
	height: 32px;
	padding: 0 10px 0 29px;
	border: 1px solid var(--mcpbar-border);
	border-radius: 8px;
	background: var(--mcpbar-layer);
	color: var(--mcpbar-text);
	font-family: inherit;
	font-size: 12.5px;
	outline: none;
	transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
}
.mcpbar-search input::placeholder { color: var(--mcpbar-text-3); }
.mcpbar-search input:focus {
	border-color: var(--mcpbar-accent);
	background: var(--mcpbar-bg);
	box-shadow: 0 0 0 3px color-mix(in srgb, var(--mcpbar-accent) 14%, transparent);
}
.mcpbar-spinner {
	display: inline-block;
	border: 2px solid color-mix(in srgb, currentColor 26%, transparent);
	border-top-color: currentColor;
	border-radius: 50%;
	animation: mcpbar-spin .7s linear infinite;
	flex: none;
}
.mcpbar-dot {
	display: inline-block;
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background: var(--mcpbar-text-3);
	flex: none;
}
.mcpbar-dot[data-size="md"] { width: 9px; height: 9px; }
.mcpbar-dot-connected { background: var(--mcpbar-success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--mcpbar-success) 16%, transparent); }
.mcpbar-dot-pending { background: var(--mcpbar-warn); box-shadow: 0 0 0 3px color-mix(in srgb, var(--mcpbar-warn) 16%, transparent); animation: mcpbar-pulse 1.6s ease-in-out infinite; }
.mcpbar-dot-error { background: var(--mcpbar-error); box-shadow: 0 0 0 3px color-mix(in srgb, var(--mcpbar-error) 16%, transparent); }
.mcpbar-dot-disabled { background: var(--mcpbar-text-3); opacity: .55; }

/* ---------- 统计与列表 ---------- */
.mcpbar-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 2px 0 14px; }
.mcpbar-stat {
	padding: 10px 12px;
	border: 1px solid var(--mcpbar-border-soft);
	border-radius: 10px;
	background: var(--mcpbar-layer);
}
.mcpbar-stat-value { font-size: 19px; line-height: 1.2; font-weight: 600; letter-spacing: -.01em; }
.mcpbar-stat-value[data-tone="error"] { color: var(--mcpbar-error); }
.mcpbar-stat-value[data-tone="success"] { color: var(--mcpbar-success); }
.mcpbar-stat-label { margin-top: 2px; color: var(--mcpbar-text-2); font-size: 11.5px; }
.mcpbar-list {
	display: flex;
	flex-direction: column;
	border: 1px solid var(--mcpbar-border);
	border-radius: 12px;
	background: var(--mcpbar-bg);
	overflow: hidden;
}
.mcpbar-row {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 12px 14px;
	cursor: pointer;
	transition: background .13s ease;
}
.mcpbar-row + .mcpbar-row { border-top: 1px solid var(--mcpbar-border-soft); }
.mcpbar-row:hover { background: var(--mcpbar-layer); }
.mcpbar-row:focus-visible { outline: 2px solid var(--mcpbar-accent); outline-offset: -2px; }
.mcpbar-row-main { flex: 1; min-width: 0; }
.mcpbar-row-title { display: flex; align-items: center; gap: 7px; min-width: 0; flex-wrap: wrap; }
.mcpbar-row-name { font-size: 13.5px; font-weight: 600; color: var(--mcpbar-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mcpbar-tag {
	flex: none;
	padding: 1px 6px;
	border: 1px solid var(--mcpbar-border);
	border-radius: 5px;
	background: var(--mcpbar-layer);
	color: var(--mcpbar-text-2);
	font-size: 10.5px;
	line-height: 1.55;
	font-weight: 500;
}
.mcpbar-tag-muted { color: var(--mcpbar-text-3); }
.mcpbar-tag-tool { color: var(--mcpbar-accent); border-color: color-mix(in srgb, var(--mcpbar-accent) 26%, transparent); background: color-mix(in srgb, var(--mcpbar-accent) 7%, transparent); }
.mcpbar-tag-warn { color: var(--mcpbar-warn); border-color: color-mix(in srgb, var(--mcpbar-warn) 30%, transparent); background: color-mix(in srgb, var(--mcpbar-warn) 8%, transparent); }
.mcpbar-tag-error { color: var(--mcpbar-error); border-color: color-mix(in srgb, var(--mcpbar-error) 30%, transparent); background: color-mix(in srgb, var(--mcpbar-error) 8%, transparent); }
.mcpbar-row-meta {
	display: flex;
	align-items: center;
	gap: 6px;
	margin-top: 4px;
	color: var(--mcpbar-text-3);
	font-size: 11.5px;
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
}
.mcpbar-row-endpoint {
	font-size: 11.5px;
	color: var(--mcpbar-text-2);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	max-width: 55%;
}
.mcpbar-row-sep { color: var(--mcpbar-border); }
.mcpbar-row-error {
	margin-top: 5px;
	color: var(--mcpbar-error);
	font-size: 11.5px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.mcpbar-row-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.mcpbar-switch {
	position: relative;
	width: 34px;
	height: 20px;
	padding: 0;
	border: 0;
	border-radius: 999px;
	background: var(--mcpbar-border);
	cursor: pointer;
	flex: none;
	transition: background .16s ease;
}
.mcpbar-switch[aria-checked="true"] { background: var(--mcpbar-success); }
.mcpbar-switch::after {
	content: "";
	position: absolute;
	top: 2px;
	left: 2px;
	width: 16px;
	height: 16px;
	border-radius: 50%;
	background: #fff;
	box-shadow: 0 1px 2px rgba(0, 0, 0, .2);
	transition: transform .16s ease;
}
.mcpbar-switch[aria-checked="true"]::after { transform: translateX(14px); }
.mcpbar-switch:disabled { opacity: .6; cursor: default; }
.mcpbar-switch .mcpbar-spinner { position: absolute; top: 50%; left: 50%; margin: -6px 0 0 -6px; color: var(--mcpbar-text-2); }
.mcpbar-switch[data-busy="true"]::after { display: none; }
.mcpbar-switch[aria-checked="true"][data-busy="true"] .mcpbar-spinner { color: #fff; }
.mcpbar-switch:focus-visible { outline: 2px solid var(--mcpbar-accent); outline-offset: 2px; }

/* ---------- 空状态 / 骨架 / 提示 ---------- */
.mcpbar-empty {
	display: flex;
	flex-direction: column;
	align-items: center;
	text-align: center;
	padding: 46px 24px 40px;
	border: 1px dashed var(--mcpbar-border);
	border-radius: 14px;
	background: var(--mcpbar-layer);
}
.mcpbar-empty-icon {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 52px;
	height: 52px;
	margin-bottom: 12px;
	border-radius: 15px;
	border: 1px solid var(--mcpbar-border);
	background: var(--mcpbar-bg);
	color: var(--mcpbar-text-3);
}
.mcpbar-empty h3 { margin: 0; font-size: 14.5px; font-weight: 600; }
.mcpbar-empty p { max-width: 380px; margin: 6px 0 16px; color: var(--mcpbar-text-2); font-size: 12.5px; }
.mcpbar-empty-actions { display: flex; gap: 8px; }
.mcpbar-skeleton-list {
	border: 1px solid var(--mcpbar-border);
	border-radius: 12px;
	overflow: hidden;
}
.mcpbar-skeleton-row {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 14px;
}
.mcpbar-skeleton-row + .mcpbar-skeleton-row { border-top: 1px solid var(--mcpbar-border-soft); }
.mcpbar-skeleton {
	height: 10px;
	border-radius: 5px;
	background: linear-gradient(90deg, var(--mcpbar-layer) 25%, var(--mcpbar-layer-2) 37%, var(--mcpbar-layer) 63%);
	background-size: 400% 100%;
	animation: mcpbar-shimmer 1.4s ease infinite;
}
.mcpbar-notice {
	display: flex;
	align-items: flex-start;
	gap: 8px;
	margin: 0 0 14px;
	padding: 9px 11px;
	border: 1px solid transparent;
	border-radius: 9px;
	font-size: 12.5px;
	line-height: 1.5;
}
.mcpbar-notice > svg { flex: none; margin-top: 1px; }
.mcpbar-notice-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.mcpbar-notice-success { border-color: color-mix(in srgb, var(--mcpbar-success) 24%, transparent); background: color-mix(in srgb, var(--mcpbar-success) 8%, transparent); color: var(--mcpbar-success); }
.mcpbar-notice-warn { border-color: color-mix(in srgb, var(--mcpbar-warn) 26%, transparent); background: color-mix(in srgb, var(--mcpbar-warn) 8%, transparent); color: var(--mcpbar-warn); }
.mcpbar-notice-error { border-color: color-mix(in srgb, var(--mcpbar-error) 26%, transparent); background: color-mix(in srgb, var(--mcpbar-error) 7%, transparent); color: var(--mcpbar-error); }
.mcpbar-notice-info { border-color: var(--mcpbar-border); background: var(--mcpbar-layer); color: var(--mcpbar-text-2); }
.mcpbar-notice .mcpbar-icon-btn { width: 22px; height: 22px; color: currentColor; opacity: .7; }
.mcpbar-banner {
	display: flex;
	align-items: flex-start;
	gap: 10px;
	margin-bottom: 14px;
	padding: 12px 14px;
	border: 1px solid var(--mcpbar-border);
	border-radius: 11px;
	background: var(--mcpbar-layer);
}
.mcpbar-banner-icon {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 26px;
	height: 26px;
	border-radius: 7px;
	background: var(--mcpbar-bg);
	border: 1px solid var(--mcpbar-border);
	color: var(--mcpbar-text-2);
	flex: none;
}
.mcpbar-banner-main { flex: 1; min-width: 0; }
.mcpbar-banner-main strong { font-size: 12.5px; font-weight: 600; }
.mcpbar-banner-main p { margin: 3px 0 0; color: var(--mcpbar-text-2); font-size: 11.5px; line-height: 1.55; }
.mcpbar-banner-main p.mcpbar-banner-warn { color: var(--mcpbar-warn); }
.mcpbar-banner > .mcpbar-btn { flex: none; margin-top: 1px; }
.mcpbar-footnote { margin: 14px 2px 0; color: var(--mcpbar-text-3); font-size: 11px; }

/* ---------- 表单 ---------- */
.mcpbar-form { display: flex; flex-direction: column; gap: 14px; }
.mcpbar-form-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.mcpbar-form-mode-hint { color: var(--mcpbar-text-3); font-size: 11.5px; }
.mcpbar-segmented {
	display: inline-flex;
	align-items: center;
	gap: 2px;
	padding: 2px;
	border: 1px solid var(--mcpbar-border);
	border-radius: 9px;
	background: var(--mcpbar-layer);
}
.mcpbar-segmented > button {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 5px;
	height: 26px;
	padding: 0 11px;
	border: 0;
	border-radius: 7px;
	background: transparent;
	color: var(--mcpbar-text-2);
	font-size: 12px;
	font-weight: 500;
	cursor: pointer;
	white-space: nowrap;
}
.mcpbar-segmented > button:hover { color: var(--mcpbar-text); }
.mcpbar-segmented > button[data-active="true"] {
	background: var(--mcpbar-bg);
	color: var(--mcpbar-text);
	box-shadow: 0 1px 2px rgba(16, 18, 24, .1);
}
.mcpbar-form-card {
	padding: 18px 18px 20px;
	border: 1px solid var(--mcpbar-border);
	border-radius: 12px;
	background: var(--mcpbar-layer);
}
.mcpbar-field-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 15px 16px; }
.mcpbar-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.mcpbar-field-wide { grid-column: 1 / -1; }
.mcpbar-label { display: flex; align-items: center; gap: 4px; color: var(--mcpbar-text-2); font-size: 12px; font-weight: 500; }
.mcpbar-req { color: var(--mcpbar-error); font-weight: 400; }
.mcpbar-input, .mcpbar-textarea {
	width: 100%;
	border: 1px solid var(--mcpbar-border);
	border-radius: 8px;
	background: var(--mcpbar-bg);
	color: var(--mcpbar-text);
	font-family: inherit;
	font-size: 13px;
	padding: 7px 10px;
	outline: none;
	transition: border-color .15s ease, box-shadow .15s ease;
}
.mcpbar-input { height: 33px; }
.mcpbar-input-mono, .mcpbar-textarea-mono { font-family: var(--mcpbar-mono); font-size: 12px; }
.mcpbar-input::placeholder, .mcpbar-textarea::placeholder { color: var(--mcpbar-text-3); }
.mcpbar-input:focus, .mcpbar-textarea:focus {
	border-color: var(--mcpbar-accent);
	box-shadow: 0 0 0 3px color-mix(in srgb, var(--mcpbar-accent) 13%, transparent);
}
.mcpbar-input[aria-invalid="true"], .mcpbar-textarea[aria-invalid="true"] { border-color: var(--mcpbar-error); }
.mcpbar-textarea { resize: vertical; min-height: 90px; line-height: 1.55; }
.mcpbar-json-editor { min-height: 330px; tab-size: 2; }
.mcpbar-hint { margin: 0; color: var(--mcpbar-text-3); font-size: 11.5px; line-height: 1.55; }
.mcpbar-error-text { margin: 0; color: var(--mcpbar-error); font-size: 11.5px; }
.mcpbar-json-head, .mcpbar-kv-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.mcpbar-json-actions { display: flex; align-items: center; gap: 6px; }
.mcpbar-kv-list { display: flex; flex-direction: column; gap: 6px; }
.mcpbar-kv-row { display: flex; align-items: center; gap: 6px; }
.mcpbar-kv-row .mcpbar-input { flex: 1; min-width: 0; }
.mcpbar-kv-empty { padding: 7px 0 2px; }
.mcpbar-switch-line { display: flex; align-items: center; gap: 9px; min-height: 33px; }
.mcpbar-switch-text { color: var(--mcpbar-text-2); font-size: 12px; }
.mcpbar-form-footer {
	position: sticky;
	bottom: 0;
	z-index: 4;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	padding: 12px 0 4px;
	border-top: 1px solid var(--mcpbar-border-soft);
	background: var(--mcpbar-bg);
}
.mcpbar-form-footer-left, .mcpbar-form-footer-right { display: flex; align-items: center; gap: 8px; }

/* ---------- 连接测试 ---------- */
.mcpbar-probe {
	display: flex;
	align-items: flex-start;
	gap: 9px;
	margin-top: 14px;
	padding: 10px 12px;
	border: 1px solid var(--mcpbar-border);
	border-radius: 10px;
	font-size: 12.5px;
}
.mcpbar-probe > svg { flex: none; margin-top: 1px; }
.mcpbar-probe-main { flex: 1; min-width: 0; }
.mcpbar-probe-main strong { font-weight: 600; overflow-wrap: anywhere; }
.mcpbar-probe-main p { margin: 2px 0 0; color: var(--mcpbar-text-2); font-size: 11.5px; overflow-wrap: anywhere; }
.mcpbar-probe-running { border-color: color-mix(in srgb, var(--mcpbar-accent) 24%, transparent); background: color-mix(in srgb, var(--mcpbar-accent) 6%, transparent); color: var(--mcpbar-accent); align-items: center; }
.mcpbar-probe-ok { border-color: color-mix(in srgb, var(--mcpbar-success) 24%, transparent); background: color-mix(in srgb, var(--mcpbar-success) 7%, transparent); color: var(--mcpbar-success); }
.mcpbar-probe-error { border-color: color-mix(in srgb, var(--mcpbar-error) 26%, transparent); background: color-mix(in srgb, var(--mcpbar-error) 7%, transparent); color: var(--mcpbar-error); }
.mcpbar-probe .mcpbar-tools { margin-top: 8px; }

/* ---------- 详情 ---------- */
.mcpbar-detail { display: flex; flex-direction: column; }
.mcpbar-detail-hero { display: flex; align-items: flex-start; gap: 16px; justify-content: space-between; margin-bottom: 14px; }
.mcpbar-detail-ident { display: flex; align-items: center; gap: 11px; min-width: 0; }
.mcpbar-detail-name { font-size: 17px; font-weight: 600; letter-spacing: -.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mcpbar-detail-sub { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 4px; color: var(--mcpbar-text-3); font-size: 11.5px; }
.mcpbar-detail-ident > .mcpbar-detail-sub { margin-top: 0; }
.mcpbar-detail-actions-top { display: flex; align-items: center; gap: 7px; flex: none; flex-wrap: wrap; justify-content: flex-end; }
.mcpbar-detail-toggle { display: inline-flex; align-items: center; gap: 7px; color: var(--mcpbar-text-2); font-size: 11.5px; margin-right: 2px; }
.mcpbar-state-text { font-weight: 500; }
.mcpbar-state-connected { color: var(--mcpbar-success); }
.mcpbar-state-pending { color: var(--mcpbar-warn); }
.mcpbar-state-error { color: var(--mcpbar-error); }
.mcpbar-state-disabled { color: var(--mcpbar-text-3); }
.mcpbar-detail-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr); gap: 12px; align-items: start; }
.mcpbar-detail-card {
	padding: 13px 15px 15px;
	border: 1px solid var(--mcpbar-border);
	border-radius: 11px;
	background: var(--mcpbar-layer);
	min-width: 0;
}
.mcpbar-config-card { margin-top: 12px; }
.mcpbar-detail-card h3 { flex: 1; margin: 0; font-size: 12.5px; font-weight: 600; }
.mcpbar-card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.mcpbar-count-pill {
	flex: none;
	min-width: 20px;
	padding: 0 6px;
	border-radius: 999px;
	background: var(--mcpbar-layer-3);
	color: var(--mcpbar-text-2);
	font-size: 10.5px;
	line-height: 17px;
	text-align: center;
}
.mcpbar-code {
	display: block;
	padding: 7px 9px;
	border-radius: 7px;
	background: var(--mcpbar-bg);
	border: 1px solid var(--mcpbar-border-soft);
	font-size: 11.5px;
	color: var(--mcpbar-text-2);
	overflow-wrap: anywhere;
	white-space: pre-wrap;
	word-break: break-all;
}
.mcpbar-kv { display: flex; flex-direction: column; gap: 6px; margin: 10px 0 0; }
.mcpbar-kv > div { display: flex; align-items: baseline; gap: 10px; }
.mcpbar-kv dt { width: 60px; flex: none; color: var(--mcpbar-text-3); font-size: 11.5px; }
.mcpbar-kv dd { margin: 0; color: var(--mcpbar-text-2); font-size: 11.5px; overflow-wrap: anywhere; }
.mcpbar-tools { display: flex; flex-direction: column; }
.mcpbar-tool + .mcpbar-tool { border-top: 1px solid var(--mcpbar-border-soft); }
.mcpbar-tool { padding: 8px 0; }
.mcpbar-tool:first-child { padding-top: 2px; }
.mcpbar-tool-head { display: flex; align-items: center; gap: 8px; }
.mcpbar-tool-name { font-size: 11.5px; font-weight: 600; color: var(--mcpbar-text); flex: 1; min-width: 0; overflow-wrap: anywhere; }
.mcpbar-tool-schema-hint { flex: none; color: var(--mcpbar-text-3); font-size: 10.5px; }
.mcpbar-tool-desc { margin: 3px 0 0; color: var(--mcpbar-text-2); font-size: 11.5px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.mcpbar-tool-details { margin-top: 5px; }
.mcpbar-tool-details summary { width: fit-content; color: var(--mcpbar-text-3); font-size: 11px; cursor: pointer; user-select: none; }
.mcpbar-tool-details summary:hover { color: var(--mcpbar-text-2); }
.mcpbar-tool-details .mcpbar-json { margin-top: 6px; }
.mcpbar-tools-compact .mcpbar-tool { padding: 6px 0; }
.mcpbar-json {
	margin: 0;
	padding: 10px 12px;
	max-height: 280px;
	overflow: auto;
	border: 1px solid var(--mcpbar-border-soft);
	border-radius: 9px;
	background: var(--mcpbar-bg);
	color: var(--mcpbar-text-2);
	font-size: 11.5px;
	line-height: 1.55;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}
.mcpbar-probe-card .mcpbar-probe { margin-top: 0; }
.mcpbar-empty-inline { padding: 10px 0 2px; color: var(--mcpbar-text-3); font-size: 11.5px; line-height: 1.6; }

/* ---------- 对话框 ---------- */
.mcpbar-dialog-backdrop {
	position: fixed;
	inset: 0;
	z-index: 1300;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 24px;
	background: rgba(15, 17, 22, .36);
	animation: mcpbar-fade .14s ease;
}
.mcpbar-dialog {
	width: min(420px, 100%);
	padding: 20px 22px 18px;
	border: 1px solid var(--mcpbar-border);
	border-radius: 15px;
	background: var(--mcpbar-bg);
	box-shadow: 0 20px 60px rgba(10, 12, 16, .26);
	animation: mcpbar-rise .16s ease;
}
.mcpbar-dialog h2 { margin: 0; font-size: 15.5px; font-weight: 600; letter-spacing: -.01em; overflow-wrap: anywhere; }
.mcpbar-dialog p { margin: 8px 0 0; color: var(--mcpbar-text-2); font-size: 12.5px; line-height: 1.6; }
.mcpbar-dialog .mcpbar-notice { margin: 12px 0 0; }
.mcpbar-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }

/* ---------- 动画 ---------- */
@keyframes mcpbar-spin { to { transform: rotate(360deg); } }
@keyframes mcpbar-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
@keyframes mcpbar-shimmer { 0% { background-position: 100% 50%; } 100% { background-position: 0 50%; } }
@keyframes mcpbar-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes mcpbar-rise { from { opacity: 0; transform: translateY(6px) scale(.994); } to { opacity: 1; transform: none; } }

@media (prefers-reduced-motion: reduce) {
	.mcpbar-root *, .mcpbar-root *::before, .mcpbar-root *::after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
}
@media (max-width: 720px) {
	.mcpbar-head { padding: 16px 18px 12px; flex-wrap: wrap; }
	.mcpbar-body { padding: 0 18px 20px; }
	.mcpbar-search input { width: 150px; }
	.mcpbar-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
	.mcpbar-detail-grid { grid-template-columns: minmax(0, 1fr); }
	.mcpbar-row-actions .mcpbar-icon-btn { display: none; }
	.mcpbar-row-actions .mcpbar-switch, .mcpbar-row-actions .mcpbar-btn { display: inline-flex; }
	.mcpbar-field-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 620px) {
	.mcpbar-root[data-view="list"] .mcpbar-head-main { flex: 1 1 100%; }
	.mcpbar-root[data-view="list"] .mcpbar-head-actions { flex: 1 1 100%; padding-top: 0; }
	.mcpbar-root[data-view="list"] .mcpbar-search { flex: 1; }
	.mcpbar-root[data-view="list"] .mcpbar-search input { width: 100%; }
	.mcpbar-title { font-size: 18px; }
	.mcpbar-detail-actions-top { justify-content: flex-start; }
}
`;
		//#endregion

		//#region 图标
		const ICONS = {
			hub: [
				"M12 3v4",
				"M12 17v4",
				"M3 12h4",
				"M17 12h4",
				"M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
				"M6.4 6.4l2.1 2.1",
				"M15.5 15.5l2.1 2.1",
				"M17.6 6.4l-2.1 2.1",
				"M8.5 15.5l-2.1 2.1"
			],
			plug: [
				"M9 2v6",
				"M15 2v6",
				"M6 8h12v3a6 6 0 0 1-12 0V8z",
				"M12 17v5"
			],
			plus: ["M12 5v14", "M5 12h14"],
			search: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "M21 21l-4.3-4.3"],
			refresh: ["M21 12a9 9 0 1 1-2.6-6.4", "M21 3v6h-6"],
			back: ["M15 18l-6-6 6-6"],
			chevronRight: ["M9 18l6-6-6-6"],
			close: ["M18 6L6 18", "M6 6l12 12"],
			check: ["M20 6L9 17l-5-5"],
			alert: ["M12 9v4", "M12 17h.01", "M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"],
			trash: ["M3 6h18", "M8 6V4h8v2", "M19 6l-1 14H6L5 6", "M10 11v6", "M14 11v6"],
			edit: ["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"],
			globe: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M2 12h20", "M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z"],
			terminal: ["M4 17l6-5-6-5", "M12 19h8"],
			copy: ["M9 9h10v12H9z", "M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"],
			eye: ["M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"],
			eyeOff: ["M3 3l18 18", "M10.6 10.6a3 3 0 0 0 4.2 4.2", "M9.9 5.2A10.6 10.6 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1", "M6.6 6.6C3.6 8.6 2 12 2 12s3.6 7 10 7a10.4 10.4 0 0 0 4-.8"],
			box: ["M21 8l-9-5-9 5 9 5 9-5z", "M3 8v8l9 5 9-5V8", "M12 13v8"],
			info: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 16v-4", "M12 8h.01"]
		};

		function Icon({ name, size = 16 }) {
			const paths = ICONS[name] || ICONS.hub;
			return h("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.8,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": true,
				focusable: false
			}, paths.map((d, index) => h("path", { key: index, d })));
		}
		//#endregion

		//#region 纯函数
		function cx(...values) {
			return values.filter(Boolean).join(" ");
		}

		function isPlainObject(value) {
			return value !== null && typeof value === "object" && !Array.isArray(value);
		}

		function errorText(error) {
			return error instanceof Error ? error.message : String(error);
		}

		function stateLabel(state) {
			if (state === "connected") return "已连接";
			if (state === "pending") return "未就绪";
			if (state === "error") return "连接异常";
			if (state === "disabled") return "已停用";
			return "未知";
		}

		function timeText(timestamp) {
			try {
				return new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false });
			} catch {
				return "";
			}
		}

		function filterServer(server, query) {
			const value = query.trim().toLowerCase();
			if (value === "") return true;
			return [server.name, server.endpoint, server.transport, server.transportLabel, server.originLabel]
				.some((item) => String(item ?? "").toLowerCase().includes(value));
		}

		/** 与宿主 parseArgs 保持一致的引号 / 转义解析；绝不执行 shell。 */
		function splitArgs(text) {
			const source = String(text ?? "");
			const args = [];
			let current = "";
			let quote = null;
			let escaped = false;
			let started = false;

			for (const ch of source) {
				if (escaped) {
					current += ch;
					escaped = false;
					started = true;
					continue;
				}
				if (ch === "\\" && quote !== "'") {
					escaped = true;
					started = true;
					continue;
				}
				if (quote !== null) {
					if (ch === quote) quote = null;
					else current += ch;
					started = true;
					continue;
				}
				if (ch === '"' || ch === "'") {
					quote = ch;
					started = true;
					continue;
				}
				if (/\s/.test(ch)) {
					if (started) {
						args.push(current);
						current = "";
						started = false;
					}
					continue;
				}
				current += ch;
				started = true;
			}

			if (escaped) current += "\\";
			if (quote !== null) throw new Error("参数里的引号没有闭合");
			if (started) args.push(current);
			return args;
		}

		function joinArgs(args) {
			if (!Array.isArray(args) || args.length === 0) return "";
			return args.map((arg) => {
				const value = String(arg);
				if (value === "") return '""';
				if (!/[\s"'\\]/.test(value)) return value;
				return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
			}).join(" ");
		}

		function rowsFromMap(map) {
			if (!isPlainObject(map)) return [];
			return Object.entries(map).map(([key, value]) => ({ key, value: String(value ?? "") }));
		}

		function rowsToMap(rows) {
			const out = {};
			for (const row of Array.isArray(rows) ? rows : []) {
				const key = String(row?.key ?? "").trim();
				if (key !== "") out[key] = String(row?.value ?? "");
			}
			return out;
		}

		function hasOrphanRow(rows) {
			return (Array.isArray(rows) ? rows : []).some((row) => (
				String(row?.key ?? "").trim() === "" && String(row?.value ?? "") !== ""
			));
		}

		function emptyDraft() {
			return {
				serverName: "",
				transport: "stdio",
				command: "",
				argsText: "",
				cwd: "",
				url: "",
				envRows: [],
				headerRows: [],
				timeoutMs: String(DEFAULT_TIMEOUT),
				enabled: true
			};
		}

		function draftFromConfig(config, server) {
			const source = isPlainObject(config) ? config : {};
			const rawTransport = String(server?.transport ?? source.transport ?? source.type ?? "").toLowerCase();
			const transport = rawTransport === "stdio" || (rawTransport === "" && source.command)
				? "stdio"
				: "streamable-http";
			return {
				serverName: String(server?.name ?? source.serverName ?? ""),
				transport,
				command: String(source.command ?? ""),
				argsText: Array.isArray(source.args) ? joinArgs(source.args) : String(source.args ?? ""),
				cwd: String(source.cwd ?? ""),
				url: String(source.url ?? ""),
				envRows: rowsFromMap(source.env),
				headerRows: rowsFromMap(source.headers),
				timeoutMs: String(source.timeoutMs ?? source.toolCallTimeoutMs ?? DEFAULT_TIMEOUT),
				enabled: (source.enabled ?? server?.enabled) !== false
			};
		}

		function validateDraft(draft) {
			const errors = {};
			if (!draft) return { serverName: "表单尚未就绪" };
			const name = draft.serverName.trim();
			if (name === "") errors.serverName = "请填写名称";
			else if (!NAME_RE.test(name)) errors.serverName = "只能包含字母、数字、下划线或短横线，长度 1–32";

			if (draft.transport === "stdio") {
				if (draft.command.trim() === "") errors.command = "请填写启动命令";
				try {
					splitArgs(draft.argsText);
				} catch (error) {
					errors.args = errorText(error);
				}
				if (hasOrphanRow(draft.envRows)) errors.env = "有环境变量缺少名称，请补全或删除该行";
			} else {
				const url = draft.url.trim();
				if (url === "") errors.url = "请填写 URL";
				else {
					try {
						const parsed = new URL(url);
						if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
							errors.url = "只支持 http:// 或 https://";
						}
					} catch {
						errors.url = "URL 格式不正确";
					}
				}
				if (hasOrphanRow(draft.headerRows)) errors.headers = "有请求头缺少名称，请补全或删除该行";
			}

			const timeout = Number(draft.timeoutMs);
			if (!Number.isInteger(timeout) || timeout < MIN_TIMEOUT || timeout > MAX_TIMEOUT) {
				errors.timeoutMs = `需为 ${MIN_TIMEOUT}–${MAX_TIMEOUT} 之间的整数毫秒`;
			}
			return errors;
		}

		function serverInputFromDraft(draft) {
			const input = {
				serverName: draft.serverName.trim(),
				transport: draft.transport,
				timeoutMs: Number(draft.timeoutMs),
				enabled: draft.enabled !== false
			};
			if (draft.transport === "stdio") {
				input.command = draft.command.trim();
				input.args = splitArgs(draft.argsText);
				input.env = rowsToMap(draft.envRows);
				if (draft.cwd.trim() !== "") input.cwd = draft.cwd.trim();
			} else {
				input.url = draft.url.trim();
				input.headers = rowsToMap(draft.headerRows);
			}
			return input;
		}

		function serializeDraftJson(draft) {
			const input = serverInputFromDraft(draft);
			const name = input.serverName || "my-server";
			delete input.serverName;
			delete input.enabled;
			return JSON.stringify({ mcpServers: { [name]: input } }, null, 2);
		}

		/** JSON → [{ name, config }]。支持 mcpServers / servers / 单配置 / 数组。 */
		function extractJsonServers(text) {
			let parsed;
			try {
				parsed = JSON.parse(String(text ?? ""));
			} catch (error) {
				throw new Error(`JSON 无法解析：${errorText(error)}`);
			}
			if (parsed === null || typeof parsed !== "object") {
				throw new Error("JSON 顶层必须是对象或数组");
			}
			if (Array.isArray(parsed)) {
				if (parsed.length === 0) throw new Error("JSON 数组是空的");
				return parsed.map((item, index) => {
					if (!isPlainObject(item)) throw new Error(`第 ${index + 1} 项不是服务器配置对象`);
					return {
						name: String(item.serverName ?? item.name ?? "").trim(),
						config: item
					};
				});
			}
			if (isPlainObject(parsed.mcpServers)) return mapEntries(parsed.mcpServers, "mcpServers");
			if (isPlainObject(parsed.servers)) return mapEntries(parsed.servers, "servers");
			if (parsed.command !== undefined || parsed.url !== undefined || parsed.type !== undefined || parsed.transport !== undefined) {
				return [{
					name: String(parsed.serverName ?? parsed.name ?? "").trim(),
					config: parsed
				}];
			}
			if (Object.keys(parsed).length === 0) throw new Error("JSON 里没有服务器配置");
			return mapEntries(parsed, "顶层对象");
		}

		function mapEntries(map, label) {
			const entries = Object.entries(map);
			if (entries.length === 0) throw new Error(`${label} 里没有服务器配置`);
			return entries.map(([name, config]) => {
				if (!isPlainObject(config)) throw new Error(`服务器「${name}」的配置必须是对象`);
				return { name: String(name).trim(), config };
			});
		}

		function maskedConfig(config) {
			if (!isPlainObject(config)) return config;
			let clone;
			try {
				clone = JSON.parse(JSON.stringify(config));
			} catch {
				clone = { ...config };
			}
			for (const group of ["env", "headers"]) {
				if (clone && isPlainObject(clone[group])) {
					for (const key of Object.keys(clone[group])) clone[group][key] = "••••••";
				}
			}
			return clone;
		}

		function probeHeadline(probe) {
			const kind = probe?.kind;
			if (kind === "auth") return "认证失败";
			if (kind === "timeout") return "连接超时";
			if (kind === "network") return "无法连接";
			if (kind === "spawn") return "进程启动失败";
			if (kind === "http") return "Server 返回错误";
			if (kind === "protocol") return "协议握手失败";
			return "连接失败";
		}

		function dockSummary(state) {
			const counts = state.counts || {};
			const total = Number(counts.total ?? 0);
			const enabled = Number(counts.enabled ?? 0);
			const connected = Number(counts.connected ?? 0);
			const pending = Number(counts.pending ?? 0);
			const error = Number(counts.error ?? 0);
			const tools = Number(counts.tools ?? 0);
			if (state.status === "loading" && total === 0) return "正在读取服务器…";
			if (state.status === "error" && total === 0) return "状态读取失败，点此查看";
			if (total === 0) return "还没有服务器，点此添加";
			if (enabled === 0) return `全部 ${total} 个服务器已停用`;
			let text = `已连接 ${connected}/${enabled} · ${tools} 个工具`;
			if (pending > 0) text += ` · ${pending} 个连接中`;
			if (error > 0) text += ` · ${error} 个异常`;
			return text;
		}

		function dockTone(state) {
			const counts = state.counts || {};
			if (state.status === "error") return "error";
			if (Number(counts.total ?? 0) === 0) return "idle";
			if (Number(counts.error ?? 0) > 0) return "error";
			if (Number(counts.enabled ?? 0) === 0) return "disabled";
			if (Number(counts.pending ?? 0) > 0) return "pending";
			if (Number(counts.connected ?? 0) >= Number(counts.enabled ?? 0)) return "connected";
			return "pending";
		}

		function installStyles() {
			document.getElementById(STYLE_ID)?.remove();
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = CSS;
			document.head.appendChild(style);
			return () => {
				style.remove();
			};
		}
		//#endregion

		//#region controller
		function createController(ctx) {
			let state = {
				status: "loading",
				servers: [],
				counts: {
					total: 0, owned: 0, native: 0, enabled: 0, connected: 0,
					pending: 0, error: 0, disabled: 0, tools: 0
				},
				loadError: null,
				lastLoadedAt: null,
				query: "",
				view: "list",
				selectedId: null,
				detail: null,
				detailLoading: false,
				detailError: null,
				showSecrets: false,
				probe: { phase: "idle" },
				draft: null,
				draftLoading: false,
				formTab: "form",
				jsonText: "",
				formError: null,
				fieldErrors: {},
				formBusy: false,
				toggling: {},
				dialog: null,
				dialogBusy: false,
				dialogError: null,
				notice: null,
				overlayOpen: false
			};

			const listeners = new Set();
			let disposed = false;
			let refreshInFlight = null;
			let noticeTimer = null;

			const getSnapshot = () => state;
			const subscribe = (listener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			};

			function emit() {
				for (const listener of [...listeners]) {
					try {
						listener();
					} catch (error) {
						console.error("[mcp-bar] listener failed:", error);
					}
				}
			}

			function set(patch) {
				if (disposed) return;
				state = { ...state, ...patch };
				emit();
			}

			function notify(text, tone = "success") {
				if (noticeTimer !== null) {
					clearTimeout(noticeTimer);
					noticeTimer = null;
				}
				set({ notice: { text, tone, at: Date.now() } });
				noticeTimer = setTimeout(() => {
					noticeTimer = null;
					if (state.notice?.text === text) set({ notice: null });
				}, NOTICE_MS);
			}

			async function request(method, params) {
				let response;
				try {
					response = await fetch(API_PATH, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ method, params: params ?? {} }),
						cache: "no-store",
						credentials: "same-origin"
					});
				} catch (cause) {
					const error = new Error("无法连接 MCP Bar 服务，宿主可能尚未加载完成");
					error.cause = cause;
					throw error;
				}
				let payload = null;
				try {
					payload = await response.json();
				} catch {
					// 非 JSON 响应按 HTTP 错误处理。
				}
				if (!response.ok || !payload || payload.ok === false) {
					const error = new Error(payload?.message || `请求失败（HTTP ${response.status}）`);
					if (payload?.kind) error.kind = payload.kind;
					throw error;
				}
				return payload;
			}

			function refresh(options = {}) {
				if (refreshInFlight) return refreshInFlight;
				if (!options.quiet && state.servers.length === 0) set({ status: "loading" });
				refreshInFlight = (async () => {
					try {
						const payload = await request("status");
						if (disposed) return;
						const next = {
							status: "ready",
							servers: Array.isArray(payload.servers) ? payload.servers : [],
							counts: payload.counts ?? state.counts,
							loadError: null,
							lastLoadedAt: Date.now()
						};
						set(next);
						if (state.view === "detail" && state.detail?.server?.id) {
							const fresh = next.servers.find((server) => server.id === state.detail.server.id);
							if (fresh) set({ detail: { ...state.detail, server: fresh } });
						}
					} catch (error) {
						if (disposed) return;
						if (state.servers.length === 0) set({ status: "error", loadError: errorText(error) });
						else if (!options.quiet) set({ loadError: errorText(error) });
					} finally {
						refreshInFlight = null;
					}
				})();
				return refreshInFlight;
			}

			function start() {
				disposed = false;
				void refresh();
				const timer = setInterval(() => {
					if (document.visibilityState !== "hidden") void refresh({ quiet: true });
				}, POLL_MS);
				const onFocus = () => {
					void refresh({ quiet: true });
				};
				const onVisibility = () => {
					if (document.visibilityState === "visible") void refresh({ quiet: true });
				};
				window.addEventListener("focus", onFocus);
				document.addEventListener("visibilitychange", onVisibility);
				return () => {
					disposed = true;
					clearInterval(timer);
					window.removeEventListener("focus", onFocus);
					document.removeEventListener("visibilitychange", onVisibility);
					if (noticeTimer !== null) clearTimeout(noticeTimer);
					listeners.clear();
				};
			}

			function layoutController() {
				try {
					if (typeof ctx.get === "function") {
						const found = ctx.get("layout");
						if (found) return found;
					}
				} catch {
					// ctx.get 对未知服务可能抛错，继续回退到 ctx.layout。
				}
				return ctx.layout;
			}

			function mainRegistered() {
				try {
					return (ctx.slots.entries("main") ?? []).some((entry) => entry.options?.key === PANEL_ID);
				} catch {
					return false;
				}
			}

			function openPanel() {
				const layout = layoutController();
				if (layout?.selectPanel && mainRegistered()) {
					try {
						layout.selectPanel(PANEL_ID);
						set({ overlayOpen: false });
						void refresh({ quiet: true });
						return;
					} catch (error) {
						console.warn("[mcp-bar] selectPanel failed:", error);
					}
				}
				set({ overlayOpen: true });
				void refresh({ quiet: true });
			}

			function closeOverlay() {
				set({ overlayOpen: false });
			}

			function closePanel() {
				if (state.overlayOpen) {
					closeOverlay();
					return;
				}
				const layout = layoutController();
				try {
					layout?.selectPanel?.(null);
				} catch (error) {
					console.warn("[mcp-bar] selectPanel(null) failed:", error);
				}
			}

			function dismissNotice() {
				if (noticeTimer !== null) {
					clearTimeout(noticeTimer);
					noticeTimer = null;
				}
				set({ notice: null });
			}

			function setQuery(query) {
				set({ query: String(query ?? "") });
			}

			function goBack() {
				if (state.dialog) {
					closeDialog();
					return;
				}
				dismissNotice();
				if (state.view === "list") {
					closePanel();
					return;
				}
				set({
					view: "list",
					selectedId: null,
					detail: null,
					detailError: null,
					draft: null,
					formError: null,
					fieldErrors: {},
					probe: { phase: "idle" }
				});
			}

			function openCreate(options = {}) {
				dismissNotice();
				set({
					view: "create",
					selectedId: null,
					detail: null,
					detailError: null,
					draft: emptyDraft(),
					draftLoading: false,
					formTab: options.tab === "json" ? "json" : "form",
					jsonText: "",
					formError: null,
					fieldErrors: {},
					formBusy: false,
					probe: { phase: "idle" },
					dialog: null
				});
			}

			async function openEdit(id) {
				dismissNotice();
				set({
					view: "edit",
					selectedId: id,
					detail: null,
					detailError: null,
					draft: null,
					draftLoading: true,
					formTab: "form",
					jsonText: "",
					formError: null,
					fieldErrors: {},
					probe: { phase: "idle" },
					dialog: null
				});
				try {
					const payload = await request("detail", { id });
					if (state.view !== "edit" || state.selectedId !== id) return;
					set({ draft: draftFromConfig(payload.config, payload.server), draftLoading: false });
				} catch (error) {
					if (state.view !== "edit" || state.selectedId !== id) return;
					set({ draftLoading: false, formError: errorText(error) });
				}
			}

			async function openDetail(id, options = {}) {
				dismissNotice();
				set({
					view: "detail",
					selectedId: id,
					detail: null,
					detailLoading: true,
					detailError: null,
					showSecrets: false,
					probe: { phase: "idle" },
					dialog: null
				});
				try {
					const payload = await request("detail", { id });
					if (state.view !== "detail" || state.selectedId !== id) return;
					set({ detail: payload, detailLoading: false });
					if (options.probe) void runProbe({ id });
				} catch (error) {
					if (state.view !== "detail" || state.selectedId !== id) return;
					set({ detailLoading: false, detailError: errorText(error) });
				}
			}

			async function refreshDetail(id, options = {}) {
				try {
					const payload = await request("detail", { id });
					if (state.view === "detail" && state.selectedId === id) set({ detail: payload });
				} catch (error) {
					if (!options.silent && state.view === "detail" && state.selectedId === id) {
						set({ detailError: errorText(error) });
					}
				}
			}

			async function runProbe(options = {}) {
				const draft = options.draft ?? null;
				const id = options.id ?? state.selectedId;
				if (draft) {
					const errors = validateDraft(draft);
					if (Object.keys(errors).length > 0) {
						set({ fieldErrors: errors, formError: "请先补全或修正表单，再测试连接" });
						return;
					}
				}
				set({ probe: { phase: "running" } });
				try {
					const payload = draft
						? await request("probe", { server: serverInputFromDraft(draft) })
						: await request("probe", { id });
					set({ probe: { phase: "done", result: payload } });
				} catch (error) {
					set({ probe: { phase: "error", error: errorText(error), kind: error.kind } });
				}
			}

			function retryProbe() {
				if (state.view === "create" || state.view === "edit") {
					if (state.draft) void runProbe({ draft: state.draft });
					return;
				}
				if (state.selectedId) void runProbe({ id: state.selectedId });
			}

			function setTab(tab) {
				if (tab === state.formTab) return;
				if (tab === "json") {
					if (!state.draft) return;
					try {
						set({ formTab: "json", jsonText: serializeDraftJson(state.draft), formError: null, fieldErrors: {} });
					} catch (error) {
						set({ formError: errorText(error) });
					}
					return;
				}
				let entries = null;
				try {
					entries = extractJsonServers(state.jsonText);
				} catch {
					entries = null;
				}
				if (entries && entries.length === 1 && state.draft) {
					const entry = entries[0];
					const merged = draftFromConfig({ ...entry.config, serverName: entry.name || state.draft.serverName }, null);
					set({ formTab: "form", draft: merged, formError: null, fieldErrors: {} });
				} else {
					set({ formTab: "form", formError: null, fieldErrors: {} });
				}
			}

			function setJsonText(text) {
				set({ jsonText: String(text ?? ""), formError: null });
			}

			function formatJson() {
				try {
					const parsed = JSON.parse(state.jsonText);
					set({ jsonText: JSON.stringify(parsed, null, 2), formError: null });
				} catch (error) {
					set({ formError: `JSON 无法解析：${errorText(error)}` });
				}
			}

			function updateDraft(patch) {
				if (!state.draft) return;
				set({ draft: { ...state.draft, ...patch }, fieldErrors: {} });
			}

			function updateDraftRow(which, index, field, value) {
				if (!state.draft) return;
				const rows = [...(state.draft[which] ?? [])];
				if (!rows[index]) return;
				rows[index] = { ...rows[index], [field]: value };
				set({ draft: { ...state.draft, [which]: rows }, fieldErrors: {} });
			}

			function addDraftRow(which) {
				if (!state.draft) return;
				const rows = [...(state.draft[which] ?? []), { key: "", value: "" }];
				set({ draft: { ...state.draft, [which]: rows }, fieldErrors: {} });
			}

			function removeDraftRow(which, index) {
				if (!state.draft) return;
				const rows = [...(state.draft[which] ?? [])];
				rows.splice(index, 1);
				set({ draft: { ...state.draft, [which]: rows }, fieldErrors: {} });
			}

			function toggleSecrets() {
				set({ showSecrets: !state.showSecrets });
			}

			function finishSaved(name, payload) {
				const warnings = Array.isArray(payload?.warnings) ? payload.warnings.filter(Boolean) : [];
				if (warnings.length > 0) {
					notify(`已保存「${name}」：${warnings.join("；")}`, "warn");
				} else {
					notify(`已保存「${name}」`, "success");
				}
				set({
					view: "list",
					selectedId: null,
					draft: null,
					formBusy: false,
					formError: null,
					fieldErrors: {},
					probe: { phase: "idle" }
				});
				void refresh({ quiet: true });
			}

			async function saveForm() {
				if (state.formBusy) return;
				if (state.formTab === "json") {
					await saveJson();
					return;
				}
				const draft = state.draft;
				if (!draft) return;
				const errors = validateDraft(draft);
				if (Object.keys(errors).length > 0) {
					set({ fieldErrors: errors, formError: "请检查标红的字段" });
					return;
				}
				set({ formBusy: true, formError: null, fieldErrors: {} });
				let server;
				try {
					server = serverInputFromDraft(draft);
				} catch (error) {
					set({ formBusy: false, formError: errorText(error) });
					return;
				}
				try {
					const payload = state.view === "edit"
						? await request("update", { id: state.selectedId, server })
						: await request("create", { server });
					finishSaved(server.serverName, payload);
				} catch (error) {
					set({ formBusy: false, formError: errorText(error) });
				}
			}

			async function saveJson() {
				if (state.formBusy) return;
				set({ formBusy: true, formError: null, fieldErrors: {} });
				let entries;
				try {
					entries = extractJsonServers(state.jsonText);
					if (entries.length === 0) throw new Error("JSON 里没有服务器配置");
					for (const entry of entries) {
						if (entry.name !== "" && !NAME_RE.test(entry.name)) {
							throw new Error(`名称「${entry.name}」不合法：只能包含字母、数字、下划线或短横线，长度 1–32`);
						}
					}
				} catch (error) {
					set({ formBusy: false, formError: errorText(error) });
					return;
				}

				try {
					if (state.view === "edit") {
						if (entries.length !== 1) throw new Error("编辑模式下 JSON 里只能有一个服务器");
						const entry = entries[0];
						const server = {
							...entry.config,
							serverName: entry.name || state.draft?.serverName || ""
						};
						const payload = await request("update", { id: state.selectedId, server });
						finishSaved(String(server.serverName), payload);
						return;
					}
					if (entries.length === 1) {
						const entry = entries[0];
						if (entry.name === "") throw new Error("请为服务器填写名称（mcpServers 的键或 serverName 字段）");
						const server = { ...entry.config, serverName: entry.name };
						const payload = await request("create", { server });
						finishSaved(entry.name, payload);
						return;
					}
					const payload = await request("importJson", { json: state.jsonText });
					const created = Array.isArray(payload.created) ? payload.created : [];
					const failed = created.filter((item) => item.warning);
					notify(
						failed.length > 0
							? `已导入 ${created.length} 个服务器，${failed.length} 个需要稍后重试`
							: `已导入 ${created.length} 个服务器`,
						failed.length > 0 ? "warn" : "success"
					);
					set({ view: "list", formBusy: false, formError: null, probe: { phase: "idle" } });
					void refresh({ quiet: true });
				} catch (error) {
					set({ formBusy: false, formError: errorText(error) });
				}
			}

			async function toggleServer(server) {
				if (!server?.canEdit || state.toggling[server.id]) return;
				set({ toggling: { ...state.toggling, [server.id]: true } });
				try {
					await request("setEnabled", { id: server.id, enabled: !server.enabled });
					notify(server.enabled ? `已停用「${server.name}」` : `已启用「${server.name}」`);
					await refresh({ quiet: true });
					if (state.view === "detail" && state.detail?.server?.id === server.id) {
						await refreshDetail(server.id, { silent: true });
					}
				} catch (error) {
					notify(errorText(error), "error");
				} finally {
					const next = { ...state.toggling };
					delete next[server.id];
					set({ toggling: next });
				}
			}

			function requestDelete(server) {
				set({
					dialog: { kind: "delete", id: server.id, name: server.name, nativeEntryId: server.nativeEntryId },
					dialogBusy: false,
					dialogError: null
				});
			}

			function requestTakeover(server) {
				set({
					dialog: {
						kind: "takeover",
						name: server.name,
						entryId: server.nativeEntryId || String(server.id).replace(/^native:/, "")
					},
					dialogBusy: false,
					dialogError: null
				});
			}

			function requestTakeoverAll() {
				set({
					dialog: { kind: "takeoverAll", count: state.counts.native },
					dialogBusy: false,
					dialogError: null
				});
			}

			function closeDialog() {
				if (state.dialogBusy) return;
				set({ dialog: null, dialogError: null });
			}

			async function confirmDialog() {
				const dialog = state.dialog;
				if (!dialog || state.dialogBusy) return;
				set({ dialogBusy: true, dialogError: null });
				try {
					if (dialog.kind === "delete") {
						const payload = await request("remove", { id: dialog.id });
						set({ dialog: null, dialogBusy: false, dialogError: null });
						notify(
							payload.restoredNative
								? `已删除「${dialog.name}」，profile 原条目已恢复`
								: `已删除「${dialog.name}」`,
							"success"
						);
						if (state.view === "detail") {
							set({ view: "list", selectedId: null, detail: null, probe: { phase: "idle" } });
						}
						await refresh({ quiet: true });
						return;
					}
					if (dialog.kind === "takeover") {
						const payload = await request("takeover", { entryId: dialog.entryId });
						set({ dialog: null, dialogBusy: false, dialogError: null });
						notify(
							`已接管「${dialog.name}」${payload.warning ? `，${payload.warning}` : ""}`,
							payload.warning ? "warn" : "success"
						);
						await refresh({ quiet: true });
						if (state.view === "detail" && state.selectedId?.startsWith("native:")) {
							set({ view: "list", selectedId: null, detail: null, probe: { phase: "idle" } });
						}
						return;
					}
					if (dialog.kind === "takeoverAll") {
						const payload = await request("takeoverAll");
						const created = Array.isArray(payload.created) ? payload.created : [];
						const failed = Array.isArray(payload.failed) ? payload.failed : [];
						set({ dialog: null, dialogBusy: false, dialogError: null });
						notify(
							`已接管 ${created.length}/${payload.total ?? created.length + failed.length} 个 Server${failed.length > 0 ? `，${failed.length} 个失败` : ""}`,
							failed.length > 0 ? "warn" : "success"
						);
						if (state.view === "detail" && state.selectedId?.startsWith("native:")) {
							set({ view: "list", selectedId: null, detail: null, probe: { phase: "idle" } });
						}
						await refresh({ quiet: true });
					}
				} catch (error) {
					set({ dialogBusy: false, dialogError: errorText(error) });
				}
			}

			async function copy(text) {
				const value = String(text ?? "");
				try {
					await navigator.clipboard.writeText(value);
					notify("已复制到剪贴板");
					return;
				} catch {
					// 回退到 execCommand。
				}
				try {
					const area = document.createElement("textarea");
					area.value = value;
					area.setAttribute("readonly", "");
					area.style.position = "fixed";
					area.style.left = "-9999px";
					area.style.opacity = "0";
					document.body.appendChild(area);
					area.select();
					document.execCommand("copy");
					area.remove();
					notify("已复制到剪贴板");
				} catch (error) {
					notify(`复制失败：${errorText(error)}`, "error");
				}
			}

			return {
				getSnapshot,
				subscribe,
				start,
				refresh: () => refresh(),
				openPanel,
				closePanel,
				closeOverlay,
				dismissNotice,
				setQuery,
				goBack,
				openCreate,
				openEdit,
				openDetail,
				runProbe,
				retryProbe,
				setTab,
				setJsonText,
				formatJson,
				updateDraft,
				updateDraftRow,
				addDraftRow,
				removeDraftRow,
				toggleSecrets,
				saveForm,
				toggleServer,
				requestDelete,
				requestTakeover,
				requestTakeoverAll,
				closeDialog,
				confirmDialog,
				copy
			};
		}
		//#endregion

		//#region 组件
		function useController(controller) {
			return React.useSyncExternalStore(controller.subscribe, controller.getSnapshot);
		}

		function Spinner({ size = 14 }) {
			return h("span", { className: "mcpbar-spinner", style: { width: size, height: size } });
		}

		function StateDot({ state, size }) {
			return h("span", { className: `mcpbar-dot mcpbar-dot-${state || "disabled"}`, "data-size": size || "sm" });
		}

		function Switch({ checked, onChange, disabled, busy, label }) {
			return h("button", {
				type: "button",
				role: "switch",
				"aria-checked": checked ? "true" : "false",
				"aria-label": label,
				className: "mcpbar-switch",
				"data-busy": busy ? "true" : "false",
				disabled: disabled || busy,
				onClick: (event) => {
					event.stopPropagation();
					onChange?.();
				}
			}, busy ? h(Spinner, { size: 12 }) : null);
		}

		function McpDock({ controller }) {
			const state = useController(controller);
			return h("button", {
				type: "button",
				className: "mcpbar-dock",
				"data-tone": dockTone(state),
				title: "打开 MCP 服务器管理",
				onClick: () => controller.openPanel()
			},
				h("span", { className: "mcpbar-dock-icon" }, h(Icon, { name: "hub", size: 13 })),
				h("span", { className: "mcpbar-dock-label" }, "MCP"),
				h(StateDot, { state: dockTone(state) === "idle" ? "disabled" : dockTone(state) }),
				h("span", { className: "mcpbar-dock-meta" }, dockSummary(state)),
				h("span", { className: "mcpbar-dock-spacer" }),
				h("span", { className: "mcpbar-dock-action" }, "管理", h(Icon, { name: "chevronRight", size: 12 }))
			);
		}

		function McpSidebarIcon({ size = 16 }) {
			return h(Icon, { name: "hub", size });
		}

		function SearchBox({ controller, state }) {
			return h("label", { className: "mcpbar-search" },
				h(Icon, { name: "search", size: 14 }),
				h("input", {
					type: "search",
					value: state.query,
					placeholder: "搜索名称或端点",
					"aria-label": "搜索 MCP 服务器",
					onChange: (event) => controller.setQuery(event.target.value)
				})
			);
		}

		function Notice({ notice, onClose }) {
			const icon = notice.tone === "error" || notice.tone === "warn" ? "alert" : notice.tone === "info" ? "info" : "check";
			return h("div", { className: `mcpbar-notice mcpbar-notice-${notice.tone || "success"}`, role: "status" },
				h(Icon, { name: icon, size: 15 }),
				h("span", { className: "mcpbar-notice-text" }, notice.text),
				h("button", { type: "button", className: "mcpbar-icon-btn", title: "关闭提示", onClick: onClose },
					h(Icon, { name: "close", size: 13 }))
			);
		}

		function Header({ controller, state, presentation }) {
			const counts = state.counts;
			let title = "MCP 服务器";
			let subtitle = state.status === "ready"
				? `已安装 ${counts.total} · 已连接 ${counts.connected} · ${counts.tools} 个工具`
				: state.status === "error" ? "无法读取服务器状态" : "正在读取服务器…";

			if (state.view === "create") {
				title = "新建 MCP 服务器";
				subtitle = "保存后会自动连接，并把工具注册给对话";
			} else if (state.view === "edit") {
				title = state.draft?.serverName ? `编辑「${state.draft.serverName}」` : "编辑 MCP 服务器";
				subtitle = "修改会立即重新连接；名称变化会改变工具前缀";
			} else if (state.view === "detail") {
				const server = state.detail?.server ?? state.servers.find((item) => item.id === state.selectedId);
				title = server?.name ?? "MCP 服务器";
				subtitle = server
					? `${server.transportLabel} · ${server.enabled ? "已启用" : "已停用"} · ${server.toolCount} 个工具`
					: "正在读取…";
			}

			return h("div", { className: "mcpbar-head" },
				state.view !== "list" && h("button", {
					type: "button",
					className: "mcpbar-back",
					title: "返回",
					onClick: () => controller.goBack()
				}, h(Icon, { name: "back", size: 16 })),
				h("div", { className: "mcpbar-head-main" },
					h("div", { className: "mcpbar-titleline" },
						h("span", { className: "mcpbar-logo" }, h(Icon, { name: "hub", size: 17 })),
						h("h1", { className: "mcpbar-title" }, title),
						state.view === "list" && h("span", { className: "mcpbar-scope" }, "用户 · 本机")
					),
					h("p", { className: "mcpbar-sub" }, subtitle)
				),
				h("div", { className: "mcpbar-head-actions" },
					state.view === "list" && h(SearchBox, { controller, state }),
					state.view === "list" && h("button", {
						type: "button",
						className: "mcpbar-icon-btn",
						title: "刷新状态",
						disabled: state.status === "loading",
						onClick: () => controller.refresh()
					}, h(Icon, { name: "refresh", size: 15 })),
					state.view === "list" && h("button", {
						type: "button",
						className: "mcpbar-btn mcpbar-btn-primary",
						onClick: () => controller.openCreate()
					}, h(Icon, { name: "plus", size: 14 }), "新建"),
					h("button", {
						type: "button",
						className: "mcpbar-icon-btn",
						title: "关闭面板",
						onClick: () => {
							if (presentation === "overlay") controller.closeOverlay();
							else controller.closePanel();
						}
					}, h(Icon, { name: "close", size: 16 }))
				)
			);
		}

		function StatsRow({ counts }) {
			const items = [
				{ label: "已安装", value: counts.total },
				{ label: "已连接", value: counts.connected, tone: counts.connected > 0 ? "success" : undefined },
				{ label: "工具", value: counts.tools },
				{ label: "异常", value: counts.error, tone: counts.error > 0 ? "error" : undefined }
			];
			return h("div", { className: "mcpbar-stats" },
				items.map((item) => h("div", { className: "mcpbar-stat", key: item.label },
					h("div", { className: "mcpbar-stat-value", "data-tone": item.tone }, String(item.value ?? 0)),
					h("div", { className: "mcpbar-stat-label" }, item.label)
				))
			);
		}

		function SkeletonRows({ count = 3 }) {
			return h("div", { className: "mcpbar-skeleton-list" },
				Array.from({ length: count }, (_, index) => h("div", { className: "mcpbar-skeleton-row", key: index },
					h("span", { className: "mcpbar-dot" }),
					h("div", { style: { flex: 1 } },
						h("div", { className: "mcpbar-skeleton", style: { width: `${38 + index * 9}%` } }),
						h("div", { className: "mcpbar-skeleton", style: { width: `${58 + index * 6}%`, marginTop: 7, height: 8 } })
					),
					h("div", { className: "mcpbar-skeleton", style: { width: 34, height: 18, borderRadius: 9 } })
				))
			);
		}

		function ServerRow({ server, controller, state }) {
			const toggling = Boolean(state.toggling[server.id]);
			const open = () => controller.openDetail(server.id);
			return h("div", {
				className: "mcpbar-row",
				"data-state": server.state,
				role: "button",
				tabIndex: 0,
				onClick: open,
				onKeyDown: (event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						open();
					}
				}
			},
				h(StateDot, { state: server.state, size: "md" }),
				h("div", { className: "mcpbar-row-main" },
					h("div", { className: "mcpbar-row-title" },
						h("span", { className: "mcpbar-row-name" }, server.name),
						server.origin === "profile" && h("span", { className: "mcpbar-tag" }, "profile"),
						server.duplicateCount > 1 && h("span", {
							className: "mcpbar-tag mcpbar-tag-warn",
							title: "同一 serverName 存在多个 loader 条目，只有一份真正生效"
						}, `${server.duplicateCount} 处配置`),
						h("span", { className: "mcpbar-tag mcpbar-tag-muted" }, server.transportLabel),
						server.toolCount > 0 && h("span", { className: "mcpbar-tag mcpbar-tag-tool" }, `${server.toolCount} 个工具`),
						server.state === "error" && h("span", { className: "mcpbar-tag mcpbar-tag-error" }, "连接异常"),
						server.state === "pending" && h("span", { className: "mcpbar-tag mcpbar-tag-warn" }, "未就绪"),
						server.state === "disabled" && h("span", { className: "mcpbar-tag mcpbar-tag-muted" }, "已停用")
					),
					h("div", { className: "mcpbar-row-meta" },
						h("code", { className: "mcpbar-row-endpoint" }, server.endpoint || "未配置端点"),
						h("span", { className: "mcpbar-row-sep" }, "·"),
						h("span", null, `${server.timeoutMs ?? DEFAULT_TIMEOUT} ms`),
						Array.isArray(server.envKeys) && server.envKeys.length > 0
							? h("span", null, ` · ${server.envKeys.length} 个环境变量`)
							: null
					),
					server.error && h("div", { className: "mcpbar-row-error" }, server.error)
				),
				h("div", { className: "mcpbar-row-actions", onClick: (event) => event.stopPropagation() },
					server.canTakeover
						? h("button", {
							type: "button",
							className: "mcpbar-btn mcpbar-btn-sm",
							onClick: () => controller.requestTakeover(server)
						}, "接管")
						: h(Switch, {
							checked: server.enabled,
							busy: toggling,
							label: `${server.enabled ? "停用" : "启用"} ${server.name}`,
							onChange: () => controller.toggleServer(server)
						}),
					h("button", {
						type: "button",
						className: "mcpbar-icon-btn",
						title: "测试连接",
						onClick: () => controller.openDetail(server.id, { probe: true })
					}, h(Icon, { name: "plug", size: 15 })),
					server.canEdit && h("button", {
						type: "button",
						className: "mcpbar-icon-btn",
						title: "编辑",
						onClick: () => controller.openEdit(server.id)
					}, h(Icon, { name: "edit", size: 15 })),
					server.canRemove && h("button", {
						type: "button",
						className: "mcpbar-icon-btn mcpbar-icon-danger",
						title: "删除",
						onClick: () => controller.requestDelete(server)
					}, h(Icon, { name: "trash", size: 15 })),
					h("button", {
						type: "button",
						className: "mcpbar-icon-btn",
						title: "查看详情",
						onClick: open
					}, h(Icon, { name: "chevronRight", size: 15 }))
				)
			);
		}

		function ListView({ controller, state }) {
			const counts = state.counts;
			const servers = state.servers.filter((server) => filterServer(server, state.query));
			const loading = state.status === "loading" && state.servers.length === 0;
			const filtered = state.query.trim() !== "";
			return h("div", null,
				h(StatsRow, { counts }),
				state.loadError && h("div", { className: "mcpbar-notice mcpbar-notice-error", role: "alert" },
					h(Icon, { name: "alert", size: 15 }),
					h("span", { className: "mcpbar-notice-text" }, state.loadError),
					h("button", { type: "button", className: "mcpbar-btn mcpbar-btn-sm", onClick: () => controller.refresh() }, "重试")
				),
				counts.native > 0 && !filtered && h("div", { className: "mcpbar-banner" },
					h("span", { className: "mcpbar-banner-icon" }, h(Icon, { name: "box", size: 14 })),
					h("div", { className: "mcpbar-banner-main" },
						h("strong", null, `profile 中还有 ${counts.native} 个 MCP Server`),
						h("p", null, "它们来自 cordis.patch.yml，可以直接测试。接管后会复制到 MCP Bar 管理，原条目停用但配置文件不改。"),
						counts.duplicateNative > 0 && h("p", { className: "mcpbar-banner-warn" },
							`检测到 ${counts.duplicateNative} 条重复配置（同一 serverName 的多个条目，仅一份生效），已合并显示；接管时会一并停用所有同名条目。`)
					),
					h("button", {
						type: "button",
						className: "mcpbar-btn",
						onClick: () => controller.requestTakeoverAll()
					}, "全部接管")
				),
				loading
					? h(SkeletonRows)
					: servers.length === 0
						? filtered
							? h("div", { className: "mcpbar-empty" },
								h("span", { className: "mcpbar-empty-icon" }, h(Icon, { name: "search", size: 24 })),
								h("h3", null, "没有匹配的服务器"),
								h("p", null, `没有名称或端点包含「${state.query.trim()}」的 Server。`),
								h("div", { className: "mcpbar-empty-actions" },
									h("button", { type: "button", className: "mcpbar-btn", onClick: () => controller.setQuery("") }, "清除搜索")
								)
							)
							: h("div", { className: "mcpbar-empty" },
								h("span", { className: "mcpbar-empty-icon" }, h(Icon, { name: "hub", size: 24 })),
								h("h3", null, "还没有 MCP 服务器"),
								h("p", null, "通过表单或 JSON 添加一个。保存后会自动连接，并把工具注册给当前对话。"),
								h("div", { className: "mcpbar-empty-actions" },
									h("button", {
										type: "button",
										className: "mcpbar-btn mcpbar-btn-primary",
										onClick: () => controller.openCreate()
									}, h(Icon, { name: "plus", size: 14 }), "新建服务器"),
									h("button", {
										type: "button",
										className: "mcpbar-btn",
										onClick: () => controller.openCreate({ tab: "json" })
									}, "粘贴 JSON")
								)
							)
						: h("div", { className: "mcpbar-list" },
							servers.map((server) => h(ServerRow, {
								key: server.id,
								server,
								controller,
								state
							}))
						),
				h("p", { className: "mcpbar-footnote" },
					state.lastLoadedAt
						? `状态更新于 ${timeText(state.lastLoadedAt)} · 每 5 秒自动刷新`
						: " "
				)
			);
		}

		function Field({ title, required, hint, error, wide, children }) {
			return h("div", { className: cx("mcpbar-field", wide && "mcpbar-field-wide") },
				h("label", { className: "mcpbar-label" },
					title,
					required ? h("span", { className: "mcpbar-req" }, "*") : null
				),
				children,
				hint ? h("p", { className: "mcpbar-hint" }, hint) : null,
				error ? h("p", { className: "mcpbar-error-text" }, error) : null
			);
		}

		function TextInput({ value, onChange, placeholder, mono, invalid, type, min, max, step }) {
			return h("input", {
				className: cx("mcpbar-input", mono && "mcpbar-input-mono"),
				type: type || "text",
				value,
				placeholder,
				min,
				max,
				step,
				"aria-invalid": invalid ? "true" : "false",
				onChange: (event) => onChange(event.target.value)
			});
		}

		function TransportPicker({ value, onChange }) {
			return h("div", { className: "mcpbar-field" },
				h("span", { className: "mcpbar-label" }, "类型"),
				h("div", { className: "mcpbar-segmented" },
					h("button", {
						type: "button",
						"data-active": value === "stdio" ? "true" : "false",
						onClick: () => onChange("stdio")
					}, h(Icon, { name: "terminal", size: 13 }), "stdio"),
					h("button", {
						type: "button",
						"data-active": value === "streamable-http" ? "true" : "false",
						onClick: () => onChange("streamable-http")
					}, h(Icon, { name: "globe", size: 13 }), "Streamable HTTP")
				),
				h("p", { className: "mcpbar-hint" },
					value === "stdio"
						? "在本机启动子进程，通过 stdin / stdout 通信"
						: "连接远程或本机的 HTTP 端点"
				)
			);
		}

		function KeyValueEditor({ title, hint, rows, onChange, onAdd, onRemove, keyPlaceholder, valuePlaceholder, error }) {
			return h("div", { className: "mcpbar-field mcpbar-field-wide" },
				h("div", { className: "mcpbar-kv-head" },
					h("span", { className: "mcpbar-label" }, title),
					h("button", { type: "button", className: "mcpbar-btn mcpbar-btn-sm", onClick: onAdd },
						h(Icon, { name: "plus", size: 13 }), "添加")
				),
				rows.length === 0
					? h("p", { className: "mcpbar-hint mcpbar-kv-empty" }, hint)
					: h("div", { className: "mcpbar-kv-list" },
						rows.map((row, index) => h("div", { className: "mcpbar-kv-row", key: index },
							h("input", {
								className: "mcpbar-input mcpbar-input-mono",
								value: row.key,
								placeholder: keyPlaceholder,
								onChange: (event) => onChange(index, "key", event.target.value)
							}),
							h("input", {
								className: "mcpbar-input mcpbar-input-mono",
								value: row.value,
								placeholder: valuePlaceholder,
								onChange: (event) => onChange(index, "value", event.target.value)
							}),
							h("button", {
								type: "button",
								className: "mcpbar-icon-btn mcpbar-icon-danger",
								title: "删除这一行",
								onClick: () => onRemove(index)
							}, h(Icon, { name: "trash", size: 14 }))
						))
					),
				error ? h("p", { className: "mcpbar-error-text" }, error) : null
			);
		}

		function FormFields({ controller, state, draft, errors }) {
			const stdio = draft.transport === "stdio";
			return h("div", { className: "mcpbar-form-card" },
				h("div", { className: "mcpbar-field-grid" },
					h(Field, {
						title: "名称",
						required: true,
						hint: "字母、数字、下划线或短横线，1–32 字符。工具会以 mcp__<名称>__ 开头。",
						error: errors.serverName
					}, h(TextInput, {
						value: draft.serverName,
						placeholder: "例如 filesystem",
						mono: true,
						invalid: Boolean(errors.serverName),
						onChange: (value) => controller.updateDraft({ serverName: value })
					})),
					h(TransportPicker, {
						value: draft.transport,
						onChange: (value) => controller.updateDraft({ transport: value })
					}),
					stdio
						? h(Field, {
							title: "命令",
							required: true,
							hint: "要执行的程序，例如 npx、uvx、node。不会经过 shell。",
							error: errors.command,
							wide: true
						}, h(TextInput, {
							value: draft.command,
							placeholder: "npx",
							mono: true,
							invalid: Boolean(errors.command),
							onChange: (value) => controller.updateDraft({ command: value })
						}))
						: h(Field, {
							title: "URL",
							required: true,
							hint: "Streamable HTTP 端点，例如 https://example.com/mcp",
							error: errors.url,
							wide: true
						}, h(TextInput, {
							value: draft.url,
							placeholder: "https://example.com/mcp",
							mono: true,
							invalid: Boolean(errors.url),
							onChange: (value) => controller.updateDraft({ url: value })
						})),
					stdio && h(Field, {
						title: "参数",
						hint: '空格分隔；含空格的参数用引号包起来，例如 --root "/Users/me/My Docs"。',
						error: errors.args,
						wide: true
					}, h(TextInput, {
						value: draft.argsText,
						placeholder: '-y @modelcontextprotocol/server-filesystem /tmp',
						mono: true,
						invalid: Boolean(errors.args),
						onChange: (value) => controller.updateDraft({ argsText: value })
					})),
					stdio && h(Field, {
						title: "工作目录",
						hint: "可选。命令会在这个目录下启动。"
					}, h(TextInput, {
						value: draft.cwd,
						placeholder: "留空使用宿主工作区",
						mono: true,
						onChange: (value) => controller.updateDraft({ cwd: value })
					})),
					h(Field, {
						title: "超时时间",
						hint: `单次工具调用超时，单位毫秒（${MIN_TIMEOUT}–${MAX_TIMEOUT}）。`,
						error: errors.timeoutMs
					}, h(TextInput, {
						value: draft.timeoutMs,
						type: "number",
						min: MIN_TIMEOUT,
						max: MAX_TIMEOUT,
						step: 1000,
						invalid: Boolean(errors.timeoutMs),
						onChange: (value) => controller.updateDraft({ timeoutMs: value })
					})),
					h("div", { className: "mcpbar-field" },
						h("span", { className: "mcpbar-label" }, state.view === "edit" ? "启用" : "创建后立即启用"),
						h("div", { className: "mcpbar-switch-line" },
							h(Switch, {
								checked: draft.enabled,
								label: "启用服务器",
								onChange: () => controller.updateDraft({ enabled: !draft.enabled })
							}),
							h("span", { className: "mcpbar-switch-text" },
								draft.enabled ? "保存后立即连接" : "先保存为停用状态")
						)
					),
					stdio && h(KeyValueEditor, {
						title: "环境变量",
						hint: "没有环境变量时留空即可。值不会出现在状态栏里。",
						rows: draft.envRows,
						error: errors.env,
						keyPlaceholder: "KEY",
						valuePlaceholder: "value",
						onAdd: () => controller.addDraftRow("envRows"),
						onRemove: (index) => controller.removeDraftRow("envRows", index),
						onChange: (index, field, value) => controller.updateDraftRow("envRows", index, field, value)
					}),
					!stdio && h(KeyValueEditor, {
						title: "请求头",
						hint: "例如 Authorization: Bearer <token>。值不会出现在状态栏里。",
						rows: draft.headerRows,
						error: errors.headers,
						keyPlaceholder: "Header",
						valuePlaceholder: "value",
						onAdd: () => controller.addDraftRow("headerRows"),
						onRemove: (index) => controller.removeDraftRow("headerRows", index),
						onChange: (index, field, value) => controller.updateDraftRow("headerRows", index, field, value)
					})
				)
			);
		}

		function JsonEditor({ controller, state }) {
			return h("div", { className: "mcpbar-form-card" },
				h("div", { className: "mcpbar-field" },
					h("div", { className: "mcpbar-json-head" },
						h("span", { className: "mcpbar-label" }, "服务器配置 JSON"),
						h("div", { className: "mcpbar-json-actions" },
							h("button", {
								type: "button",
								className: "mcpbar-btn mcpbar-btn-sm",
								onClick: () => controller.formatJson()
							}, "格式化")
						)
					),
					h("textarea", {
						className: "mcpbar-textarea mcpbar-textarea-mono mcpbar-json-editor",
						value: state.jsonText,
						spellCheck: false,
						placeholder: JSON_EXAMPLE,
						onChange: (event) => controller.setJsonText(event.target.value)
					}),
					h("p", { className: "mcpbar-hint" },
						"支持 { \"mcpServers\": { … } }、单个服务器对象或数组。粘贴多个服务器时保存会批量导入；env 与 headers 的值必须是字符串。"
					)
				)
			);
		}

		function ProbeCard({ controller, state, compact }) {
			const probe = state.probe ?? { phase: "idle" };
			if (probe.phase === "idle") {
				if (compact) return null;
				return h("div", { className: "mcpbar-detail-card mcpbar-probe-card", style: { marginTop: 12 } },
					h("h3", null, "连接测试"),
					h("p", { className: "mcpbar-hint" },
						"独立于运行中的客户端，发一次 initialize 和 tools/list，检查 Server 是否可用。"
					),
					h("button", {
						type: "button",
						className: "mcpbar-btn mcpbar-btn-sm",
						style: { marginTop: 8 },
						onClick: () => controller.runProbe()
					}, h(Icon, { name: "plug", size: 13 }), "开始测试")
				);
			}
			if (probe.phase === "running") {
				return h("div", { className: "mcpbar-probe mcpbar-probe-running" },
					h(Spinner, { size: 14 }),
					h("div", { className: "mcpbar-probe-main" }, "正在握手并读取工具列表…"),
					compact ? h("span", { className: "mcpbar-hint" }, "最长约 20 秒") : null
				);
			}
			if (probe.phase === "error") {
				return h("div", { className: "mcpbar-probe mcpbar-probe-error" },
					h(Icon, { name: "alert", size: 15 }),
					h("div", { className: "mcpbar-probe-main" },
						h("strong", null, probeHeadline(probe)),
						h("p", null, probe.error || "未知错误")
					),
					h("button", {
						type: "button",
						className: "mcpbar-btn mcpbar-btn-sm",
						onClick: () => controller.retryProbe()
					}, "重试")
				);
			}
			const result = probe.result ?? {};
			const tools = Array.isArray(result.tools) ? result.tools : [];
			return h("div", { className: "mcpbar-probe mcpbar-probe-ok" },
				h(Icon, { name: "check", size: 15 }),
				h("div", { className: "mcpbar-probe-main" },
					h("strong", null,
						`连接成功 · ${result.toolCount ?? tools.length} 个工具 · ${result.latencyMs ?? "—"} ms`
					),
					h("p", null,
						`${result.transport === "stdio" ? "stdio" : "HTTP"} · 协议 ${result.protocolVersion ?? "未知"}`
					),
					tools.length > 0 && h("details", { className: "mcpbar-tool-details" },
						h("summary", null, `查看探测到的 ${tools.length} 个工具`),
						h("div", { className: "mcpbar-tools mcpbar-tools-compact" },
							tools.map((tool) => h(ToolItem, { key: tool.publicName || tool.name, tool }))
						)
					)
				)
			);
		}

		function ToolItem({ tool }) {
			const schema = tool.inputSchema;
			const hasSchema = schema && typeof schema === "object" && Object.keys(schema).length > 0;
			const schemaText = hasSchema ? JSON.stringify(schema, null, 2) : "";
			return h("div", { className: "mcpbar-tool" },
				h("div", { className: "mcpbar-tool-head" },
					h("code", { className: "mcpbar-tool-name" }, tool.name || tool.publicName || "unknown"),
					hasSchema ? h("span", { className: "mcpbar-tool-schema-hint" }, "有输入参数") : null
				),
				tool.description ? h("p", { className: "mcpbar-tool-desc" }, tool.description) : null,
				hasSchema && h("details", { className: "mcpbar-tool-details" },
					h("summary", null, "查看输入 Schema"),
					h("pre", { className: "mcpbar-json" }, schemaText)
				)
			);
		}

		function FormView({ controller, state }) {
			if (state.draftLoading || !state.draft) {
				return h("div", { className: "mcpbar-form-card" },
					state.formError
						? h("div", { className: "mcpbar-notice mcpbar-notice-error" },
							h(Icon, { name: "alert", size: 15 }),
							h("span", { className: "mcpbar-notice-text" }, state.formError)
						)
						: h(SkeletonRows, { count: 2 })
				);
			}
			const draft = state.draft;
			const errors = state.fieldErrors ?? {};
			return h("div", { className: "mcpbar-form" },
				h("div", { className: "mcpbar-form-toolbar" },
					h("div", { className: "mcpbar-segmented" },
						h("button", {
							type: "button",
							"data-active": state.formTab === "form" ? "true" : "false",
							onClick: () => controller.setTab("form")
						}, "表单"),
						h("button", {
							type: "button",
							"data-active": state.formTab === "json" ? "true" : "false",
							onClick: () => controller.setTab("json")
						}, "JSON")
					),
					h("span", { className: "mcpbar-form-mode-hint" },
						state.formTab === "form" ? "逐项填写，适合大多数 Server" : "粘贴配置，可一次导入多个服务器")
				),
				state.formError && h("div", { className: "mcpbar-notice mcpbar-notice-error", role: "alert" },
					h(Icon, { name: "alert", size: 15 }),
					h("span", { className: "mcpbar-notice-text" }, state.formError)
				),
				state.formTab === "json"
					? h(JsonEditor, { controller, state })
					: h(FormFields, { controller, state, draft, errors }),
				state.probe.phase !== "idle" && h(ProbeCard, { controller, state, compact: true }),
				h("div", { className: "mcpbar-form-footer" },
					h("div", { className: "mcpbar-form-footer-left" },
						state.formTab === "form" && h("button", {
							type: "button",
							className: "mcpbar-btn",
							disabled: state.formBusy,
							onClick: () => controller.runProbe({ draft })
						},
							state.probe.phase === "running" ? h(Spinner, { size: 13 }) : h(Icon, { name: "plug", size: 14 }),
							"测试连接"
						)
					),
					h("div", { className: "mcpbar-form-footer-right" },
						h("button", {
							type: "button",
							className: "mcpbar-btn",
							disabled: state.formBusy,
							onClick: () => controller.goBack()
						}, "取消"),
						h("button", {
							type: "button",
							className: "mcpbar-btn mcpbar-btn-primary",
							disabled: state.formBusy,
							onClick: () => controller.saveForm()
						},
							state.formBusy ? h(Spinner, { size: 13 }) : null,
							state.formBusy ? "保存中…" : state.view === "edit" ? "保存并重新连接" : "保存并连接"
						)
					)
				)
			);
		}

		function DetailSkeleton() {
			return h("div", { className: "mcpbar-skeleton-list", style: { padding: 18 } },
				h("div", { className: "mcpbar-skeleton", style: { width: "32%", height: 14 } }),
				h("div", { className: "mcpbar-skeleton", style: { width: "64%", marginTop: 12 } }),
				h("div", { className: "mcpbar-skeleton", style: { width: "82%", marginTop: 8, height: 8 } })
			);
		}

		function DetailView({ controller, state }) {
			if (state.detailLoading) return h(DetailSkeleton);
			if (state.detailError) {
				return h("div", { className: "mcpbar-notice mcpbar-notice-error", role: "alert" },
					h(Icon, { name: "alert", size: 15 }),
					h("span", { className: "mcpbar-notice-text" }, state.detailError),
					h("button", {
						type: "button",
						className: "mcpbar-btn mcpbar-btn-sm",
						onClick: () => controller.openDetail(state.selectedId)
					}, "重试"),
					h("button", {
						type: "button",
						className: "mcpbar-btn mcpbar-btn-sm",
						onClick: () => controller.goBack()
					}, "返回列表")
				);
			}
			const detail = state.detail;
			if (!detail) return null;
			const server = detail.server ?? {};
			const tools = Array.isArray(detail.tools) ? detail.tools : [];
			const config = detail.config ?? {};
			const raw = state.showSecrets ? config : maskedConfig(config);
			const toggling = Boolean(state.toggling[server.id]);

			return h("div", { className: "mcpbar-detail" },
				h("div", { className: "mcpbar-detail-hero" },
					h("div", { className: "mcpbar-detail-ident" },
						h(StateDot, { state: server.state, size: "md" }),
						h("div", { className: "mcpbar-detail-sub" },
							h("span", { className: "mcpbar-tag" }, server.originLabel || "MCP Bar"),
							h("span", { className: `mcpbar-state-text mcpbar-state-${server.state}` }, stateLabel(server.state)),
							!server.enabled && h("span", { className: "mcpbar-tag mcpbar-tag-muted" }, "已停用")
						)
					),
					h("div", { className: "mcpbar-detail-actions-top" },
						server.canEdit && h("div", { className: "mcpbar-detail-toggle" },
							h(Switch, {
								checked: server.enabled,
								busy: toggling,
								label: `${server.enabled ? "停用" : "启用"} ${server.name}`,
								onChange: () => controller.toggleServer(server)
							}),
							h("span", null, server.enabled ? "已启用" : "已停用")
						),
						server.canTakeover && h("button", {
							type: "button",
							className: "mcpbar-btn mcpbar-btn-primary",
							onClick: () => controller.requestTakeover(server)
						}, "接管到 MCP Bar"),
						server.canEdit && h("button", {
							type: "button",
							className: "mcpbar-btn",
							onClick: () => controller.openEdit(server.id)
						}, h(Icon, { name: "edit", size: 14 }), "编辑"),
						server.canRemove && h("button", {
							type: "button",
							className: "mcpbar-btn mcpbar-btn-danger",
							onClick: () => controller.requestDelete(server)
						}, h(Icon, { name: "trash", size: 14 }), "删除")
					)
				),
				server.error && h("div", { className: "mcpbar-notice mcpbar-notice-error", role: "alert" },
					h(Icon, { name: "alert", size: 15 }),
					h("span", { className: "mcpbar-notice-text" }, server.error)
				),
				h("div", { className: "mcpbar-detail-grid" },
					h("div", { className: "mcpbar-detail-card" },
						h("h3", null, "端点"),
						h("code", { className: "mcpbar-code" }, server.endpoint || "—"),
						h("dl", { className: "mcpbar-kv" },
							h("div", null, h("dt", null, "传输"), h("dd", null, server.transportLabel)),
							h("div", null, h("dt", null, "超时"), h("dd", null, `${server.timeoutMs ?? DEFAULT_TIMEOUT} ms`)),
							h("div", null, h("dt", null, "来源"), h("dd", null, server.originLabel || "MCP Bar")),
							Array.isArray(server.envKeys) && server.envKeys.length > 0
								? h("div", null, h("dt", null, "环境变量"), h("dd", null, server.envKeys.join("、")))
								: null
						)
					),
					h("div", { className: "mcpbar-detail-card" },
						h("div", { className: "mcpbar-card-head" },
							h("h3", null, "工具"),
							h("span", { className: "mcpbar-count-pill" }, String(tools.length)),
							h("button", {
								type: "button",
								className: "mcpbar-btn mcpbar-btn-sm mcpbar-btn-ghost",
								disabled: state.probe.phase === "running",
								onClick: () => controller.runProbe({ id: server.id })
							},
								state.probe.phase === "running" ? h(Spinner, { size: 12 }) : h(Icon, { name: "plug", size: 13 }),
								"测试连接"
							)
						),
						tools.length === 0
							? h("p", { className: "mcpbar-hint" },
								server.state === "error"
									? "连接失败，尚未注册工具。修正配置或凭证后重新启用，或点“测试连接”定位问题。"
									: server.state === "pending"
										? "Server 已启用，仍在连接中。稍等几秒再刷新；也可以点“测试连接”独立检查。"
										: server.state === "disabled"
											? "Server 已停用，启用后会重新注册工具。"
											: "尚未注册工具。可以点“测试连接”检查 Server 是否可用。"
							)
							: h("div", { className: "mcpbar-tools" },
								tools.map((tool) => h(ToolItem, { key: tool.publicName || tool.name, tool }))
							)
					)
				),
				h(ProbeCard, { controller, state }),
				h("div", { className: "mcpbar-detail-card mcpbar-config-card" },
					h("div", { className: "mcpbar-card-head" },
						h("h3", null, "原始配置"),
						h("div", { className: "mcpbar-json-actions" },
							h("button", {
								type: "button",
								className: "mcpbar-btn mcpbar-btn-sm mcpbar-btn-ghost",
								onClick: () => controller.toggleSecrets()
							}, h(Icon, { name: state.showSecrets ? "eyeOff" : "eye", size: 13 }),
								state.showSecrets ? "隐藏敏感值" : "显示敏感值"),
							h("button", {
								type: "button",
								className: "mcpbar-btn mcpbar-btn-sm mcpbar-btn-ghost",
								onClick: () => controller.copy(JSON.stringify(config, null, 2))
							}, h(Icon, { name: "copy", size: 13 }), "复制")
						)
					),
					h("pre", { className: "mcpbar-json" }, JSON.stringify(raw, null, 2))
				),
				h("p", { className: "mcpbar-footnote" },
					server.origin === "profile"
						? "这条配置来自 profile 的 cordis.patch.yml。接管后会复制到 MCP Bar，原配置不会被改写。"
						: "配置保存在 MCP Bar 的独立存储中，启动时自动重建连接。"
				)
			);
		}

		function DialogView({ controller, state }) {
			const dialog = state.dialog;
			if (!dialog) return null;
			let title = "";
			let text = "";
			let confirmLabel = "确认";
			let danger = false;
			if (dialog.kind === "delete") {
				title = `删除「${dialog.name}」？`;
				text = dialog.nativeEntryId
					? "会移除 MCP Bar 保存的配置，并从当前会话注销它的工具；profile 中的原条目会重新启用。"
					: "会移除 MCP Bar 保存的配置，并从当前会话注销它的工具。";
				confirmLabel = "删除";
				danger = true;
			} else if (dialog.kind === "takeover") {
				title = `接管「${dialog.name}」？`;
				text = "会复制这份配置到 MCP Bar，并停用 profile 中的原条目。原配置文件不会被修改；删除接管记录会恢复它。";
				confirmLabel = "接管";
			} else {
				title = `接管 ${dialog.count} 个 Server？`;
				text = "它们会被逐一复制到 MCP Bar 并停用原条目，配置文件本身不会改动。";
				confirmLabel = "全部接管";
			}
			return h("div", {
				className: "mcpbar-dialog-backdrop",
				onClick: (event) => {
					if (event.target === event.currentTarget) controller.closeDialog();
				}
			},
				h("div", { className: "mcpbar-dialog", role: "dialog", "aria-modal": "true" },
					h("h2", null, title),
					h("p", null, text),
					dialog.kind === "takeoverAll" && h("p", { className: "mcpbar-hint" }, "接管会逐个连接，可能需要几十秒。"),
					state.dialogError && h("div", { className: "mcpbar-notice mcpbar-notice-error" },
						h(Icon, { name: "alert", size: 15 }),
						h("span", { className: "mcpbar-notice-text" }, state.dialogError)
					),
					h("div", { className: "mcpbar-dialog-actions" },
						h("button", {
							type: "button",
							className: "mcpbar-btn",
							disabled: state.dialogBusy,
							onClick: () => controller.closeDialog()
						}, "取消"),
						h("button", {
							type: "button",
							className: cx("mcpbar-btn", danger ? "mcpbar-btn-danger" : "mcpbar-btn-primary"),
							disabled: state.dialogBusy,
							onClick: () => controller.confirmDialog()
						},
							state.dialogBusy ? h(Spinner, { size: 13 }) : null,
							state.dialogBusy ? "处理中…" : confirmLabel
						)
					)
				)
			);
		}

		function View({ controller, state }) {
			if (state.view === "create" || state.view === "edit") return h(FormView, { controller, state });
			if (state.view === "detail") return h(DetailView, { controller, state });
			return h(ListView, { controller, state });
		}

		function McpPanel({ controller, presentation }) {
			const state = useController(controller);
			const overlay = presentation === "overlay";

			React.useEffect(() => {
				const onKeyDown = (event) => {
					if (event.key !== "Escape") return;
					if (state.dialog) {
						controller.closeDialog();
						return;
					}
					if (overlay) {
						controller.closeOverlay();
						return;
					}
					controller.goBack();
				};
				window.addEventListener("keydown", onKeyDown);
				return () => window.removeEventListener("keydown", onKeyDown);
			}, [controller, overlay, state.dialog]);

			return h("div", { className: cx("mcpbar-root", overlay ? "mcpbar-overlay-panel" : "mcpbar-main"), "data-view": state.view },
				h(Header, { controller, state, presentation }),
				h("div", { className: "mcpbar-body" },
					h("div", { className: "mcpbar-content" },
						state.notice && h(Notice, {
							notice: state.notice,
							onClose: () => controller.dismissNotice()
						}),
						h(View, { controller, state })
					)
				),
				state.dialog && h(DialogView, { controller, state })
			);
		}

		function McpOverlay({ controller }) {
			const state = useController(controller);
			if (!state.overlayOpen) return null;
			return h("div", {
				className: "mcpbar-overlay-backdrop",
				onMouseDown: (event) => {
					if (event.target === event.currentTarget) controller.closeOverlay();
				}
			}, h(McpPanel, { controller, presentation: "overlay" }));
		}
		//#endregion

		//#region 入口
		function apply(ctx) {
			try {
				const controller = createController(ctx);
				ctx.effect(() => installStyles(), "mcp-bar: styles");
				ctx.effect(() => controller.start(), "mcp-bar: polling");

				ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
					name: "conversation.input.dock",
					id: DOCK_ID,
					order: 10,
					inject: () => ({ controller })
				}, McpDock));

				ctx.slots.inject("main", () => ctx.slots.register({
					name: "main",
					key: PANEL_ID,
					inject: () => ({ controller, presentation: "panel" })
				}, McpPanel));

				ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
					name: "sidebar.panellist",
					id: PANEL_ID,
					order: 41,
					label: "MCP 服务器"
				}, McpSidebarIcon));

				ctx.slots.inject("shell.overlay", () => ctx.slots.register({
					name: "shell.overlay",
					id: `${PANEL_ID}-overlay`,
					order: 90,
					inject: () => ({ controller })
				}, McpOverlay));
			} catch (error) {
				console.error("[mcp-bar] client apply() failed:", error);
			}
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	}
});
