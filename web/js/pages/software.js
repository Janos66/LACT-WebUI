/** Software page — upstream's `software_page.rs`: driver, VBIOS, Vulkan/OpenCL capabilities, PCIe link. */

import { api, download } from "../api.js";
import { el, fmt } from "../dom.js";
import { badge, button, modal, section, toast } from "../ui.js";

export default {
  id: "software",
  title: "Software",
  icon: "package",

  async render(ctx) {
    const { state } = ctx;
    const root = el("div", { class: "stack" });
    const info = state.info || {};
    const apiInfo = await api.device.apiInfo(ctx.deviceId).catch(() => null);

    // ------------------------------------------------------------------ versions

    const flags = Array.isArray(info.flags) ? info.flags : [];
    const rows = el("div", {});

    rows.append(
      infoRow("Driver", info.driver || "—"),
      infoRow("VBIOS version", info.vbios_version || "—"),
    );

    const link = info.link_info || {};
    if (link.current_speed) {
      rows.append(
        infoRow(
          "PCIe link",
          `${link.current_speed} x${link.current_width}${link.max_speed ? ` (max ${link.max_speed} x${link.max_width})` : ""}`,
        ),
      );
    }

    if (flags.includes("DumpableVBios")) {
      rows.append(
        el("div", { class: "row" },
          el("div", { class: "row-label" },
            el("span", { class: "row-title" }, "VBIOS dump"),
            el("span", { class: "row-subtitle" }, "Download the raw VBIOS image (gzipped on AMD)"),
          ),
          el("div", { class: "row-control" },
            button("Dump VBIOS", {
              kind: "small",
              iconName: "download",
              onClick: async () => {
                try {
                  const response = await api.request(api.device.vbiosUrl(ctx.deviceId), { method: "POST", raw: true });
                  await download(response, `vbios-${ctx.deviceId}.bin`);
                  toast("VBIOS downloaded", "success");
                } catch (error) {
                  toast(error.message, "error");
                }
              },
            }),
          ),
        ),
      );
    }

    root.append(section("Device software", { body: rows }).root);

    // ------------------------------------------------------------------ vulkan

    const vulkanInstances = apiInfo?.vulkan_instances || [];
    if (vulkanInstances.length > 0) {
      const body = el("div", {});

      for (const instance of vulkanInstances) {
        const features = Object.entries(instance.features || {});
        const extensions = Object.entries(instance.extensions || {});
        const enabledFeatures = features.filter(([, enabled]) => enabled).length;
        const enabledExtensions = extensions.filter(([, enabled]) => enabled).length;

        body.append(
          infoRow("Device", instance.device_name),
          infoRow("API version", instance.api_version),
          infoRow(
            "Driver",
            [instance.driver?.name, instance.driver?.driver_version ?? instance.driver?.info]
              .filter(Boolean)
              .join(" "),
          ),
          infoRow("Enabled layers", String((instance.enabled_layers || []).length)),
          el("div", { class: "row" },
            el("div", { class: "row-label" },
              el("span", { class: "row-title" }, "Features"),
              el("span", { class: "row-subtitle" }, `${enabledFeatures} of ${features.length} enabled`),
            ),
            el("div", { class: "row-control" },
              button("Show", { kind: "small", onClick: () => showList(instance.device_name, features) }),
            ),
          ),
          el("div", { class: "row" },
            el("div", { class: "row-label" },
              el("span", { class: "row-title" }, "Extensions"),
              el("span", { class: "row-subtitle" }, `${enabledExtensions} of ${extensions.length} enabled`),
            ),
            el("div", { class: "row-control" },
              button("Show", { kind: "small", onClick: () => showList(instance.device_name, extensions) }),
            ),
          ),
        );
      }

      root.append(section("Vulkan", { body }).root);

      function showList(deviceName, entries) {
        const body = el("div", { class: "stack" });
        const sorted = [...entries].sort((a, b) => a[0].localeCompare(b[0]));

        body.append(
          el("div", { class: "table-wrap" },
            el("table", { class: "table" },
              el("thead", {}, el("tr", {}, el("th", {}, "Name"), el("th", { class: "num" }, "Enabled"))),
              el("tbody", {},
                sorted.map(([name, enabled]) =>
                  el("tr", {},
                    el("td", { class: "mono" }, name),
                    el("td", { class: "num" }, enabled ? badge("yes", "ok") : badge("no")),
                  ),
                ),
              ),
            ),
          ),
        );

        modal({ title: deviceName, body, wide: true, actions: [{ label: "Close", kind: "suggested" }] });
      }
    }

    // ------------------------------------------------------------------ opencl

    const openclInstances = apiInfo?.opencl_instances || [];
    if (openclInstances.length > 0) {
      const body = el("div", {});

      for (const instance of openclInstances) {
        body.append(
          infoRow("Platform", instance.platform_name),
          infoRow("Device", instance.device_name),
          infoRow("Version", instance.version),
          infoRow("Driver version", instance.driver_version),
          infoRow("Compute units", String(instance.compute_units)),
          infoRow("Global memory", fmt.bytes(instance.global_memory)),
        );
      }

      root.append(section("OpenCL", { body }).root);
    }

    // ------------------------------------------------------------------ daemon

    const daemon = state.status?.daemon || {};
    root.append(
      section("LACT", {
        body: el("div", {},
          infoRow("Daemon version", daemon.version || "—"),
          infoRow("Web UI version", state.status?.webui_version || "—"),
          infoRow("Daemon endpoint", state.status?.daemon_endpoint || "—"),
          infoRow("Connection", state.daemonConnected ? "connected" : "disconnected"),
          el("div", { class: "row" },
            el("div", { class: "row-label" },
              el("span", { class: "row-title" }, "Historical charts"),
              el("span", { class: "row-subtitle" }, "Open the live statistics view"),
            ),
            el("div", { class: "row-control" },
              button("Open", { kind: "small", onClick: () => ctx.navigate("charts") }),
            ),
          ),
        ),
      }).root,
    );

    return { root };
  },
};

function infoRow(name, value) {
  return el("div", { class: "row" },
    el("div", { class: "row-label" }, el("span", { class: "row-title" }, name)),
    el("div", { class: "row-control mono", style: { textAlign: "right", maxWidth: "60%" } }, String(value ?? "—")),
  );
}
