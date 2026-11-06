/** Thermals page — upstream's `thermals_page.rs`: fan mode (auto/curve/static), fan curve editor,
 *  spindown/threshold tuning and AMD PMFW firmware thermal limits. */

import { el, fmt } from "../dom.js";
import { FanCurveEditor } from "../fancurve.js";
import { primaryTemp } from "../store.js";
import {
  badge,
  button,
  numberControl,
  section,
  segmented,
  selectControl,
  sliderControl,
  switchControl,
  tile,
  toast,
} from "../ui.js";

const DEFAULT_CURVE = { 40: 0.3, 50: 0.35, 60: 0.5, 70: 0.75, 80: 1.0 };

export default {
  id: "thermals",
  title: "Thermals",
  icon: "fan",

  render(ctx) {
    const { state } = ctx;
    const stats = state.stats || {};
    const fan = stats.fan || {};
    const root = el("div", { class: "stack" });

    const tiles = {
      temp: tile("Temperature", fmt.temp(primaryTemp(stats)), { iconName: "thermometer" }),
      rpm: tile(
        "Fan speed",
        fan.speed_current !== null && fan.speed_current !== undefined ? fmt.number(fan.speed_current) : "—",
        { unit: "RPM", iconName: "fan" },
      ),
      pwm: tile("PWM", fan.pwm_current !== null && fan.pwm_current !== undefined ? fmt.percent((fan.pwm_current / 255) * 100) : "—", {
        iconName: "fan",
        bar: fan.pwm_current !== null && fan.pwm_current !== undefined ? (fan.pwm_current / 255) * 100 : null,
      }),
      mode: tile("Control mode", controlModeLabel(state.draft)),
    };

    root.append(section("Live", { body: el("div", { class: "tiles" }, Object.values(tiles).map((entry) => entry.root)) }).root);

    // ------------------------------------------------------------------ fan control

    const modePanel = el("div", { class: "stack", style: { padding: "10px 16px 14px" } });

    const currentMode = fanMode(state.draft);

    const modeSwitch = segmented({
      options: [
        { value: "auto", label: "Automatic" },
        { value: "curve", label: "Curve" },
        { value: "static", label: "Static" },
      ],
      value: currentMode,
      onChange: (next) => {
        ctx.edit((draft) => {
          if (next === "auto") {
            draft.fan_control_enabled = false;
          } else {
            draft.fan_control_enabled = true;
            const settings = ensureSettings(draft, stats);
            settings.mode = next;
          }
        });
        tiles.mode.set(controlModeLabel(state.draft));
        renderPanel();
      },
    });

    const fanSection = section("Fan control", {
      actions: [badge(fanControlSupported(state) ? "configurable" : "read-only")],
      body: el("div", {}, el("div", { style: { padding: "10px 16px 0" } }, modeSwitch), modePanel),
    });

    const supported = fanControlSupported(state);
    if (!supported) {
      // No ConfigurableFanControl flag: the daemon would reject writes, so lock the controls.
      fanSection.root.querySelector(".badge")?.classList.add("warn");
      modeSwitch.querySelectorAll("button").forEach((button) => {
        button.disabled = true;
      });
    }

    root.append(fanSection.root);

    function renderPanel() {
      modePanel.replaceChildren();

      if (!supported) {
        modePanel.append(
          el("div", { class: "section-note", style: { padding: "0" } },
            "This GPU does not expose fan control through the driver. Monitoring values, if any, are still shown."),
        );
        return;
      }

      const mode = fanMode(state.draft);

      if (mode === "auto") {
        modePanel.append(
          el(
            "div",
            { class: "section-note", style: { padding: "0" } },
            "The GPU firmware controls the fan. Configure a curve or a static speed to take over.",
          ),
        );
        return;
      }

      const settings = state.draft.fan_control_settings;

      if (mode === "static") {
        const speed = Math.round((settings?.static_speed ?? 0.5) * 100);
        const slider = sliderControl({
          min: 0,
          max: 100,
          step: 1,
          value: speed,
          format: (value) => `${value}%`,
          onInput: (value) => {
            ctx.edit((draft) => {
              const target = ensureSettings(draft, stats);
              target.mode = "static";
              target.static_speed = value / 100;
            });
          },
        });

        modePanel.append(
          el(
            "div",
            { class: "row", style: { padding: "0" } },
            el("div", { class: "row-label" },
              el("span", { class: "row-title" }, "Static speed"),
              el("span", { class: "row-subtitle" }, "Fixed fan duty cycle"),
            ),
            el("div", { class: "row-control" }, slider),
          ),
        );
        return;
      }

      // ---------------------------------------------------------------- curve mode
      const curve = settings?.curve || DEFAULT_CURVE;
      const tempRange = fan.temperature_range || [20, 115];

      const legend = el("div", { class: "curve-legend" });
      const curveWrap = el("div", { class: "curve-wrap" });

      const editor = new FanCurveEditor(curveWrap, {
        curve,
        tempRange,
        currentTemp: primaryTemp(stats),
        onChange: (nextCurve) => {
          ctx.edit((draft) => {
            const target = ensureSettings(draft, stats);
            target.mode = "curve";
            target.curve = nextCurve;
          });
          updateLegend();
        },
      });

      function updateLegend() {
        const points = Object.entries(editor.toCurve())
          .map(([temp, speed]) => `${temp}°→${Math.round(speed * 100)}%`)
          .join("   ");
        legend.replaceChildren(el("span", {}, "Points: "), el("b", {}, points));
      }

      updateLegend();

      const tempKeys = Object.keys(stats.temps || {});
      const tempKey = settings?.temperature_key || tempKeys[0] || "";

      const tempSelect = selectControl({
        options: tempKeys.map((key) => ({
          value: key,
          label: `${key}${stats.temps[key]?.value !== undefined ? ` (${fmt.temp(stats.temps[key].value)})` : ""}`,
        })),
        value: tempKey,
        onChange: (value) => {
          ctx.edit((draft) => {
            ensureSettings(draft, stats).temperature_key = value;
          });
        },
      });

      const spindown = numberControl({
        value: settings?.spindown_delay_ms ?? null,
        min: 0,
        max: 60000,
        step: 100,
        suffix: "ms",
        placeholder: "daemon default",
        onChange: (value) => {
          ctx.edit((draft) => {
            ensureSettings(draft, stats).spindown_delay_ms = value;
          });
        },
      });

      const threshold = numberControl({
        value: settings?.change_threshold ?? null,
        min: 0,
        max: 100,
        step: 1,
        suffix: "%",
        placeholder: "daemon default",
        onChange: (value) => {
          ctx.edit((draft) => {
            ensureSettings(draft, stats).change_threshold = value;
          });
        },
      });

      const resetButton = button("Reset curve", {
        kind: "small",
        iconName: "refresh",
        onClick: () => {
          editor.setCurve(DEFAULT_CURVE);
          updateLegend();
          ctx.edit((draft) => {
            const target = ensureSettings(draft, stats);
            target.mode = "curve";
            target.curve = { ...DEFAULT_CURVE };
          });
        },
      });

      modePanel.append(
        el("div", { class: "wrap", style: { justifyContent: "space-between" } },
          el("span", { class: "row-title" }, "Fan curve"),
          resetButton,
        ),
        curveWrap,
        legend,
        el("div", { class: "row", style: { padding: "8px 0 0" } },
          el("div", { class: "row-label" },
            el("span", { class: "row-title" }, "Temperature sensor"),
            el("span", { class: "row-subtitle" }, "Which sensor drives the curve"),
          ),
          el("div", { class: "row-control" }, tempKeys.length ? tempSelect : el("span", { class: "hint" }, "no sensors")),
        ),
        el("div", { class: "row", style: { padding: "8px 0 0" } },
          el("div", { class: "row-label" },
            el("span", { class: "row-title" }, "Spindown delay"),
            el("span", { class: "row-subtitle" }, "Keep the fan at its last speed after the temperature drops"),
          ),
          el("div", { class: "row-control" }, spindown),
        ),
        el("div", { class: "row", style: { padding: "8px 0 0" } },
          el("div", { class: "row-label" },
            el("span", { class: "row-title" }, "Change threshold"),
            el("span", { class: "row-subtitle" }, "Ignore curve moves smaller than this"),
          ),
          el("div", { class: "row-control" }, threshold),
        ),
      );

      this._editor = editor;
      this._updateLegend = updateLegend;
    }

    renderPanel();

    // ------------------------------------------------------------------ PMFW

    const pmfwInfo = fan.pmfw_info;
    if (pmfwInfo && Object.keys(pmfwInfo).length > 0) {
      const pmfw = state.draft.pmfw_options || {};
      const body = el("div", {});

      const pmfwRow = (label, key, info, unit = "°C") => {
        if (!info) return null;
        const [min, max] = info.allowed_range || [0, 100];
        return numRow({
          title: label,
          subtitle: `current ${info.current}${unit} · range ${min}–${max}${unit}`,
          value: pmfw[key] ?? null,
          min,
          max,
          suffix: unit,
          onChange: (value) => ctx.edit((draft) => {
            draft.pmfw_options = { ...(draft.pmfw_options || {}), [key]: value };
          }),
        });
      };

      body.append(
        pmfwRow("Target temperature", "target_temperature", pmfwInfo.target_temp),
        pmfwRow("Acoustic limit", "acoustic_limit", pmfwInfo.acoustic_limit),
        pmfwRow("Acoustic target", "acoustic_target", pmfwInfo.acoustic_target),
        pmfwRow("Minimum PWM", "minimum_pwm", pmfwInfo.minimum_pwm, ""),
      );

      if (pmfwInfo.zero_rpm_enable !== null && pmfwInfo.zero_rpm_enable !== undefined) {
        const zeroRpm = switchControl({
          checked: pmfw.zero_rpm ?? pmfwInfo.zero_rpm_enable,
          onChange: (value) => ctx.edit((draft) => {
            draft.pmfw_options = { ...(draft.pmfw_options || {}), zero_rpm: value };
          }),
        });

        body.append(
          el("div", { class: "row" },
            el("div", { class: "row-label" },
              el("span", { class: "row-title" }, "Zero RPM"),
              el("span", { class: "row-subtitle" }, "Stop the fan below a temperature threshold"),
            ),
            el("div", { class: "row-control" }, zeroRpm),
          ),
        );

        if (pmfwInfo.zero_rpm_temperature) {
          const info = pmfwInfo.zero_rpm_temperature;
          const [min, max] = info.allowed_range || [0, 100];
          body.append(
            numRow({
              title: "Zero RPM threshold",
              subtitle: `current ${info.current}°C · range ${min}–${max}°C`,
              value: pmfw.zero_rpm_threshold ?? null,
              min,
              max,
              suffix: "°C",
              onChange: (value) => ctx.edit((draft) => {
                draft.pmfw_options = { ...(draft.pmfw_options || {}), zero_rpm_threshold: value };
              }),
            }),
          );
        }
      }

      root.append(
        section("Firmware thermal limits", {
          note: "PMFW limits are applied by the GPU firmware and also apply in automatic mode.",
          body,
        }).root,
      );
    }

    // ------------------------------------------------------------------ Nvidia auto threshold

    if (Array.isArray(state.info?.flags) && state.info.flags.includes("AutoFanThreshold")) {
      const settings = state.draft.fan_control_settings;
      root.append(
        section("NVIDIA fan behaviour", {
          body: numRow({
            title: "Automatic fan threshold",
            subtitle: "Temperature above which the fan starts spinning",
            value: settings?.auto_threshold ?? null,
            min: 0,
            max: 120,
            suffix: "°C",
            onChange: (value) => ctx.edit((draft) => {
              ensureSettings(draft, stats).auto_threshold = value;
            }),
          }),
        }).root,
      );
    }

    return {
      root,
      onStats(next) {
        const nextStats = next || {};
        const nextFan = nextStats.fan || {};
        tiles.temp.set(fmt.temp(primaryTemp(nextStats)));
        tiles.rpm.set(
          nextFan.speed_current !== null && nextFan.speed_current !== undefined
            ? fmt.number(nextFan.speed_current)
            : "—",
        );
        tiles.pwm.set(
          nextFan.pwm_current !== null && nextFan.pwm_current !== undefined
            ? fmt.percent((nextFan.pwm_current / 255) * 100)
            : "—",
          undefined,
          nextFan.pwm_current !== null && nextFan.pwm_current !== undefined
            ? (nextFan.pwm_current / 255) * 100
            : null,
        );
        if (this._editor) this._editor.setCurrentTemp(primaryTemp(nextStats));
      },
    };
  },
};

// ---------------------------------------------------------------------------- helpers

function numRow({ title, subtitle, value, min, max, suffix, onChange }) {
  return el(
    "div",
    { class: "row" },
    el("div", { class: "row-label" },
      el("span", { class: "row-title" }, title),
      subtitle ? el("span", { class: "row-subtitle" }, subtitle) : null,
    ),
    el("div", { class: "row-control" }, numberControl({ value, min, max, step: 1, suffix, onChange })),
  );
}

function fanMode(draft) {
  if (!draft?.fan_control_enabled) return "auto";
  return draft.fan_control_settings?.mode || "curve";
}

function controlModeLabel(draft) {
  const mode = fanMode(draft);
  if (mode === "auto") return "Automatic";
  if (mode === "static") return "Static";
  return "Curve";
}

function fanControlSupported(state) {
  const flags = state.info?.flags;
  if (!Array.isArray(flags)) return true;
  return flags.includes("ConfigurableFanControl");
}

/** Create a complete FanControlSettings object the first time the user takes over the fan. */
function ensureSettings(draft, stats) {
  if (!draft.fan_control_settings) {
    const tempKeys = Object.keys(stats.temps || {});
    draft.fan_control_settings = {
      mode: "curve",
      static_speed: 0.5,
      temperature_key: tempKeys[0] || "edge",
      interval_ms: 1000,
      curve: { ...DEFAULT_CURVE },
      spindown_delay_ms: null,
      change_threshold: null,
      auto_threshold: null,
    };
  } else {
    if (!draft.fan_control_settings.temperature_key) {
      const tempKeys = Object.keys(stats.temps || {});
      draft.fan_control_settings.temperature_key = tempKeys[0] || "edge";
    }
    if (!draft.fan_control_settings.interval_ms) {
      draft.fan_control_settings.interval_ms = 1000;
    }
    if (!draft.fan_control_settings.curve) {
      draft.fan_control_settings.curve = { ...DEFAULT_CURVE };
    }
  }

  return draft.fan_control_settings;
}
