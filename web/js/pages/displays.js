/** Displays page — upstream's `displays_page.rs`: connectors, models and resolutions. */

import { api } from "../api.js";
import { el } from "../dom.js";
import { emptyState, section } from "../ui.js";

export default {
  id: "displays",
  title: "Displays",
  icon: "monitor",

  async render(ctx) {
    const root = el("div", { class: "stack" });
    const data = await api.device.displays(ctx.deviceId).catch(() => null);
    const displays = data?.displays || {};
    const entries = Object.entries(displays);

    if (entries.length === 0) {
      root.append(
        section("Displays", {
          body: emptyState("No displays are connected to this GPU, or the daemon was built without display support.", "monitor"),
        }).root,
      );
      return { root };
    }

    const table = el("table", { class: "table" },
      el("thead", {},
        el("tr", {},
          el("th", {}, "Connector"),
          el("th", {}, "Manufacturer"),
          el("th", {}, "Model"),
          el("th", {}, "Size"),
          el("th", {}, "Manufactured"),
        ),
      ),
      el("tbody", {},
        entries.map(([name, display]) => {
          const connector = display.connector_type?.type || display.connector_type?.Unknown || "unknown";
          const size = display.size ? `${display.size[0]} × ${display.size[1]} mm` : "—";
          const date = display.manufacture_date
            ? `${display.manufacture_date.year}-${String(display.manufacture_date.week).padStart(2, "0")}`
            : "—";

          return el("tr", {},
            el("td", {},
              el("div", {}, name),
              el("div", { class: "hint" }, `${connector} ${display.connector_id ?? ""}`),
            ),
            el("td", {}, display.manufacturer || "—"),
            el("td", {}, display.model || "—"),
            el("td", {}, size),
            el("td", {}, date),
          );
        }),
      ),
    );

    root.append(
      section(`Displays (${entries.length})`, {
        body: el("div", { class: "table-wrap" }, table),
      }).root,
    );

    return { root };
  },
};
