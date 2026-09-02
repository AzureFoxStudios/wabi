# Wabi TUI Guide

## What is a TUI?

A **Terminal User Interface (TUI)** is like a GUI, but runs entirely in your terminal. Think of it as a text-based app with:
- Keyboard navigation (no mouse needed)
- Real-time rendering with colors and layouts
- Interactive input fields
- Multiple panels/views

**Examples you might know:**
- `htop` - process monitor
- `ncmpcpp` - music player
- `lazygit` - git client
- `ranger` - file manager

---

## What We Built

**Wabi TUI** - A terminal chat client for Wabi servers.

### Features (Current State)
- ✅ Connect to Wabi server
- ✅ View channel list (left panel)
- ✅ View messages (right panel)
- ✅ Send messages (input mode)
- ✅ Keyboard navigation (j/k for channels)
- ✅ Status bar showing connection state
- ✅ Error display

### Features (TODO)
- ❌ User login/register
- ❌ Real-time message updates (WebSocket)
- ❌ Typing indicators
- ❌ Multiple servers
- ❌ Config management UI

---

## Architecture Overview

```
wabi-tui/
├── Cargo.toml          # Dependencies + package info
└── src/
    ├── main.rs         # Entry point + event loop
    ├── app.rs          # Application state + logic
    ├── ui.rs           # Rendering code
    ├── api.rs          # HTTP API client
    └── config.rs       # Config file handling
```

### How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                         main.rs                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Event Loop (crossterm)                              │    │
│  │  - Listen for key presses                            │    │
│  │  - Call app.handle_key()                             │    │
│  │  - Call terminal.draw(|f| ui::draw(f, &mut app))     │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                         app.rs                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  App Struct (state)                                  │    │
│  │  - user: Option<User>                                │    │
│  │  - channels: Vec<Channel>                            │    │
│  │  - messages: HashMap<channel_id, Vec<Message>>       │    │
│  │  - input: String                                     │    │
│  │  - mode: AppMode (Normal/Input/Login/Register)       │    │
│  └─────────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Methods                                             │    │
│  │  - handle_key() - process keyboard input             │    │
│  │  - load_channels() - fetch from API                  │    │
│  │  - send_message() - post to API                      │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                         api.rs                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  ApiClient                                           │    │
│  │  - GET /api/channels                                 │    │
│  │  - GET /api/messages/{channel_id}                    │    │
│  │  - POST /api/messages                                │    │
│  │  - POST /api/auth/login                              │    │
│  │  - POST /api/auth/register                           │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

---

## Key Dependencies

### 1. **ratatui** (TUI Framework)
```toml
ratatui = "0.29"
```
**What it does:** Provides widgets, layouts, and rendering.

**Key concepts:**
- `Frame` - One render pass
- `Widget` - UI component (Block, Paragraph, List, etc.)
- `Layout` - Flexbox-like positioning
- `Style` - Colors, modifiers (bold, underline)

**Example:**
```rust
use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout},
    style::{Color, Style},
    widgets::{Block, Borders, Paragraph},
};

// Create a 50/50 split layout
let chunks = Layout::default()
    .direction(Direction::Horizontal)
    .constraints([
        Constraint::Percentage(30),  // Left panel (channels)
        Constraint::Percentage(70),  // Right panel (messages)
    ])
    .split(area);

// Create a bordered box
let block = Block::default()
    .title("Channels")
    .borders(Borders::ALL)
    .style(Style::default().fg(Color::White));

// Render text inside the block
let paragraph = Paragraph::new("general")
    .block(block);
frame.render_widget(paragraph, chunks[0]);
```

---

### 2. **crossterm** (Terminal I/O)
```toml
crossterm = "0.28"
```
**What it does:** Cross-platform terminal manipulation.

**Key features:**
- Raw mode (disable line buffering)
- Event polling (non-blocking input)
- Cursor control
- Color output

**Example:**
```rust
use crossterm::{
    event::{self, Event, KeyCode},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode},
};

// Enable raw mode (capture every keystroke)
enable_raw_mode()?;

// Listen for events
loop {
    if event::poll(Duration::from_millis(100))? {
        if let Event::Key(key) = event::read()? {
            match key.code {
                KeyCode::Char('q') => break,  // Quit
                KeyCode::Enter => { /* submit */ }
                _ => {}
            }
        }
    }
    
    // Render frame
    terminal.draw(|f| ui::draw(f, &mut app))?;
}

// Restore terminal on exit
disable_raw_mode()?;
```

---

### 3. **tokio** (Async Runtime)
```toml
tokio = { version = "1", features = ["full"] }
```
**What it does:** Async I/O for network requests without blocking the UI.

**Why we need it:**
- HTTP requests to Wabi API
- Don't freeze UI while waiting for response
- Can spawn background tasks

**Example:**
```rust
#[tokio::main]
async fn main() -> Result<()> {
    // Async main function
    let app = App::new().await?;  // Fetches channels on startup
    run_app(&mut terminal, app).await?;
    Ok(())
}

// In app.rs
pub async fn load_channels(&mut self) -> Result<()> {
    self.channels = self.api.get_channels().await?;
    Ok(())
}
```

---

### 4. **reqwest** (HTTP Client)
```toml
reqwest = { version = "0.12", features = ["json"] }
```
**What it does:** Makes HTTP requests.

**Example:**
```rust
use reqwest::Client;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
struct Channel {
    id: String,
    name: String,
}

pub struct ApiClient {
    client: Client,
    base_url: String,
}

impl ApiClient {
    pub async fn get_channels(&self) -> Result<Vec<Channel>> {
        let resp = self.client
            .get(format!("{}/api/channels", self.base_url))
            .send()
            .await?
            .json()
            .await?;
        Ok(resp)
    }
}
```

---

## The Event Loop (main.rs)

This is the heart of any TUI:

```rust
#[tokio::main]
async fn main() -> Result<()> {
    // 1. Initialize terminal
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    // 2. Create app state
    let mut app = App::new().await?;

    // 3. Main loop
    loop {
        // A. Render frame
        terminal.draw(|f| ui::draw(f, &mut app))?;

        // B. Wait for input (100ms timeout)
        if event::poll(Duration::from_millis(100))? {
            if let Event::Key(key) = event::read()? {
                // C. Handle key
                if !app.handle_key(key.code)? {
                    break;  // Quit signal
                }
            }
        }
    }

    // 4. Cleanup
    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        DisableMouseCapture
    )?;
    terminal.show_cursor()?;

    Ok(())
}
```

**Flow:**
1. Clear screen, enter alternate screen buffer
2. Create app (load config, connect to server)
3. Loop forever:
   - Draw UI
   - Check for keypress
   - Handle input
   - Repeat
4. On exit: restore terminal, show cursor

---

## App State (app.rs)

The `App` struct holds **all** application state:

```rust
pub struct App {
    pub config: Config,           // Server URL, theme, etc.
    pub api: ApiClient,           // HTTP client
    pub user: Option<User>,       // Logged-in user
    pub channels: Vec<Channel>,   // Channel list
    pub messages: HashMap<String, Vec<Message>>,  // Messages per channel
    pub active_channel: Option<String>,  // Currently viewing
    pub input: String,            // Text being typed
    pub error: Option<String>,    // Error message to display
    pub status: String,           // Status bar text
    pub mode: AppMode,            // Current mode (Normal/Input/etc.)
}
```

**Why this matters:**
- Single source of truth
- UI is a **function of state**: `UI = f(App)`
- Every render, we draw based on current state

---

## Rendering (ui.rs)

The UI is **declarative** - we describe what to draw:

```rust
pub fn draw(frame: &mut Frame, app: &mut App) {
    let area = frame.area();  // Full terminal size

    // 1. Create layout (30% left, 70% right)
    let chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(30), Constraint::Percentage(70)])
        .split(area);

    // 2. Draw channel list (left panel)
    draw_channels(frame, app, chunks[0]);

    // 3. Draw messages (right panel)
    draw_messages(frame, app, chunks[1]);

    // 4. Draw status bar (bottom)
    draw_status_bar(frame, app, area);
}

fn draw_channels(frame: &mut Frame, app: &App, area: Rect) {
    let items: Vec<ListItem> = app.channels
        .iter()
        .map(|c| {
            let style = if Some(&c.id) == app.active_channel.as_ref() {
                Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };
            ListItem::new(c.name.as_str()).style(style)
        })
        .collect();

    let list = List::new(items)
        .block(Block::default()
            .title("Channels")
            .borders(Borders::ALL));

    frame.render_widget(list, area);
}
```

**Key insight:** We don't "update" widgets. We **rebuild** the entire UI every frame based on current state.

---

## Keyboard Handling

Mode-based input processing:

```rust
pub fn handle_key(&mut self, key: KeyCode) -> Result<bool> {
    match self.mode {
        AppMode::Normal => self.handle_normal_key(key),
        AppMode::Input => self.handle_input_key(key),
        AppMode::Login => Ok(true),
        AppMode::Register => Ok(true),
    }
}

fn handle_normal_key(&mut self, key: KeyCode) -> Result<bool> {
    match key {
        KeyCode::Char('q') => return Ok(false),  // Signal quit
        KeyCode::Char('i') => self.mode = AppMode::Input,
        KeyCode::Char('j') => { /* next channel */ }
        KeyCode::Char('k') => { /* prev channel */ }
        KeyCode::Enter => { /* refresh */ }
        _ => {}
    }
    Ok(true)  // Continue running
}

fn handle_input_key(&mut self, key: KeyCode) -> Result<bool> {
    match key {
        KeyCode::Enter => {
            let _ = self.send_message().await;
            self.mode = AppMode::Normal;
        }
        KeyCode::Esc => self.mode = AppMode::Normal,
        KeyCode::Char(c) => self.input.push(c),
        KeyCode::Backspace => { self.input.pop(); }
        _ => {}
    }
    Ok(true)
}
```

**Why modes?**
- Same key does different things in different contexts
- `Enter` sends message in Input mode, but refreshes in Normal mode
- `Esc` cancels input, returns to Normal

---

## Configuration (config.rs)

Simple TOML config file:

```rust
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub server_url: String,
    pub username: Option<String>,
    pub theme: String,
}

impl Config {
    pub fn load() -> Result<Self> {
        let config_path = dirs::config_dir()
            .unwrap()
            .join("wabi")
            .join("config.toml");
        
        if config_path.exists() {
            let content = std::fs::read_to_string(&config_path)?;
            Ok(toml::from_str(&content)?)
        } else {
            Ok(Self::default())
        }
    }

    pub fn save(&self) -> Result<()> {
        let config_path = dirs::config_dir()
            .unwrap()
            .join("wabi")
            .join("config.toml");
        
        std::fs::create_dir_all(config_path.parent().unwrap())?;
        std::fs::write(&config_path, toml::to_string(self)?)?;
        Ok(())
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            server_url: "http://localhost:8080".to_string(),
            username: None,
            theme: "default".to_string(),
        }
    }
}
```

**Config file location:** `~/.config/wabi/config.toml`

**Example config:**
```toml
server_url = "https://www.wabi.chat"
username = "ronin"
theme = "dark"
```

---

## Building & Running

```bash
# Build
cd /home/Ronin/Desktop/Wabi/dotronin-worktree/wabi
cargo build -p wabi-tui --release

# Run
./target/release/wabi-tui

# With custom server
./target/release/wabi-tui --server https://www.wabi.chat
```

---

## Common Patterns

### 1. **Conditional Styling**
```rust
let style = if is_active {
    Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)
} else {
    Style::default()
};
```

### 2. **Scrollable Lists**
```rust
let list = List::new(items)
    .block(Block::default().title("Messages").borders(Borders::ALL))
    .highlight_style(Style::default().add_modifier(Modifier::REVERSED))
    .highlight_symbol("> ");

// Track scroll offset
let offset = messages.len().saturating_sub(visible_height);
```

### 3. **Input Fields**
```rust
let input = Paragraph::new(self.input.as_str())
    .block(Block::default()
        .title("Input (Esc to cancel)")
        .borders(Borders::ALL)
        .style(Style::default().fg(Color::Green)));
```

### 4. **Error Display**
```rust
if let Some(ref error) = self.error {
    let error_box = Paragraph::new(error.as_str())
        .style(Style::default().fg(Color::Red))
        .block(Block::default()
            .title("Error")
            .borders(Borders::ALL)
            .style(Style::default().fg(Color::Red)));
    frame.render_widget(error_box, error_area);
}
```

---

## Debugging Tips

### 1. **Terminal gets messed up?**
```bash
# Reset terminal
reset

# Or manually restore
tput sgr0
tput cnorm  # Show cursor
```

### 2. **Add debug output**
```rust
// Write to stderr (doesn't affect TUI)
eprintln!("DEBUG: channels = {:?}", self.channels);

// Or log to file
use std::fs::OpenOptions;
use std::io::Write;

let mut log = OpenOptions::new()
    .create(true)
    .append(true)
    .open("/tmp/wabi-tui.log")?;
writeln!(log, "Loaded {} channels", self.channels.len())?;
```

### 3. **Panic handling**
```rust
// In main.rs
use std::panic;

panic::set_hook(Box::new(|panic_info| {
    // Restore terminal before panicking
    let _ = disable_raw_mode();
    let _ = execute!(io::stdout(), LeaveAlternateScreen, ShowCursor);
    eprintln!("Panic: {}", panic_info);
}));
```

---

## Next Steps (Learning Path)

1. **Add login flow** - Create Login mode with username/password fields
2. **WebSocket integration** - Real-time message updates
3. **Scrolling** - Navigate long message history
4. **Tabs** - Switch between channels with numbers (1, 2, 3...)
5. **Themes** - Dark/light mode toggle
6. **Notifications** - Flash on new message when not focused

---

## Resources

- **ratatui docs:** https://docs.rs/ratatui
- **ratatui examples:** https://github.com/ratatui/ratatui/tree/main/examples
- **crossterm docs:** https://docs.rs/crossterm
- **TUI design patterns:** https://github.com/rothgar/awesome-tuis

---

## Quick Reference: Key Bindings

| Key | Action |
|-----|--------|
| `q` | Quit |
| `i` | Enter input mode |
| `j` / `↓` | Next channel |
| `k` / `↑` | Previous channel |
| `Enter` | Refresh messages |
| `r` / `F5` | Full refresh |
| `Esc` | Cancel input |
| `?` | Show help |

---

*Generated: 2026-04-29*
*Version: wabi-tui 0.1.0*
