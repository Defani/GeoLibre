//! GPU choice (Defani edition): Settings › Performance stores which graphics
//! adapter the map should use; it is applied when the WebView starts, through
//! WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, so a change takes effect on restart.

use std::path::PathBuf;

const BASE_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --enable-gpu-rasterization --enable-zero-copy --ignore-gpu-blocklist";

fn pref_path() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA")?;
    Some(PathBuf::from(base).join("TheFunnyGIS").join("gpu.txt"))
}

fn read_pref() -> String {
    pref_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| matches!(s.as_str(), "high" | "low" | "auto" | "software"))
        .unwrap_or_else(|| "high".to_string())
}

/// Set the WebView2 browser arguments for the stored GPU choice. Call before the
/// first window is created.
pub fn apply_gpu_preference() {
    if std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_some() {
        return;
    }
    let flag = match read_pref().as_str() {
        "low" => " --force_low_power_gpu",
        "auto" => "",
        "software" => " --disable-gpu",
        _ => " --force_high_performance_gpu",
    };
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", format!("{BASE_ARGS}{flag}"));
}

#[tauri::command]
pub fn get_gpu_preference() -> String {
    read_pref()
}

#[tauri::command]
pub fn set_gpu_preference(preference: String) -> Result<(), String> {
    if !matches!(preference.as_str(), "high" | "low" | "auto" | "software") {
        return Err(format!("Unknown GPU preference: {preference}"));
    }
    let path = pref_path().ok_or("APPDATA is not set")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, preference).map_err(|e| e.to_string())
}
