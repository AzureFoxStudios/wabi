//! Wabi TUI — terminal admin / power-user client

mod api;
mod app;
mod config;
mod ui;

use anyhow::Result;
use app::App;
use std::time::{Duration, Instant};

/// Restores terminal to a usable state on drop, including during panics.
struct TerminalGuard;

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = crossterm::terminal::disable_raw_mode();
        let _ = crossterm::execute!(
            std::io::stdout(),
            crossterm::terminal::LeaveAlternateScreen,
            crossterm::event::DisableMouseCapture,
            crossterm::cursor::Show,
        );
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // Log to file so stderr doesn't trash the TUI.
    let log_path = std::env::temp_dir().join("wabi-tui.log");
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .ok();

    let subscriber = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("wabi_tui=info".parse().unwrap()),
        )
        .with_target(false)
        .with_ansi(false);

    if let Some(f) = log_file {
        subscriber.with_writer(std::sync::Mutex::new(f)).init();
    } else {
        subscriber.with_writer(std::io::sink).init();
    }

    crossterm::terminal::enable_raw_mode()?;
    crossterm::execute!(
        std::io::stdout(),
        crossterm::terminal::EnterAlternateScreen,
        crossterm::event::EnableMouseCapture,
    )?;

    let _guard = TerminalGuard;

    let backend = ratatui::backend::CrosstermBackend::new(std::io::stdout());
    let mut terminal = ratatui::Terminal::new(backend)?;
    let mut app = App::new().await?;

    let res = run_app(&mut terminal, &mut app).await;

    drop(_guard);

    if let Err(err) = res {
        eprintln!("Error: {err:?}");
        eprintln!("Log: {}", log_path.display());
        std::process::exit(1);
    }

    Ok(())
}

async fn run_app(
    terminal: &mut ratatui::Terminal<ratatui::backend::CrosstermBackend<std::io::Stdout>>,
    app: &mut App,
) -> Result<()> {
    let mut last_draw = Instant::now()
        .checked_sub(Duration::from_secs(60))
        .unwrap_or_else(Instant::now);

    loop {
        // Drain network/bg results first so dirty is accurate.
        app.poll_bg();

        let frame_ms = app.config.frame_ms();
        let frame_budget = Duration::from_millis(frame_ms);
        let due_for_frame = last_draw.elapsed() >= frame_budget;

        // Redraw only when something changed OR the FPS budget says so.
        // E-ink: low fps => fewer full terminal paints (ghosting / power).
        if app.dirty || due_for_frame {
            terminal.draw(|frame| ui::render(frame, app))?;
            app.dirty = false;
            last_draw = Instant::now();
        }

        // Sleep up to the remaining frame budget (or a short slice) waiting for keys.
        // Always wake often enough to process bg results, but never busier than fps.
        let wait = frame_budget
            .checked_sub(last_draw.elapsed())
            .unwrap_or(Duration::from_millis(1))
            .min(Duration::from_millis(frame_ms.max(1)))
            .max(Duration::from_millis(1));

        if crossterm::event::poll(wait)? {
            if let crossterm::event::Event::Key(key) = crossterm::event::read()? {
                if key.kind == crossterm::event::KeyEventKind::Press {
                    match app.handle_key(key.code) {
                        Ok(false) => break,
                        Ok(true) => {}
                        Err(e) => app.set_error(e.to_string()),
                    }
                }
            } else {
                // Resize etc. — force paint
                app.mark_dirty();
            }
        }

        if app.pending_connect {
            if let Err(e) = app.do_connect().await {
                app.set_error(e.to_string());
            }
            app.mark_dirty();
        }
    }

    Ok(())
}
