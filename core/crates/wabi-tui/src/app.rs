//! Application state — multi-screen admin/power TUI.

use anyhow::Result;
use crossterm::event::KeyCode;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use tokio::sync::mpsc;

use crate::api::{ApiClient, ChannelKind};
use crate::config::Config;

const LOG_CAP: usize = 200;
const MSG_LIMIT: u32 = 80;

#[derive(Debug)]
pub enum BgMsg {
    Channels(Vec<Channel>),
    Messages(String, Vec<Message>),
    Users(Vec<RegisteredUser>),
    Stats(ServerStats),
    Health(String),
    SendOk(String),
    LoginOk {
        request_id: u64,
        token: String,
        user_id: i64,
        username: String,
        highest_role: Option<String>,
    },
    LoginErr {
        request_id: u64,
        message: String,
    },
    ActionOk(String),
    Error(String),
    Info(String),
    LiveConnected,
    LiveDisconnected(String),
    LiveAuthFailed(String),
    LiveMessage {
        channel_id: String,
        message: Message,
    },
    LiveTyping {
        channel_id: String,
        username: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Screen {
    #[default]
    Chat,
    Users,
    Server,
    Logs,
}

impl Screen {
    pub fn next(self) -> Self {
        match self {
            Self::Chat => Self::Users,
            Self::Users => Self::Server,
            Self::Server => Self::Logs,
            Self::Logs => Self::Chat,
        }
    }
    pub fn prev(self) -> Self {
        match self {
            Self::Chat => Self::Logs,
            Self::Users => Self::Chat,
            Self::Server => Self::Users,
            Self::Logs => Self::Server,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Chat => "Chat",
            Self::Users => "Users",
            Self::Server => "Server",
            Self::Logs => "Logs",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FocusPane {
    #[default]
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AppMode {
    #[default]
    Normal,
    Input,
    Login,
    LoginLoading,
    ServerSetup,
    Command,
    Help,
    Prompt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptKind {
    ResetPassword,
    ConfirmAction,
}

#[derive(Debug)]
pub struct App {
    pub config: Config,
    pub api: ApiClient,
    pub user: Option<User>,
    pub channels: Vec<Channel>,
    pub messages: HashMap<String, Vec<Message>>,
    pub users: Vec<RegisteredUser>,
    pub stats: Option<ServerStats>,
    pub health_blob: String,
    pub active_channel: Option<String>,
    pub selected_user: usize,
    pub input: String,
    pub command: String,
    pub prompt: String,
    pub prompt_kind: Option<PromptKind>,
    pub prompt_title: String,
    pub channel_filter: String,
    pub user_filter: String,
    pub error: Option<String>,
    pub status: String,
    pub mode: AppMode,
    pub screen: Screen,
    pub focus: FocusPane,
    pub login_username: String,
    pub login_password: String,
    pub login_field: u8,
    pub pending_connect: bool,
    pub server_input: String,
    pub login_request_id: u64,
    pub msg_scroll: usize,
    pub show_help: bool,
    pub logs: VecDeque<String>,
    pub bg_tx: mpsc::Sender<BgMsg>,
    pub bg_rx: mpsc::Receiver<BgMsg>,
    last_poll_ms: u64,
    /// UI needs a redraw (keys, bg results, timers).
    pub dirty: bool,
    /// Socket.IO live feed handle + health.
    pub live: crate::live::LiveClient,
    /// Unread counters per channel id, cleared on selection.
    pub unread: HashMap<String, u32>,
    /// Typing indicator state (fresh < TYPING_TTL_MS).
    pub typing_channel: Option<String>,
    pub typing_user: Option<String>,
    pub typing_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub handle: Option<String>,
    pub highest_role: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub channel_type: String,
    pub kind: ChannelKind,
    pub description: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Message {
    pub id: String,
    pub channel_id: String,
    pub sender_id: i64,
    pub sender_name: String,
    pub text: String,
    pub timestamp: i64,
    pub message_type: String,
}

#[derive(Debug, Clone)]
pub struct RegisteredUser {
    pub user_id: i64,
    pub username: String,
    pub profile_picture: Option<String>,
    pub color: String,
}

#[derive(Debug, Clone, Default)]
pub struct ServerStats {
    pub total_users: u64,
    pub online_users: u64,
    pub banned_users: u64,
    pub muted_users: u64,
    pub total_channels: u64,
    pub total_roles: u64,
    pub total_emojis: u64,
    pub total_messages: u64,
    pub open_reports: u64,
    /// Extended counters from the server's `extra` object.
    /// (registered/bot/active users, 24h-seen, channels-by-kind)
    pub registered_users: Option<u64>,
    pub bot_users: Option<u64>,
    pub active_users: Option<u64>,
    pub users_seen_24h: Option<u64>,
    pub channels_by_kind: Vec<(String, u64)>,
}

impl App {
    pub async fn new() -> Result<Self> {
        let mut config = if Config::config_path().exists() {
            Config::load()?
        } else {
            Config::default()
        };
        // load() already applies env when from file; default path needs it too.
        config.apply_env_overrides();
        config.clamp();
        let mut api = ApiClient::new(&config.server_url);
        if let Some(token) = config.token.clone() {
            api.set_token(token);
        }
        let remembered_user = config.username.as_ref().map(|username| User {
            id: 0,
            username: username.clone(),
            handle: None,
            highest_role: None,
        });
        let (bg_tx, bg_rx) = mpsc::channel(128);

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
            users: Vec::new(),
            stats: None,
            health_blob: String::new(),
            active_channel: None,
            selected_user: 0,
            input: String::new(),
            command: String::new(),
            prompt: String::new(),
            prompt_kind: None,
            prompt_title: String::new(),
            channel_filter: String::new(),
            user_filter: String::new(),
            error: None,
            status: if mode == AppMode::ServerSetup {
                "Enter your Wabi server URL to get started.".into()
            } else {
                "Connecting…".into()
            },
            mode,
            screen: Screen::Chat,
            focus: FocusPane::Left,
            login_username: String::new(),
            login_password: String::new(),
            login_field: 0,
            pending_connect: false,
            server_input: String::new(),
            login_request_id: 0,
            msg_scroll: 0,
            show_help: false,
            logs: VecDeque::with_capacity(LOG_CAP),
            bg_tx,
            bg_rx,
            last_poll_ms: 0,
            dirty: true,
            live: crate::live::LiveClient::new(),
            unread: HashMap::new(),
            typing_channel: None,
            typing_user: None,
            typing_at_ms: 0,
        };

        if app.mode != AppMode::ServerSetup {
            match app.api.health().await {
                Ok(blob) => {
                    app.health_blob = blob;
                    app.status = format!("Connected · {}", app.config.server_url);
                    app.log("health ok");
                    app.spawn_load_channels();
                    if app.config.token.is_some() {
                        app.spawn_load_users();
                        app.spawn_admin_stats();
                    }
                }
                Err(e) => {
                    app.status = format!("Offline: {e}");
                    app.log(format!("health fail: {e}"));
                }
            }
        }

        Ok(app)
    }

    pub fn log(&mut self, line: impl Into<String>) {
        let ts = chrono::Local::now().format("%H:%M:%S");
        self.logs.push_back(format!("[{ts}] {}", line.into()));
        while self.logs.len() > LOG_CAP {
            self.logs.pop_front();
        }
        self.dirty = true;
    }

    pub fn mark_dirty(&mut self) {
        self.dirty = true;
    }

    pub fn filtered_channels(&self) -> Vec<&Channel> {
        let q = self.channel_filter.to_lowercase();
        let mut direct: Vec<&Channel> = Vec::new();
        let mut rest: Vec<&Channel> = Vec::new();
        for c in &self.channels {
            // Category rows are containers, never selectable surfaces.
            if matches!(c.kind, ChannelKind::Category) {
                continue;
            }
            if !(q.is_empty()
                || c.name.to_lowercase().contains(&q)
                || c.channel_type.to_lowercase().contains(&q))
            {
                continue;
            }
            if matches!(c.kind, ChannelKind::Dm | ChannelKind::Group) {
                direct.push(c);
            } else {
                rest.push(c);
            }
        }
        // Stable order by name within each section; Direct pinned on top.
        direct.sort_by(|a, b| a.name.cmp(&b.name));
        rest.sort_by(|a, b| a.name.cmp(&b.name));
        direct.extend(rest);
        direct
    }

    pub fn filtered_users(&self) -> Vec<&RegisteredUser> {
        let q = self.user_filter.to_lowercase();
        self.users
            .iter()
            .filter(|u| q.is_empty() || u.username.to_lowercase().contains(&q))
            .collect()
    }

    pub fn is_adminish(&self) -> bool {
        matches!(
            self.user
                .as_ref()
                .and_then(|u| u.highest_role.as_deref())
                .map(|r| r.to_lowercase())
                .as_deref(),
            Some("owner" | "admin")
        )
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
                    let _ = tx.send(BgMsg::Error(format!("Channels: {e}"))).await;
                }
            }
        });
    }

    pub fn spawn_load_messages(&self, channel_id: &str) {
        let api = self.api.clone();
        let tx = self.bg_tx.clone();
        let ch_id = channel_id.to_string();
        tokio::spawn(async move {
            match api.get_messages(&ch_id, MSG_LIMIT).await {
                Ok(msgs) => {
                    let _ = tx.send(BgMsg::Messages(ch_id, msgs)).await;
                }
                Err(e) => {
                    let _ = tx.send(BgMsg::Error(format!("Messages: {e}"))).await;
                }
            }
        });
    }

    pub fn spawn_load_users(&self) {
        let api = self.api.clone();
        let tx = self.bg_tx.clone();
        tokio::spawn(async move {
            match api.list_users().await {
                Ok(u) => {
                    let _ = tx.send(BgMsg::Users(u)).await;
                }
                Err(e) => {
                    let _ = tx.send(BgMsg::Error(format!("Users: {e}"))).await;
                }
            }
        });
    }

    pub fn spawn_admin_stats(&self) {
        let api = self.api.clone();
        let tx = self.bg_tx.clone();
        tokio::spawn(async move {
            match api.admin_stats().await {
                Ok(s) => {
                    let _ = tx.send(BgMsg::Stats(s)).await;
                }
                Err(e) => {
                    let _ = tx
                        .send(BgMsg::Info(format!("Admin stats unavailable: {e}")))
                        .await;
                }
            }
        });
    }

    pub fn spawn_health(&self) {
        let api = self.api.clone();
        let tx = self.bg_tx.clone();
        tokio::spawn(async move {
            match api.health().await {
                Ok(h) => {
                    let _ = tx.send(BgMsg::Health(h)).await;
                }
                Err(e) => {
                    let _ = tx.send(BgMsg::Error(format!("Health: {e}"))).await;
                }
            }
        });
    }

    pub fn poll_bg(&mut self) {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let poll_every = self.config.poll_ms();
        let live_ok = self.live.is_connected()
            && now_ms.saturating_sub(
                self.live
                    .health
                    .last_event_ms
                    .load(std::sync::atomic::Ordering::Relaxed),
            ) < 30_000;
        if !live_ok && now_ms.saturating_sub(self.last_poll_ms) >= poll_every {
            if self.screen == Screen::Chat {
                if let Some(ref ch_id) = self.active_channel {
                    if self.config.token.is_some() {
                        self.spawn_load_messages(ch_id);
                    }
                }
            }
            self.last_poll_ms = now_ms;
        }

        while let Ok(msg) = self.bg_rx.try_recv() {
            self.dirty = true;
            match msg {
                BgMsg::Channels(channels) => {
                    self.channels = channels;
                    self.status = if self.channels.is_empty() {
                        "Connected — no channels".into()
                    } else {
                        format!("{} channels", self.channels.len())
                    };
                    self.log(format!("loaded {} channels", self.channels.len()));
                    if self.active_channel.is_none() {
                        if let Some(ch) = self.channels.first() {
                            let id = ch.id.clone();
                            self.active_channel = Some(id.clone());
                            self.spawn_load_messages(&id);
                        }
                    }
                    // First live connect once we have a room to join.
                    if self.config.token.is_some()
                        && !self.live.is_connected()
                        && self.active_channel.is_some()
                    {
                        self.spawn_live_connect();
                    }
                }
                BgMsg::Messages(ch_id, msgs) => {
                    self.messages.insert(ch_id, msgs);
                }
                BgMsg::Users(users) => {
                    self.log(format!("loaded {} users", users.len()));
                    self.users = users;
                    if self.selected_user >= self.users.len() {
                        self.selected_user = self.users.len().saturating_sub(1);
                    }
                }
                BgMsg::Stats(stats) => {
                    self.log("admin stats refreshed");
                    self.stats = Some(stats);
                }
                BgMsg::Health(h) => {
                    self.health_blob = h;
                    self.status = format!("Healthy · {}", self.config.server_url);
                    self.log("health refreshed");
                }
                BgMsg::SendOk(ch_id) => {
                    self.spawn_load_messages(&ch_id);
                }
                BgMsg::LoginOk {
                    request_id,
                    token,
                    user_id,
                    username,
                    highest_role,
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
                        highest_role: highest_role.clone(),
                    });
                    self.status = format!("Logged in as {username}");
                    self.log(format!(
                        "login ok as {username} role={}",
                        highest_role.as_deref().unwrap_or("?")
                    ));
                    self.mode = AppMode::Normal;
                    self.spawn_load_channels();
                    self.spawn_load_users();
                    self.spawn_admin_stats();
                    self.spawn_live_connect();
                }
                BgMsg::LoginErr {
                    request_id,
                    message,
                } => {
                    if self.mode == AppMode::LoginLoading && request_id == self.login_request_id {
                        self.mode = AppMode::Login;
                        self.status = "Not logged in".into();
                        self.log(format!("login fail: {message}"));
                        self.set_error(message);
                    }
                }
                BgMsg::ActionOk(m) => {
                    self.log(m.clone());
                    self.status = m;
                }
                BgMsg::Error(e) => {
                    self.log(format!("err: {e}"));
                    self.set_error(e);
                }
                BgMsg::Info(m) => {
                    self.log(m);
                }
                BgMsg::LiveConnected => {
                    self.status = format!("LIVE · {}", self.config.server_url);
                    self.log("live feed connected");
                    if let Some(ref ch) = self.active_channel {
                        self.live.join_channel(ch);
                    }
                }
                BgMsg::LiveDisconnected(reason) => {
                    // Poll loop re-engages automatically via live_ok guard.
                    self.status = "POLL · live offline".into();
                    self.log(format!("live disconnected: {reason}"));
                }
                BgMsg::LiveAuthFailed(reason) => {
                    // Server rejected the JWT at handshake. Drop the dead
                    // token and require a fresh login instead of flapping.
                    self.log(format!("live auth failed: {reason} — re-login required"));
                    self.config.token = None;
                    let _ = self.config.save();
                    self.api.clear_token();
                    self.user = None;
                    self.mode = AppMode::Login;
                    self.login_field = 0;
                    self.status = "Session expired — press Enter to log in".into();
                }
                BgMsg::LiveMessage {
                    channel_id,
                    message,
                } => {
                    let is_active = self.active_channel.as_deref() == Some(channel_id.as_str());
                    let already = self
                        .messages
                        .entry(channel_id.clone())
                        .or_default()
                        .iter()
                        .any(|m| m.id == message.id);
                    if !already {
                        if is_active {
                            self.messages.get_mut(&channel_id).unwrap().push(message);
                        } else {
                            *self.unread.entry(channel_id.clone()).or_insert(0) += 1;
                            // Keep the buffer warm so switching shows it.
                            self.messages.entry(channel_id).or_default().push(message);
                        }
                    }
                }
                BgMsg::LiveTyping {
                    channel_id,
                    username,
                } => {
                    self.typing_channel = Some(channel_id);
                    self.typing_user = Some(username);
                    self.typing_at_ms = now_ms;
                }
            }
        }
    }

    /// Spawn the socket.io connect task after a successful login (or with a
    /// remembered token at startup).
    pub fn spawn_live_connect(&self) {
        let Some(token) = self.config.token.clone() else {
            return;
        };
        let Some(username) = self.config.username.clone() else {
            return;
        };
        let channel = self.active_channel.clone().unwrap_or_default();
        if channel.is_empty() {
            return; // retried when channels load / LiveConnected fires join
        }
        // rust_engineio's secure transport builds its own tokio runtime and
        // block_on's inside — calling connect() on a tokio worker thread
        // panics with "Cannot start a runtime from within a runtime".
        // Run it on a plain OS thread instead; results arrive via bg_tx.
        let live = self.live.clone();
        let server = self.config.server_url.clone();
        let bg_tx = self.bg_tx.clone();
        std::thread::spawn(move || {
            if let Err(e) = live.connect(&server, &token, &username, &channel, bg_tx) {
                tracing::warn!("live connect failed: {e}");
            }
        });
    }

    pub fn set_error(&mut self, error: String) {
        self.error = Some(error);
        self.dirty = true;
    }

    pub fn clear_error(&mut self) {
        self.error = None;
        self.dirty = true;
    }

    pub async fn do_connect(&mut self) -> Result<()> {
        self.pending_connect = false;
        match self.api.health().await {
            Ok(h) => {
                self.health_blob = h;
                self.status = format!(
                    "Connected to {} — press l to log in",
                    self.config.server_url
                );
                self.log("connected");
                self.mode = AppMode::Login;
                self.login_username.clear();
                self.login_password.clear();
                self.login_field = 0;
            }
            Err(e) => {
                self.set_error(format!("Could not reach {}: {e}", self.config.server_url));
                self.mode = AppMode::ServerSetup;
            }
        }
        Ok(())
    }

    pub fn handle_key(&mut self, key: KeyCode) -> Result<bool> {
        self.dirty = true;
        if self.error.is_some() && matches!(key, KeyCode::Esc) {
            self.clear_error();
            return Ok(true);
        }
        if self.show_help || self.mode == AppMode::Help {
            if matches!(key, KeyCode::Esc | KeyCode::Char('?') | KeyCode::Char('q')) {
                self.show_help = false;
                if self.mode == AppMode::Help {
                    self.mode = AppMode::Normal;
                }
            }
            return Ok(true);
        }

        match self.mode {
            AppMode::Normal => self.handle_normal_key(key),
            AppMode::Input => self.handle_input_key(key),
            AppMode::Login | AppMode::LoginLoading => self.handle_login_key(key),
            AppMode::ServerSetup => self.handle_server_setup_key(key),
            AppMode::Command => self.handle_command_key(key),
            AppMode::Prompt => self.handle_prompt_key(key),
            AppMode::Help => Ok(true),
        }
    }

    fn handle_normal_key(&mut self, key: KeyCode) -> Result<bool> {
        // Global screen / focus keys
        match key {
            KeyCode::Char('q') => return Ok(false),
            KeyCode::Char('?') => {
                self.show_help = true;
                return Ok(true);
            }
            KeyCode::Char(':') => {
                self.mode = AppMode::Command;
                self.command.clear();
                return Ok(true);
            }
            KeyCode::Tab => {
                self.screen = self.screen.next();
                self.status = format!("Screen · {}", self.screen.label());
                self.on_screen_enter();
                return Ok(true);
            }
            KeyCode::BackTab => {
                self.screen = self.screen.prev();
                self.status = format!("Screen · {}", self.screen.label());
                self.on_screen_enter();
                return Ok(true);
            }
            KeyCode::Char('1') => {
                self.screen = Screen::Chat;
                self.on_screen_enter();
                return Ok(true);
            }
            KeyCode::Char('2') => {
                self.screen = Screen::Users;
                self.on_screen_enter();
                return Ok(true);
            }
            KeyCode::Char('3') => {
                self.screen = Screen::Server;
                self.on_screen_enter();
                return Ok(true);
            }
            KeyCode::Char('4') => {
                self.screen = Screen::Logs;
                return Ok(true);
            }
            KeyCode::Char('l') | KeyCode::Char('L') => {
                self.mode = AppMode::Login;
                self.login_username = self.config.username.clone().unwrap_or_default();
                self.login_password.clear();
                self.login_field = if self.login_username.is_empty() { 0 } else { 1 };
                self.clear_error();
                return Ok(true);
            }
            KeyCode::Char('r') | KeyCode::F(5) => {
                self.refresh_current();
                return Ok(true);
            }
            KeyCode::Esc => {
                self.clear_error();
                return Ok(true);
            }
            _ => {}
        }

        match self.screen {
            Screen::Chat => self.handle_chat_keys(key),
            Screen::Users => self.handle_users_keys(key),
            Screen::Server => self.handle_server_keys(key),
            Screen::Logs => Ok(true),
        }
    }

    fn on_screen_enter(&mut self) {
        match self.screen {
            Screen::Users => {
                if self.users.is_empty() {
                    self.spawn_load_users();
                }
            }
            Screen::Server => {
                self.spawn_health();
                self.spawn_admin_stats();
            }
            Screen::Chat => {
                if self.channels.is_empty() {
                    self.spawn_load_channels();
                }
            }
            Screen::Logs => {}
        }
    }

    fn refresh_current(&mut self) {
        self.status = "Refreshing…".into();
        match self.screen {
            Screen::Chat => {
                self.spawn_load_channels();
                if let Some(id) = self.active_channel.clone() {
                    self.spawn_load_messages(&id);
                }
            }
            Screen::Users => self.spawn_load_users(),
            Screen::Server => {
                self.spawn_health();
                self.spawn_admin_stats();
            }
            Screen::Logs => {}
        }
    }

    fn handle_chat_keys(&mut self, key: KeyCode) -> Result<bool> {
        match key {
            KeyCode::Char('i') | KeyCode::Char('I') => {
                self.mode = AppMode::Input;
            }
            KeyCode::Char('/') => {
                self.mode = AppMode::Command;
                self.command = "filter ".into();
            }
            KeyCode::Char('h') | KeyCode::Left => self.focus = FocusPane::Left,
            KeyCode::Char(' ') => {
                self.focus = match self.focus {
                    FocusPane::Left => FocusPane::Center,
                    FocusPane::Center => FocusPane::Right,
                    FocusPane::Right => FocusPane::Left,
                };
            }
            KeyCode::Char('j') | KeyCode::Down => self.nav_channels(1),
            KeyCode::Char('k') | KeyCode::Up => self.nav_channels(-1),
            KeyCode::PageUp => {
                let max = self
                    .active_channel
                    .as_ref()
                    .and_then(|id| self.messages.get(id))
                    .map(|m| m.len().saturating_sub(1))
                    .unwrap_or(0);
                self.msg_scroll = (self.msg_scroll + 8).min(max);
            }
            KeyCode::PageDown => {
                self.msg_scroll = self.msg_scroll.saturating_sub(8);
            }
            KeyCode::Enter => {
                if let Some(ref ch_id) = self.active_channel.clone() {
                    self.spawn_load_messages(ch_id);
                }
            }
            _ => {}
        }
        Ok(true)
    }

    fn nav_channels(&mut self, delta: i32) {
        let list: Vec<String> = self
            .filtered_channels()
            .into_iter()
            .map(|c| c.id.clone())
            .collect();
        if list.is_empty() {
            return;
        }
        let idx = self
            .active_channel
            .as_ref()
            .and_then(|id| list.iter().position(|c| c == id))
            .unwrap_or(0) as i32;
        let next = (idx + delta).clamp(0, list.len() as i32 - 1) as usize;
        let id = list[next].clone();
        self.active_channel = Some(id.clone());
        self.unread.remove(&id);
        self.msg_scroll = 0;
        self.live.join_channel(&id);
        self.spawn_load_messages(&id);
    }

    fn handle_users_keys(&mut self, key: KeyCode) -> Result<bool> {
        let n = self.filtered_users().len();
        match key {
            KeyCode::Char('j') | KeyCode::Down => {
                if n > 0 {
                    self.selected_user = (self.selected_user + 1).min(n - 1);
                }
            }
            KeyCode::Char('k') | KeyCode::Up => {
                self.selected_user = self.selected_user.saturating_sub(1);
            }
            KeyCode::Char('/') => {
                self.mode = AppMode::Command;
                self.command = "ufilter ".into();
            }
            KeyCode::Char('p') => {
                if !self.is_adminish() {
                    self.set_error("Admin/owner only".into());
                    return Ok(true);
                }
                self.prompt_kind = Some(PromptKind::ResetPassword);
                self.prompt_title = "New password for selected user".into();
                self.prompt.clear();
                self.mode = AppMode::Prompt;
            }
            KeyCode::Char('c') => {
                if !self.is_adminish() {
                    self.set_error("Admin/owner only".into());
                    return Ok(true);
                }
                if let Some(u) = self
                    .filtered_users()
                    .get(self.selected_user)
                    .map(|u| (*u).clone())
                {
                    let id = u.user_id;
                    let name = u.username.clone();
                    let api = self.api.clone();
                    let tx = self.bg_tx.clone();
                    tokio::spawn(async move {
                        match api.admin_clear_lockout(id).await {
                            Ok(()) => {
                                let _ = tx
                                    .send(BgMsg::ActionOk(format!("Cleared lockout for {name}")))
                                    .await;
                            }
                            Err(e) => {
                                let _ = tx.send(BgMsg::Error(e.to_string())).await;
                            }
                        }
                    });
                }
            }
            _ => {}
        }
        Ok(true)
    }

    fn handle_server_keys(&mut self, key: KeyCode) -> Result<bool> {
        match key {
            KeyCode::Char('s') => {
                self.mode = AppMode::ServerSetup;
                self.server_input = self.config.server_url.clone();
            }
            KeyCode::Char('o') => {
                // logout
                self.config.token = None;
                let _ = self.config.save();
                self.api.clear_token();
                self.user = None;
                self.stats = None;
                self.status = "Logged out".into();
                self.log("logout");
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
                        self.set_error("Not logged in — press l".into());
                        self.input.clear();
                        self.mode = AppMode::Normal;
                        return Ok(true);
                    }
                    if let Some(ch_id) = self.active_channel.clone() {
                        let display_name = self
                            .user
                            .as_ref()
                            .map(|u| u.username.clone())
                            .or_else(|| self.config.username.clone())
                            .unwrap_or_else(|| "me".into());
                        let user_id = self.user.as_ref().map(|u| u.id).unwrap_or(0);
                        let now_ms = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_millis() as i64)
                            .unwrap_or(0);
                        self.messages
                            .entry(ch_id.clone())
                            .or_default()
                            .push(Message {
                                id: format!("local-{now_ms}"),
                                channel_id: ch_id.clone(),
                                sender_id: user_id,
                                sender_name: display_name,
                                text: text.clone(),
                                timestamp: now_ms,
                                message_type: "text".into(),
                            });
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
                                        tx.send(BgMsg::Error(format!("Send failed: {e}"))).await;
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

    fn handle_command_key(&mut self, key: KeyCode) -> Result<bool> {
        match key {
            KeyCode::Esc => {
                self.mode = AppMode::Normal;
                self.command.clear();
            }
            KeyCode::Enter => {
                let cmd = self.command.trim().to_string();
                self.mode = AppMode::Normal;
                self.command.clear();
                self.run_command(&cmd);
            }
            KeyCode::Char(c) => self.command.push(c),
            KeyCode::Backspace => {
                self.command.pop();
            }
            _ => {}
        }
        Ok(true)
    }

    fn run_command(&mut self, cmd: &str) {
        let mut parts = cmd.split_whitespace();
        let head = parts.next().unwrap_or("").to_lowercase();
        match head.as_str() {
            "q" | "quit" => {
                // handled by returning false from key — set a flag via status
                self.status = "Press q again to quit".into();
            }
            "chat" => {
                self.screen = Screen::Chat;
                self.on_screen_enter();
            }
            "users" => {
                self.screen = Screen::Users;
                self.on_screen_enter();
            }
            "server" => {
                self.screen = Screen::Server;
                self.on_screen_enter();
            }
            "logs" => self.screen = Screen::Logs,
            "refresh" | "r" => self.refresh_current(),
            "logout" => {
                self.config.token = None;
                let _ = self.config.save();
                self.api.clear_token();
                self.user = None;
                self.log("logout");
            }
            "login" => {
                self.mode = AppMode::Login;
            }
            "filter" => {
                self.channel_filter = parts.collect::<Vec<_>>().join(" ");
                self.status = format!("Channel filter: {:?}", self.channel_filter);
            }
            "ufilter" => {
                self.user_filter = parts.collect::<Vec<_>>().join(" ");
                self.selected_user = 0;
                self.status = format!("User filter: {:?}", self.user_filter);
            }
            "goto" => {
                let name = parts.collect::<Vec<_>>().join(" ").to_lowercase();
                if let Some(ch) = self
                    .channels
                    .iter()
                    .find(|c| c.name.to_lowercase() == name || c.name.to_lowercase().contains(&name))
                {
                    let id = ch.id.clone();
                    self.screen = Screen::Chat;
                    self.active_channel = Some(id.clone());
                    self.spawn_load_messages(&id);
                } else {
                    self.set_error(format!("No channel matching '{name}'"));
                }
            }
            "help" => self.show_help = true,
            "fps" => {
                if let Some(raw) = parts.next() {
                    if let Ok(n) = raw.parse::<f32>() {
                        self.config.fps = n;
                        self.config.clamp();
                        let _ = self.config.save();
                        self.status = format!(
                            "FPS {:.1} (~{}ms/frame)",
                            self.config.fps,
                            self.config.frame_ms()
                        );
                        self.log(self.status.clone());
                    } else {
                        self.set_error("usage: :fps <0.2-60>".into());
                    }
                } else {
                    self.status = format!(
                        "FPS {:.1} (~{}ms) — set with :fps N (e-ink try 1-5)",
                        self.config.fps,
                        self.config.frame_ms()
                    );
                }
            }
            "poll" => {
                if let Some(raw) = parts.next() {
                    if let Ok(n) = raw.parse::<f32>() {
                        self.config.poll_secs = n;
                        self.config.clamp();
                        let _ = self.config.save();
                        self.status = format!("Chat poll every {:.1}s", self.config.poll_secs);
                        self.log(self.status.clone());
                    } else {
                        self.set_error("usage: :poll <seconds>".into());
                    }
                } else {
                    self.status = format!(
                        "Chat poll {:.1}s — set with :poll N",
                        self.config.poll_secs
                    );
                }
            }
            "eink" => {
                // Preset: slow redraw + slower network poll for e-ink / low power.
                self.config.fps = 2.0;
                self.config.poll_secs = 8.0;
                self.config.clamp();
                let _ = self.config.save();
                self.status = format!(
                    "E-ink preset · {:.0} fps · poll {:.0}s",
                    self.config.fps, self.config.poll_secs
                );
                self.log(self.status.clone());
            }
            "" => {}
            other => self.set_error(format!(
                "Unknown :{other} — try :chat :users :server :logs :filter :ufilter :goto :refresh :logout :fps :poll :eink :help"
            )),
        }
    }

    fn handle_prompt_key(&mut self, key: KeyCode) -> Result<bool> {
        match key {
            KeyCode::Esc => {
                self.mode = AppMode::Normal;
                self.prompt.clear();
                self.prompt_kind = None;
            }
            KeyCode::Enter => {
                let value = self.prompt.clone();
                let kind = self.prompt_kind;
                self.mode = AppMode::Normal;
                self.prompt.clear();
                self.prompt_kind = None;
                if let Some(PromptKind::ResetPassword) = kind {
                    if value.len() < 6 {
                        self.set_error("Password must be ≥ 6 chars".into());
                        return Ok(true);
                    }
                    if let Some(u) = self
                        .filtered_users()
                        .get(self.selected_user)
                        .map(|u| (*u).clone())
                    {
                        let id = u.user_id;
                        let name = u.username.clone();
                        let api = self.api.clone();
                        let tx = self.bg_tx.clone();
                        tokio::spawn(async move {
                            match api.admin_reset_password(id, &value, true).await {
                                Ok(()) => {
                                    let _ = tx
                                        .send(BgMsg::ActionOk(format!(
                                            "Password reset for {name} (temporary)"
                                        )))
                                        .await;
                                }
                                Err(e) => {
                                    let _ = tx.send(BgMsg::Error(e.to_string())).await;
                                }
                            }
                        });
                    }
                }
            }
            KeyCode::Char(c) => self.prompt.push(c),
            KeyCode::Backspace => {
                self.prompt.pop();
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
                    format!("https://{url}")
                };
                self.config.server_url = url.clone();
                let _ = self.config.save();
                self.api = ApiClient::new(&url);
                self.server_input.clear();
                self.status = format!("Connecting to {url}…");
                self.pending_connect = true;
            }
            KeyCode::Esc => {
                if self.config.server_url.is_empty() {
                    return Ok(false);
                }
                self.mode = AppMode::Normal;
            }
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
                if self.mode == AppMode::LoginLoading {
                    self.login_request_id = self.login_request_id.wrapping_add(1);
                }
                self.mode = AppMode::Normal;
                self.login_password.clear();
            }
            KeyCode::Tab | KeyCode::Down | KeyCode::Up => {
                self.login_field ^= 1;
            }
            KeyCode::Enter => {
                if self.login_field == 0 {
                    self.login_field = 1;
                } else if !self.login_username.is_empty() && !self.login_password.is_empty() {
                    self.mode = AppMode::LoginLoading;
                    self.status = "Authenticating…".into();
                    self.login_request_id = self.login_request_id.wrapping_add(1);
                    let request_id = self.login_request_id;
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
                                        highest_role: r.highest_role,
                                    })
                                    .await;
                            }
                            Err(e) => {
                                let _ = tx
                                    .send(BgMsg::LoginErr {
                                        request_id,
                                        message: format!("Login failed: {e}"),
                                    })
                                    .await;
                            }
                        }
                    });
                } else {
                    self.status = "Need username AND password".into();
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
