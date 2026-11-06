/** Minimal DOM helpers. Everything user-visible is set via textContent, never innerHTML — GPU model
 *  names, sensor labels and filenames all come from the host and must never be parsed as HTML. */

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;

    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "html") {
      node.innerHTML = value;
    } else if (value === true) {
      node.setAttribute(key, "");
    } else {
      node.setAttribute(key, String(value));
    }
  }

  append(node, children);
  return node;
}

export function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function icon(name, extra = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", `icon ${extra}`.trim());
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

export const fmt = {
  number(value, digits = 0) {
    if (value === null || value === undefined || Number.isNaN(value)) return "—";
    return Number(value).toLocaleString(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  },

  bytes(value) {
    if (!value) return "—";
    const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
    let index = 0;
    let size = Number(value);
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    return `${size.toFixed(size >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
  },

  mib(value) {
    if (value === null || value === undefined) return "—";
    return `${(Number(value) / 1024 / 1024).toFixed(0)} MiB`;
  },

  temp(value) {
    if (value === null || value === undefined) return "—";
    return `${Number(value).toFixed(0)}°C`;
  },

  power(value) {
    if (value === null || value === undefined) return "—";
    return `${Number(value).toFixed(0)} W`;
  },

  clock(value, ratio = 1) {
    if (value === null || value === undefined) return "—";
    const mhz = Number(value) / 1e6 / ratio;
    if (!Number.isFinite(mhz)) return "—";
    return `${Math.round(mhz)} MHz`;
  },

  percent(value, digits = 0) {
    if (value === null || value === undefined) return "—";
    return `${Number(value).toFixed(digits)}%`;
  },

  duration(seconds) {
    if (!seconds) return "—";
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor((seconds / 3600) % 24);
    const d = Math.floor(seconds / 86400);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  },
};

export function debounce(fn, delay = 150) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** Structural equality for JSON-shaped data, used to detect unsaved config changes. */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (typeof a === "object") {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => deepEqual(a[key], b[key]));
  }

  return false;
}

export function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}
