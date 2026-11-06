//! Hardware information beyond the GPU.
//!
//! These endpoints are additive to upstream LACT: they let a headless box be inspected from the
//! same page as the GPU (SMART/NVMe health, hwmon sensors, host load). Everything is read-only and
//! degrades gracefully when a tool or file is missing.

use axum::{Json, extract::Query};
use serde::Serialize;
use serde_json::{Value, json};
use std::{collections::HashMap, path::Path, process::Stdio, time::Duration};
use tokio::process::Command;

const CMD_TIMEOUT: Duration = Duration::from_secs(10);

async fn read(path: impl AsRef<Path>) -> Option<String> {
    tokio::fs::read_to_string(path)
        .await
        .ok()
        .map(|value| value.trim().to_owned())
}

async fn read_num(path: impl AsRef<Path>) -> Option<i64> {
    let value = read(path).await?;
    value.parse().ok()
}

/// Run a command and capture stdout, returning `None` when it fails or times out.
async fn run(program: &str, args: &[&str]) -> Option<String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;

    let stdout = child.stdout.take()?;

    // Drain stdout concurrently: waiting first would deadlock once the pipe buffer fills.
    let reader = tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = Vec::new();
        let mut stdout = stdout;
        let _ = stdout.read_to_end(&mut buf).await;
        buf
    });

    match tokio::time::timeout(CMD_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) if status.success() => {
            let bytes = reader.await.ok()?;
            Some(String::from_utf8_lossy(&bytes).to_string())
        }
        Ok(Ok(_)) => {
            let _ = reader.await;
            None
        }
        Ok(Err(_)) => {
            let _ = reader.await;
            None
        }
        Err(_) => {
            let _ = child.start_kill();
            let _ = reader.await;
            None
        }
    }
}

async fn which(program: &str) -> bool {
    run("sh", &["-c", &format!("command -v {program}")])
        .await
        .is_some()
}

// ---------------------------------------------------------------------------------------------
// Host system
// ---------------------------------------------------------------------------------------------

pub async fn system() -> Json<Value> {
    let cpuinfo = read("/proc/cpuinfo").await.unwrap_or_default();

    let cpu_model = cpuinfo
        .lines()
        .find(|line| line.starts_with("model name"))
        .and_then(|line| line.split_once(':'))
        .map(|(_, value)| value.trim().to_owned())
        .unwrap_or_else(|| "unknown".to_owned());

    let physical_cores = cpuinfo
        .lines()
        .filter(|line| line.starts_with("cpu cores"))
        .filter_map(|line| line.split_once(':'))
        .filter_map(|(_, value)| value.trim().parse::<u32>().ok())
        .max();

    let logical_cpus = cpuinfo
        .lines()
        .filter(|line| line.starts_with("processor"))
        .count() as u32;

    let loadavg = read("/proc/loadavg").await.unwrap_or_default();
    let load: Vec<f32> = loadavg
        .split_whitespace()
        .take(3)
        .filter_map(|value| value.parse().ok())
        .collect();

    let uptime = read("/proc/uptime")
        .await
        .and_then(|value| value.split_whitespace().next()?.parse::<f64>().ok())
        .unwrap_or(0.0);

    let meminfo = parse_meminfo(&read("/proc/meminfo").await.unwrap_or_default());
    let os_release = read("/etc/os-release").await.unwrap_or_default();
    let pretty_name = os_release
        .lines()
        .find(|line| line.starts_with("PRETTY_NAME="))
        .map(|line| line.trim_start_matches("PRETTY_NAME=").trim_matches('"').to_owned());

    let kernel = read("/proc/sys/kernel/osrelease").await.unwrap_or_default();
    let hostname = read("/proc/sys/kernel/hostname").await.unwrap_or_default();

    let total_kb = meminfo.get("MemTotal").copied().unwrap_or(0);
    let available_kb = meminfo.get("MemAvailable").copied().unwrap_or(0);
    let swap_total_kb = meminfo.get("SwapTotal").copied().unwrap_or(0);
    let swap_free_kb = meminfo.get("SwapFree").copied().unwrap_or(0);

    Json(json!({
        "hostname": hostname,
        "cpu": {
            "model": cpu_model,
            "physical_cores": physical_cores,
            "logical_cores": logical_cpus,
            "load": load,
        },
        "memory": {
            "total_kb": total_kb,
            "available_kb": available_kb,
            "used_kb": total_kb.saturating_sub(available_kb),
            "swap_total_kb": swap_total_kb,
            "swap_used_kb": swap_total_kb.saturating_sub(swap_free_kb),
        },
        "uptime_seconds": uptime as u64,
        "os": pretty_name,
        "kernel": kernel,
    }))
}

fn parse_meminfo(contents: &str) -> HashMap<String, u64> {
    contents
        .lines()
        .filter_map(|line| {
            let (key, rest) = line.split_once(':')?;
            let value = rest.split_whitespace().next()?.parse().ok()?;
            Some((key.to_owned(), value))
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// hwmon sensors
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct Sensor {
    chip: String,
    chip_path: String,
    kind: String,
    label: String,
    value: f64,
    unit: String,
}

pub async fn sensors() -> Json<Value> {
    let mut chips: Vec<Value> = Vec::new();
    let mut sensors: Vec<Sensor> = Vec::new();

    let Ok(mut dir) = tokio::fs::read_dir("/sys/class/hwmon").await else {
        return Json(json!({ "chips": chips, "sensors": sensors }));
    };

    while let Ok(Some(entry)) = dir.next_entry().await {
        let path = entry.path();
        let name = read(path.join("name"))
            .await
            .unwrap_or_else(|| "unknown".to_owned());

        let mut chip_sensors = 0usize;

        // Temperature inputs are the most common; scan a fixed window like lm-sensors does.
        for index in 1..=16 {
            let Some(raw) = read_num(path.join(format!("temp{index}_input"))).await else {
                continue;
            };

            let label = read(path.join(format!("temp{index}_label")))
                .await
                .unwrap_or_else(|| format!("temp{index}"));

            sensors.push(Sensor {
                chip: name.clone(),
                chip_path: path.display().to_string(),
                kind: "temperature".to_owned(),
                label,
                value: raw as f64 / 1000.0,
                unit: "°C".to_owned(),
            });
            chip_sensors += 1;
        }

        for index in 1..=8 {
            if let Some(raw) = read_num(path.join(format!("fan{index}_input"))).await {
                let label = read(path.join(format!("fan{index}_label")))
                    .await
                    .unwrap_or_else(|| format!("fan{index}"));

                sensors.push(Sensor {
                    chip: name.clone(),
                    chip_path: path.display().to_string(),
                    kind: "fan".to_owned(),
                    label,
                    value: raw as f64,
                    unit: "RPM".to_owned(),
                });
                chip_sensors += 1;
            }
        }

        for index in 1..=16 {
            if let Some(raw) = read_num(path.join(format!("in{index}_input"))).await {
                let label = read(path.join(format!("in{index}_label")))
                    .await
                    .unwrap_or_else(|| format!("in{index}"));

                sensors.push(Sensor {
                    chip: name.clone(),
                    chip_path: path.display().to_string(),
                    kind: "voltage".to_owned(),
                    label,
                    value: raw as f64 / 1000.0,
                    unit: "V".to_owned(),
                });
                chip_sensors += 1;
            }
        }

        for index in 1..=4 {
            if let Some(raw) = read_num(path.join(format!("power{index}_input"))).await {
                let label = read(path.join(format!("power{index}_label")))
                    .await
                    .unwrap_or_else(|| format!("power{index}"));

                sensors.push(Sensor {
                    chip: name.clone(),
                    chip_path: path.display().to_string(),
                    kind: "power".to_owned(),
                    label,
                    value: raw as f64 / 1_000_000.0,
                    unit: "W".to_owned(),
                });
                chip_sensors += 1;
            }
        }

        if let Some(raw) = read_num(path.join("curr1_input")).await {
            sensors.push(Sensor {
                chip: name.clone(),
                chip_path: path.display().to_string(),
                kind: "current".to_owned(),
                label: "curr1".to_owned(),
                value: raw as f64 / 1000.0,
                unit: "A".to_owned(),
            });
            chip_sensors += 1;
        }

        if let Some(pwm) = read_num(path.join("pwm1")).await {
            sensors.push(Sensor {
                chip: name.clone(),
                chip_path: path.display().to_string(),
                kind: "pwm".to_owned(),
                label: "pwm1".to_owned(),
                value: pwm as f64,
                unit: "".to_owned(),
            });
            chip_sensors += 1;
        }

        if chip_sensors > 0 {
            chips.push(json!({
                "name": name,
                "path": path.display().to_string(),
                "sensor_count": chip_sensors,
            }));
        }
    }

    Json(json!({ "chips": chips, "sensors": sensors }))
}

// ---------------------------------------------------------------------------------------------
// NVMe / SMART
// ---------------------------------------------------------------------------------------------

pub async fn nvme() -> Json<Value> {
    let has_nvme = which("nvme").await;

    if !has_nvme {
        return Json(json!({
            "available": false,
            "reason": "the `nvme` CLI is not installed (package: nvme-cli)",
            "drives": [],
        }));
    }

    let Some(list_raw) = run("nvme", &["list", "--output-format=json"]).await else {
        return Json(json!({
            "available": true,
            "reason": "`nvme list` returned no data (no NVMe devices or insufficient permissions)",
            "drives": [],
        }));
    };

    let list: Value = match serde_json::from_str(&list_raw) {
        Ok(value) => value,
        Err(err) => {
            return Json(json!({
                "available": true,
                "reason": format!("could not parse `nvme list`: {err}"),
                "drives": [],
            }));
        }
    };

    let mut drives = Vec::new();
    let empty = Vec::new();
    let devices = list
        .get("Devices")
        .and_then(Value::as_array)
        .unwrap_or(&empty);

    for device in devices {
        let node = device
            .get("DevicePath")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();

        let smart: Option<Value> = if node.is_empty() {
            None
        } else {
            run("nvme", &["smart-log", "--output-format=json", &node])
                .await
                .and_then(|raw| serde_json::from_str(&raw).ok())
        };

        drives.push(json!({
            "device": node,
            "model": device.get("ModelNumber").cloned().unwrap_or(Value::Null),
            "serial": device.get("SerialNumber").cloned().unwrap_or(Value::Null),
            "firmware": device.get("Firmware").cloned().unwrap_or(Value::Null),
            "size_bytes": device.get("PhysicalSize").cloned().unwrap_or(Value::Null),
            "smart": smart,
            "health": smart.as_ref().and_then(|smart| {
                smart.get("critical_warning").and_then(Value::as_u64).map(|warning| {
                    if warning == 0 { "ok" } else { "warning" }
                })
            }),
        }));
    }

    Json(json!({
        "available": true,
        "reason": Value::Null,
        "drives": drives,
    }))
}

pub async fn drives() -> Json<Value> {
    let mut out = Vec::new();

    let Ok(mut dir) = tokio::fs::read_dir("/sys/block").await else {
        return Json(json!({ "drives": out }));
    };

    while let Ok(Some(entry)) = dir.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip virtual block devices, they carry no useful health data.
        if name.starts_with("loop")
            || name.starts_with("ram")
            || name.starts_with("zram")
            || name.starts_with("dm-")
            || name.starts_with("md")
        {
            continue;
        }

        let path = entry.path();
        let sectors = read_num(path.join("size")).await.unwrap_or(0) as f64;
        let rotational = read_num(path.join("queue/rotational")).await.unwrap_or(0);

        out.push(json!({
            "name": name,
            "size_bytes": (sectors * 512.0) as u64,
            "model": read(path.join("device/model")).await,
            "serial": read(path.join("device/serial")).await,
            "rotational": rotational == 1,
        }));
    }

    out.sort_by(|a, b| {
        let left = a.get("name").and_then(Value::as_str).unwrap_or_default();
        let right = b.get("name").and_then(Value::as_str).unwrap_or_default();
        left.cmp(right)
    });

    Json(json!({ "drives": out, "smartctl_available": which("smartctl").await }))
}

// ---------------------------------------------------------------------------------------------
// PCI inventory
// ---------------------------------------------------------------------------------------------

pub async fn pci() -> Json<Value> {
    let mut devices = Vec::new();

    let Ok(mut dir) = tokio::fs::read_dir("/sys/bus/pci/devices").await else {
        return Json(json!({ "devices": devices }));
    };

    while let Ok(Some(entry)) = dir.next_entry().await {
        let path = entry.path();
        let address = entry.file_name().to_string_lossy().to_string();

        devices.push(json!({
            "address": address,
            "vendor": read(path.join("vendor")).await,
            "device": read(path.join("device")).await,
            "class": read(path.join("class")).await,
            "driver": tokio::fs::read_link(path.join("driver"))
                .await
                .ok()
                .and_then(|target| {
                    target
                        .file_name()
                        .map(|name| name.to_string_lossy().to_string())
                }),
            "label": read(path.join("label")).await,
        }));
    }

    devices.sort_by(|a, b| {
        let left = a.get("address").and_then(Value::as_str).unwrap_or_default();
        let right = b.get("address").and_then(Value::as_str).unwrap_or_default();
        left.cmp(right)
    });

    Json(json!({ "devices": devices }))
}

// ---------------------------------------------------------------------------------------------
// Service status
// ---------------------------------------------------------------------------------------------

pub async fn services(Query(query): Query<HashMap<String, String>>) -> Json<Value> {
    let names: Vec<String> = match query.get("names") {
        Some(names) => names.split(',').map(|name| name.trim().to_owned()).collect(),
        None => vec![
            "lactd".to_owned(),
            "lact-webui".to_owned(),
        ],
    };

    let mut out = Vec::new();
    for name in names {
        let state = run("systemctl", &["is-active", &name])
            .await
            .map(|value| value.trim().to_owned())
            .unwrap_or_else(|| "unknown".to_owned());

        out.push(json!({ "name": name, "active_state": state }));
    }

    Json(json!({ "services": out }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_meminfo() {
        let map = parse_meminfo("MemTotal:       16000 kB\nMemAvailable:    8000 kB\n");
        assert_eq!(map.get("MemTotal"), Some(&16000));
        assert_eq!(map.get("MemAvailable"), Some(&8000));
    }
}
