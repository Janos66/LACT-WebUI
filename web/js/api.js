/** HTTP client for the LACT WebUI API. */

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = "not logged in") {
    super(401, message);
    this.name = "UnauthorizedError";
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

async function request(path, { method = "GET", body, headers = {}, raw = false } = {}) {
  const options = {
    method,
    credentials: "same-origin",
    headers: { ...headers },
  };

  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  // Mutating requests must carry this header; it also defeats form-based CSRF.
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    options.headers["X-LACT-WebUI"] = "1";
  }

  let response;
  try {
    response = await fetch(path, options);
  } catch (error) {
    throw new ApiError(0, `network error: ${error.message}`);
  }

  if (response.status === 401) {
    onUnauthorized();
    throw new UnauthorizedError();
  }

  if (raw) {
    if (!response.ok) throw new ApiError(response.status, await response.text());
    return response;
  }

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text();

  if (!response.ok) {
    const message =
      (payload && typeof payload === "object" && payload.error) ||
      (typeof payload === "string" && payload) ||
      `HTTP ${response.status}`;
    throw new ApiError(response.status, message);
  }

  return payload;
}

export const api = {
  request,

  get: (path) => request(path),
  post: (path, body) => request(path, { method: "POST", body }),
  put: (path, body) => request(path, { method: "PUT", body }),
  del: (path) => request(path, { method: "DELETE" }),

  session: () => request("/api/auth/session"),
  login: (password) => request("/api/auth/login", { method: "POST", body: { password } }),
  logout: () => request("/api/auth/logout", { method: "POST" }),

  status: () => request("/api/status"),
  devices: () => request("/api/devices"),

  device: {
    info: (id) => request(`/api/devices/${encodeURIComponent(id)}/info`),
    infoRows: (id) => request(`/api/devices/${encodeURIComponent(id)}/info-rows`),
    apiInfo: (id) => request(`/api/devices/${encodeURIComponent(id)}/api-info`),
    stats: (id) => request(`/api/devices/${encodeURIComponent(id)}/stats`),
    clocks: (id) => request(`/api/devices/${encodeURIComponent(id)}/clocks`),
    powerProfileModes: (id) => request(`/api/devices/${encodeURIComponent(id)}/power-profile-modes`),
    powerStates: (id) => request(`/api/devices/${encodeURIComponent(id)}/power-states`),
    displays: (id) => request(`/api/devices/${encodeURIComponent(id)}/displays`),
    processes: (id) => request(`/api/devices/${encodeURIComponent(id)}/processes`),
    config: (id) => request(`/api/devices/${encodeURIComponent(id)}/config`),
    setConfig: (id, config) =>
      request(`/api/devices/${encodeURIComponent(id)}/config`, { method: "PUT", body: config }),
    confirmConfig: (id, command) =>
      request(`/api/devices/${encodeURIComponent(id)}/config/confirm`, {
        method: "POST",
        body: { command },
      }),
    setFan: (id, body) =>
      request(`/api/devices/${encodeURIComponent(id)}/fan`, { method: "POST", body }),
    setPowerCap: (id, cap) =>
      request(`/api/devices/${encodeURIComponent(id)}/power-cap`, { method: "POST", body: { cap } }),
    setPerformanceLevel: (id, level) =>
      request(`/api/devices/${encodeURIComponent(id)}/performance-level`, {
        method: "POST",
        body: { level },
      }),
    setClocks: (id, commands) =>
      request(`/api/devices/${encodeURIComponent(id)}/clocks`, { method: "POST", body: commands }),
    setPowerProfileMode: (id, index, custom_heuristics = []) =>
      request(`/api/devices/${encodeURIComponent(id)}/power-profile-mode`, {
        method: "POST",
        body: { index, custom_heuristics },
      }),
    setPowerStates: (id, kind, states) =>
      request(`/api/devices/${encodeURIComponent(id)}/power-states`, {
        method: "POST",
        body: { kind, states },
      }),
    detach: (id) => request(`/api/devices/${encodeURIComponent(id)}/detach`, { method: "POST" }),
    reattach: (id) => request(`/api/devices/${encodeURIComponent(id)}/reattach`, { method: "POST" }),
    vbiosUrl: (id) => `/api/devices/${encodeURIComponent(id)}/vbios`,
  },

  profiles: {
    list: (includeState = true) => request(`/api/profiles?include_state=${includeState}`),
    get: (name) => request(`/api/profiles/${encodeURIComponent(name)}`),
    create: (name, base) => request("/api/profiles", { method: "POST", body: { name, base } }),
    remove: (name) => request(`/api/profiles/${encodeURIComponent(name)}`, { method: "DELETE" }),
    activate: (name, autoSwitch = false) =>
      request(`/api/profiles/${encodeURIComponent(name)}/activate`, {
        method: "POST",
        body: { auto_switch: autoSwitch },
      }),
    rename: (name, newName) =>
      request(`/api/profiles/${encodeURIComponent(name)}/rename`, {
        method: "POST",
        body: { new_name: newName },
      }),
    move: (name, position) =>
      request(`/api/profiles/${encodeURIComponent(name)}/move`, {
        method: "POST",
        body: { new_position: position },
      }),
    getRule: (name) => request(`/api/profiles/${encodeURIComponent(name)}/rule`),
    setRule: (name, rule, hooks = {}) =>
      request(`/api/profiles/${encodeURIComponent(name)}/rule`, {
        method: "PUT",
        body: { rule, hooks },
      }),
    evaluate: (rule) => request("/api/profiles/rule/evaluate", { method: "POST", body: rule }),
  },

  overdrive: {
    enable: () => request("/api/overdrive/enable", { method: "POST" }),
    disable: () => request("/api/overdrive/disable", { method: "POST" }),
  },

  snapshot: () => request("/api/snapshot", { method: "POST", raw: true }),
  resetConfig: () => request("/api/config/reset", { method: "POST" }),

  hardware: {
    system: () => request("/api/hardware/system"),
    sensors: () => request("/api/hardware/sensors"),
    nvme: () => request("/api/hardware/nvme"),
    drives: () => request("/api/hardware/drives"),
    pci: () => request("/api/hardware/pci"),
    services: () => request("/api/hardware/services"),
  },
};

/** Trigger a browser download for a response we fetched with `raw: true`. */
export async function download(response, fallbackName) {
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") || "";
  const match = /filename="?([^"]+)"?/.exec(disposition);
  const name = match ? match[1] : fallbackName;

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
