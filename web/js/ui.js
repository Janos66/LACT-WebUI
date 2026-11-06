/** Widgets that mirror libadwaita controls (cards, rows, switches, sliders, segmented views). */

import { clear, clamp, el, fmt, icon } from "./dom.js";

// ------------------------------------------------------------------------------ structure

export function section(title, { actions = [], note = null, padded = false, body = null } = {}) {
  const header = el("div", { class: "section-header" }, el("span", {}, title), el("div", { class: "wrap" }, actions));
  const content = el("div", { class: `section-body${padded ? " padded" : ""}` });

  if (body) content.append(body);

  const root = el("div", { class: "section" }, header, content);
  if (note) root.append(el("div", { class: "section-note" }, note));

  return { root, body: content, header };
}

export function row(title, control, subtitle = null) {
  const label = el(
    "div",
    { class: "row-label" },
    el("span", { class: "row-title" }, title),
    subtitle ? el("span", { class: "row-subtitle" }, subtitle) : null,
  );

  const controlWrap = el(
    "div",
    { class: `row-control${control?.dataset?.wide ? " wide" : ""}` },
    control || null,
  );

  return el("div", { class: "row" }, label, controlWrap);
}

export function tile(label, value, { unit = null, bar = null, iconName = null } = {}) {
  const valueNode = el("div", { class: "tile-value" }, String(value), unit ? el("small", {}, unit) : null);

  const root = el(
    "div",
    { class: "tile" },
    el("div", { class: "tile-label" }, iconName ? icon(iconName, "icon-small") : null, label),
    valueNode,
  );

  let barNode = null;
  if (bar !== null) {
    barNode = el("div", { class: "tile-bar" }, el("span", { style: { width: `${clamp(bar, 0, 100)}%` } }));
    root.append(barNode);
  }

  return {
    root,
    set(next, nextUnit = undefined, nextBar = undefined) {
      valueNode.firstChild.nodeValue = String(next);
      if (nextUnit !== undefined) {
        const small = valueNode.querySelector("small");
        if (small) small.textContent = nextUnit;
      }
      if (barNode && nextBar !== undefined) {
        barNode.firstChild.style.width = `${clamp(nextBar, 0, 100)}%`;
      }
    },
  };
}

export function infoGrid(rows) {
  if (!rows || rows.length === 0) {
    return el("div", { class: "section-note" }, "No information reported by the daemon.");
  }

  return el(
    "div",
    { class: "info-grid" },
    rows.map((row) =>
      el(
        "div",
        { class: "info-cell" },
        el("div", { class: "info-name" }, row.name),
        el("div", { class: "info-value" }, row.value ?? "—"),
      ),
    ),
  );
}

export function badge(text, kind = "") {
  return el("span", { class: `badge ${kind}`.trim() }, text);
}

export function emptyState(message, iconName = "info") {
  return el("div", { class: "empty-state" }, icon(iconName), el("div", {}, message));
}

export function spinner() {
  return el("div", { class: "spinner" });
}

// ------------------------------------------------------------------------------ controls

export function switchControl({ checked = false, onChange, disabled = false, title = null }) {
  const button = el("button", {
    class: "switch",
    type: "button",
    role: "switch",
    title,
    "aria-checked": checked ? "true" : "false",
    disabled,
  });

  button.addEventListener("click", () => {
    if (button.disabled) return;
    const next = button.getAttribute("aria-checked") !== "true";
    button.setAttribute("aria-checked", next ? "true" : "false");
    onChange?.(next);
  });

  button.set = (value) => button.setAttribute("aria-checked", value ? "true" : "false");
  return button;
}

export function sliderControl({
  min = 0,
  max = 100,
  step = 1,
  value = 0,
  onInput,
  onChange,
  disabled = false,
  format = (v) => String(v),
}) {
  const input = el("input", {
    type: "range",
    min,
    max,
    step,
    value: value ?? min,
    disabled,
  });

  const output = el("span", { class: "mono", style: { minWidth: "64px", textAlign: "right" } }, format(input.value));

  input.addEventListener("input", () => {
    output.textContent = format(input.value);
    onInput?.(Number(input.value));
  });

  input.addEventListener("change", () => onChange?.(Number(input.value)));

  const root = el("div", { class: "wrap" }, input, output);
  root.input = input;
  root.set = (next) => {
    if (next === null || next === undefined) return;
    input.value = next;
    output.textContent = format(next);
  };
  root.setRange = (nextMin, nextMax, nextStep = step) => {
    input.min = nextMin;
    input.max = nextMax;
    input.step = nextStep;
  };

  return root;
}

export function numberControl({
  value = null,
  min = null,
  max = null,
  step = 1,
  onChange,
  disabled = false,
  suffix = null,
  placeholder = "auto",
  wide = false,
}) {
  const input = el("input", {
    type: "number",
    value: value ?? "",
    min,
    max,
    step,
    disabled,
    placeholder,
    dataset: wide ? { wide: "1" } : {},
  });

  const commit = () => {
    const raw = input.value.trim();
    if (raw === "") {
      onChange?.(null);
      return;
    }

    let next = Number(raw);
    if (!Number.isFinite(next)) return;
    if (min !== null) next = Math.max(next, min);
    if (max !== null) next = Math.min(next, max);
    input.value = next;
    onChange?.(next);
  };

  input.addEventListener("change", commit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    }
  });

  const root = el("div", { class: "wrap" }, input, suffix ? el("span", { class: "hint" }, suffix) : null);
  root.input = input;
  root.set = (next) => {
    input.value = next ?? "";
  };
  return root;
}

export function selectControl({ options, value, onChange, disabled = false }) {
  const select = el("select", { disabled });

  for (const option of options) {
    const node = el("option", { value: option.value }, option.label);
    if (String(option.value) === String(value)) node.selected = true;
    select.append(node);
  }

  select.addEventListener("change", () => onChange?.(select.value));
  select.set = (next) => {
    select.value = next;
  };
  return select;
}

export function segmented({ options, value, onChange }) {
  const root = el("div", { class: "segmented" });

  for (const option of options) {
    const button = el(
      "button",
      {
        type: "button",
        class: String(option.value) === String(value) ? "active" : "",
      },
      option.label,
    );

    button.addEventListener("click", () => {
      for (const child of root.children) child.classList.remove("active");
      button.classList.add("active");
      onChange?.(option.value);
    });

    root.append(button);
  }

  root.set = (next) => {
    for (const [index, child] of [...root.children].entries()) {
      child.classList.toggle("active", String(options[index].value) === String(next));
    }
  };

  return root;
}

export function button(label, { onClick, kind = "", iconName = null, disabled = false, title = null } = {}) {
  const node = el(
    "button",
    { class: `button ${kind}`.trim(), type: "button", disabled, title },
    iconName ? icon(iconName) : null,
    label ? el("span", {}, label) : null,
  );

  if (onClick) node.addEventListener("click", onClick);
  return node;
}

// ------------------------------------------------------------------------------ feedback

export function toast(message, kind = "info", timeout = 4000) {
  const host = document.getElementById("toasts");
  const iconName = kind === "success" ? "check" : kind === "error" ? "x" : kind === "warning" ? "warning" : "info";

  const node = el("div", { class: `toast ${kind}` }, icon(iconName), el("span", {}, message));
  host.append(node);

  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transition = "opacity .2s ease";
    setTimeout(() => node.remove(), 220);
  }, timeout);
}

export function modal({ title, body, actions = [], wide = false, onClose = null }) {
  const root = document.getElementById("modal-root");
  const card = el("div", { class: `modal${wide ? " wide" : ""}` });

  let actionTaken = false;
  let backdrop = null;

  const close = () => {
    backdrop?.remove();
    if (!actionTaken) onClose?.();
  };

  card.append(
    el("div", { class: "modal-header" }, title),
    el("div", { class: "modal-body" }, body),
  );

  if (actions.length > 0) {
    card.append(
      el(
        "div",
        { class: "modal-footer" },
        actions.map((action) =>
          button(action.label, {
            kind: action.kind || "",
            onClick: () => {
              actionTaken = true;
              backdrop.remove();
              action.onClick?.();
            },
          }),
        ),
      ),
    );
  }

  backdrop = el(
    "div",
    {
      class: "modal-backdrop",
      onClick: (event) => {
        if (event.target === backdrop) close();
      },
    },
    card,
  );

  clear(root).append(backdrop);
  return { close, card };
}

export function confirmDialog({ title, message, confirmLabel = "Continue", destructive = false }) {
  return new Promise((resolve) => {
    modal({
      title,
      body: message,
      onClose: () => resolve(false),
      actions: [
        { label: "Cancel", onClick: () => resolve(false) },
        {
          label: confirmLabel,
          kind: destructive ? "destructive" : "suggested",
          onClick: () => resolve(true),
        },
      ],
    });
  });
}

export function promptDialog({ title, message, value = "", placeholder = "", confirmLabel = "OK" }) {
  return new Promise((resolve) => {
    const input = el("input", { type: "text", value, placeholder, style: { width: "100%" } });

    modal({
      title,
      body: el("div", { class: "stack" }, message ? el("div", {}, message) : null, input),
      onClose: () => resolve(null),
      actions: [
        { label: "Cancel", onClick: () => resolve(null) },
        {
          label: confirmLabel,
          kind: "suggested",
          onClick: () => resolve(input.value.trim() || null),
        },
      ],
    });

    setTimeout(() => input.focus(), 30);

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        resolve(input.value.trim() || null);
        document.getElementById("modal-root").replaceChildren();
      }
    });
  });
}
