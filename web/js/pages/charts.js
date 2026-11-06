/** Historical charts — the equivalent of upstream's separate "graphs" window, as a page. */

import { LineChart } from "../charts.js";
import { el, fmt } from "../dom.js";
import { button, section } from "../ui.js";

const SERIES = [
  { key: "temp", title: "Temperature", color: "#ff7b63", unit: "°C", format: (v) => `${v.toFixed(0)}°` },
  { key: "power", title: "Power", color: "#f5c211", unit: "W", format: (v) => v.toFixed(0) },
  { key: "core", title: "Core clock", color: "#78aeff", unit: "MHz", format: (v) => (v / 1000).toFixed(1) },
  { key: "mem", title: "Memory clock", color: "#c061cb", unit: "MHz", format: (v) => (v / 1000).toFixed(1) },
  { key: "fan", title: "Fan speed", color: "#57e389", unit: "RPM", format: (v) => v.toFixed(0) },
  { key: "vram", title: "VRAM usage", color: "#99c1f1", unit: "%", format: (v) => `${v.toFixed(0)}%` },
  { key: "busy", title: "GPU usage", color: "#f9a825", unit: "%", format: (v) => `${v.toFixed(0)}%` },
];

export default {
  id: "charts",
  title: "Historical charts",
  icon: "chart",

  render(ctx) {
    const { state } = ctx;
    const root = el("div", { class: "stack" });
    const charts = new Map();

    const grid = el("div", { class: "chart-grid" });

    for (const series of SERIES) {
      const canvas = el("canvas", { class: "chart" });
      const valueLabel = el("b", {}, "—");

      const card = el("div", { class: "chart-card" },
        el("div", { class: "chart-title" }, el("span", {}, `${series.title} (${series.unit})`), valueLabel),
        canvas,
      );

      grid.append(card);

      const chart = new LineChart(canvas, {
        color: series.color,
        format: series.format,
      });

      charts.set(series.key, { chart, valueLabel, unit: series.unit });
    }

    // Seed with whatever has been recorded so far.
    for (const [key, entry] of charts) {
      entry.chart.setData(state.history[key] || []);
    }

    const exportButton = button("Export CSV", {
      kind: "small",
      iconName: "download",
      onClick: () => exportCsv(state.history),
    });

    const clearButton = button("Clear", {
      kind: "small",
      onClick: () => {
        ctx.editHistory((history) => {
          for (const key of Object.keys(history)) history[key].length = 0;
        });
        for (const entry of charts.values()) entry.chart.clear();
      },
    });

    root.append(
      section("Live series", {
        actions: [clearButton, exportButton],
        note: "One sample per second, 600 samples retained (10 minutes).",
        body: grid,
      }).root,
    );

    return {
      root,
      onStats() {
        for (const [key, entry] of charts) {
          const data = state.history[key] || [];
          entry.chart.setData(data);
          const last = data[data.length - 1];
          entry.valueLabel.textContent = last === undefined ? "—" : formatValue(last, entry.unit);
        }
      },
    };
  },
};

function formatValue(value, unit) {
  if (unit === "MHz") return `${(value / 1000).toFixed(2)} GHz`;
  if (unit === "°C") return `${value.toFixed(0)} °C`;
  if (unit === "%") return `${value.toFixed(0)} %`;
  return `${Math.round(value)} ${unit}`;
}

function exportCsv(history) {
  const length = Math.max(...Object.values(history).map((series) => series.length), 0);
  const header = Object.keys(history).join(",");
  const rows = [];

  for (let index = 0; index < length; index += 1) {
    rows.push(
      Object.keys(history)
        .map((key) => history[key][index] ?? "")
        .join(","),
    );
  }

  const blob = new Blob([`${header}\n${rows.join("\n")}\n`], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: `lact-stats-${new Date().toISOString().slice(0, 19).replaceAll(":", "")}.csv` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
