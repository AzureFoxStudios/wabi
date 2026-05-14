//! Terminal UI rendering

use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, List, ListItem, Paragraph, Wrap},
    Frame,
};

use crate::app::{App, AppMode};

pub fn render(frame: &mut Frame, app: &App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .margin(1)
        .constraints([
            Constraint::Length(3), // Header
            Constraint::Min(0),    // Main content
            Constraint::Length(3), // Input/status
        ])
        .split(frame.area());

    render_header(frame, app, chunks[0]);
    render_main(frame, app, chunks[1]);
    render_footer(frame, app, chunks[2]);

    if app.mode == AppMode::ServerSetup {
        render_server_setup(frame, app);
    } else if app.mode == AppMode::Login || app.mode == AppMode::LoginLoading {
        render_login_form(frame, app);
    }

    if let Some(error) = &app.error {
        render_error_popup(frame, error);
    }
}

fn render_header(frame: &mut Frame, app: &App, area: Rect) {
    let status_line = if let Some(ref user) = app.user {
        vec![Line::from(vec![
            Span::styled(" ● ", Style::default().fg(Color::Green)),
            Span::styled(&user.username, Style::default().fg(Color::Green)),
            Span::raw(" | "),
            Span::raw(&app.status),
        ])]
    } else {
        vec![Line::from(vec![
            Span::styled(" ○ ", Style::default().fg(Color::DarkGray)),
            Span::styled("Not logged in", Style::default().fg(Color::DarkGray)),
            Span::raw(" | "),
            Span::raw(&app.status),
        ])]
    };

    frame.render_widget(
        Paragraph::new(status_line).block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::Cyan))
                .title(" Wabi TUI v0.1.0 "),
        ),
        area,
    );
}

fn render_main(frame: &mut Frame, app: &App, area: Rect) {
    let main_chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(25), Constraint::Percentage(75)])
        .split(area);

    render_channels(frame, app, main_chunks[0]);
    render_messages(frame, app, main_chunks[1]);
}

fn render_channels(frame: &mut Frame, app: &App, area: Rect) {
    // Subtract 2 for top/bottom borders.
    let visible_height = area.height.saturating_sub(2) as usize;

    let active_idx = app
        .active_channel
        .as_ref()
        .and_then(|id| app.channels.iter().position(|c| &c.id == id))
        .unwrap_or(0);

    // Compute start offset so the active channel is always visible.
    let start = if active_idx < visible_height {
        0
    } else {
        active_idx + 1 - visible_height
    };

    let items: Vec<ListItem> = app
        .channels
        .iter()
        .enumerate()
        .skip(start)
        .take(visible_height)
        .map(|(_, channel)| {
            let active = Some(&channel.id) == app.active_channel.as_ref();
            let style = if active {
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };
            let prefix = if active { "▶ " } else { "  " };
            ListItem::new(format!("{}#{}", prefix, channel.name)).style(style)
        })
        .collect();

    frame.render_widget(
        List::new(items).block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::White))
                .title(" Channels "),
        ),
        area,
    );
}

fn render_messages(frame: &mut Frame, app: &App, area: Rect) {
    // Subtract 2 for borders, then at least 1 row for content.
    let visible_height = area.height.saturating_sub(2) as usize;

    let channel_name = app.active_channel.as_deref().unwrap_or("general");

    let lines: Vec<Line> = if let Some(msgs) = app
        .active_channel
        .as_ref()
        .and_then(|id| app.messages.get(id))
    {
        let total = msgs.len();
        // msg_scroll=0 → tail of list; scroll > 0 → further back in history.
        let end = total.saturating_sub(app.msg_scroll);
        let start = end.saturating_sub(visible_height);

        msgs[start..end]
            .iter()
            .map(|msg| {
                let time = chrono::DateTime::from_timestamp(msg.timestamp / 1000, 0)
                    .map(|dt| dt.format("%H:%M").to_string())
                    .unwrap_or_else(|| "??:??".to_string());

                // If message contains an uploaded file (content starts with /uploads/ or
                // message_type is not "text"), show a spoiler line instead of raw URL.
                let text_display = if msg.text.starts_with("/uploads/") {
                    let filename = std::path::Path::new(&msg.text)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or(&msg.text);
                    let label = match msg.message_type.as_str() {
                        "audio" => "AUDIO",
                        "gif" => "GIF",
                        _ => "SPOILER",
                    };
                    format!("[{}: {} \u{2014} click to view in browser]", label, filename)
                } else if msg.message_type != "text" && !msg.text.is_empty() {
                    let label = match msg.message_type.as_str() {
                        "audio" => "AUDIO",
                        _ => "SPOILER",
                    };
                    format!("[{}: {} \u{2014} click to view in browser]", label, msg.text)
                } else {
                    msg.text.clone()
                };

                Line::from(vec![
                    Span::styled(format!("[{}] ", time), Style::default().fg(Color::DarkGray)),
                    Span::styled(
                        format!("{}: ", msg.sender_name),
                        Style::default().fg(Color::Green),
                    ),
                    Span::raw(text_display),
                ])
            })
            .collect()
    } else {
        vec![Line::from(Span::styled(
            "No messages yet — press 'i' to start typing",
            Style::default().fg(Color::DarkGray),
        ))]
    };

    let scroll_hint = if app.msg_scroll > 0 {
        format!(" #{} (↑{}) ", channel_name, app.msg_scroll)
    } else {
        format!(" #{} ", channel_name)
    };

    frame.render_widget(
        Paragraph::new(lines)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(Color::White))
                    .title(scroll_hint),
            )
            .wrap(Wrap { trim: false }),
        area,
    );
}

fn render_footer(frame: &mut Frame, app: &App, area: Rect) {
    let footer = match app.mode {
        AppMode::Input => Paragraph::new(app.input.as_str())
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(Color::Green))
                    .title(" Type message (Enter=send, Esc=cancel) "),
            )
            .style(Style::default().fg(Color::White)),
        AppMode::LoginLoading => Paragraph::new("Authenticating... please wait").block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::Yellow)),
        ),
        AppMode::Normal => Paragraph::new(vec![Line::from(vec![
            if app.user.is_some() {
                Span::styled("● ", Style::default().fg(Color::Green))
            } else {
                Span::styled("○ ", Style::default().fg(Color::DarkGray))
            },
            Span::raw("i=type  j/k=channels  l=login  PgUp/Dn=scroll  ?=help  q=quit"),
        ])])
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::White)),
        ),
        _ => Paragraph::new("Tab=switch  Enter=submit  Esc=cancel").block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::White)),
        ),
    };

    frame.render_widget(footer, area);
}

fn render_server_setup(frame: &mut Frame, app: &App) {
    let area = centered_rect(56, 40, frame.area());
    frame.render_widget(Clear, area);

    let block = Block::default()
        .borders(Borders::ALL)
        .title(" Wabi — Connect to a server ")
        .style(Style::default().fg(Color::Cyan));

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
        Paragraph::new("Enter your Wabi server URL:").style(Style::default().fg(Color::White)),
        rows[0],
    );

    let display = if app.server_input.is_empty() {
        Span::styled("https://", Style::default().fg(Color::DarkGray))
    } else {
        Span::styled(
            app.server_input.as_str(),
            Style::default().fg(Color::Yellow),
        )
    };
    frame.render_widget(
        Paragraph::new(Line::from(display))
            .block(Block::default().borders(Borders::ALL).title(" URL ")),
        rows[1],
    );

    frame.render_widget(
        Paragraph::new("Enter to connect   Esc to quit")
            .style(Style::default().fg(Color::DarkGray)),
        rows[2],
    );
}

fn render_error_popup(frame: &mut Frame, error: &str) {
    let area = centered_rect(50, 30, frame.area());
    frame.render_widget(Clear, area);

    frame.render_widget(
        Paragraph::new(error)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(Color::Red))
                    .title(" Error — Esc to dismiss "),
            )
            .style(Style::default().fg(Color::White))
            .wrap(Wrap { trim: true }),
        area,
    );
}

fn render_login_form(frame: &mut Frame, app: &App) {
    let area = centered_rect(50, 40, frame.area());
    frame.render_widget(Clear, area);

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .margin(1)
        .constraints([
            Constraint::Length(3),
            Constraint::Length(3),
            Constraint::Length(1),
        ])
        .split(area);

    let (username_style, password_style, user_text, pass_text, hint_text) =
        if app.mode == AppMode::LoginLoading {
            (
                Style::default().fg(Color::DarkGray),
                Style::default().fg(Color::DarkGray),
                app.login_username.clone(),
                "*".repeat(app.login_password.len()),
                "Authenticating... please wait".to_string(),
            )
        } else {
            (
                if app.login_field == 0 {
                    Style::default().fg(Color::Yellow)
                } else {
                    Style::default().fg(Color::White)
                },
                if app.login_field == 1 {
                    Style::default().fg(Color::Yellow)
                } else {
                    Style::default().fg(Color::White)
                },
                app.login_username.clone(),
                "*".repeat(app.login_password.len()),
                "Tab=switch field  Enter=submit  Esc=cancel".to_string(),
            )
        };

    frame.render_widget(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Cyan))
            .title(" Login to Wabi "),
        area,
    );

    frame.render_widget(
        Paragraph::new(user_text.as_str())
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(username_style)
                    .title(" Username "),
            )
            .style(Style::default().fg(Color::White)),
        chunks[0],
    );

    frame.render_widget(
        Paragraph::new(pass_text.as_str())
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(password_style)
                    .title(" Password "),
            )
            .style(Style::default().fg(Color::White)),
        chunks[1],
    );

    frame.render_widget(
        Paragraph::new(hint_text.as_str()).style(Style::default().fg(Color::DarkGray)),
        chunks[2],
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
