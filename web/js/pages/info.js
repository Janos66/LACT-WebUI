/** Information page — upstream's `info_page.rs`: an information card grid plus live statistics. */

import { el, fmt } from "../dom.js";
import { buildCacheRows, buildInfoRows, buildIpRows } from "../infoRows.js";
import { primaryTemp } from "../store.js";
import { badge, emptyState, infoGrid, section, tile } from "../ui.js";

export default {
  id: "info",
  title: "Information",
  icon: "info",

  render(ctx) {
    const { state } = ctx;
    const root = el("div", { class: "stack" });
    const stats = state.stats || {};

    const temp = primaryTemp(stats);
    const fan = stats.fan || {};
    const clocks = stats.clockspeed || {};
    const vram = stats.vram || {};
    const power = stats.power || {};

    const vramPercent = vram.total && vram.used ? (vram.used / vram.total) * 100 : null;

    const tiles = {
      temp: tile("Temperature", fmt.temp(temp), { iconName: "thermometer" }),
      power: tile("Power", fmt.power(power.average ?? power.current), {
        iconName: "power",
        bar: power.cap_current ? ((power.average ?? power.current ?? 0) / power.cap_current) * 100 : null,
      }),
      core: tile("Core clock", fmt.clock(clocks.gpu_clockspeed), { iconName: "gauge" }),
      mem: tile("Memory clock", fmt.clock(clocks.vram_clockspeed), { iconName: "database" }),
      fan: tile("Fan speed", fan.speed_current !== null && fan.speed_current !== undefined ? fmt.number(fan.speed_current) : "—", {
        unit: fan.speed_current !== null && fan.speed_current !== undefined ? "RPM" : null,
        iconName: "fan",
      }),
      busy: tile("GPU usage", stats.busy_percent !== null && stats.busy_percent !== undefined ? fmt.percent(stats.busy_percent) : "—", {
        iconName: "gauge",
        bar: stats.busy_percent ?? null,
      }),
      vram: tile(
        "VRAM",
        vram.used !== null && vram.used !== undefined ? `${fmt.bytes(vram.used)}` : "—",
        {
          unit: vram.total ? `/ ${fmt.bytes(vram.total)}` : null,
          iconName: "database",
          bar: vramPercent,
        },
      ),
    };

    const liveSection = section("Live", {
      body: el("div", { class: "tiles" }, Object.values(tiles).map((entry) => entry.root)),
    });

    root.append(liveSection.root);

    const infoRows = buildInfoRows(state.info, stats);
    if (infoRows.length > 0) {
      root.append(section("Device information", { body: infoGrid(infoRows) }).root);
    } else {
      root.append(section("Device information", { body: emptyState("Waiting for the daemon…") }).root);
    }

    // Throttling, if the daemon reports any status.
    const throttle = stats.throttle_info;
    if (throttle && Object.keys(throttle).length > 0) {
      const rows = [];
      for (const [kind, statuses] of Object.entries(throttle)) {
        for (const status of statuses) {
          rows.push(
            el(
              "div",
              { class: "row" },
              el("div", { class: "row-label" }, el("span", { class: "row-title" }, status)),
              el("div", { class: "row-control" }, badge(kind, "warn")),
            ),
          );
        }
      }
      root.append(section("Throttling", { body: el("div", {}, rows) }).root);
    }

    // Cache / IP block information (AMD exposes these through DRM info).
    const drm = state.info?.drm_info;
    const cacheSection = buildCacheSection(drm);
    if (cacheSection) root.append(cacheSection);

    if (stats.active_power_states) {
      const states = stats.active_power_states;
      const rows = [
        ["Core", states.core],
        ["Memory", states.memory],
        ["PCIe", states.pcie],
      ]
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([label, value]) =>
          el(
            "div",
            { class: "row" },
            el("div", { class: "row-label" }, el("span", { class: "row-title" }, label)),
            el("div", { class: "row-control mono" }, JSON.stringify(value)),
          ),
        );

      if (rows.length > 0) {
        root.append(section("Active power states", { body: el("div", {}, rows) }).root);
      }
    }

    return {
      root,
      onStats(next) {
        const nextStats = next || {};
        const nextFan = nextStats.fan || {};
        const nextClocks = nextStats.clockspeed || {};
        const nextVram = nextStats.vram || {};
        const nextPower = nextStats.power || {};

        tiles.temp.set(fmt.temp(primaryTemp(nextStats)));
        tiles.power.set(
          fmt.power(nextPower.average ?? nextPower.current),
          undefined,
          nextPower.cap_current
            ? ((nextPower.average ?? nextPower.current ?? 0) / nextPower.cap_current) * 100
            : null,
        );
        tiles.core.set(fmt.clock(nextClocks.gpu_clockspeed));
        tiles.mem.set(fmt.clock(nextClocks.vram_clockspeed));
        tiles.fan.set(
          nextFan.speed_current !== null && nextFan.speed_current !== undefined
            ? fmt.number(nextFan.speed_current)
            : "—",
          nextFan.speed_current !== null && nextFan.speed_current !== undefined ? "RPM" : null,
        );
        tiles.busy.set(
          nextStats.busy_percent !== null && nextStats.busy_percent !== undefined
            ? fmt.percent(nextStats.busy_percent)
            : "—",
          undefined,
          nextStats.busy_percent ?? null,
        );
        tiles.vram.set(
          nextVram.used !== null && nextVram.used !== undefined ? fmt.bytes(nextVram.used) : "—",
          nextVram.total ? `/ ${fmt.bytes(nextVram.total)}` : null,
          nextVram.total && nextVram.used ? (nextVram.used / nextVram.total) * 100 : null,
        );
      },
    };
  },
};

function buildCacheSection(drm) {
  if (!drm) return null;

  const rows = [];

  for (const cache of buildCacheRows({ drm_info: drm })) {
    rows.push(
      el(
        "div",
        { class: "row" },
        el("div", { class: "row-label" }, el("span", { class: "row-title" }, `${cache.count}x ${cache.text}`)),
      ),
    );
  }

  for (const ip of buildIpRows({ drm_info: drm })) {
    rows.push(
      el(
        "div",
        { class: "row" },
        el("div", { class: "row-label" },
          el("span", { class: "row-title" }, ip.name),
          el("span", { class: "row-subtitle" }, ip.value),
        ),
      ),
    );
  }

  if (rows.length === 0) return null;
  return section("Caches & IP blocks", { body: el("div", {}, rows) }).root;
}
