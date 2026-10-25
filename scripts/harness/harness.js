/**
 * UI harness：用最小实现模拟 DSH 的 slots / layout / ctx，把浏览器半区真正挂起来。
 *
 * 只为了视觉与交互验收，不追求与 DSH 内部实现逐行一致。
 */
(() => {
	const React = window.React;
	const ReactDOM = window.ReactDOM;
	const mod = window.__mcpBarModule;
	const root = document.getElementById("root");

	if (!React || !ReactDOM || !mod || typeof mod.apply !== "function") {
		root.textContent = "harness 初始化失败：React 或 client.js 未加载。";
		return;
	}

	const h = React.createElement;

	//#region slots / layout 模拟
	const slotEntries = new Map();
	const listeners = new Set();
	const disposers = [];
	let version = 0;
	let selectedPanel = null;
	let layoutBroken = false;

	function notify() {
		version += 1;
		for (const listener of [...listeners]) listener();
	}

	const slots = {
		inject(name, factory) {
			try {
				const dispose = factory();
				return () => dispose?.();
			} catch (error) {
				console.error(`[harness] inject "${name}" failed:`, error);
				return () => {};
			}
		},
		register(options, component) {
			const entry = { options, component };
			const next = [...(slotEntries.get(options.name) ?? []), entry];
			slotEntries.set(options.name, next);
			notify();
			return () => {
				const current = slotEntries.get(options.name) ?? [];
				if (!current.includes(entry)) return;
				slotEntries.set(options.name, current.filter((item) => item !== entry));
				notify();
			};
		},
		entries(name) {
			return [...(slotEntries.get(name) ?? [])];
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getSnapshot() {
			return version;
		}
	};

	const layout = {
		selectPanel(key) {
			if (layoutBroken) throw new Error("harness: layout 已被禁用（overlay 预览）");
			if (key === null) {
				selectedPanel = null;
				notify();
				return;
			}
			const exists = (slotEntries.get("main") ?? []).some((entry) => entry.options.key === key);
			if (!exists) throw new Error(`harness: main 槽位「${key}」尚未注册`);
			selectedPanel = key;
			notify();
		}
	};

	const ctx = {
		slots,
		layout,
		get(name) {
			return name === "layout" ? layout : undefined;
		},
		effect(fn) {
			try {
				const dispose = fn();
				if (typeof dispose === "function") disposers.push(dispose);
			} catch (error) {
				console.error("[harness] effect failed:", error);
			}
		},
		logger: {
			info: (...args) => console.info("[mcp-bar]", ...args),
			warn: (...args) => console.warn("[mcp-bar]", ...args)
		}
	};

	// 给截图脚本 / 控制台用的调试入口；只存在于 harness。
	window.__MCP_UI__ = {
		slots,
		layout,
		mock: window.__MCP_MOCK__ ?? null,
		get controller() {
			return findController();
		},
		get state() {
			return findController()?.getSnapshot() ?? null;
		},
		showPanel() {
			layoutBroken = false;
			layout.selectPanel("mcp-bar");
		},
		showConversation() {
			layoutBroken = false;
			layout.selectPanel(null);
		},
		openCreate(tab = "form") {
			layoutBroken = false;
			layout.selectPanel("mcp-bar");
			const controller = findController();
			controller.openCreate({ tab });
			return controller.getSnapshot();
		},
		openCreateJson(text) {
			const controller = findController();
			this.openCreate("json");
			if (text) controller.setJsonText(text);
			return controller.getSnapshot();
		},
		openEdit(id) {
			layoutBroken = false;
			layout.selectPanel("mcp-bar");
			return findController().openEdit(id);
		},
		openDetail(id, probe = false) {
			layoutBroken = false;
			layout.selectPanel("mcp-bar");
			return findController().openDetail(id, { probe });
		},
		openOverlay() {
			layoutBroken = true;
			findController().openPanel();
		},
		closeOverlay() {
			findController().closeOverlay();
		},
		goBack() {
			findController().goBack();
		},
		setTheme(theme) {
			document.documentElement.setAttribute("data-theme", theme === "dark" ? "dark" : "light");
		}
	};

	window.addEventListener("beforeunload", () => {
		for (const dispose of disposers.reverse()) {
			try {
				dispose();
			} catch {
				// 忽略卸载期错误。
			}
		}
	});

	mod.apply(ctx);
	//#endregion

	const noopSubscribe = () => () => {};
	const noopSnapshot = () => null;

	function useSlotVersion() {
		return React.useSyncExternalStore(slots.subscribe, slots.getSnapshot);
	}

	function useMcpState(controller) {
		return React.useSyncExternalStore(
			controller?.subscribe ?? noopSubscribe,
			controller?.getSnapshot ?? noopSnapshot
		);
	}

	function findMainEntry() {
		const entries = slots.entries("main");
		return entries.find((entry) => entry.options.key === selectedPanel) ?? null;
	}

	function findController() {
		const main = slots.entries("main")[0];
		if (main?.options.inject) return main.options.inject().controller;
		return null;
	}

	function Sidebar({ controller, state }) {
		const counts = state?.counts;
		const tone = counts?.error > 0 ? "error" : counts?.pending > 0 ? "pending" : "ok";
		return h("aside", { className: "sidebar" },
			h("div", { className: "brand" },
				h("span", { className: "brand-mark" }, "D"),
				h("span", null, "DeepSeek Harness")
			),
			h("button", { className: "new-chat", type: "button" },
				h("span", { "aria-hidden": "true" }, "+"),
				"新对话"
			),
			h("div", { className: "nav-label" }, "工作区"),
			h("nav", { className: "nav" },
				h("button", {
					type: "button",
					className: `nav-item${selectedPanel === null ? " active" : ""}`,
					onClick: () => layout.selectPanel(null)
				},
					h("span", { className: "nav-icon" }, h(Icon, { name: "chat" })),
					"对话"
				),
				h("button", {
					type: "button",
					className: `nav-item${selectedPanel === "mcp-bar" ? " active" : ""}`,
					onClick: () => layout.selectPanel("mcp-bar")
				},
					h("span", { className: "nav-icon" }, h(Icon, { name: "hub" })),
					h("span", { className: "nav-text" }, "MCP 服务器"),
					counts
						? h("span", { className: `nav-badge nav-badge-${tone}` },
							counts.error > 0 ? `${counts.total} · ${counts.error} 异常` : String(counts.total))
						: null
				)
			),
			h("div", { className: "sidebar-spacer" }),
			h("div", { className: "sidebar-foot" },
				"MCP Bar UI harness",
				h("br"),
				"mock 宿主 · 不写真实配置"
			)
		);
	}

	function Conversation() {
		return h("div", { className: "conversation" },
			h("div", { className: "conv-head" },
				h("h1", null, "下午好，Tanggang"),
				h("p", null,
					"这个页面是 MCP Bar 的视觉验收环境。对话页不注入任何常驻 UI，",
					"管理面板从侧边栏「MCP 服务器」进入。"
				)
			),
			h("div", { className: "composer" },
				h("div", { className: "inputbar" },
					h("span", { className: "inputbar-placeholder" }, "给 DeepSeek Harness 发消息…"),
					h("span", { className: "inputbar-hint" }, "⌘ ↵"),
					h("button", { className: "inputbar-send", type: "button", "aria-label": "发送" }, "↑")
				)
			)
		);
	}

	function Icon({ name = "hub", size = 16 }) {
		const paths = {
			hub: [
				"M12 3v4",
				"M12 17v4",
				"M3 12h4",
				"M17 12h4",
				"M6.3 6.3l2.8 2.8",
				"M14.9 14.9l2.8 2.8",
				"M17.7 6.3l-2.8 2.8",
				"M9.1 14.9l-2.8 2.8"
			],
			chat: [
				"M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v7a2.5 2.5 0 0 1-2.5 2.5H9l-4 4v-4.2A2.5 2.5 0 0 1 4 12.5z"
			]
		};
		return h("svg", {
			width: size,
			height: size,
			viewBox: "0 0 24 24",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 1.7,
			strokeLinecap: "round",
			strokeLinejoin: "round",
			"aria-hidden": "true"
		}, (paths[name] ?? paths.hub).map((d, index) => h("path", { key: index, d })));
	}

	function Chrome({ controller, state }) {
		const [dark, setDark] = React.useState(
			document.documentElement.getAttribute("data-theme") === "dark"
		);
		const [overlayMode, setOverlayMode] = React.useState(layoutBroken);
		const toggleTheme = () => {
			const next = !dark;
			setDark(next);
			document.documentElement.setAttribute("data-theme", next ? "dark" : "light");
		};
		const toggleOverlay = () => {
			const next = !overlayMode;
			setOverlayMode(next);
			layoutBroken = next;
			if (!next) {
				controller?.closeOverlay();
				layout.selectPanel("mcp-bar");
			}
		};
		const reset = () => {
			window.__MCP_MOCK__?.reset();
			window.location.reload();
		};
		const title = selectedPanel === "mcp-bar" ? "MCP 服务器" : "对话";
		return h("header", { className: "chrome" },
			h("div", { className: "chrome-title" }, "harness / ", h("strong", null, title)),
			state?.counts
				? h("span", { className: "chrome-stat" },
					`${state.counts.connected}/${state.counts.enabled} 已连接 · ${state.counts.tools} 工具`)
				: null,
			h("div", { className: "chrome-actions" },
				h("button", {
					type: "button",
					className: `chrome-btn${overlayMode ? " chrome-btn-on" : ""}`,
					onClick: toggleOverlay,
					title: "禁用 layout.selectPanel，验证 shell.overlay 回退"
				}, overlayMode ? "Overlay 模式" : "面板模式"),
				h("button", { type: "button", className: "chrome-btn", onClick: reset }, "重置数据"),
				h("button", { type: "button", className: "chrome-btn", onClick: toggleTheme }, dark ? "浅色" : "深色")
			)
		);
	}

	function App() {
		useSlotVersion();
		const controller = findController();
		const state = useMcpState(controller);
		const mainEntry = findMainEntry();
		const overlayEntries = slots.entries("shell.overlay");

		return h(React.Fragment, null,
			h("div", { className: "shell" },
				h(Sidebar, { controller, state }),
				h("main", { className: "center" },
					h(Chrome, { controller, state }),
					mainEntry
						? h("div", { className: "main-panel" },
							h(mainEntry.component, {
								key: mainEntry.options.key,
								...(mainEntry.options.inject ? mainEntry.options.inject() : {})
							})
						)
						: h(Conversation)
				)
			),
			overlayEntries.map((entry) => {
				const props = entry.options.inject ? entry.options.inject() : {};
				return h(entry.component, { key: entry.options.id ?? "overlay", ...props });
			})
		);
	}

	ReactDOM.createRoot(root).render(h(App));

	// 首屏直接进入面板，省一次点击；需要看对话态时点侧栏「对话」。
	setTimeout(() => {
		try {
			layout.selectPanel("mcp-bar");
		} catch (error) {
			console.warn("[harness] initial selectPanel failed:", error);
		}
	}, 0);
})();
