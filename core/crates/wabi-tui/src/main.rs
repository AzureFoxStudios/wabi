//! Wabi TUI — terminal admin / power-user client

mod api;
mod app;
mod config;
mod ui;

use anyhow::Result;
use app::App;

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
    loop {
        app.poll_bg();
        terminal.draw(|frame| ui::render(frame, app))?;

        if crossterm::event::poll(std::time::Duration::from_millis(50))? {
            if let crossterm::event::Event::Key(key) = crossterm::event::read()? {
                if key.kind == crossterm::event::KeyEventKind::Press {
                    match app.handle_key(key.code) {
                        Ok(false) => break,
                        Ok(true) => {}
                        Err(e) => app.set_error(e.to_string()),
                    }
                }
            }
        }

        if app.pending_connect {
            if let Err(e) = app.do_connect().await {
                app.set_error(e.to_string());
            }
        }
    }

    Ok(())
}
