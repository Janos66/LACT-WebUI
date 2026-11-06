/** Builds the information rows the GTK app renders via `DeviceInfo::info_elements()`.
 *
 *  Why client-side: the daemon-side helper localizes labels using the *server's* locale, which is
 *  wrong for a browser UI that may be opened from any machine. The values and their formatting
 *  (vendor/model ids, cache descriptions, PCIe link, VRAM type) follow upstream exactly.
 *  `/api/devices/{id}/info-rows` still exists for API consumers.
 */

import { fmt } from "./dom.js";

export function buildInfoRows(info, stats) {
  if (!info) return [];

  const pci = info.pci_info;
  const drm = info.drm_info || {};
  const rows = [];

  const add = (name, value) => {
    if (value === null || value === undefined || value === "") return;
    rows.push({ name, value: String(value) });
  };

  // --- identity -------------------------------------------------------------------------------
  let gpuModel = drm.device_name || pci?.device_pci_info?.model || "Unknown";

  let subvendor = pci?.subsystem_pci_info?.vendor || "Unknown";
  let subdevice = pci?.subsystem_pci_info?.model || "Unknown";

  if (pci) {
    const vendorId = pci.device_pci_info?.vendor_id;
    const modelId = pci.device_pci_info?.model_id;

    if (drm.pci_revision_id !== undefined && drm.pci_revision_id !== null) {
      gpuModel += ` (0x${vendorId}:0x${modelId}:0x${drm.pci_revision_id.toString(16).toUpperCase()})`;
    } else {
      gpuModel += ` (0x${vendorId}:0x${modelId})`;
    }

    subvendor += ` (0x${pci.subsystem_pci_info?.vendor_id})`;
    subdevice += ` (0x${pci.subsystem_pci_info?.model_id})`;
  }

  add("GPU Model", gpuModel);
  add("Subvendor", subvendor);
  add("Subdevice", subdevice);
  add("Driver used", info.driver);

  // --- silicon --------------------------------------------------------------------------------
  const vramType = formatVramType(drm);
  add("VBIOS version", info.vbios_version);
  add("VRAM size", stats?.vram?.total ? `${Math.round(stats.vram.total / 1024 / 1024)} MiB` : null);
  add("GPU family", drm.family_name);
  add("ASIC name", drm.asic_name);
  add("Compute units", drm.compute_units);
  // `IntelDrmInfo` is flattened by serde, so its fields live directly on `drm_info`.
  add("Execution units", drm.execution_units ?? drm.intel?.execution_units);
  add("Subslices", drm.subslices ?? drm.intel?.subslices);
  add("CUDA cores", drm.cuda_cores);
  add("SM count", drm.streaming_multiprocessors);

  if (drm.rop_info) {
    const rop = drm.rop_info;
    add("ROP count", `${rop.operations_count} (${rop.unit_count} * ${rop.operations_factor})`);
  }

  add("ISA", drm.isa);
  add("VRAM type", vramType);

  if (drm.memory_info) {
    if (drm.memory_info.resizeable_bar !== null && drm.memory_info.resizeable_bar !== undefined) {
      add("ReBar", drm.memory_info.resizeable_bar ? "Enabled" : "Disabled");
    }
    add("CPU VRAM", `${Math.round((drm.memory_info.cpu_accessible_total ?? 0) / 1024 / 1024)} MiB`);
  }

  // --- link -----------------------------------------------------------------------------------
  const link = info.link_info || {};
  if (link.current_speed && link.current_width) {
    const max = link.max_speed && link.max_width ? ` (Max: ${link.max_speed} x${link.max_width})` : "";
    add("PCIe speed", `${link.current_speed} x${link.current_width}${max}`);
  }

  return rows;
}

function formatVramType(drm) {
  if (!drm.vram_type) return null;

  let type = drm.vram_type;
  if (drm.vram_bit_width) type += ` ${drm.vram_bit_width}-bit`;
  if (drm.vram_vendor) type += ` (${drm.vram_vendor})`;
  if (drm.vram_max_bw && drm.vram_max_bw !== "0") type += ` ${drm.vram_max_bw} GiB/s`;

  return type;
}

/** Cache entries, mirroring `CacheInfo` (AMD: a list of [instance, count] pairs). */
export function buildCacheRows(info) {
  const cache = info?.drm_info?.cache_info;
  if (!cache) return [];

  if (cache.Amd) {
    return cache.Amd.map(([instance, count]) => ({
      count,
      text: `${fmt.bytes(instance.size)} L${instance.level} ${instance.types.join("+")} cache shared by ${instance.cu_count} CUs`,
    }));
  }

  if (cache.Nvidia) {
    return [{ count: 1, text: `${fmt.bytes(cache.Nvidia.l2)} L2 cache` }];
  }

  return [];
}

/** AMD IP block inventory (`amd_ip_info`). */
export function buildIpRows(info) {
  const ips = info?.drm_info?.amd_ip_info || [];
  return ips.map((ip) => ({
    name: `${ip.ip_type} v${ip.version_major}.${ip.version_minor}`,
    value: `${ip.count}x, ${ip.queues} queues`,
  }));
}
