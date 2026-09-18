//! A consent-gated native save path for workspace exports. No arbitrary path,
//! URL, shell command, persistent file grant or document upload is accepted.
#[path = "workspace_export_io.rs"]
mod disk;
use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;
#[cfg(not(mobile))]
use {base64::{engine::general_purpose::STANDARD, Engine}, sha2::{Digest, Sha256}, std::sync::atomic::{AtomicBool, Ordering}, tauri::Manager, tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind}};

#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct ExportInput { protocol: u8, suggested_name: String, bytes_base64: String, byte_length: usize }
#[derive(Serialize)]
#[serde(tag="status", rename_all="camelCase")]
pub enum ExportResult {
    Cancelled,
    Saved { #[serde(rename="bytesWritten")] bytes_written: usize, #[serde(rename="directorySynced")] directory_synced: bool, sha256: String },
}

#[cfg(not(mobile))]
static SAVING: AtomicBool = AtomicBool::new(false);
#[cfg(not(mobile))]
struct ExportLease;
#[cfg(not(mobile))]
impl ExportLease {
    fn acquire()->Result<Self,String> { SAVING.compare_exchange(false,true,Ordering::AcqRel,Ordering::Acquire).map(|_|Self).map_err(|_|"Another export dialog is already open. Finish or cancel it first.".to_owned()) }
}
#[cfg(not(mobile))]
impl Drop for ExportLease { fn drop(&mut self){SAVING.store(false,Ordering::Release);} }

#[cfg(not(mobile))]
fn trusted(window: &WebviewWindow)->Result<(),String> {
    let current=window.url().map_err(|_|"The workspace window is no longer available.".to_owned())?;
    let label=window.label();
    if label!="main" && !(label.starts_with("detached-") && current.path()=="/detached") { return Err("Native export is restricted to Wabi workspace windows.".into()); }
    if !current.username().is_empty() || current.password().is_some() { return Err("Remote content cannot use native workspace export.".into()); }
    let bundled = current.port().is_none() && ((current.scheme()=="tauri" && current.host_str()==Some("localhost")) || (["http","https"].contains(&current.scheme()) && current.host_str()==Some("tauri.localhost")));
    // Development privileges match ONLY the configured dev-server origin and
    // are not compiled into a release's network-origin allowlist.
    #[cfg(debug_assertions)]
    let development=window.app_handle().config().build.dev_url.as_ref().is_some_and(|dev|current.origin()==dev.origin());
    #[cfg(not(debug_assertions))]
    let development=false;
    if !bundled && !development { return Err("Native export requires the bundled Wabi application.".into()); }
    Ok(())
}

#[tauri::command]
pub async fn workspace_export_file(window: WebviewWindow, input: ExportInput)->Result<ExportResult,String> {
    #[cfg(mobile)] { let _=(window,input);Err("Desktop native export is unavailable on this platform. Use the system download/share workflow.".into()) }
    #[cfg(not(mobile))] {
        trusted(&window)?;
        if input.protocol!=1 || input.suggested_name.len()>4096 || input.byte_length>disk::MAX_EXPORT_BYTES || input.bytes_base64.len()>disk::MAX_EXPORT_BYTES.div_ceil(3)*4 {
            return Err("Invalid export request or export exceeds 32 MiB. Your workspace is unchanged.".into());
        }
        let lease=ExportLease::acquire()?;
        // Dialog wait, decoding and disk writes run off the GUI thread. Keep the
        // lease inside the job even when a closing WebView drops its IPC waiter.
        tauri::async_runtime::spawn_blocking(move || {
            let _lease=lease;
            let bytes=STANDARD.decode(&input.bytes_base64).map_err(|_|"Invalid export encoding. Nothing was written.".to_owned())?;
            if bytes.len()!=input.byte_length || bytes.len()>disk::MAX_EXPORT_BYTES { return Err("Export length did not match. Nothing was written.".into()); }
            let name=disk::safe_name(&input.suggested_name);
            let selection=window.app_handle().dialog().file().set_parent(&window).set_title("Save Wabi workspace export — local file only").set_file_name(name).blocking_save_file();
            let Some(selection)=selection else{return Ok(ExportResult::Cancelled)};
            trusted(&window)?;
            let path=selection.into_path().map_err(|_|"This destination is not a desktop file path.".to_owned())?;
            let target=disk::destination(&path).map_err(|e|format!("Cannot use that destination ({:?}). Choose a regular local file.",e.kind()))?;
            let expected=disk::inspect_target(&target).map_err(|e|format!("Cannot replace that destination ({:?}). Choose a writable regular file.",e.kind()))?;
            if expected.is_some() {
                let approved=window.app_handle().dialog().message(format!("Replace this existing file with the export?\n\n{}\n\nYour Wabi document and original attachment will not be changed.",target.display()))
                    .title("Replace exported file?").kind(MessageDialogKind::Warning).buttons(MessageDialogButtons::OkCancel).blocking_show();
                if !approved{return Ok(ExportResult::Cancelled)};
            }
            trusted(&window)?;
            let receipt=disk::write_export(&target,&expected,&bytes).map_err(|e|format!("Native export was not committed ({:?}). Check the destination and retry. A new export requires a filesystem supporting hard links; your workspace remains available.",e.kind()))?;
            Ok(ExportResult::Saved {bytes_written:receipt.bytes_written,directory_synced:receipt.directory_synced,sha256:format!("{:x}",Sha256::digest(&bytes))})
        }).await.map_err(|_|"The native export task stopped unexpectedly. Check the destination before retrying; your workspace is unchanged.".to_owned())?
    }
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn workspace_export_input_cannot_supply_a_destination_or_network_url(){
        let valid=r#"{"protocol":1,"suggestedName":"test.csv","bytesBase64":"","byteLength":0}"#;
        assert!(serde_json::from_str::<ExportInput>(valid).is_ok());
        for key in ["path","destination","url","overwrite","command"]{let mut value:serde_json::Value=serde_json::from_str(valid).unwrap();value[key]=serde_json::json!("untrusted");assert!(serde_json::from_value::<ExportInput>(value).is_err());}
    }
    #[test] fn workspace_export_receipt_does_not_disclose_a_filesystem_path(){let value=serde_json::to_value(ExportResult::Saved{bytes_written:4,directory_synced:true,sha256:"digest".into()}).unwrap();assert_eq!(value["status"],"saved");assert_eq!(value["bytesWritten"],4);assert!(value.get("path").is_none());}
}
