//! Runtime add-on switches — the in-app half of attach/detach.
//!
//! Compile-time attachment stays in Cargo features (see
//! `docs/addons/ATTACH_DETACH.md`). This module persists the runtime switches a
//! server owner flips from Server Center → Add-ons, so a self-hoster never has
//! to edit compose/env just to turn a compiled-in add-on off.
//!
//! Precedence: an explicit env var wins (operator intent lives in compose),
//! then the persisted switch, then the compiled default.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Add-ons whose runtime state can be switched from the app.
pub const SWITCHABLE_ADDONS: &[&str] = &["steam", "lore", "tailcat"];

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AddonSwitches {
    /// addon id → enabled
    #[serde(default)]
    switches: BTreeMap<String, bool>,
}

impl AddonSwitches {
    pub fn path(data_dir: &str) -> PathBuf {
        Path::new(data_dir).join("addons.json")
    }

    /// Missing or unreadable file = compiled defaults (never an error).
    pub fn load(data_dir: &str) -> Self {
        std::fs::read_to_string(Self::path(data_dir))
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, data_dir: &str) -> anyhow::Result<()> {
        let path = Self::path(data_dir);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::write(&path, serde_json::to_vec_pretty(self)?)?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<bool> {
        self.switches.get(id).copied()
    }

    pub fn set(&mut self, id: &str, enabled: bool) {
        self.switches.insert(id.to_string(), enabled);
    }

    /// Effective state: env override → persisted switch → default.
    pub fn resolve(&self, id: &str, env_var: Option<&str>, default: bool) -> bool {
        if let Some(var) = env_var {
            if let Ok(raw) = std::env::var(var) {
                let value = raw.trim().to_ascii_lowercase();
                if !value.is_empty() {
                    return matches!(value.as_str(), "1" | "true" | "yes" | "on");
                }
            }
        }
        self.switches.get(id).copied().unwrap_or(default)
    }

    /// True when this add-on can be switched from the app.
    pub fn is_switchable(id: &str) -> bool {
        SWITCHABLE_ADDONS.contains(&id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persisted_switch_wins_over_compiled_default() {
        let mut switches = AddonSwitches::default();
        assert!(!switches.resolve("steam", None, false));
        switches.set("steam", true);
        assert!(switches.resolve("steam", None, false));
        switches.set("steam", false);
        assert!(!switches.resolve("steam", None, true));
    }

    #[test]
    fn env_var_overrides_the_persisted_switch() {
        let var = "WABI_TEST_ADDON_SWITCH_ENV";
        let mut switches = AddonSwitches::default();
        switches.set("probe", false);
        std::env::set_var(var, "1");
        assert!(switches.resolve("probe", Some(var), false));
        std::env::set_var(var, "0");
        assert!(!switches.resolve("probe", Some(var), true));
        std::env::remove_var(var);
        assert!(!switches.resolve("probe", Some(var), true));
    }

    #[test]
    fn only_compiled_in_addons_are_switchable() {
        assert!(AddonSwitches::is_switchable("steam"));
        assert!(AddonSwitches::is_switchable("lore"));
        assert!(AddonSwitches::is_switchable("tailcat"));
        assert!(!AddonSwitches::is_switchable("payments-crypto"));
        assert!(!AddonSwitches::is_switchable("webhooks"));
    }
}
