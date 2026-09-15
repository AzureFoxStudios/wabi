use serde::Serialize;
use std::sync::OnceLock;

const ACCESS_SERVICE: &str = "chat.wabi.app.auth.access";
const REFRESH_SERVICE: &str = "chat.wabi.app.auth.refresh";
const MAX_SCOPE_BYTES: usize = 2048;

static STORE_INIT: OnceLock<Result<(), String>> = OnceLock::new();

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
            #[cfg(target_os = "android")]
            {
                return keyring::use_named_store("android").map_err(|error| error.to_string());
            }
            #[cfg(target_os = "ios")]
            {
                return keyring::use_named_store("protected").map_err(|error| error.to_string());
            }
            #[cfg(target_os = "macos")]
            {
                return keyring::use_named_store("keychain").map_err(|error| error.to_string());
            }
            #[cfg(target_os = "windows")]
            {
                return keyring::use_named_store("windows").map_err(|error| error.to_string());
            }
            #[cfg(target_os = "linux")]
            {
                // Secret Service is persistent and user-scoped. If it is unavailable
                // (for example a headless desktop), remember-me fails closed instead of
                // dropping an auth token into plaintext localStorage.
                return keyring::use_named_store("secret-service").map_err(|error| error.to_string());
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

    match refresh_token.map(str::trim).filter(|value| !value.is_empty()) {
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

#[tauri::command]
pub async fn secure_auth_get(server_scope: String) -> Result<Option<SecureAuthBundle>, String> {
    tauri::async_runtime::spawn_blocking(move || get_impl(&server_scope))
        .await
        .map_err(|error| format!("secure auth task failed: {error}"))?
}

#[tauri::command]
pub async fn secure_auth_set(
    server_scope: String,
    access_token: String,
    refresh_token: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        set_impl(&server_scope, &access_token, refresh_token.as_deref())
    })
    .await
    .map_err(|error| format!("secure auth task failed: {error}"))?
}

#[tauri::command]
pub async fn secure_auth_delete(server_scope: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_impl(&server_scope))
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
