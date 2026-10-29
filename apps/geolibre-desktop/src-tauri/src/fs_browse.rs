//! Add Data browser (Defani edition): list drives and folder contents for the
//! ArcGIS-style Add Data dialog, which browses any local folder.

use serde_json::json;
use std::time::UNIX_EPOCH;

#[tauri::command]
pub fn tfg_list_drives() -> Vec<String> {
    if cfg!(target_os = "windows") {
        (b'A'..=b'Z')
            .map(|c| format!("{}:\\", c as char))
            .filter(|d| std::path::Path::new(d).exists())
            .collect()
    } else {
        vec!["/".to_string()]
    }
}

#[tauri::command]
pub fn tfg_list_dir(path: String) -> Result<Vec<serde_json::Value>, String> {
    let read = std::fs::read_dir(&path).map_err(|e| format!("Cannot open \"{path}\": {e}"))?;
    let mut out = Vec::new();
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('$') || name == "System Volume Information" {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(json!({
            "name": name,
            "path": entry.path().to_string_lossy(),
            "dir": meta.is_dir(),
            "size": if meta.is_dir() { 0 } else { meta.len() },
            "modified": modified,
        }));
    }
    Ok(out)
}

#[tauri::command]
pub fn tfg_known_folders() -> serde_json::Value {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
    let join = |p: &str| std::path::Path::new(&home).join(p).to_string_lossy().to_string();
    json!({ "home": home, "desktop": join("Desktop"), "documents": join("Documents"), "downloads": join("Downloads") })
}
