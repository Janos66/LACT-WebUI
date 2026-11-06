/** LACT WebUI front-end bootstrap: session handling, sidebar, routing, live updates, apply/revert. */

import { api, ApiError, download, setUnauthorizedHandler } from "./api.js";
import { clone, el, fmt, icon } from "./dom.js";
import { deviceLabel, isDirty, recordHistory, resetHistory, set, state, subscribe } from "./store.js";
import { badge, button, confirmDialog, emptyState, modal, promptDialog, section, selectControl, spinner, toast } from "./ui.js";

import chartsPage from "./pages/charts.js";
import displaysPage from "./pages/displays.js";
import infoPage from "./pages/info.js";
import ocPage from "./pages/oc.js";
import softwarePage from "./pages/software.js";
import systemPage from "./pages/system.js";
import thermalsPage from "./pages/thermals.js";

const PAGES = [infoPage, ocPage, thermalsPage, softwarePage, displaysPage, systemPage, chartsPage];

const dom = {
  app: document.getElementById("app"),
  login: document.getElementById("login"),
  loginForm: document.getElementById("login-form"),
  loginPassword: document.getElementById("login-password"),
  loginError: document.getElementById("login-error"),
  nav: document.getElementById("nav"),
  page: document.getElementById("page"),
  pageTitle: document.getElementById("page-title"),
  apply: document.getElementById("apply-button"),
  revert: document.getElementById("revert-button"),
  dirtyDot: document.getElementById("dirty-dot"),
  banner: document.getElementById("banner"),
  bannerText: document.getElementById("banner-text"),
  bannerAction: document.getElementById("banner-action"),
  devicePicker: document.getElementById("device-picker"),
  deviceButton: document.getElementById("device-picker-button"),
  deviceLabel: document.getElementById("device-picker-label"),
  devicePopover: document.getElementById("device-picker-popover"),
  profileButton: document.getElementById("profile-picker-button"),
  profileLabel: document.getElementById("profile-picker-label"),
  profilePopover: document.getElementById("profile-picker-popover"),
  menuButton: document.getElementById("menu-button"),
  menu: document.getElementById("menu"),
  chartsButton: document.getElementById("charts-button"),
  version: document.getElementById("webui-version"),
};

let currentPage = null;
let renderToken = 0;
let socket = null;
let socketRetry = 0;
let pollTimer = null;
let refreshInterval = Number(localStorage.getItem("lact.refresh") || 1000);
let theme = localStorage.getItem("lact.theme") || "dark";

// ------------------------------------------------------------------------------ boot

setUnauthorizedHandler(() => {
  showLogin();
});

dom.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  dom.loginError.textContent = "";

  try {
    await api.login(dom.loginPassword.value);
    dom.loginPassword.value = "";
    await start();
  } catch (error) {
    dom.loginError.textContent = error.message || "login failed";
  }
});

document.title = "LACT";

applyTheme(theme);
void boot();

async function boot() {
  try {
    const session = await api.session();
    if (session.auth_required && !session.authenticated) {
      showLogin();
      return;
    }
    await start();
  } catch (error) {
    showLogin();
    if (!(error instanceof ApiError) || error.status !== 401) {
      dom.loginError.textContent = error.message;
    }
  }
}

function showLogin() {
  dom.app.hidden = true;
  dom.login.hidden = false;
  dom.loginPassword?.focus();
  socket?.close();
  stopPolling();
}

function hideLogin() {
  dom.login.hidden = true;
  dom.app.hidden = false;
}

async function start() {
  hideLogin();

  const status = await api.status().catch(() => null);
  set({ status, webuiVersion: status?.webui_version, daemonConnected: status?.daemon_connected ?? false });

  const devices = await api.devices().catch(() => []);
  set({ devices });

  const stored = localStorage.getItem("lact.device");
  const deviceId = devices.find((device) => device.id === stored)?.id || devices[0]?.id || null;

  // Deep links win over the last-used page: `#thermals` opens the thermals page directly.
  const hashPage = location.hash.replace("#", "");
  const storedPage = localStorage.getItem("lact.page") || "info";
  const pageId = PAGES.some((page) => page.id === hashPage) ? hashPage : storedPage;
  set({ pageId: PAGES.some((page) => page.id === pageId) ? pageId : "info" });

  buildNav();
  wireChrome();

  if (deviceId) {
    set({ deviceId });
    await loadDevice(deviceId);
  } else {
    set({ deviceId: null });
    renderNoDevices();
  }

  connectSocket();
  updateChrome();
}

async function logout() {
  await api.logout().catch(() => {});
  set({ authenticated: false, deviceId: null, info: null, config: null, draft: null });
  showLogin();
}

// ------------------------------------------------------------------------------ data

async function loadDevice(id) {
  const [info, infoRows, stats, config, profiles, status] = await Promise.all([
    api.device.info(id).catch(() => null),
    api.device.infoRows(id).catch(() => []),
    api.device.stats(id).catch(() => null),
    api.device.config(id).catch(() => null),
    api.profiles.list(true).catch(() => null),
    api.status().catch(() => state.status),
  ]);

  const draft = config || defaultConfig();

  resetHistory();
  recordHistory(stats);

  set({
    info,
    infoRows: infoRows || [],
    stats,
    config: config ? clone(config) : null,
    draft: clone(draft),
    profiles,
    activeProfile: profiles?.current_profile ?? null,
    status,
    daemonConnected: status?.daemon_connected ?? state.daemonConnected,
  });

  await renderPage();
  updateChrome();
}

function defaultConfig() {
  return {
    fan_control_enabled: false,
    fan_control_settings: null,
    pmfw_options: {},
    nvidia_thermal_options: {},
    power_mizer_mode: null,
    power_cap: null,
    performance_level: null,
    power_profile_mode_index: null,
    custom_power_profile_mode_hueristics: [],
    power_states: {},
    uma_carveout: null,
  };
}

// ------------------------------------------------------------------------------ websocket

function connectSocket() {
  socket?.close();

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/api/ws`);

  socket.addEventListener("open", () => {
    socketRetry = 0;
    stopPolling();
    if (state.deviceId) {
      socket.send(JSON.stringify({ type: "select", id: state.deviceId }));
    }
    socket.send(JSON.stringify({ type: "interval", ms: refreshInterval }));
  });

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === "stats") {
      set({ stats: message.stats, daemonConnected: true }, "stats");
      recordHistory(message.stats);
      currentPage?.onStats?.(message.stats);
      updateBanner();
    } else if (message.type === "daemon") {
      set({ daemonConnected: message.connected }, "daemon");
      updateBanner();
    } else if (message.type === "hello") {
      set({ daemonConnected: message.daemon_connected }, "hello");
      updateBanner();
    } else if (message.type === "error") {
      set({ daemonConnected: message.daemon_connected !== false }, "error");
      updateBanner();
    }
  });

  socket.addEventListener("close", () => {
    socketRetry += 1;
    const delay = Math.min(1000 * 2 ** socketRetry, 15000);
    setTimeout(() => {
      if (!dom.app.hidden) connectSocket();
    }, delay);
    startPolling();
  });
}

/** Fall back to HTTP polling when the websocket cannot be established (proxies, older browsers). */
function startPolling() {
  if (pollTimer || !state.deviceId) return;

  pollTimer = setInterval(async () => {
    if (socket && socket.readyState === WebSocket.OPEN) return;
    try {
      const stats = await api.device.stats(state.deviceId);
      set({ stats, daemonConnected: true }, "stats");
      recordHistory(stats);
      currentPage?.onStats?.(stats);
      updateBanner();
    } catch {
      set({ daemonConnected: false }, "daemon");
      updateBanner();
    }
  }, Math.max(refreshInterval, 1000));
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

// ------------------------------------------------------------------------------ chrome

function buildNav() {
  dom.nav.replaceChildren(
    ...PAGES.map((page) => {
      const item = el(
        "button",
        { class: `nav-item${page.id === state.pageId ? " active" : ""}`, type: "button", "data-page": page.id },
        icon(page.icon),
        el("span", {}, page.title),
      );
      item.addEventListener("click", () => navigate(page.id));
      return item;
    }),
  );
}

let chromeWired = false;
function wireChrome() {
  if (chromeWired) return;
  chromeWired = true;

  dom.apply.addEventListener("click", () => applyChanges());
  dom.revert.addEventListener("click", () => revertChanges());
  dom.chartsButton.addEventListener("click", () => navigate("charts"));
  dom.menuButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleMenu();
  });

  dom.deviceButton.addEventListener("click", (event) => {
    event.stopPropagation();
    togglePopover(dom.devicePopover, buildDeviceList);
  });

  dom.profileButton.addEventListener("click", (event) => {
    event.stopPropagation();
    togglePopover(dom.profilePopover, buildProfileList);
  });

  document.addEventListener("click", () => {
    dom.devicePopover.hidden = true;
    dom.profilePopover.hidden = true;
    dom.menu.hidden = true;
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      dom.devicePopover.hidden = true;
      dom.profilePopover.hidden = true;
      dom.menu.hidden = true;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      if (!dom.apply.disabled) applyChanges();
    }
  });

  subscribe((reason) => {
    if (reason === "stats" || reason === "daemon" || reason === "hello") updateBanner();
  });
}

function navigate(pageId) {
  if (!PAGES.some((page) => page.id === pageId)) return;
  set({ pageId });
  localStorage.setItem("lact.page", pageId);

  // Keep the address bar in sync so pages can be bookmarked and shared.
  if (location.hash.replace("#", "") !== pageId) {
    history.replaceState(null, "", `#${pageId}`);
  }

  buildNav();
  renderPage();
}

window.addEventListener("hashchange", () => {
  const pageId = location.hash.replace("#", "");
  if (pageId && pageId !== state.pageId) navigate(pageId);
});

async function renderPage() {
  const page = PAGES.find((entry) => entry.id === state.pageId) || infoPage;
  const token = ++renderToken;

  dom.pageTitle.textContent = page.title;
  dom.page.replaceChildren(el("div", { class: "empty-state" }, spinner()));

  if (!state.deviceId) {
    renderNoDevices();
    return;
  }

  try {
    const result = await page.render(makeContext());
    if (token !== renderToken) return;

    const root = result?.root ?? result;
    dom.page.replaceChildren(root);
    currentPage = { page, onStats: result?.onStats ?? null };
  } catch (error) {
    if (token !== renderToken) return;
    console.error(error);
    dom.page.replaceChildren(
      emptyState(`Could not load this page: ${error.message}`, "warning"),
    );
    currentPage = null;
  }

  updateChrome();
}

function renderNoDevices() {
  dom.page.replaceChildren(
    emptyState(
      state.daemonConnected
        ? "The daemon reports no supported GPUs."
        : "Waiting for the LACT daemon. Is lactd running?",
      "gauge",
    ),
  );
}

function makeContext() {
  return {
    state,
    deviceId: state.deviceId,
    devices: state.devices,
    get info() {
      return state.info;
    },
    get stats() {
      return state.stats;
    },
    get config() {
      return state.draft;
    },
    edit(mutator) {
      if (!state.draft) state.draft = defaultConfig();
      mutator(state.draft);
      updateChrome();
    },
    editHistory(mutator) {
      mutator(state.history);
    },
    async refresh() {
      if (state.deviceId) await loadDevice(state.deviceId);
    },
    rerender() {
      renderPage();
    },
    navigate,
    toast,
  };
}

function updateChrome() {
  const dirty = isDirty();
  dom.apply.disabled = !dirty;
  dom.revert.disabled = !dirty;
  dom.dirtyDot.hidden = !dirty;

  const device = state.devices.find((entry) => entry.id === state.deviceId);
  dom.deviceLabel.textContent = device ? deviceLabel(device) : "No devices";
  dom.profileLabel.textContent = state.activeProfile || "Profiles";
  dom.version.textContent = state.status?.webui_version ? `v${state.status.webui_version}` : "";

  updateBanner();
}

function updateBanner() {
  const info = state.info;

  if (!state.daemonConnected) {
    showBanner("Reconnecting to the LACT daemon…", "error", "Retry", async () => {
      const status = await api.status().catch(() => null);
      set({ status, daemonConnected: status?.daemon_connected ?? false });
      if (state.daemonConnected) {
        updateBanner();
        await loadDevice(state.deviceId);
        connectSocket();
      }
    });
    return;
  }

  const overdriveDisabled = state.status?.daemon?.amdgpu_overdrive_enabled === false && info?.driver === "amdgpu";
  if (overdriveDisabled) {
    showBanner("AMD overclocking is disabled in the kernel.", "", "Enable overdrive", async () => {
      try {
        await api.overdrive.enable();
        toast("Overdrive enabled — a reboot may be required", "success");
        await loadDevice(state.deviceId);
      } catch (error) {
        toast(error.message, "error");
      }
    });
    return;
  }

  dom.banner.hidden = true;
}

function showBanner(text, kind = "", actionLabel = "", action = null) {
  dom.banner.hidden = false;
  dom.banner.classList.toggle("error", kind === "error");
  dom.bannerText.textContent = text;

  if (actionLabel && action) {
    dom.bannerAction.hidden = false;
    dom.bannerAction.textContent = actionLabel;
    dom.bannerAction.onclick = action;
  } else {
    dom.bannerAction.hidden = true;
    dom.bannerAction.onclick = null;
  }
}

// ------------------------------------------------------------------------------ apply / revert

async function applyChanges() {
  if (!state.deviceId || !isDirty()) return;

  dom.apply.disabled = true;

  try {
    const response = await api.device.setConfig(state.deviceId, state.draft);
    const autoRevert = Number(response?.auto_revert_ms ?? 0);

    if (autoRevert > 0) {
      promptConfirmation(autoRevert);
    } else {
      toast("Settings applied", "success");
    }

    set({ config: clone(state.draft) });
    updateChrome();
  } catch (error) {
    toast(error.message, "error");
    updateChrome();
  }
}

/**
 * After applying, the daemon waits for a confirmation and reverts the change if it does not arrive.
 * This mirrors the GTK app's "keep settings?" flow.
 */
function promptConfirmation(autoRevertMs) {
  let remaining = Math.ceil(autoRevertMs / 1000);
  let settled = false;

  const countdown = el("b", {}, `${remaining}s`);
  const body = el("div", { class: "stack" },
    el("div", {}, "The settings were applied. If they are not confirmed, the daemon reverts them automatically in ", countdown, "."),
    el("div", { class: "hint" }, "A bad overclock can make the screen go dark or the system unstable."),
  );

  const dialog = modal({
    title: "Keep the new settings?",
    body,
    onClose: () => {},
    actions: [
      {
        label: "Revert",
        onClick: async () => {
          settled = true;
          clearInterval(timer);
          await api.device.confirmConfig(state.deviceId, "revert").catch(() => {});
          toast("Settings reverted", "warning");
          await loadDevice(state.deviceId);
        },
      },
      {
        label: "Keep settings",
        kind: "suggested",
        onClick: async () => {
          settled = true;
          clearInterval(timer);
          await api.device.confirmConfig(state.deviceId, "confirm").catch(() => {});
          toast("Settings saved", "success");
          await loadDevice(state.deviceId);
        },
      },
    ],
  });

  const timer = setInterval(() => {
    if (settled) return;
    remaining -= 1;
    countdown.textContent = `${Math.max(remaining, 0)}s`;

    if (remaining <= 0) {
      clearInterval(timer);
      settled = true;
      dialog.close();
      toast("Settings were not confirmed and have been reverted", "warning");
      loadDevice(state.deviceId);
    }
  }, 1000);
}

async function revertChanges() {
  if (!state.deviceId) return;

  if (isDirty()) {
    const ok = await confirmDialog({
      title: "Discard changes?",
      message: "All unsaved changes on every page will be discarded.",
      confirmLabel: "Discard",
      destructive: true,
    });
    if (!ok) return;
  }

  await loadDevice(state.deviceId);
  toast("Changes discarded", "info", 2000);
}

// ------------------------------------------------------------------------------ popovers

function togglePopover(popover, builder) {
  const willShow = popover.hidden;
  dom.devicePopover.hidden = true;
  dom.profilePopover.hidden = true;
  dom.menu.hidden = true;

  if (willShow) {
    builder(popover);
    popover.hidden = false;
  }
}

function buildDeviceList(popover) {
  popover.replaceChildren(
    ...state.devices.map((device) =>
      el(
        "div",
        {
          class: `popover-item${device.id === state.deviceId ? " selected" : ""}`,
          onClick: async () => {
            popover.hidden = true;
            if (device.id === state.deviceId) return;
            localStorage.setItem("lact.device", device.id);
            set({ deviceId: device.id });
            await loadDevice(device.id);
            connectSocket();
          },
        },
        el("span", {}, deviceLabel(device)),
        icon("check", "icon-small check"),
      ),
    ),
  );

  if (state.devices.length === 0) {
    popover.replaceChildren(el("div", { class: "popover-item" }, "No devices"));
  }
}

function buildProfileList(popover) {
  const profiles = state.profiles?.profiles ? Object.keys(state.profiles.profiles) : [];

  const items = [
    ...profiles.map((name) =>
      el(
        "div",
        {
          class: `popover-item${name === state.activeProfile ? " selected" : ""}`,
          onClick: async () => {
            popover.hidden = true;
            try {
              await api.profiles.activate(name, state.profiles?.auto_switch ?? false);
              toast(`Profile “${name}” activated`, "success");
              await loadDevice(state.deviceId);
            } catch (error) {
              toast(error.message, "error");
            }
          },
        },
        el("span", {}, name),
        icon("check", "icon-small check"),
      ),
    ),
    el("div", { class: "menu-separator" }),
    el(
      "div",
      {
        class: "popover-item",
        onClick: async () => {
          popover.hidden = true;
          await createProfile();
        },
      },
      icon("plus", "icon-small"),
      el("span", {}, "New profile…"),
    ),
  ];

  if (profiles.length === 0) {
    items.unshift(el("div", { class: "popover-item" }, el("span", { class: "muted" }, "No profiles yet")));
  }

  popover.replaceChildren(...items);
}

async function createProfile() {
  const name = await promptDialog({
    title: "New profile",
    message: "Profiles store a full GPU configuration and can be activated manually or by rule.",
    placeholder: "e.g. Gaming",
    confirmLabel: "Create",
  });

  if (!name) return;

  try {
    await api.profiles.create(name, { current: state.deviceId });
    toast(`Profile “${name}” created`, "success");
    await loadDevice(state.deviceId);
  } catch (error) {
    toast(error.message, "error");
  }
}

// ------------------------------------------------------------------------------ menu

function toggleMenu() {
  const willShow = dom.menu.hidden;
  dom.menu.hidden = true;

  if (!willShow) return;

  const items = [
    ["Process monitor", "gauge", showProcesses],
    null,
    ["Generate debug snapshot", "download", downloadSnapshot],
    ["Dump VBIOS", "package", dumpVbios],
    null,
    ["Preferences", "server", showPreferences],
    ["About", "info", showAbout],
    ["Sign out", "logout", logout],
  ];

  dom.menu.replaceChildren(
    ...items.map((item) => {
      if (item === null) return el("div", { class: "menu-separator" });

      const [label, iconName, handler] = item;
      return el(
        "button",
        {
          class: `menu-item${label === "Sign out" ? " danger" : ""}`,
          type: "button",
          onClick: () => {
            dom.menu.hidden = true;
            handler();
          },
        },
        icon(iconName),
        el("span", {}, label),
      );
    }),
  );

  dom.menu.hidden = false;
}

async function downloadSnapshot() {
  try {
    const response = await api.snapshot();
    await download(response, "lact-snapshot.tar.gz");
    toast("Debug snapshot downloaded", "success");
  } catch (error) {
    toast(error.message, "error");
  }
}

async function dumpVbios() {
  if (!state.deviceId) return;
  try {
    const response = await api.request(api.device.vbiosUrl(state.deviceId), { method: "POST", raw: true });
    await download(response, `vbios-${state.deviceId}.bin`);
    toast("VBIOS downloaded", "success");
  } catch (error) {
    toast(error.message, "error");
  }
}

function showProcesses() {
  if (!state.deviceId) {
    toast("Select a GPU first", "warning");
    return;
  }

  const body = el("div", {}, spinner());
  const dialog = modal({
    title: "Process monitor",
    body,
    wide: true,
    onClose: () => clearInterval(timer),
    actions: [{ label: "Close", kind: "suggested" }],
  });

  const timer = setInterval(load, 2000);
  load();

  async function load() {
    try {
      const data = await api.device.processes(state.deviceId);
      const processes = Object.entries(data.processes || {});

      if (processes.length === 0) {
        body.replaceChildren(emptyState("No processes are using this GPU.", "gauge"));
        return;
      }

      body.replaceChildren(
        el("div", { class: "table-wrap" },
          el("table", { class: "table" },
            el("thead", {}, el("tr", {},
              el("th", {}, "PID"), el("th", {}, "Process"), el("th", {}, "Type"),
              el("th", { class: "num" }, "Memory"), el("th", { class: "num" }, "Usage"),
            )),
            el("tbody", {},
              processes.map(([pid, proc]) => {
                const usage = Object.entries(proc.util || {})
                  .map(([kind, value]) => `${kind} ${value}%`)
                  .join(", ");

                return el("tr", {},
                  el("td", { class: "mono" }, pid),
                  el("td", {},
                    el("div", {}, proc.name),
                    el("div", { class: "hint", style: { maxWidth: "380px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, proc.args || ""),
                  ),
                  el("td", {}, (proc.types || []).join(", ")),
                  el("td", { class: "num" }, fmt.bytes(proc.memory_used)),
                  el("td", { class: "num" }, usage || "—"),
                );
              }),
            ),
          ),
        ),
      );
    } catch (error) {
      body.replaceChildren(emptyState(error.message, "warning"));
    }
  }

  void dialog;
}

function showPreferences() {
  const themeSelect = selectControl({
    options: [
      { value: "dark", label: "Dark" },
      { value: "light", label: "Light" },
    ],
    value: theme,
    onChange: (value) => {
      theme = value;
      localStorage.setItem("lact.theme", value);
      applyTheme(value);
    },
  });

  const intervalSelect = selectControl({
    options: [
      { value: "500", label: "2 samples/s" },
      { value: "1000", label: "1 sample/s" },
      { value: "2000", label: "1 sample every 2s" },
      { value: "5000", label: "1 sample every 5s" },
    ],
    value: String(refreshInterval),
    onChange: (value) => {
      refreshInterval = Number(value);
      localStorage.setItem("lact.refresh", value);
      socket?.send(JSON.stringify({ type: "interval", ms: refreshInterval }));
    },
  });

  modal({
    title: "Preferences",
    body: el("div", { class: "stack" },
      el("div", { class: "row" },
        el("div", { class: "row-label" },
          el("span", { class: "row-title" }, "Theme"),
          el("span", { class: "row-subtitle" }, "Stored in this browser"),
        ),
        el("div", { class: "row-control" }, themeSelect),
      ),
      el("div", { class: "row" },
        el("div", { class: "row-label" },
          el("span", { class: "row-title" }, "Statistics interval"),
          el("span", { class: "row-subtitle" }, "How often the daemon is polled"),
        ),
        el("div", { class: "row-control" }, intervalSelect),
      ),
      el("div", { class: "row" },
        el("div", { class: "row-label" },
          el("span", { class: "row-title" }, "Keyboard shortcut"),
          el("span", { class: "row-subtitle" }, "Apply pending changes"),
        ),
        el("div", { class: "row-control mono" }, "Ctrl + Enter"),
      ),
      el("div", { class: "row" },
        el("div", { class: "row-label" },
          el("span", { class: "row-title" }, "Session"),
          el("span", { class: "row-subtitle" }, `${state.status?.sessions ?? "?"} active session(s), timeout ${state.status?.session_timeout ?? "?"}`),
        ),
      ),
    ),
    actions: [{ label: "Done", kind: "suggested" }],
  });
}

function showAbout() {
  modal({
    title: "About LACT WebUI",
    body: el("div", { class: "stack" },
      el("div", {}, "A headless web front-end for the Linux GPU Control Application."),
      el("div", { class: "row" },
        el("div", { class: "row-label" }, el("span", { class: "row-title" }, "Web UI version")),
        el("div", { class: "row-control mono" }, state.status?.webui_version ?? "—"),
      ),
      el("div", { class: "row" },
        el("div", { class: "row-label" }, el("span", { class: "row-title" }, "Daemon version")),
        el("div", { class: "row-control mono" }, state.status?.daemon?.version ?? "—"),
      ),
      el("div", { class: "row" },
        el("div", { class: "row-label" }, el("span", { class: "row-title" }, "Hostname")),
        el("div", { class: "row-control mono" }, state.status?.hostname ?? "—"),
      ),
      el("div", { class: "hint" },
        "Based on LACT by Ilya Zlobintsev (MIT). The GTK interface was replaced by this web UI; ",
        "the daemon and its hardware support are unchanged.",
      ),
    ),
    actions: [
      {
        label: "Open upstream",
        onClick: () => window.open("https://github.com/ilya-zlobintsev/LACT", "_blank", "noopener"),
      },
      { label: "Close", kind: "suggested" },
    ],
  });
}

function applyTheme(value) {
  document.documentElement.dataset.theme = value;
}

// Keep the page title in sync when the user reloads a page through the browser.
window.addEventListener("beforeunload", () => {
  socket?.close();
});

void badge;
void section;
