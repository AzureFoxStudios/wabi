//! Wabi TUI - Terminal chat client

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
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("wabi_tui=info".parse().unwrap()),
        )
        .with_target(false)
        .with_thread_ids(false)
        .with_file(false)
        .with_line_number(false)
        .init();

    crossterm::terminal::enable_raw_mode()?;
    crossterm::execute!(
        std::io::stdout(),
        crossterm::terminal::EnterAlternateScreen,
        crossterm::event::EnableMouseCapture,
    )?;

    // Guard ensures terminal is restored even if the code below panics.
    let _guard = TerminalGuard;

    let backend = ratatui::backend::CrosstermBackend::new(std::io::stdout());
    let mut terminal = ratatui::Terminal::new(backend)?;
    let mut app = App::new().await?;

    let res = run_app(&mut terminal, &mut app).await;

    drop(_guard);

    if let Err(err) = res {
        eprintln!("Error: {:?}", err);
        std::process::exit(1);
    }

    Ok(())
}

async fn run_app(
    terminal: &mut ratatui::Terminal<ratatui::backend::CrosstermBackend<std::io::Stdout>>,
    app: &mut App,
) -> Result<()> {
    loop {
        // Drain background results before drawing so the frame is always fresh.
        app.poll_bg();

        terminal.draw(|frame| ui::render(frame, app))?;

        // Non-blocking poll: if no key arrives within 50 ms we loop and redraw,
        // which lets background API results appear without waiting for input.
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
        // Login runs entirely in background via tokio::spawn — nothing to await here.
    }

    Ok(())
}
