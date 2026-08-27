use std::net::IpAddr;
use std::path::PathBuf;
use tauri::command;

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

fn parse_station_config(raw: &str) -> Result<serde_json::Value, serde_json::Error> {
    serde_json::from_str(raw.trim_start_matches('\u{feff}'))
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
    use super::parse_station_config;

    #[test]
    fn station_config_accepts_windows_utf8_bom() {
        let value = parse_station_config("\u{feff}{\"register\":{\"stationLabel\":\"Main Hub\"}}")
            .expect("station config with a UTF-8 BOM should parse");

        assert_eq!(value["register"]["stationLabel"], "Main Hub");
    }
}
