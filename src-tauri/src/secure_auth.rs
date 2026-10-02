use serde::Serialize;
use std::sync::{Mutex, OnceLock};

const ACCESS_SERVICE: &str = "chat.wabi.app.auth.access";
const REFRESH_SERVICE: &str = "chat.wabi.app.auth.refresh";
const MAX_SCOPE_BYTES: usize = 2048;

static STORE_INIT: OnceLock<Result<(), String>> = OnceLock::new();
// OS stores are not all safe for concurrent operations on one credential.
// Frontend ordering supplies session intent; this lock protects native I/O too.
static STORE_IO: Mutex<()> = Mutex::new(());

fn with_store<T>(operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let _guard = STORE_IO
        .lock()
        .map_err(|_| "credential store lock poisoned".to_string())?;
    operation()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecureAuthBundle {
    access_token: String,
    refresh_token: Option<String>,
}

fn validate_scope(server_scope: &str) -> Result<&str, String> {
    let scope = server_scope.trim();
    if scope.is_empty() {
        return Err("secure auth scope is empty".to_string());
    }
    if scope.len() > MAX_SCOPE_BYTES {
        return Err("secure auth scope is too long".to_string());
    }
    Ok(scope)
}

fn initialize_native_store() -> Result<(), String> {
    STORE_INIT
        .get_or_init(|| {
            // Link only the selected persistent OS stores. The keyring CLI glue
            // also enables example/file/database stores that this app never uses.
            #[cfg(target_os = "android")]
            use android_native_keyring_store::Store;
            #[cfg(target_os = "macos")]
            use apple_native_keyring_store::keychain::Store;
            #[cfg(target_os = "ios")]
            use apple_native_keyring_store::protected::Store;
            #[cfg(target_os = "windows")]
            use windows_native_keyring_store::Store;
            #[cfg(target_os = "linux")]
            use zbus_secret_service_keyring_store::Store;

            #[cfg(any(
                target_os = "android",
                target_os = "ios",
                target_os = "macos",
                target_os = "windows",
                target_os = "linux"
            ))]
            {
                // A locked/unavailable OS store fails closed; there is no plaintext
                // file store or transient Linux keyutils fallback.
                let store = Store::new_with_configuration(&std::collections::HashMap::new())
                    .map_err(|error| error.to_string())?;
                keyring_core::set_default_store(store);
                return Ok(());
            }
            #[allow(unreachable_code)]
            Err("no OS credential store is configured for this platform".to_string())
        })
        .clone()
}

fn entry(service: &str, server_scope: &str) -> Result<keyring_core::Entry, String> {
    initialize_native_store()?;
    let scope = validate_scope(server_scope)?;
    keyring_core::Entry::new(service, scope).map_err(|error| error.to_string())
}

fn read_secret(service: &str, server_scope: &str) -> Result<Option<String>, String> {
    let entry = entry(service, server_scope)?;
    match entry.get_secret() {
        Ok(secret) => String::from_utf8(secret)
            .map(Some)
            .map_err(|_| "stored auth credential is not valid UTF-8".to_string()),
        Err(keyring_core::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn write_secret(service: &str, server_scope: &str, value: &str) -> Result<(), String> {
    entry(service, server_scope)?
        .set_password(value)
        .map_err(|error| error.to_string())
}

fn delete_secret(service: &str, server_scope: &str) -> Result<(), String> {
    let entry = entry(service, server_scope)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn get_impl(server_scope: &str) -> Result<Option<SecureAuthBundle>, String> {
    let Some(access_token) = read_secret(ACCESS_SERVICE, server_scope)? else {
        return Ok(None);
    };
    let refresh_token = read_secret(REFRESH_SERVICE, server_scope)?;
    Ok(Some(SecureAuthBundle {
        access_token,
        refresh_token,
    }))
}

fn set_impl(
    server_scope: &str,
    access_token: &str,
    refresh_token: Option<&str>,
) -> Result<(), String> {
    let access_token = access_token.trim();
    if access_token.is_empty() {
        return delete_impl(server_scope);
    }

    match refresh_token
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(refresh) => write_secret(REFRESH_SERVICE, server_scope, refresh)?,
        None => delete_secret(REFRESH_SERVICE, server_scope)?,
    }
    write_secret(ACCESS_SERVICE, server_scope, access_token)
}

fn delete_impl(server_scope: &str) -> Result<(), String> {
    // Always attempt both removals. A stale refresh credential must not survive
    // merely because the access entry was already absent (or vice versa).
    let access = delete_secret(ACCESS_SERVICE, server_scope);
    let refresh = delete_secret(REFRESH_SERVICE, server_scope);
    access.and(refresh)
}

// Credential access is allowed on mobile, unlike desktop hosting controls.
// Reuse the exact main-window origin boundary before touching the OS store.
fn authorize(window: &tauri::WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|error| error.to_string())?;
    if !crate::hosting::local_main_origin(window.label(), &url, cfg!(debug_assertions)) {
        return Err("Credentials are available only in Wabi's local main window".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn secure_auth_get(
    window: tauri::WebviewWindow,
    server_scope: String,
) -> Result<Option<SecureAuthBundle>, String> {
    authorize(&window)?;
    tauri::async_runtime::spawn_blocking(move || with_store(|| get_impl(&server_scope)))
        .await
        .map_err(|error| format!("secure auth task failed: {error}"))?
}

#[tauri::command]
pub async fn secure_auth_set(
    window: tauri::WebviewWindow,
    server_scope: String,
    access_token: String,
    refresh_token: Option<String>,
) -> Result<(), String> {
    authorize(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        with_store(|| set_impl(&server_scope, &access_token, refresh_token.as_deref()))
    })
    .await
    .map_err(|error| format!("secure auth task failed: {error}"))?
}

#[tauri::command]
pub async fn secure_auth_delete(
    window: tauri::WebviewWindow,
    server_scope: String,
) -> Result<(), String> {
    authorize(&window)?;
    tauri::async_runtime::spawn_blocking(move || with_store(|| delete_impl(&server_scope)))
        .await
        .map_err(|error| format!("secure auth task failed: {error}"))?
}

/// keyring's Android credential store encrypts SharedPreferences through the
/// Android Keystore, but it needs ndk-context initialized with the Activity
/// application context. `scripts/tauri-android-init.mjs` wires this method into
/// the generated Tauri MainActivity after every `tauri android init`.
#[cfg(target_os = "android")]
#[allow(non_snake_case)]
#[unsafe(no_mangle)]
pub extern "system" fn Java_chat_wabi_app_MainActivity_initNdkContext(
    env: jni::JNIEnv,
    _class: jni::objects::JObject,
    context: jni::objects::JObject,
) {
    use jni::objects::GlobalRef;
    use std::ffi::c_void;

    static CONTEXT_REF: OnceLock<Option<GlobalRef>> = OnceLock::new();
    CONTEXT_REF.get_or_init(|| match env.new_global_ref(&context) {
        Ok(reference) => {
            let vm = match env.get_java_vm() {
                Ok(vm) => vm,
                Err(error) => {
                    log::error!("secure auth: failed to obtain Android VM: {error}");
                    return None;
                }
            };
            let vm = vm.get_java_vm_pointer() as *mut c_void;
            unsafe {
                ndk_context::initialize_android_context(vm, reference.as_obj().as_raw() as _);
            }
            Some(reference)
        }
        Err(error) => {
            log::error!("secure auth: failed to retain Android application context: {error}");
            None
        }
    });
}

#[cfg(test)]
mod tests {
    use super::validate_scope;

    #[test]
    fn scope_validation_rejects_empty_and_accepts_normalized_server_urls() {
        assert!(validate_scope("   ").is_err());
        assert_eq!(
            validate_scope(" https://wabi.example ").unwrap(),
            "https://wabi.example"
        );
    }
}
