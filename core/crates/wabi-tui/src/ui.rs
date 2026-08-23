//! Terminal UI — multi-screen admin/power layout.

use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, List, ListItem, Paragraph, Tabs, Wrap},
    Frame,
};

use crate::api::ChannelKind;
use crate::app::{App, AppMode, FocusPane, Screen};

// Wabi-ish indigo palette for the terminal.
const C_BG: Color = Color::Rgb(26, 26, 46);
const C_PANEL: Color = Color::Rgb(36, 36, 62);
const C_ACCENT: Color = Color::Rgb(99, 102, 241);
const C_ACCENT2: Color = Color::Rgb(129, 140, 248);
const C_TEXT: Color = Color::Rgb(224, 224, 255);
const C_MUTED: Color = Color::Rgb(153, 153, 255);
const C_OK: Color = Color::Rgb(74, 222, 128);
const C_WARN: Color = Color::Rgb(251, 191, 36);
const C_ERR: Color = Color::Rgb(248, 113, 113);

pub fn render(frame: &mut Frame, app: &App) {
    let root = frame.area();
    // paint base
    frame.render_widget(
        Block::default().style(Style::default().bg(C_BG).fg(C_TEXT)),
        root,
    );

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // header + tabs
            Constraint::Min(0),
            Constraint::Length(3), // footer
        ])
        .split(root);

    render_header(frame, app, chunks[0]);
    match app.screen {
        Screen::Chat => render_chat(frame, app, chunks[1]),
        Screen::Users => render_users(frame, app, chunks[1]),
        Screen::Server => render_server(frame, app, chunks[1]),
        Screen::Logs => render_logs(frame, app, chunks[1]),
    }
    render_footer(frame, app, chunks[2]);

    if app.mode == AppMode::ServerSetup {
        render_server_setup(frame, app);
    } else if app.mode == AppMode::Login || app.mode == AppMode::LoginLoading {
        render_login_form(frame, app);
    } else if app.mode == AppMode::Command {
        render_command_bar(frame, app);
    } else if app.mode == AppMode::Prompt {
        render_prompt(frame, app);
    }

    if app.show_help || app.mode == AppMode::Help {
        render_help(frame);
    }

    if let Some(error) = &app.error {
        render_error_popup(frame, error);
    }
}

fn render_header(frame: &mut Frame, app: &App, area: Rect) {
    let tabs = ["1 Chat", "2 Users", "3 Server", "4 Logs"];
    let selected = match app.screen {
        Screen::Chat => 0,
        Screen::Users => 1,
        Screen::Server => 2,
        Screen::Logs => 3,
    };

    let user_bit = if let Some(ref u) = app.user {
        let role = u.highest_role.as_deref().unwrap_or("member");
        format!("● {} ({})", u.username, role)
    } else {
        "○ guest".into()
    };

    let title = format!(" Wabi TUI  ·  {}  ·  {} ", user_bit, app.status);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(C_ACCENT))
        .title(Span::styled(
            title,
            Style::default().fg(C_ACCENT2).add_modifier(Modifier::BOLD),
        ))
        .style(Style::default().bg(C_PANEL));

    let inner = block.inner(area);
    frame.render_widget(block, area);

    let tab_titles: Vec<Line> = tabs
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let style = if i == selected {
                Style::default()
                    .fg(C_BG)
                    .bg(C_ACCENT2)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(C_MUTED)
            };
            Line::from(Span::styled(format!(" {t} "), style))
        })
        .collect();

    frame.render_widget(
        Tabs::new(tab_titles)
            .select(selected)
            .divider(" ")
            .style(Style::default().fg(C_MUTED)),
        inner,
    );
}

fn render_chat(frame: &mut Frame, app: &App, area: Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(22),
            Constraint::Percentage(58),
            Constraint::Percentage(20),
        ])
        .split(area);

    render_channels(frame, app, cols[0]);
    render_messages(frame, app, cols[1]);
    render_chat_side(frame, app, cols[2]);
}

fn pane_border(focused: bool) -> Style {
    if focused {
        Style::default().fg(C_ACCENT2)
    } else {
        Style::default().fg(Color::Rgb(70, 70, 110))
    }
}

fn render_channels(frame: &mut Frame, app: &App, area: Rect) {
    let focused = app.focus == FocusPane::Left && app.screen == Screen::Chat;
    let visible = area.height.saturating_sub(2) as usize;
    let list = app.filtered_channels();

    // Build the display list with a "Direct" section header for DM/group
    // channels pinned above everything else. Section headers are not
    // selectable; track the active channel's display index for scrolling.
    let mut items: Vec<ListItem> = Vec::new();
    let mut active_display: Option<usize> = None;
    let mut last_section: Option<u8> = None;
    for ch in list.iter() {
        let section: u8 = if matches!(ch.kind, ChannelKind::Dm | ChannelKind::Group) {
            0
        } else {
            1
        };
        if last_section != Some(section) {
            let label = if section == 0 { "Direct" } else { "Channels" };
            items.push(ListItem::new(Line::from(Span::styled(
                label,
                Style::default().fg(C_MUTED).add_modifier(Modifier::BOLD),
            ))));
            last_section = Some(section);
        }
        let active = Some(&ch.id) == app.active_channel.as_ref();
        if active {
            active_display = Some(items.len());
        }
        let style = if active {
            Style::default().fg(C_ACCENT2).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(C_TEXT)
        };
        let mark = if active { "▶ " } else { "  " };
        let mut spans = vec![
            Span::styled(mark, style),
            Span::styled(ch.kind.badge(), Style::default().fg(C_MUTED)),
            Span::styled(ch.name.clone(), style),
        ];
        if let Some(n) = app.unread.get(&ch.id) {
            if *n > 0 {
                spans.push(Span::styled(
                    format!(" ({n})"),
                    Style::default().fg(C_WARN).add_modifier(Modifier::BOLD),
                ));
            }
        }
        items.push(ListItem::new(Line::from(spans)));
    }
    let active_display = active_display.unwrap_or(0);
    let start = if active_display < visible {
        0
    } else {
        active_display + 1 - visible
    };

    let items: Vec<ListItem> = items.into_iter().skip(start).take(visible).collect();

    let filter = if app.channel_filter.is_empty() {
        String::new()
    } else {
        format!(" /{}", app.channel_filter)
    };

    frame.render_widget(
        List::new(items).block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(pane_border(focused))
                .title(format!(" Channels{filter} "))
                .style(Style::default().bg(C_PANEL).fg(C_TEXT)),
        ),
        area,
    );
}

fn render_messages(frame: &mut Frame, app: &App, area: Rect) {
    let focused = app.focus == FocusPane::Center && app.screen == Screen::Chat;
    let visible = area.height.saturating_sub(2) as usize;
    let channel_name = app
        .active_channel
        .as_ref()
        .and_then(|id| app.channels.iter().find(|c| &c.id == id))
        .map(|c| c.name.as_str())
        .unwrap_or("—");

    let lines: Vec<Line> = if let Some(msgs) = app
        .active_channel
        .as_ref()
        .and_then(|id| app.messages.get(id))
    {
        let total = msgs.len();
        let end = total.saturating_sub(app.msg_scroll);
        let start = end.saturating_sub(visible.max(1));
        msgs[start..end]
            .iter()
            .map(|msg| {
                let time = chrono::DateTime::from_timestamp(msg.timestamp / 1000, 0)
                    .map(|dt| dt.format("%H:%M").to_string())
                    .unwrap_or_else(|| "??:??".into());
                let text_display = if msg.text.starts_with("/uploads/") {
                    let filename = std::path::Path::new(&msg.text)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or(&msg.text);
                    format!("[file: {filename}]")
                } else {
                    msg.text.clone()
                };
                Line::from(vec![
                    Span::styled(format!("[{time}] "), Style::default().fg(C_MUTED)),
                    Span::styled(
                        format!("{}: ", msg.sender_name),
                        Style::default().fg(C_OK).add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(text_display, Style::default().fg(C_TEXT)),
                ])
            })
            .collect()
    } else {
        vec![Line::from(Span::styled(
            "No messages — i to type, l to login",
            Style::default().fg(C_MUTED),
        ))]
    };

    let scroll = if app.msg_scroll > 0 {
        format!(" ↑{}", app.msg_scroll)
    } else {
        String::new()
    };

    frame.render_widget(
        Paragraph::new(lines)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(pane_border(focused))
                    .title(format!(" #{channel_name}{scroll} "))
                    .style(Style::default().bg(C_PANEL)),
            )
            .wrap(Wrap { trim: false }),
        area,
    );
}

fn render_chat_side(frame: &mut Frame, app: &App, area: Rect) {
    let focused = app.focus == FocusPane::Right && app.screen == Screen::Chat;
    let ch = app
        .active_channel
        .as_ref()
        .and_then(|id| app.channels.iter().find(|c| &c.id == id));

    let mut lines = vec![Line::from(Span::styled(
        "CHANNEL",
        Style::default().fg(C_MUTED).add_modifier(Modifier::BOLD),
    ))];
    if let Some(c) = ch {
        lines.push(Line::from(format!("#{}", c.name)));
        lines.push(Line::from(Span::styled(
            format!("type: {}", c.channel_type),
            Style::default().fg(C_MUTED),
        )));
        if let Some(d) = &c.description {
            if !d.is_empty() {
                lines.push(Line::from(Span::styled(
                    d.as_str(),
                    Style::default().fg(C_TEXT),
                )));
            }
        }
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled("id", Style::default().fg(C_MUTED))));
        lines.push(Line::from(c.id.chars().take(18).collect::<String>()));
    } else {
        lines.push(Line::from("none selected"));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "KEYS",
        Style::default().fg(C_MUTED).add_modifier(Modifier::BOLD),
    )));
    lines.push(Line::from("j/k channels"));
    lines.push(Line::from("i compose"));
    lines.push(Line::from("Space focus"));
    lines.push(Line::from(": commands"));
    lines.push(Line::from("? help"));

    frame.render_widget(
        Paragraph::new(lines).block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(pane_border(focused))
                .title(" Detail ")
                .style(Style::default().bg(C_PANEL).fg(C_TEXT)),
        ),
        area,
    );
}

fn render_users(frame: &mut Frame, app: &App, area: Rect) {
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(45), Constraint::Percentage(55)])
        .split(area);

    let list = app.filtered_users();
    let items: Vec<ListItem> = list
        .iter()
        .enumerate()
        .map(|(i, u)| {
            let sel = i == app.selected_user;
            let style = if sel {
                Style::default()
                    .fg(C_BG)
                    .bg(C_ACCENT2)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(C_TEXT)
            };
            let mark = if sel { "▶ " } else { "  " };
            ListItem::new(format!("{mark}{}  #{}", u.username, u.user_id)).style(style)
        })
        .collect();

    let filter = if app.user_filter.is_empty() {
        String::new()
    } else {
        format!(" /{}", app.user_filter)
    };

    frame.render_widget(
        List::new(items).block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(C_ACCENT))
                .title(format!(" Users ({}){filter} ", list.len()))
                .style(Style::default().bg(C_PANEL)),
        ),
        cols[0],
    );

    let mut detail = vec![Line::from(Span::styled(
        "SELECTED",
        Style::default().fg(C_MUTED).add_modifier(Modifier::BOLD),
    ))];
    if let Some(u) = list.get(app.selected_user) {
        detail.push(Line::from(format!("user: {}", u.username)));
        detail.push(Line::from(format!("id:   {}", u.user_id)));
        detail.push(Line::from(format!("color:{}", u.color)));
        detail.push(Line::from(""));
        detail.push(Line::from(Span::styled(
            "ADMIN ACTIONS",
            Style::default().fg(C_MUTED).add_modifier(Modifier::BOLD),
        )));
        if app.is_adminish() {
            detail.push(Line::from(Span::styled(
                "p  reset password (temp)",
                Style::default().fg(C_WARN),
            )));
            detail.push(Line::from(Span::styled(
                "c  clear login lockout",
                Style::default().fg(C_WARN),
            )));
        } else {
            detail.push(Line::from(Span::styled(
                "(login as admin/owner)",
                Style::default().fg(C_MUTED),
            )));
        }
    } else {
        detail.push(Line::from("No users loaded — press r"));
    }
    detail.push(Line::from(""));
    detail.push(Line::from("j/k move  / filter  r refresh"));

    frame.render_widget(
        Paragraph::new(detail).block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(C_ACCENT2))
                .title(" User ops ")
                .style(Style::default().bg(C_PANEL).fg(C_TEXT)),
        ),
        cols[1],
    );
}

fn render_server(frame: &mut Frame, app: &App, area: Rect) {
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(45), Constraint::Percentage(55)])
        .split(area);

    let top = vec![
        Line::from(Span::styled(
            "CONNECTION",
            Style::default().fg(C_MUTED).add_modifier(Modifier::BOLD),
        )),
        Line::from(format!("url     {}", app.config.server_url)),
        Line::from(format!(
            "auth    {}",
            if app.config.token.is_some() {
                "token present"
            } else {
                "none"
            }
        )),
        Line::from(format!(
            "role    {}",
            app.user
                .as_ref()
                .and_then(|u| u.highest_role.as_deref())
                .unwrap_or("—")
        )),
        Line::from(""),
        Line::from(Span::styled(
            "HEALTH",
            Style::default().fg(C_MUTED).add_modifier(Modifier::BOLD),
        )),
        Line::from(if app.health_blob.is_empty() {
            "—".into()
        } else {
            app.health_blob.chars().take(200).collect::<String>()
        }),
        Line::from(""),
        Line::from(Span::styled(
            "s switch server   o logout   r refresh",
            Style::default().fg(C_MUTED),
        )),
    ];

    frame.render_widget(
        Paragraph::new(top).block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(C_ACCENT))
                .title(" Server ")
                .style(Style::default().bg(C_PANEL).fg(C_TEXT)),
        ),
        rows[0],
    );

    let mut stats_lines = vec![Line::from(Span::styled(
        "ADMIN DASHBOARD STATS",
        Style::default().fg(C_MUTED).add_modifier(Modifier::BOLD),
    ))];
    if let Some(s) = &app.stats {
        stats_lines.extend([
            Line::from(format!(
                "users      {}  (online {})",
                s.total_users, s.online_users
            )),
            Line::from(format!("channels   {}", s.total_channels)),
            Line::from(format!("messages   {}", s.total_messages)),
            Line::from(format!("roles      {}", s.total_roles)),
            Line::from(format!("emojis     {}", s.total_emojis)),
            Line::from(format!(
                "banned     {}  muted {}",
                s.banned_users, s.muted_users
            )),
            Line::from(format!("reports    {}", s.open_reports)),
        ]);
    } else {
        stats_lines.push(Line::from(Span::styled(
            "No stats yet (needs admin token). Press r.",
            Style::default().fg(C_MUTED),
        )));
    }

    frame.render_widget(
        Paragraph::new(stats_lines).block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(C_ACCENT2))
                .title(" Stats ")
                .style(Style::default().bg(C_PANEL).fg(C_TEXT)),
        ),
        rows[1],
    );
}

fn render_logs(frame: &mut Frame, app: &App, area: Rect) {
    let lines: Vec<Line> = app
        .logs
        .iter()
        .rev()
        .take(area.height.saturating_sub(2) as usize)
        .map(|l| Line::from(Span::styled(l.as_str(), Style::default().fg(C_TEXT))))
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();

    frame.render_widget(
        Paragraph::new(if lines.is_empty() {
            vec![Line::from(Span::styled(
                "No log lines yet.",
                Style::default().fg(C_MUTED),
            ))]
        } else {
            lines
        })
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(C_ACCENT))
                .title(" Event log ")
                .style(Style::default().bg(C_PANEL)),
        ),
        area,
    );
}

fn render_footer(frame: &mut Frame, app: &App, area: Rect) {
    let footer = match app.mode {
        AppMode::Input => Paragraph::new(app.input.as_str())
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(C_OK))
                    .title(" Compose · Enter send · Esc cancel ")
                    .style(Style::default().bg(C_PANEL)),
            )
            .style(Style::default().fg(C_TEXT)),
        AppMode::LoginLoading => Paragraph::new("Authenticating…").block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(C_WARN))
                .style(Style::default().bg(C_PANEL)),
        ),
        AppMode::Command => Paragraph::new(format!(":{}", app.command)).block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(C_ACCENT2))
                .title(" Command ")
                .style(Style::default().bg(C_PANEL)),
        ),
        AppMode::Normal => {
            // Typing indicator (3s TTL) prepended to the hints line.
            let typing_fresh = app.typing_at_ms > 0 && now_ms() - app.typing_at_ms < 3_000;
            let mut spans = vec![Span::styled(
                if app.user.is_some() { "● " } else { "○ " },
                Style::default().fg(if app.user.is_some() { C_OK } else { C_MUTED }),
            )];
            if typing_fresh {
                let who = app.typing_user.as_deref().unwrap_or("someone");
                spans.push(Span::styled(
                    format!("{who} is typing…  "),
                    Style::default().fg(C_WARN).add_modifier(Modifier::BOLD),
                ));
            }
            spans.push(Span::styled(
                if app.live.is_connected() {
                    "[LIVE] "
                } else {
                    "[POLL] "
                },
                Style::default().fg(if app.live.is_connected() {
                    C_OK
                } else {
                    C_MUTED
                }),
            ));
            spans.push(Span::styled(
                "Tab screens  :cmd  i type  l login  r refresh  ? help  q quit",
                Style::default().fg(C_MUTED),
            ));
            Paragraph::new(Line::from(spans)).block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(Color::Rgb(70, 70, 110)))
                    .style(Style::default().bg(C_PANEL)),
            )
        }
        _ => Paragraph::new("Esc cancel").block(
            Block::default()
                .borders(Borders::ALL)
                .style(Style::default().bg(C_PANEL).fg(C_MUTED)),
        ),
    };
    frame.render_widget(footer, area);
}

fn render_command_bar(frame: &mut Frame, app: &App) {
    // footer already shows command; also dim overlay hint top
    let area = Rect {
        x: frame.area().x + 2,
        y: frame.area().y + 3,
        width: frame.area().width.saturating_sub(4),
        height: 3,
    };
    frame.render_widget(Clear, area);
    frame.render_widget(
        Paragraph::new(format!(":{}", app.command)).block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(C_ACCENT2))
                .title(" :chat :users :server :logs :filter x :ufilter x :goto name :refresh :logout :help "),
        ),
        area,
    );
}

fn render_prompt(frame: &mut Frame, app: &App) {
    let area = centered_rect(50, 28, frame.area());
    frame.render_widget(Clear, area);
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .margin(1)
        .constraints([
            Constraint::Length(1),
            Constraint::Length(3),
            Constraint::Length(1),
        ])
        .split(area);
    frame.render_widget(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(C_WARN))
            .title(format!(" {} ", app.prompt_title))
            .style(Style::default().bg(C_PANEL)),
        area,
    );
    frame.render_widget(
        Paragraph::new(app.prompt.as_str())
            .block(Block::default().borders(Borders::ALL).title(" value ")),
        rows[1],
    );
    frame.render_widget(
        Paragraph::new("Enter confirm · Esc cancel").style(Style::default().fg(C_MUTED)),
        rows[2],
    );
}

fn render_help(frame: &mut Frame) {
    let area = centered_rect(70, 70, frame.area());
    frame.render_widget(Clear, area);
    let text = vec![
        Line::from(Span::styled(
            "Wabi TUI — power user guide",
            Style::default().fg(C_ACCENT2).add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
        Line::from("SCREENS"),
        Line::from("  1 / Tab     Chat"),
        Line::from("  2           Users (admin ops)"),
        Line::from("  3           Server health + stats"),
        Line::from("  4           Event log"),
        Line::from(""),
        Line::from("CHAT"),
        Line::from("  j/k ↑↓      channels"),
        Line::from("  i           compose message"),
        Line::from("  PgUp/PgDn   scroll history"),
        Line::from("  Space       cycle focus panes"),
        Line::from("  / or :filter name"),
        Line::from(""),
        Line::from("USERS (admin/owner)"),
        Line::from("  j/k         select user"),
        Line::from("  p           reset password (temp)"),
        Line::from("  c           clear login lockout"),
        Line::from("  :ufilter x  filter users"),
        Line::from(""),
        Line::from("GLOBAL"),
        Line::from("  l           login"),
        Line::from("  r / F5      refresh"),
        Line::from("  :           command palette"),
        Line::from("  :goto name  jump channel"),
        Line::from("  :logout     drop token"),
        Line::from("  :fps N      UI refresh rate (e-ink: 1-5)"),
        Line::from("  :poll N     chat poll seconds"),
        Line::from("  :eink       preset 2fps + 8s poll"),
        Line::from("  q           quit"),
        Line::from(""),
        Line::from(Span::styled(
            "Esc / ? closes this help",
            Style::default().fg(C_MUTED),
        )),
    ];
    frame.render_widget(
        Paragraph::new(text).block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(C_ACCENT2))
                .title(" Help ")
                .style(Style::default().bg(C_PANEL).fg(C_TEXT)),
        ),
        area,
    );
}

fn render_server_setup(frame: &mut Frame, app: &App) {
    let area = centered_rect(56, 40, frame.area());
    frame.render_widget(Clear, area);
    let block = Block::default()
        .borders(Borders::ALL)
        .title(" Connect to Wabi ")
        .border_style(Style::default().fg(C_ACCENT2))
        .style(Style::default().bg(C_PANEL));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .margin(1)
        .constraints([
            Constraint::Length(2),
            Constraint::Length(3),
            Constraint::Length(2),
        ])
        .split(inner);
    frame.render_widget(
        Paragraph::new("Server URL (https://wabi.chat or host:port)"),
        rows[0],
    );
    let display = if app.server_input.is_empty() {
        Span::styled("https://", Style::default().fg(C_MUTED))
    } else {
        Span::styled(app.server_input.as_str(), Style::default().fg(C_WARN))
    };
    frame.render_widget(
        Paragraph::new(Line::from(display))
            .block(Block::default().borders(Borders::ALL).title(" URL ")),
        rows[1],
    );
    frame.render_widget(
        Paragraph::new("Enter connect · Esc cancel/quit").style(Style::default().fg(C_MUTED)),
        rows[2],
    );
}

fn render_login_form(frame: &mut Frame, app: &App) {
    let area = centered_rect(50, 42, frame.area());
    frame.render_widget(Clear, area);
    frame.render_widget(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(C_ACCENT2))
            .title(" Login ")
            .style(Style::default().bg(C_PANEL)),
        area,
    );
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .margin(1)
        .constraints([
            Constraint::Length(3),
            Constraint::Length(3),
            Constraint::Length(1),
        ])
        .split(area);

    let loading = app.mode == AppMode::LoginLoading;
    let user_style = if !loading && app.login_field == 0 {
        Style::default().fg(C_WARN)
    } else {
        Style::default().fg(C_MUTED)
    };
    let pass_style = if !loading && app.login_field == 1 {
        Style::default().fg(C_WARN)
    } else {
        Style::default().fg(C_MUTED)
    };
    let pass = if loading {
        "*".repeat(app.login_password.len().max(1))
    } else {
        "*".repeat(app.login_password.len())
    };
    let hint = if loading {
        "Authenticating…"
    } else {
        "Tab fields · Enter submit · Esc cancel"
    };

    frame.render_widget(
        Paragraph::new(app.login_username.as_str())
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(user_style)
                    .title(" Username "),
            )
            .style(Style::default().fg(C_TEXT)),
        chunks[0],
    );
    frame.render_widget(
        Paragraph::new(pass.as_str())
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(pass_style)
                    .title(" Password "),
            )
            .style(Style::default().fg(C_TEXT)),
        chunks[1],
    );
    frame.render_widget(
        Paragraph::new(hint).style(Style::default().fg(C_MUTED)),
        chunks[2],
    );
}

fn render_error_popup(frame: &mut Frame, error: &str) {
    let area = centered_rect(55, 28, frame.area());
    frame.render_widget(Clear, area);
    frame.render_widget(
        Paragraph::new(error)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(C_ERR))
                    .title(" Notice · Esc ")
                    .style(Style::default().bg(C_PANEL)),
            )
            .style(Style::default().fg(C_TEXT))
            .wrap(Wrap { trim: true }),
        area,
    );
}

fn centered_rect(percent_x: u16, percent_y: u16, area: Rect) -> Rect {
    let popup_layout = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - percent_y) / 2),
            Constraint::Percentage(percent_y),
            Constraint::Percentage((100 - percent_y) / 2),
        ])
        .split(area);

    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - percent_x) / 2),
            Constraint::Percentage(percent_x),
            Constraint::Percentage((100 - percent_x) / 2),
        ])
        .split(popup_layout[1])[1]
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
