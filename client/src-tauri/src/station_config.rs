use serde::{Deserialize, Serialize};
use std::fs;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::command;

static STATION_CONFIG_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterStationConfig {
    mode: String,
    ip: String,
    port: u16,
    system_name: String,
    language: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StationHardwareConfig {
    cash_drawer_enabled: bool,
    receipt_printer: PrinterStationConfig,
    tag_printer: PrinterStationConfig,
    report_printer: PrinterStationConfig,
}

#[cfg(windows)]
fn station_config_path() -> PathBuf {
    std::env::var_os("PROGRAMDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
        .join("RiversideOS")
        .join("station-config.json")
}

#[cfg(not(windows))]
fn station_config_path() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".riverside-os")
        .join("station-config.json")
}

#[command]
pub async fn load_station_config() -> Result<Option<serde_json::Value>, String> {
    read_station_config_value()
}

#[command]
pub fn save_station_hardware_config(hardware: StationHardwareConfig) -> Result<(), String> {
    let _guard = STATION_CONFIG_WRITE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Station setup write lock is unavailable.".to_string())?;
    validate_hardware_config(&hardware)?;

    let path = station_config_path();
    let Some(mut config) = read_station_config_value()? else {
        return Err("Riverside station setup is not installed on this computer.".to_string());
    };
    apply_hardware_config(&mut config, hardware)?;
    write_station_config_value(&path, &config)
}

fn parse_station_config(raw: &str) -> Result<serde_json::Value, serde_json::Error> {
    serde_json::from_str(raw.trim_start_matches('\u{feff}'))
}

fn validate_printer_config(printer: &PrinterStationConfig) -> Result<(), String> {
    if !matches!(printer.mode.as_str(), "network" | "system") {
        return Err("Printer mode must be network or system.".to_string());
    }
    if !matches!(printer.language.as_str(), "" | "epl" | "zpl") {
        return Err("Tag printer language must be EPL or ZPL.".to_string());
    }
    Ok(())
}

fn validate_hardware_config(hardware: &StationHardwareConfig) -> Result<(), String> {
    validate_printer_config(&hardware.receipt_printer)?;
    validate_printer_config(&hardware.tag_printer)?;
    validate_printer_config(&hardware.report_printer)
}

fn apply_hardware_config(
    config: &mut serde_json::Value,
    hardware: StationHardwareConfig,
) -> Result<(), String> {
    let register = config
        .get_mut("register")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| "Station setup is missing its register configuration.".to_string())?;
    register.insert(
        "cashDrawerEnabled".to_string(),
        serde_json::Value::Bool(hardware.cash_drawer_enabled),
    );
    register.insert(
        "receiptPrinter".to_string(),
        serde_json::to_value(hardware.receipt_printer)
            .map_err(|error| format!("Could not save receipt printer setup: {error}"))?,
    );
    register.insert(
        "tagPrinter".to_string(),
        serde_json::to_value(hardware.tag_printer)
            .map_err(|error| format!("Could not save tag printer setup: {error}"))?,
    );
    register.insert(
        "reportPrinter".to_string(),
        serde_json::to_value(hardware.report_printer)
            .map_err(|error| format!("Could not save reports printer setup: {error}"))?,
    );
    Ok(())
}

fn write_station_config_value(
    path: &std::path::Path,
    config: &serde_json::Value,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Station setup path has no parent directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create station setup directory: {error}"))?;
    let bytes = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("Could not serialize station setup: {error}"))?;
    let temp_path = path.with_extension("json.tmp");
    let backup_path = path.with_extension("json.bak");
    fs::write(&temp_path, bytes)
        .map_err(|error| format!("Could not write station setup update: {error}"))?;

    if backup_path.exists() {
        fs::remove_file(&backup_path)
            .map_err(|error| format!("Could not clear prior station setup backup: {error}"))?;
    }
    if path.exists() {
        fs::rename(path, &backup_path)
            .map_err(|error| format!("Could not preserve prior station setup: {error}"))?;
    }
    if let Err(error) = fs::rename(&temp_path, path) {
        let _ = fs::rename(&backup_path, path);
        let _ = fs::remove_file(&temp_path);
        return Err(format!("Could not activate station setup update: {error}"));
    }
    let _ = fs::remove_file(backup_path);
    Ok(())
}

pub(crate) fn read_station_config_value() -> Result<Option<serde_json::Value>, String> {
    let path = station_config_path();
    if !path.exists() {
        return Ok(None);
    }

    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("Could not read station setup file: {e}"))?;
    let value = parse_station_config(&raw)
        .map_err(|e| format!("Could not read station setup values: {e}"))?;
    Ok(Some(value))
}

pub(crate) fn is_allowed_internal_update_host(host: &str) -> bool {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(ip) => {
                ip.is_private()
                    || ip.is_loopback()
                    || (ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1]))
            }
            IpAddr::V6(ip) => ip.is_loopback() || (ip.segments()[0] & 0xfe00) == 0xfc00,
        };
    }

    !host.contains('.') || host.ends_with(".local") || host.ends_with(".ts.net")
}

#[cfg(test)]
mod tests {
    use super::{
        apply_hardware_config, parse_station_config, PrinterStationConfig, StationHardwareConfig,
    };

    #[test]
    fn station_config_accepts_windows_utf8_bom() {
        let value = parse_station_config("\u{feff}{\"register\":{\"stationLabel\":\"Main Hub\"}}")
            .expect("station config with a UTF-8 BOM should parse");

        assert_eq!(value["register"]["stationLabel"], "Main Hub");
    }

    #[test]
    fn hardware_save_preserves_station_identity() {
        let mut value = serde_json::json!({
            "releaseVersion": "0.96.0",
            "register": {
                "stationLabel": "Register #1",
                "apiBase": "http://10.64.70.196:3000"
            }
        });
        let printer = |system_name: &str| PrinterStationConfig {
            mode: "system".to_string(),
            ip: String::new(),
            port: 9100,
            system_name: system_name.to_string(),
            language: String::new(),
        };

        apply_hardware_config(
            &mut value,
            StationHardwareConfig {
                cash_drawer_enabled: true,
                receipt_printer: printer("Lightspeed Printer 1"),
                tag_printer: printer("Zebra LP 2844"),
                report_printer: printer("RMS COUNTER"),
            },
        )
        .expect("hardware config should merge");

        assert_eq!(value["register"]["stationLabel"], "Register #1");
        assert_eq!(value["register"]["apiBase"], "http://10.64.70.196:3000");
        assert_eq!(
            value["register"]["receiptPrinter"]["systemName"],
            "Lightspeed Printer 1"
        );
        assert_eq!(value["register"]["cashDrawerEnabled"], true);
    }
}
