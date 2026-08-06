//! Configuration management

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Empty `server_url` triggers the first-run ServerSetup prompt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub server_url: String,
    pub username: Option<String>,
    pub token: Option<String>,
    /// Target UI refresh rate. E-ink: try `1`–`5`. Default `20`.
    /// Overridable via `WABI_TUI_FPS`.
    #[serde(default = "default_fps")]
    pub fps: f32,
    /// Chat message poll interval in seconds (active channel only). Default `3`.
    /// Overridable via `WABI_TUI_POLL_SECS`.
    #[serde(default = "default_poll_secs")]
    pub poll_secs: f32,
}

fn default_fps() -> f32 {
    20.0
}

fn default_poll_secs() -> f32 {
    3.0
}

impl Default for Config {
    fn default() -> Self {
        Self {
            server_url: String::new(),
            username: None,
            token: None,
            fps: default_fps(),
            poll_secs: default_poll_secs(),
        }
    }
}

impl Config {
    pub fn config_path() -> PathBuf {
        let mut path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
        path.push("wabi");
        path.push("config.toml");
        path
    }

    pub fn load() -> Result<Self> {
        let path = Self::config_path();
        let content = std::fs::read_to_string(&path).context("Failed to read config file")?;
        let mut config: Config = toml::from_str(&content).context("Failed to parse config file")?;
        config.apply_env_overrides();
        config.clamp();
        Ok(config)
    }

    pub fn save(&self) -> Result<()> {
        let path = Self::config_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let content = toml::to_string_pretty(self).context("Failed to serialize config")?;
        std::fs::write(&path, &content)?;

        // Restrict config file to owner-only on Unix (token is stored here).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }

        Ok(())
    }

    /// Env wins over file: `WABI_TUI_FPS`, `WABI_TUI_POLL_SECS`.
    pub fn apply_env_overrides(&mut self) {
        if let Ok(v) = std::env::var("WABI_TUI_FPS") {
            if let Ok(n) = v.parse::<f32>() {
                self.fps = n;
            }
        }
        if let Ok(v) = std::env::var("WABI_TUI_POLL_SECS") {
            if let Ok(n) = v.parse::<f32>() {
                self.poll_secs = n;
            }
        }
    }

    pub fn clamp(&mut self) {
        // 0.2 fps ≈ 5s/frame (extreme e-ink); 60 fps cap.
        if !self.fps.is_finite() || self.fps <= 0.0 {
            self.fps = default_fps();
        }
        self.fps = self.fps.clamp(0.2, 60.0);

        if !self.poll_secs.is_finite() || self.poll_secs < 0.5 {
            self.poll_secs = default_poll_secs();
        }
        self.poll_secs = self.poll_secs.clamp(0.5, 120.0);
    }

    /// Frame budget in milliseconds from fps.
    pub fn frame_ms(&self) -> u64 {
        let ms = (1000.0 / self.fps as f64).round() as u64;
        ms.clamp(16, 5000)
    }

    pub fn poll_ms(&self) -> u64 {
        (self.poll_secs as f64 * 1000.0).round() as u64
    }
}
