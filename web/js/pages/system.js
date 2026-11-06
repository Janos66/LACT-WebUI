/** System page — new in this fork: host load, hwmon sensors, NVMe/SMART health, block devices and PCI
 *  inventory, so a headless box can be inspected without ssh. */

import { api } from "../api.js";
import { el, fmt } from "../dom.js";
import { badge, button, emptyState, section, tile, toast } from "../ui.js";

export default {
  id: "system",
  title: "System",
  icon: "server",

  async render(ctx) {
    const root = el("div", { class: "stack" });

    const [host, sensors, nvme, drives, pci, services] = await Promise.all([
      api.hardware.system().catch((error) => ({ error: error.message })),
      api.hardware.sensors().catch(() => ({ chips: [], sensors: [] })),
      api.hardware.nvme().catch((error) => ({ available: false, reason: error.message, drives: [] })),
      api.hardware.drives().catch(() => ({ drives: [] })),
      api.hardware.pci().catch(() => ({ devices: [] })),
      api.hardware.services().catch(() => ({ services: [] })),
    ]);

    // ------------------------------------------------------------------ host

    if (host && !host.error) {
      const mem = host.memory || {};
      const usedPercent = mem.total_kb ? ((mem.used_kb / mem.total_kb) * 100) : 0;
      const load = host.cpu?.load || [];

      root.append(
        section("Host", {
          actions: [
            button("Refresh", {
              kind: "small",
              iconName: "refresh",
              onClick: () => ctx.rerender(),
            }),
          ],
          body: el("div", {},
            el("div", { class: "tiles" },
              tile("Hostname", host.hostname || "—", { iconName: "server" }).root,
              tile("Uptime", fmt.duration(host.uptime_seconds), { iconName: "gauge" }).root,
              tile("Memory used", fmt.bytes((mem.used_kb || 0) * 1024), {
                unit: `/ ${fmt.bytes((mem.total_kb || 0) * 1024)}`,
                bar: usedPercent,
                iconName: "database",
              }).root,
              tile("Load (1m)", (load[0] ?? 0).toFixed(2), {
                unit: `/ ${host.cpu?.logical_cores ?? "?"} threads`,
                iconName: "cpu",
              }).root,
            ),
            el("div", { class: "row" },
              el("div", { class: "row-label" }, el("span", { class: "row-title" }, "CPU")),
              el("div", { class: "row-control", style: { textAlign: "right" } },
                el("span", {},
                  `${host.cpu?.model ?? "unknown"} · ${host.cpu?.physical_cores ?? "?"} cores / ${host.cpu?.logical_cores ?? "?"} threads`),
              ),
            ),
            infoLine("Load average", load.map((value) => Number(value).toFixed(2)).join("  ") || "—"),
            infoLine("Operating system", host.os || "—"),
            infoLine("Kernel", host.kernel || "—"),
            infoLine("Swap", `${fmt.bytes((mem.swap_used_kb || 0) * 1024)} of ${fmt.bytes((mem.swap_total_kb || 0) * 1024)}`),
          ),
        }).root,
      );
    } else {
      root.append(
        section("Host", { body: emptyState(`Could not read host information: ${host?.error ?? "unknown error"}`) }).root,
      );
    }

    // ------------------------------------------------------------------ nvme

    root.append(buildNvmeSection(nvme));

    // ------------------------------------------------------------------ sensors

    if (sensors && sensors.sensors && sensors.sensors.length > 0) {
      const groups = new Map();
      for (const sensor of sensors.sensors) {
        if (!groups.has(sensor.chip)) groups.set(sensor.chip, []);
        groups.get(sensor.chip).push(sensor);
      }

      const body = el("div", {});

      for (const [chip, entries] of groups) {
        body.append(
          el("div", { class: "row" },
            el("div", { class: "row-label" },
              el("span", { class: "row-title" }, chip),
              el("span", { class: "row-subtitle" }, `${entries.length} sensor${entries.length === 1 ? "" : "s"}`),
            ),
          ),
        );

        for (const sensor of entries) {
          body.append(
            el("div", { class: "row", style: { paddingLeft: "28px" } },
              el("div", { class: "row-label" },
                el("span", { class: "row-title" }, sensor.label),
                el("span", { class: "row-subtitle" }, sensor.kind),
              ),
              el("div", { class: "row-control mono" }, `${sensor.value.toFixed(sensor.kind === "temperature" ? 1 : 0)} ${sensor.unit}`),
            ),
          );
        }
      }

      root.append(section(`Sensors (${sensors.sensors.length})`, { note: "Collected from /sys/class/hwmon.", body }).root);
    }

    // ------------------------------------------------------------------ drives

    if (drives?.drives?.length) {
      root.append(
        section("Block devices", {
          body: el("div", { class: "table-wrap" },
            el("table", { class: "table" },
              el("thead", {}, el("tr", {},
                el("th", {}, "Device"), el("th", {}, "Model"), el("th", {}, "Serial"), el("th", { class: "num" }, "Size"), el("th", {}, "Type"),
              )),
              el("tbody", {},
                drives.drives.map((drive) =>
                  el("tr", {},
                    el("td", {}, drive.name),
                    el("td", {}, drive.model || "—"),
                    el("td", { class: "mono" }, drive.serial || "—"),
                    el("td", { class: "num" }, fmt.bytes(drive.size_bytes)),
                    el("td", {}, drive.rotational ? "HDD" : "SSD"),
                  ),
                ),
              ),
            ),
          ),
        }).root,
      );
    }

    // ------------------------------------------------------------------ pci

    if (pci?.devices?.length) {
      root.append(
        section(`PCI devices (${pci.devices.length})`, {
          body: el("div", { class: "table-wrap" },
            el("table", { class: "table" },
              el("thead", {}, el("tr", {},
                el("th", {}, "Address"), el("th", {}, "Vendor"), el("th", {}, "Device"), el("th", {}, "Class"), el("th", {}, "Driver"),
              )),
              el("tbody", {},
                pci.devices.map((device) =>
                  el("tr", {},
                    el("td", { class: "mono" }, device.address),
                    el("td", { class: "mono" }, device.vendor),
                    el("td", { class: "mono" }, device.device),
                    el("td", { class: "mono" }, device.class),
                    el("td", {}, device.driver || "—"),
                  ),
                ),
              ),
            ),
          ),
        }).root,
      );
    }

    // ------------------------------------------------------------------ services

    if (services?.services?.length) {
      root.append(
        section("Services", {
          body: el("div", {},
            services.services.map((service) =>
              el("div", { class: "row" },
                el("div", { class: "row-label" }, el("span", { class: "row-title" }, service.name)),
                el("div", { class: "row-control" },
                  badge(service.active_state, service.active_state === "active" ? "ok" : "warn"),
                ),
              ),
            ),
          ),
        }).root,
      );
    }

    return { root };
  },
};

function infoLine(name, value) {
  return el("div", { class: "row" },
    el("div", { class: "row-label" }, el("span", { class: "row-title" }, name)),
    el("div", { class: "row-control", style: { textAlign: "right" } }, String(value ?? "—")),
  );
}

function buildNvmeSection(data) {
  if (!data || data.available === false) {
    return section("NVMe / SMART", {
      body: emptyState(data?.reason || "nvme-cli is not available on the host.", "database"),
    }).root;
  }

  if (!data.drives || data.drives.length === 0) {
    return section("NVMe / SMART", {
      body: emptyState(data.reason || "No NVMe devices found.", "database"),
    }).root;
  }

  const cards = [];

  for (const drive of data.drives) {
    const smart = drive.smart || {};
    const temperature = smart.temperature ?? smart.temp ?? null;
    const cells = [];

    const add = (label, value) => {
      cells.push(
        el("div", { class: "info-cell" },
          el("div", { class: "info-name" }, label),
          el("div", { class: "info-value" }, value),
        ),
      );
    };

    add("Model", drive.model || "—");
    add("Serial", drive.serial || "—");
    add("Firmware", drive.firmware || "—");
    add("Capacity", fmt.bytes(drive.size_bytes));

    if (temperature !== null) add("Temperature", fmt.temp(temperature));
    if (smart.percent_used !== undefined) add("Wear", `${smart.percent_used} %`);
    if (smart.power_on_hours !== undefined) add("Power-on hours", fmt.number(smart.power_on_hours));
    if (smart.data_units_written !== undefined) {
      add("Data written", fmt.bytes(Number(smart.data_units_written) * 512000));
    }
    if (smart.media_errors !== undefined) add("Media errors", fmt.number(smart.media_errors));
    if (smart.unsafe_shutdowns !== undefined) add("Unsafe shutdowns", fmt.number(smart.unsafe_shutdowns));

    cards.push(
      el("div", { class: "section", style: { marginBottom: "10px" } },
        el("div", { class: "section-header" },
          el("span", {}, drive.device || "drive"),
          badge(
            drive.health === "ok" ? "healthy" : drive.health === "warning" ? "critical warning" : "unknown",
            drive.health === "ok" ? "ok" : "warn",
          ),
        ),
        el("div", { class: "info-grid", style: { padding: "10px" } }, cells),
      ),
    );
  }

  return section("NVMe / SMART", {
    note: "Read with `nvme list` and `nvme smart-log`.",
    body: el("div", { style: { padding: "10px 12px" } }, cards),
  }).root;
}

void toast;
void tile;
