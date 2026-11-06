/** Overclocking page — upstream's `oc_page.rs`: power cap, performance level, clocks, voltages,
 *  per-pstate offsets, AMD power profile modes and power states. */

import { api } from "../api.js";
import { el, fmt } from "../dom.js";
import {
  badge,
  button,
  confirmDialog,
  emptyState,
  modal,
  numberControl,
  section,
  selectControl,
  sliderControl,
  switchControl,
  toast,
} from "../ui.js";

const PERFORMANCE_LEVELS = [
  { value: "auto", label: "Automatic" },
  { value: "low", label: "Low" },
  { value: "high", label: "High" },
  { value: "manual", label: "Manual" },
];

const POWER_MIZER_MODES = [
  { value: "Auto", label: "Auto" },
  { value: "Adaptive", label: "Adaptive" },
  { value: "PreferMaximumPerformance", label: "Prefer maximum performance" },
  { value: "PreferConsistentPerformance", label: "Prefer consistent performance" },
];

export default {
  id: "oc",
  title: "Overclocking",
  icon: "gauge",

  async render(ctx) {
    const { state } = ctx;
    const root = el("div", { class: "stack" });
    const stats = state.stats || {};
    const draft = state.draft;

    // Power states and profile modes are AMD-only; asking the daemon on other drivers just
    // produces a 409 in the console.
    const isAmd = state.info?.driver === "amdgpu";

    const [clocks, powerStates, profileModes] = await Promise.all([
      api.device.clocks(ctx.deviceId).catch(() => null),
      isAmd ? api.device.powerStates(ctx.deviceId).catch(() => null) : Promise.resolve(null),
      isAmd ? api.device.powerProfileModes(ctx.deviceId).catch(() => null) : Promise.resolve(null),
    ]);

    // ------------------------------------------------------------------ power & performance

    const power = stats.power || {};
    const powerSection = section("Power & performance", { body: el("div", {}) });

    if (power.cap_max !== null && power.cap_max !== undefined) {
      const min = Math.round(power.cap_min ?? 0);
      const max = Math.round(power.cap_max);
      const value = Math.round(draft.power_cap ?? power.cap_current ?? max);

      const numeric = numberControl({
        value: draft.power_cap ?? power.cap_current ?? null,
        min,
        max,
        step: 1,
        suffix: "W",
        placeholder: `${Math.round(power.cap_default ?? max)} (default)`,
        onChange: (next) => {
          ctx.edit((config) => {
            config.power_cap = next;
          });
          slider.set(next ?? power.cap_current);
        },
      });

      const slider = sliderControl({
        min,
        max,
        step: 1,
        value,
        format: (next) => `${next} W`,
        onInput: (next) => {
          ctx.edit((config) => {
            config.power_cap = next;
          });
        },
        onChange: (next) => numeric.set(next),
      });

      powerSection.body.append(
        el("div", { class: "row" },
          el("div", { class: "row-label" },
            el("span", { class: "row-title" }, "Power limit"),
            el("span", { class: "row-subtitle" }, `range ${min}–${max} W · current ${fmt.power(power.cap_current)}`),
          ),
          el("div", { class: "row-control" }, slider, numeric),
        ),
      );
    }

    const performanceLevelSupported =
      stats.performance_level !== null && stats.performance_level !== undefined;

    if (performanceLevelSupported || draft.performance_level) {
      const select = selectControl({
        options: PERFORMANCE_LEVELS,
        value: draft.performance_level ?? stats.performance_level ?? "auto",
        onChange: (value) => ctx.edit((config) => {
          config.performance_level = value;
        }),
      });

      powerSection.body.append(
        el("div", { class: "row" },
          el("div", { class: "row-label" },
            el("span", { class: "row-title" }, "Performance level"),
            el("span", { class: "row-subtitle" }, `currently ${stats.performance_level ?? "unknown"}`),
          ),
          el("div", { class: "row-control" }, select),
        ),
      );
    }

    if (Array.isArray(stats.supported_power_mizer_modes) && stats.supported_power_mizer_modes.length) {
      const options = POWER_MIZER_MODES.filter((mode) =>
        stats.supported_power_mizer_modes.includes(mode.value),
      );

      powerSection.body.append(
        el("div", { class: "row" },
          el("div", { class: "row-label" },
            el("span", { class: "row-title" }, "PowerMizer mode"),
            el("span", { class: "row-subtitle" }, `currently ${stats.active_power_mizer_mode ?? "unknown"}`),
          ),
          el("div", { class: "row-control" },
            selectControl({
              options: options.length ? options : POWER_MIZER_MODES,
              value: draft.power_mizer_mode ?? stats.active_power_mizer_mode ?? "Auto",
              onChange: (value) => ctx.edit((config) => {
                config.power_mizer_mode = value;
              }),
            }),
          ),
        ),
      );
    }

    if (powerSection.body.childElementCount > 0) root.append(powerSection.root);

    // ------------------------------------------------------------------ clocks

    const clocksSection = section("Clocks", {
      note: "Values are in MHz. Leave a field empty to keep the driver default.",
      body: el("div", {}),
    });

    const clockRow = (title, key, subtitle, maxValue = null) =>
      el("div", { class: "row" },
        el("div", { class: "row-label" },
          el("span", { class: "row-title" }, title),
          subtitle ? el("span", { class: "row-subtitle" }, subtitle) : null,
        ),
        el("div", { class: "row-control" },
          numberControl({
            value: draft[key] ?? null,
            min: 0,
            max: maxValue,
            step: 1,
            suffix: "MHz",
            onChange: (value) => ctx.edit((config) => {
              config[key] = value;
            }),
          }),
        ),
      );

    clocksSection.body.append(
      clockRow("Maximum core clock", "max_core_clock", clocks?.max_sclk ? `hardware maximum ${clocks.max_sclk} MHz` : null, clocks?.max_sclk ?? null),
      clockRow("Minimum core clock", "min_core_clock"),
      clockRow("Maximum memory clock", "max_memory_clock", clocks?.max_mclk ? `hardware maximum ${clocks.max_mclk} MHz` : null, clocks?.max_mclk ?? null),
      clockRow("Minimum memory clock", "min_memory_clock"),
    );

    root.append(clocksSection.root);

    // ------------------------------------------------------------------ voltages

    const voltageSection = section("Voltages", {
      note: "Voltage offset applies to RDNA and newer AMD GPUs; the min/max voltages apply to Vega and older.",
      body: el("div", {}),
    });

    voltageSection.body.append(
      el("div", { class: "row" },
        el("div", { class: "row-label" },
          el("span", { class: "row-title" }, "Voltage offset"),
          el("span", { class: "row-subtitle" }, "Negative values undervolt"),
        ),
        el("div", { class: "row-control" },
          numberControl({
            value: draft.voltage_offset ?? null,
            min: -500,
            max: 500,
            step: 1,
            suffix: "mV",
            onChange: (value) => ctx.edit((config) => {
              config.voltage_offset = value;
            }),
          }),
        ),
      ),
      el("div", { class: "row" },
        el("div", { class: "row-label" },
          el("span", { class: "row-title" }, "Maximum voltage"),
          el("span", { class: "row-subtitle" }, clocks?.max_voltage ? `hardware maximum ${clocks.max_voltage} mV` : ""),
        ),
        el("div", { class: "row-control" },
          numberControl({
            value: draft.max_voltage ?? null,
            min: 0,
            max: clocks?.max_voltage ?? 2000,
            step: 1,
            suffix: "mV",
            onChange: (value) => ctx.edit((config) => {
              config.max_voltage = value;
            }),
          }),
        ),
      ),
      el("div", { class: "row" },
        el("div", { class: "row-label" },
          el("span", { class: "row-title" }, "Minimum voltage"),
        ),
        el("div", { class: "row-control" },
          numberControl({
            value: draft.min_voltage ?? null,
            min: 0,
            max: 2000,
            step: 1,
            suffix: "mV",
            onChange: (value) => ctx.edit((config) => {
              config.min_voltage = value;
            }),
          }),
        ),
      ),
    );

    root.append(voltageSection.root);

    // ------------------------------------------------------------------ offsets

    const offsetsSection = section("Clock offsets", {
      note: "Per-pstate offsets in MHz. Applies to NVIDIA and AMD RDNA4.",
      body: el("div", {}),
      actions: [
        button("Add offset", {
          kind: "small",
          iconName: "plus",
          onClick: () => {
            ctx.edit((config) => {
              const gpuOffsets = { ...(config.gpu_clock_offsets || {}) };
              const nextKey = String(Object.keys(gpuOffsets).length);
              gpuOffsets[nextKey] = 0;
              config.gpu_clock_offsets = gpuOffsets;
            });
            ctx.rerender();
          },
        }),
      ],
    });

    const offsetEntries = [
      ...Object.entries(draft.gpu_clock_offsets || {}).map(([key, value]) => ["gpu", key, value]),
      ...Object.entries(draft.mem_clock_offsets || {}).map(([key, value]) => ["mem", key, value]),
    ];

    if (offsetEntries.length === 0) {
      offsetsSection.body.append(el("div", { class: "row" }, el("div", { class: "row-label" }, el("span", { class: "row-subtitle" }, "No offsets configured."))));
    }

    for (const [kind, key, value] of offsetEntries) {
      const field = kind === "gpu" ? "gpu_clock_offsets" : "mem_clock_offsets";

      offsetsSection.body.append(
        el("div", { class: "row" },
          el("div", { class: "row-label" },
            el("span", { class: "row-title" }, `${kind === "gpu" ? "GPU" : "Memory"} offset (pstate ${key})`),
          ),
          el("div", { class: "row-control" },
            numberControl({
              value,
              min: -2000,
              max: 2000,
              step: 1,
              suffix: "MHz",
              onChange: (next) => ctx.edit((config) => {
                if (next === null) {
                  const copy = { ...(config[field] || {}) };
                  delete copy[key];
                  config[field] = copy;
                } else {
                  config[field] = { ...(config[field] || {}), [key]: next };
                }
              }),
            }),
            button("", {
              kind: "flat icon-only",
              iconName: "trash",
              title: "Remove",
              onClick: () => {
                ctx.edit((config) => {
                  const copy = { ...(config[field] || {}) };
                  delete copy[key];
                  config[field] = copy;
                });
                ctx.rerender();
              },
            }),
          ),
        ),
      );
    }

    root.append(offsetsSection.root);

    // ------------------------------------------------------------------ power profile modes (AMD)

    if (profileModes && profileModes.modes) {
      const modes = Object.entries(profileModes.modes).map(([index, mode]) => ({
        value: index,
        label: `${mode.name}${Number(index) === profileModes.active ? " (active)" : ""}`,
      }));

      const valueNames = profileModes.value_names || [];
      const heuristicsHost = el("div", { class: "stack", style: { padding: "0 16px 12px" } });

      const selectedIndex = String(draft.power_profile_mode_index ?? profileModes.active ?? 0);
      const selectedMode = profileModes.modes[selectedIndex];

      const isCustom = /custom/i.test(selectedMode?.name || "");

      if (isCustom && valueNames.length > 0) {
        const current = draft.custom_power_profile_mode_hueristics?.[0] ||
          selectedMode.components?.[0]?.values || valueNames.map(() => 0);

        heuristicsHost.append(
          el("div", { class: "row-subtitle", style: { paddingTop: "8px" } },
            "Custom heuristic values for the first power profile component."),
        );

        const inputs = valueNames.map((name, index) =>
          el("div", { class: "row", style: { padding: "4px 0" } },
            el("div", { class: "row-label" }, el("span", { class: "row-title" }, `${index}: ${name}`)),
            el("div", { class: "row-control" },
              numberControl({
                value: current[index] ?? 0,
                min: -2147483648,
                max: 2147483647,
                step: 1,
                onChange: (value) => {
                  ctx.edit((config) => {
                    const rows = [...(config.custom_power_profile_mode_hueristics || [[]])];
                    const first = [...(rows[0] || [])];
                    while (first.length <= index) first.push(0);
                    first[index] = value ?? 0;
                    rows[0] = first;
                    config.custom_power_profile_mode_hueristics = rows;
                  });
                },
              }),
            ),
          ),
        );

        heuristicsHost.append(...inputs);
      }

      const modeSection = section("Power profile mode", {
        note: "Requires the performance level to be set to Manual. Heuristic names come from the GPU firmware.",
        body: el("div", {},
          el("div", { class: "row" },
            el("div", { class: "row-label" },
              el("span", { class: "row-title" }, "Mode"),
              el("span", { class: "row-subtitle" }, `active: ${profileModes.modes[profileModes.active]?.name ?? "unknown"}`),
            ),
            el("div", { class: "row-control" },
              selectControl({
                options: modes,
                value: selectedIndex,
                onChange: (value) => {
                  ctx.edit((config) => {
                    config.power_profile_mode_index = Number(value);
                  });
                  ctx.rerender();
                },
              }),
            ),
          ),
          heuristicsHost,
        ),
      });

      root.append(modeSection.root);
    }

    // ------------------------------------------------------------------ power states (AMD)

    if (powerStates && (powerStates.core?.length || powerStates.vram?.length)) {
      const enabledOf = (kind) => draft.power_states?.[kind] ?? null;

      const summary = (kind, states) => {
        const enabled = enabledOf(kind);
        if (!enabled) return `all (${states.length})`;
        return `${enabled.length} of ${states.length}`;
      };

      root.append(
        section("Power states", {
          note: "Select which DPM states may be used. Disabling states can reduce power draw, but also performance.",
          body: el("div", {},
            el("div", { class: "row" },
              el("div", { class: "row-label" }, el("span", { class: "row-title" }, "GPU states")),
              el("div", { class: "row-control" },
                el("span", { class: "badge" }, summary("core_clock", powerStates.core || [])),
                button("Edit", { kind: "small", onClick: () => openStates("core_clock", "GPU states", powerStates.core || []) }),
              ),
            ),
            el("div", { class: "row" },
              el("div", { class: "row-label" }, el("span", { class: "row-title" }, "Memory states")),
              el("div", { class: "row-control" },
                el("span", { class: "badge" }, summary("memory_clock", powerStates.vram || [])),
                button("Edit", { kind: "small", onClick: () => openStates("memory_clock", "Memory states", powerStates.vram || []) }),
              ),
            ),
          ),
        }).root,
      );

      function openStates(kind, title, states) {
        const enabledIds = new Set(
          draft.power_states?.[kind] ?? states.filter((state) => state.enabled).map((state) => state.id ?? state.value),
        );

        const body = el("div", { class: "stack" });

        for (const state of states) {
          const id = state.id ?? state.value;
          const toggle = switchControl({
            checked: enabledIds.has(id),
            onChange: (value) => {
              if (value) enabledIds.add(id);
              else enabledIds.delete(id);
            },
          });

          body.append(
            el("div", { class: "row" },
              el("div", { class: "row-label" },
                el("span", { class: "row-title" }, `State ${id}`),
                el("span", { class: "row-subtitle" },
                  [state.value ? `${state.value} MHz` : null, state.min_value ? `min ${state.min_value} MHz` : null]
                    .filter(Boolean).join(" · ") || "—"),
              ),
              el("div", { class: "row-control" }, toggle),
            ),
          );
        }

        modal({
          title,
          body,
          actions: [
            { label: "Cancel" },
            {
              label: "Save",
              kind: "suggested",
              onClick: () => {
                ctx.edit((config) => {
                  config.power_states = { ...(config.power_states || {}), [kind]: [...enabledIds].sort((a, b) => a - b) };
                });
                ctx.rerender();
              },
            },
          ],
        });
      }
    }

    // ------------------------------------------------------------------ maintenance

    const maintenance = section("Maintenance", {
      body: el("div", {},
        el("div", { class: "row" },
          el("div", { class: "row-label" },
            el("span", { class: "row-title" }, "Detach GPU"),
            el("span", { class: "row-subtitle" }, "Unbind the device from its driver (useful for VFIO passthrough)"),
          ),
          el("div", { class: "row-control" },
            button("Detach", {
              kind: "small",
              onClick: async () => {
                const ok = await confirmDialog({
                  title: "Detach GPU?",
                  message: "The GPU will be removed from the driver. A display connected to it will go dark.",
                  confirmLabel: "Detach",
                  destructive: true,
                });
                if (!ok) return;
                try {
                  await api.device.detach(ctx.deviceId);
                  toast("GPU detached", "success");
                } catch (error) {
                  toast(error.message, "error");
                }
              },
            }),
            button("Reattach", {
              kind: "small",
              onClick: async () => {
                try {
                  await api.device.reattach(ctx.deviceId);
                  toast("GPU reattached", "success");
                } catch (error) {
                  toast(error.message, "error");
                }
              },
            }),
          ),
        ),
        el("div", { class: "row" },
          el("div", { class: "row-label" },
            el("span", { class: "row-title" }, "Reset configuration"),
            el("span", { class: "row-subtitle" }, "Remove all saved settings for this GPU and reload the defaults"),
          ),
          el("div", { class: "row-control" },
            button("Reset", {
              kind: "small destructive",
              onClick: async () => {
                const ok = await confirmDialog({
                  title: "Reset configuration?",
                  message: "All saved settings for every GPU are removed from the daemon configuration.",
                  confirmLabel: "Reset",
                  destructive: true,
                });
                if (!ok) return;
                try {
                  await api.resetConfig();
                  toast("Configuration reset", "success");
                  ctx.refresh();
                } catch (error) {
                  toast(error.message, "error");
                }
              },
            }),
          ),
        ),
      ),
    });

    root.append(maintenance.root);

    if (root.childElementCount === 0) {
      root.append(emptyState("This GPU does not expose any overclocking controls.", "gauge"));
    }

    void switchControl;
    return { root };
  },
};
