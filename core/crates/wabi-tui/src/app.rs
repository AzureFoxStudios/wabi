//! Application state and logic

use anyhow::Result;
use crossterm::event::KeyCode;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::mpsc;

use crate::api::ApiClient;
use crate::config::Config;

#[derive(Debug)]
pub enum BgMsg {
    Channels(Vec<Channel>),
    Messages(String, Vec<Message>),
    SendOk(String),
    LoginOk {
        request_id: u64,
        token: String,
        user_id: i64,
        username: String,
    },
    LoginErr {
        request_id: u64,
        message: String,
    },
    Error(String),
}

#[derive(Debug)]
pub struct App {
    pub config: Config,
    pub api: ApiClient,
    pub user: Option<User>,
    pub channels: Vec<Channel>,
    pub messages: HashMap<String, Vec<Message>>,
    pub active_channel: Option<String>,
    pub input: String,
    pub error: Option<String>,
    pub status: String,
    pub mode: AppMode,
    pub login_username: String,
    pub login_password: String,
    pub login_field: u8,
    pub pending_connect: bool,
    pub server_input: String,
    /// Monotonic login attempt id. Incrementing it invalidates older background login results.
    pub login_request_id: u64,
    /// How many messages to skip from the end (0 = show latest).
    pub msg_scroll: usize,
    /// Persistent sender — all background tasks hold a clone of this.
    pub bg_tx: mpsc::Sender<BgMsg>,
    /// Receiver drained every frame by poll_bg().
    pub bg_rx: mpsc::Receiver<BgMsg>,
    /// Monotonic timestamp (millis) of last auto-poll for live updates.
    last_poll_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub handle: Option<String>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub channel_type: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct Message {
    pub id: String,
    pub channel_id: String,
    pub sender_id: i64,
    pub sender_name: String,
    pub text: String,
    pub timestamp: i64,
    pub message_type: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum AppMode {
    #[default]
    Normal,
    Input,
    Login,
    LoginLoading,
    #[allow(dead_code)]
    Register,
    ServerSetup,
}

impl App {
    pub async fn new() -> Result<Self> {
        let config = if Config::config_path().exists() {
            Config::load()?
        } else {
            Config::default()
        };
        let mut api = ApiClient::new(&config.server_url);
        if let Some(token) = config.token.clone() {
            api.set_token(token);
        }
        let remembered_user = config.username.as_ref().map(|username| User {
            id: 0,
            username: username.clone(),
            handle: None,
        });
        let (bg_tx, bg_rx) = mpsc::channel(64);

        let first_run = !Config::config_path().exists() || config.server_url.is_empty();
        let mode = if first_run {
            AppMode::ServerSetup
        } else {
            AppMode::Normal
        };

        let mut app = Self {
            config,
            api,
            user: remembered_user,
            channels: Vec::new(),
            messages: HashMap::new(),
            active_channel: None,
            input: String::new(),
            error: None,
            status: if mode == AppMode::ServerSetup {
                "Enter your Wabi server URL to get started.".to_string()
            } else {
                "Connecting...".to_string()
            },
            mode,
            login_username: String::new(),
            login_password: String::new(),
            login_field: 0,
            pending_connect: false,
            server_input: String::new(),
            login_request_id: 0,
            msg_scroll: 0,
            bg_tx,
            bg_rx,
            last_poll_ms: 0,
        };

        if app.mode != AppMode::ServerSetup {
            match app.api.health().await {
                Ok(_) => {
                    app.status = format!("Connected to {}", app.config.server_url);
                    app.spawn_load_channels();
                }
                Err(e) => {
                    app.status = format!("Offline: {}", e);
                }
            }
        }

        Ok(app)
    }

    pub fn spawn_load_channels(&self) {
        let api = self.api.clone();
        let tx = self.bg_tx.clone();
        tokio::spawn(async move {
            match api.get_channels().await {
                Ok(ch) => {
                    let _ = tx.send(BgMsg::Channels(ch)).await;
                }
                Err(e) => {
                    let _ = tx.send(BgMsg::Error(format!("Channels: {}", e))).await;
                }
            }
        });
    }

    pub fn spawn_load_messages(&self, channel_id: &str) {
        let api = self.api.clone();
        let tx = self.bg_tx.clone();
        let ch_id = channel_id.to_string();
        tokio::spawn(async move {
            match api.get_messages(&ch_id, 50).await {
                Ok(msgs) => {
                    let _ = tx.send(BgMsg::Messages(ch_id, msgs)).await;
                }
                Err(e) => {
                    let _ = tx.send(BgMsg::Error(format!("Messages: {}", e))).await;
                }
            }
        });
    }

    /// Drain all pending background messages and update state.
    pub fn poll_bg(&mut self) {
        // Auto-poll for new messages every 3 seconds on the active channel.
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        if now_ms.saturating_sub(self.last_poll_ms) >= 3000 {
            if let Some(ref ch_id) = self.active_channel {
                if self.config.token.is_some() {
                    self.spawn_load_messages(ch_id);
                }
            }
            self.last_poll_ms = now_ms;
        }

        while let Ok(msg) = self.bg_rx.try_recv() {
            match msg {
                BgMsg::Channels(channels) => {
                    self.channels = channels;
                    self.status = if self.channels.is_empty() {
                        "Connected — no channels visible".into()
                    } else {
                        format!("{} channels", self.channels.len())
                    };
                    if self.active_channel.is_none() {
                        if let Some(ch) = self.channels.first() {
                            let id = ch.id.clone();
                            self.active_channel = Some(id.clone());
                            self.spawn_load_messages(&id);
                        }
                    }
                }
                BgMsg::Messages(ch_id, msgs) => {
                    self.messages.insert(ch_id, msgs);
                }
                BgMsg::SendOk(ch_id) => {
                    self.spawn_load_messages(&ch_id);
                }
                BgMsg::LoginOk {
                    request_id,
                    token,
                    user_id,
                    username,
                } => {
                    if self.mode != AppMode::LoginLoading || request_id != self.login_request_id {
                        continue;
                    }
                    self.config.token = Some(token.clone());
                    self.config.username = Some(username.clone());
                    let _ = self.config.save();
                    self.api.set_token(token);
                    self.user = Some(User {
                        id: user_id,
                        username: username.clone(),
                        handle: None,
                    });
                    self.status = format!("Logged in as {}", username);
                    self.mode = AppMode::Normal;
                    self.spawn_load_channels();
                }
                BgMsg::LoginErr {
                    request_id,
                    message,
                } => {
                    if self.mode == AppMode::LoginLoading && request_id == self.login_request_id {
                        self.mode = AppMode::Login;
                        self.status = "Not logged in".into();
                        self.set_error(message);
                    }
                }
                BgMsg::Error(e) => {
                    self.set_error(e);
                }
            }
        }
    }

    pub fn set_error(&mut self, error: String) {
        self.error = Some(error);
    }

    pub fn clear_error(&mut self) {
        self.error = None;
    }

    pub async fn do_connect(&mut self) -> Result<()> {
        self.pending_connect = false;
        match self.api.health().await {
            Ok(_) => {
                self.status = format!(
                    "Connected to {} — press l to log in",
                    self.config.server_url
                );
                self.mode = AppMode::Login;
                self.login_username.clear();
                self.login_password.clear();
                self.login_field = 0;
            }
            Err(e) => {
                self.set_error(format!("Could not reach {}: {}", self.config.server_url, e));
                self.mode = AppMode::ServerSetup;
            }
        }
        Ok(())
    }

    pub fn handle_key(&mut self, key: KeyCode) -> Result<bool> {
        match self.mode {
            AppMode::Normal => self.handle_normal_key(key),
            AppMode::Input => self.handle_input_key(key),
            AppMode::Login | AppMode::LoginLoading => self.handle_login_key(key),
            AppMode::ServerSetup => self.handle_server_setup_key(key),
            AppMode::Register => Ok(true),
        }
    }

    fn handle_normal_key(&mut self, key: KeyCode) -> Result<bool> {
        match key {
            KeyCode::Esc => self.clear_error(),
            KeyCode::Char('q') => return Ok(false),
            KeyCode::Char('i') | KeyCode::Char('I') => {
                self.mode = AppMode::Input;
            }
            KeyCode::Char('j') | KeyCode::Down => {
                if let Some(idx) = self
                    .active_channel
                    .as_ref()
                    .and_then(|id| self.channels.iter().position(|c| &c.id == id))
                {
                    if idx + 1 < self.channels.len() {
                        let next_id = self.channels[idx + 1].id.clone();
                        self.active_channel = Some(next_id.clone());
                        self.msg_scroll = 0;
                        self.spawn_load_messages(&next_id);
                    }
                }
            }
            KeyCode::Char('k') | KeyCode::Up => {
                if let Some(idx) = self
                    .active_channel
                    .as_ref()
                    .and_then(|id| self.channels.iter().position(|c| &c.id == id))
                {
                    if idx > 0 {
                        let prev_id = self.channels[idx - 1].id.clone();
                        self.active_channel = Some(prev_id.clone());
                        self.msg_scroll = 0;
                        self.spawn_load_messages(&prev_id);
                    }
                }
            }
            KeyCode::PageUp => {
                let max = self
                    .active_channel
                    .as_ref()
                    .and_then(|id| self.messages.get(id))
                    .map(|m| m.len().saturating_sub(1))
                    .unwrap_or(0);
                self.msg_scroll = (self.msg_scroll + 5).min(max);
            }
            KeyCode::PageDown => {
                self.msg_scroll = self.msg_scroll.saturating_sub(5);
            }
            KeyCode::Enter | KeyCode::Char('r') | KeyCode::F(5) => {
                if let Some(ref ch_id) = self.active_channel.clone() {
                    self.status = "Refreshing...".to_string();
                    self.spawn_load_messages(ch_id);
                }
            }
            KeyCode::Char('l') | KeyCode::Char('L') => {
                self.mode = AppMode::Login;
                self.login_username.clear();
                self.login_password.clear();
                self.login_field = 0;
                self.clear_error();
            }
            KeyCode::Char('?') => {
                self.set_error(
                    "q=quit  i=input  j/k=channels  l=login  Enter/r=refresh  PgUp/PgDn=scroll"
                        .into(),
                );
            }
            _ => {}
        }
        Ok(true)
    }

    fn handle_input_key(&mut self, key: KeyCode) -> Result<bool> {
        match key {
            KeyCode::Enter => {
                let text = self.input.trim().to_string();
                if !text.is_empty() {
                    if self.config.token.is_none() {
                        self.set_error("Not logged in — press l to log in first".into());
                        self.input.clear();
                        self.mode = AppMode::Normal;
                        return Ok(true);
                    }
                    if let Some(ch_id) = self.active_channel.clone() {
                        // Optimistic: show the message immediately.
                        let display_name = self
                            .user
                            .as_ref()
                            .map(|u| u.username.clone())
                            .or_else(|| self.config.username.clone())
                            .unwrap_or_else(|| "me".to_string());
                        let user_id = self.user.as_ref().map(|u| u.id).unwrap_or(0);
                        let now_ms = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_millis() as i64)
                            .unwrap_or(0);
                        self.messages
                            .entry(ch_id.clone())
                            .or_default()
                            .push(Message {
                                id: format!("local-{}", now_ms),
                                channel_id: ch_id.clone(),
                                sender_id: user_id,
                                sender_name: display_name,
                                text: text.clone(),
                                timestamp: now_ms,
                                message_type: "text".to_string(),
                            });
                        // Scroll back to latest so the new message is visible.
                        self.msg_scroll = 0;

                        let api = self.api.clone();
                        let tx = self.bg_tx.clone();
                        tokio::spawn(async move {
                            match api.send_message(&ch_id, &text, false).await {
                                Ok(()) => {
                                    let _ = tx.send(BgMsg::SendOk(ch_id)).await;
                                }
                                Err(e) => {
                                    let _ =
                                        tx.send(BgMsg::Error(format!("Send failed: {}", e))).await;
                                }
                            }
                        });
                    }
                    self.input.clear();
                }
                self.mode = AppMode::Normal;
            }
            KeyCode::Esc => {
                self.mode = AppMode::Normal;
                self.clear_error();
            }
            KeyCode::Char(c) => self.input.push(c),
            KeyCode::Backspace => {
                self.input.pop();
            }
            _ => {}
        }
        Ok(true)
    }

    fn handle_server_setup_key(&mut self, key: KeyCode) -> Result<bool> {
        match key {
            KeyCode::Enter => {
                let url = self.server_input.trim().to_string();
                if url.is_empty() {
                    self.set_error("Enter a server URL, e.g. https://chat.example.com".into());
                    return Ok(true);
                }
                let url = if url.contains("://") {
                    url
                } else {
                    format!("https://{}", url)
                };
                self.config.server_url = url.clone();
                let _ = self.config.save();
                self.api = ApiClient::new(&url);
                self.server_input.clear();
                self.status = format!("Connecting to {}...", url);
                self.pending_connect = true;
            }
            KeyCode::Esc => return Ok(false),
            KeyCode::Char(c) => self.server_input.push(c),
            KeyCode::Backspace => {
                self.server_input.pop();
            }
            _ => {}
        }
        Ok(true)
    }

    fn handle_login_key(&mut self, key: KeyCode) -> Result<bool> {
        if self.mode == AppMode::LoginLoading && key != KeyCode::Esc {
            return Ok(true);
        }

        match key {
            KeyCode::Esc => {
                // Esc during LoginLoading abandons waiting for the result;
                // the background task may still complete but result is discarded.
                if self.mode == AppMode::LoginLoading {
                    self.login_request_id = self.login_request_id.wrapping_add(1);
                }
                self.mode = AppMode::Normal;
                self.login_password.clear();
            }
            KeyCode::Tab | KeyCode::Down => {
                self.login_field ^= 1;
            }
            KeyCode::Up => {
                self.login_field ^= 1;
            }
            KeyCode::Enter => {
                if self.login_field == 0 {
                    self.login_field = 1;
                } else if !self.login_username.is_empty() && !self.login_password.is_empty() {
                    self.mode = AppMode::LoginLoading;
                    self.status = "Authenticating...".to_string();
                    self.login_request_id = self.login_request_id.wrapping_add(1);
                    let request_id = self.login_request_id;
                    // Take the password out of the struct immediately to limit its lifetime.
                    let username = self.login_username.clone();
                    let password = std::mem::take(&mut self.login_password);
                    let api = self.api.clone();
                    let tx = self.bg_tx.clone();
                    tokio::spawn(async move {
                        match api.login(&username, &password).await {
                            Ok(r) => {
                                let _ = tx
                                    .send(BgMsg::LoginOk {
                                        request_id,
                                        token: r.token,
                                        user_id: r.user_id,
                                        username: r.username,
                                    })
                                    .await;
                            }
                            Err(e) => {
                                let _ = tx
                                    .send(BgMsg::LoginErr {
                                        request_id,
                                        message: format!("Login failed: {}", e),
                                    })
                                    .await;
                            }
                        }
                    });
                } else {
                    self.status = "Need username AND password".to_string();
                }
            }
            KeyCode::Char(c) => {
                if self.mode != AppMode::LoginLoading {
                    if self.login_field == 0 {
                        self.login_username.push(c);
                    } else {
                        self.login_password.push(c);
                    }
                }
            }
            KeyCode::Backspace => {
                if self.mode != AppMode::LoginLoading {
                    if self.login_field == 0 {
                        self.login_username.pop();
                    } else {
                        self.login_password.pop();
                    }
                }
            }
            _ => {}
        }
        Ok(true)
    }
}
