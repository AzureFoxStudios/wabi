// Game Sync socket handlers — real-time shared board games among chat
// channel participants. v1 scope: Go (9x9 / 13x13 / 19x19), two players per
// channel, server-validated moves, in-memory session state (no durable writes).
//
// Wire contract: docs/plans/2026-10-15-game-sync-panel.md
//
// Retention honestly: session state is process-local and lost on restart.
// The protocol carries complete match records (board, move log, revision, seats)
// so a later persistence pass can store them unchanged.

// SioState and require_socket_channel are provided by the including module
// (socketio_impl) via include!(), so no explicit imports are required.
// (no explicit imports: this file is include!()'d into socketio_impl, and all
// of these (json, Value, SocketRef, Mutex, OnceLock) are already in scope)

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GameStatus { Waiting, Active, Finished }

#[derive(Clone, Debug)]
pub struct GoMove { pub x: u8, pub y: u8, pub pass: bool }

#[derive(Clone, Debug)]
pub struct GameSession {
    pub channel_id: String,
    pub game_id: String,
    pub size: u8,
    pub board: Vec<i8>,
    pub ko: Option<usize>,
    pub to_play: usize,
    pub seats: [Option<i64>; 2],
    pub seat_names: [Option<String>; 2],
    pub moves: Vec<GoMove>,
    pub consecutive_passes: u8,
    pub status: GameStatus,
    pub winner: Option<usize>,
    pub reason: String,
    /// Final counted score in points when the game ended by scoring
    /// (two passes). `None` for resignations / unfinished games.
    pub score: Option<GoScore>,
    pub revision: u64,
    pub created_at: u64,
}

/// Display-ready area score with komi already applied to white.
#[derive(Clone, Copy, Debug)]
struct GoScore {
    black: f64,
    white: f64,
}

#[derive(Clone, Debug)]
struct Room {
    session: Option<GameSession>,
}

static ROOMS: OnceLock<Mutex<std::collections::HashMap<String, Room>>> = OnceLock::new();

fn rooms() -> &'static Mutex<std::collections::HashMap<String, Room>> {
    ROOMS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

// ---------------------------------------------------------------------------
// Go rules
// ---------------------------------------------------------------------------

fn neighbors(size: u8, i: usize) -> Vec<usize> {
    let s = size as usize;
    let x = i % s;
    let y = i / s;
    let mut out = Vec::new();
    if x > 0 { out.push(i - 1); }
    if x + 1 < s { out.push(i + 1); }
    if y > 0 { out.push(i - s); }
    if y + 1 < s { out.push(i + s); }
    out
}

fn collect_group(board: &[i8], size: u8, start: usize) -> (Vec<usize>, usize) {
    let color = board[start];
    let mut members = Vec::new();
    let mut libs = 0_usize;
    let mut stack = vec![start];
    let mut seen = vec![false; board.len()];
    seen[start] = true;
    while let Some(i) = stack.pop() {
        members.push(i);
        for n in neighbors(size, i) {
            if board[n] == color && !seen[n] {
                seen[n] = true;
                stack.push(n);
            } else if board[n] == -1 {
                libs += 1;
            }
        }
    }
    (members, libs)
}

pub fn apply_go_move(board: &mut Vec<i8>, size: u8, x: u8, y: u8, color: i8, ko: &mut Option<usize>) -> Result<usize, String> {
    let s = size as usize;
    if x as usize >= s || y as usize >= s { return Err("out of bounds".into()); }
    let p = y as usize * s + x as usize;
    if board[p] != -1 { return Err("occupied".into()); }
    if ko.map(|k| k == p).unwrap_or(false) { return Err("ko".into()); }

    let opponent: i8 = if color == 0 { 1 } else { 0 };
    board[p] = color;

    // capture opponent groups without liberties
    let mut captured: Vec<Vec<usize>> = Vec::new();
    let mut seen_group_start: std::collections::HashSet<usize> = std::collections::HashSet::new();
    for n in neighbors(size, p) {
        if board[n] == opponent && !seen_group_start.contains(&n) {
            let (members, libs) = collect_group(board, size, n);
            for m in &members { seen_group_start.insert(*m); }
            if libs == 0 {
                captured.push(members);
            }
        }
    }
    let mut captured_total = 0usize;
    for grp in &captured {
        for m in grp {
            board[*m] = -1;
            captured_total += 1;
        }
    }

    let (_own_members, own_libs) = collect_group(board, size, p);
    if own_libs == 0 {
        if captured_total == 0 {
            board[p] = -1;
            for grp in &captured { for m in grp { board[*m] = opponent; } }
            return Err("suicide".into());
        }
    }
    // ko
    let single_capture = captured.len() == 1 && captured[0].len() == 1;
    let (_om, own_libs2) = collect_group(board, size, p);
    if single_capture && own_libs2 == 1 {
        *ko = Some(captured[0][0]);
    } else {
        *ko = None;
    }
    Ok(captured_total)
}

pub fn score_go(board: &[i8], size: u8) -> (i64, i64) {
    let s = size as usize;
    let total = board.len();
    let mut b: i64 = 0;
    let mut w: i64 = 0;
    for c in board {
        if *c == 0 { b += 2; }
        if *c == 1 { w += 2; }
    }
    let mut visited = vec![false; total];
    for i in 0..total {
        if board[i] != -1 || visited[i] { continue; }
        let mut region = Vec::new();
        let mut stack = vec![i];
        visited[i] = true;
        let mut border: std::collections::HashSet<i8> = std::collections::HashSet::new();
        while let Some(cur) = stack.pop() {
            region.push(cur);
            for n in neighbors(size, cur) {
                if board[n] == -1 {
                    if !visited[n] { visited[n] = true; stack.push(n); }
                } else {
                    border.insert(board[n]);
                }
            }
        }
        if border.len() == 1 {
            let c = *border.iter().next().unwrap();
            if c == 0 { b += region.len() as i64 * 2; }
            else if c == 1 { w += region.len() as i64 * 2; }
        }
    }
    let _ = s;
    (b, w)
}

/// Area scoring uses doubled counts (every point counted twice) so the half
/// point from 6.5 komi stays exact: `white_with_komi = w + 13`.
fn decide_winner(black_half: i64, white_half_with_komi: i64) -> (usize, &'static str) {
    if black_half > white_half_with_komi { (0, "area") }
    else if white_half_with_komi > black_half { (1, "area") }
    else { (1, "tie-komi") }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn game_now_micros() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_micros() as u64).unwrap_or(0)
}

fn game_error(socket: &SocketRef, msg: &str) {
    let _ = socket.emit("game:error", &serde_json::json!({"error": msg}));
}

/// Runtime gate: the add-on switch / env var must be on before any game socket
/// event is served. Mirrors the REST-side gate used by the steam add-on.
async fn game_sync_enabled(state: &SioState) -> bool {
    state
        .app
        .addon_enabled("game-sync", Some("WABI_GAME_SYNC_ENABLED"), false)
        .await
}

fn session_json(sess: &GameSession) -> serde_json::Value {
    let board: Vec<i8> = sess.board.clone();
    let moves: Vec<Value> = sess.moves.iter().map(|m| if m.pass {
        serde_json::json!({"pass": true})
    } else {
        serde_json::json!({"x": m.x, "y": m.y})
    }).collect();
    let status_str = match sess.status { GameStatus::Waiting=>"waiting", GameStatus::Active=>"active", GameStatus::Finished=>"finished" };
    let ko = sess.ko.map(|i| serde_json::json!({"x": (i % sess.size as usize) as u8, "y": (i / sess.size as usize) as u8}));
    serde_json::json!({
        "channelId": sess.channel_id,
        "size": sess.size,
        "board": board,
        "toPlay": sess.to_play,
        "seats": [sess.seats[0], sess.seats[1]],
        "seatNames": [sess.seat_names[0], sess.seat_names[1]],
        "moves": moves,
        "consecutivePasses": sess.consecutive_passes,
        "status": status_str,
        "winner": sess.winner,
        "reason": sess.reason,
        "score": sess.score.map(|s| serde_json::json!({"black": s.black, "white": s.white})),
        "revision": sess.revision,
        "ko": ko,
        "createdAt": sess.created_at,
    })
}

fn get_room(channel_id: &str) -> Option<Room> {
    rooms().lock().ok().and_then(|g| g.get(channel_id).cloned())
}

fn broadcast_state(io: &socketioxide::SocketIo, channel_id: &str, sess: &GameSession) {
    let room = format!("game:{}", channel_id);
    let payload = session_json(sess);
    let _ = io.to(room).emit("game:state", &payload);
}

pub fn evict_channel_games(channel_id: &str) {
    if let Ok(mut g) = rooms().lock() { g.remove(channel_id); }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

pub async fn on_game_join(socket: SocketRef, data: serde_json::Value, state: SioState) {
    let channel_id = data.get("channelId").and_then(serde_json::Value::as_str).unwrap_or("").to_string();
    if channel_id.is_empty() { game_error(&socket, "missing channelId"); return; }
    if !game_sync_enabled(&state).await { game_error(&socket, "Game Sync is disabled on this server"); return; }
    let Some(_ident) = require_socket_channel(&socket, &state, &channel_id, "game:error").await else { return; };
    socket.join(format!("game:{}", channel_id));
    if let Some(room) = get_room(&channel_id) {
        if let Some(sess) = room.session.as_ref() {
            let _ = socket.emit("game:state", &session_json(sess));
        } else {
            let _ = socket.emit("game:state", &serde_json::json!({"channelId": channel_id, "status": "none"}));
        }
    } else {
        let _ = socket.emit("game:state", &serde_json::json!({"channelId": channel_id, "status": "none"}));
    }
}

pub async fn on_game_leave(socket: SocketRef, data: serde_json::Value, _state: SioState) {
    let channel_id = data.get("channelId").and_then(serde_json::Value::as_str).unwrap_or("").to_string();
    if channel_id.is_empty() { return; }
    socket.leave(format!("game:{}", channel_id));
    let _ = socket.emit("game:left", &serde_json::json!({"channelId": channel_id}));
}

pub async fn on_game_create(socket: SocketRef, data: serde_json::Value, state: SioState, io: socketioxide::SocketIo) {
    let channel_id = data.get("channelId").and_then(serde_json::Value::as_str).unwrap_or("").to_string();
    if channel_id.is_empty() { game_error(&socket, "missing channelId"); return; }
    if !game_sync_enabled(&state).await { game_error(&socket, "Game Sync is disabled on this server"); return; }
    let Some(ident) = require_socket_channel(&socket, &state, &channel_id, "game:error").await else { return; };
    let size: u8 = data.get("size").and_then(serde_json::Value::as_u64).unwrap_or(19) as u8;
    let size = match size { 9 | 13 | 19 => size, _ => 19 };

    if let Some(room) = get_room(&channel_id) {
        if room.session.as_ref().map(|s| s.status != GameStatus::Finished).unwrap_or(false) {
            game_error(&socket, "A game is already in progress in this channel");
            return;
        }
    }
    let total = size as usize * size as usize;
    let sess = GameSession {
        channel_id: channel_id.clone(),
        game_id: format!("{}-{}", channel_id, game_now_micros()),
        size,
        board: vec![-1i8; total],
        ko: None,
        to_play: 0,
        seats: [Some(ident.user_id), None],
        seat_names: [Some(ident.username.clone()), None],
        moves: Vec::new(),
        consecutive_passes: 0,
        status: GameStatus::Waiting,
        winner: None,
        reason: String::new(),
        score: None,
        revision: 0,
        created_at: game_now_micros(),
    };
    if let Ok(mut g) = rooms().lock() {
        g.insert(channel_id.clone(), Room { session: Some(sess.clone()) });
    }
    socket.join(format!("game:{}", channel_id));
    broadcast_state(&io, &channel_id, &sess);
}

pub async fn on_game_claim(socket: SocketRef, data: serde_json::Value, state: SioState, io: socketioxide::SocketIo) {
    let channel_id = data.get("channelId").and_then(serde_json::Value::as_str).unwrap_or("").to_string();
    if channel_id.is_empty() { game_error(&socket, "missing channelId"); return; }
    if !game_sync_enabled(&state).await { game_error(&socket, "Game Sync is disabled on this server"); return; }
    let Some(ident) = require_socket_channel(&socket, &state, &channel_id, "game:error").await else { return; };
    let mut g = match rooms().lock() { Ok(g)=>g, Err(_)=>{ game_error(&socket,"lock"); return; } };
    let room = match g.get_mut(&channel_id) { Some(r)=>r, None=>{ drop(g); game_error(&socket,"no game"); return; } };
    let sess = match room.session.as_mut() { Some(s)=>s, None=>{ drop(g); game_error(&socket,"no game"); return; } };
    if sess.status != GameStatus::Waiting { drop(g); game_error(&socket, "game already started"); return; }
    if sess.seats[0] == Some(ident.user_id) || sess.seats[1] == Some(ident.user_id) { drop(g); game_error(&socket, "already seated"); return; }
    if sess.seats[1].is_some() { drop(g); game_error(&socket, "no open seat"); return; }
    sess.seats[1] = Some(ident.user_id);
    sess.seat_names[1] = Some(ident.username.clone());
    sess.status = GameStatus::Active;
    sess.revision += 1;
    let sess_clone = sess.clone();
    drop(g);
    socket.join(format!("game:{}", channel_id));
    broadcast_state(&io, &channel_id, &sess_clone);
}

pub async fn on_game_move(socket: SocketRef, data: serde_json::Value, state: SioState, io: socketioxide::SocketIo) {
    let channel_id = data.get("channelId").and_then(serde_json::Value::as_str).unwrap_or("").to_string();
    if channel_id.is_empty() { game_error(&socket, "missing channelId"); return; }
    if !game_sync_enabled(&state).await { game_error(&socket, "Game Sync is disabled on this server"); return; }
    let Some(ident) = require_socket_channel(&socket, &state, &channel_id, "game:error").await else { return; };
    // Parse as u64; validate against the board size before casting to u8 so
    // oversized values cannot wrap around into a legal coordinate.
    let x_raw = match data.get("x").and_then(serde_json::Value::as_u64) { Some(v)=>v, None=>{ game_error(&socket,"missing x"); return; } };
    let y_raw = match data.get("y").and_then(serde_json::Value::as_u64) { Some(v)=>v, None=>{ game_error(&socket,"missing y"); return; } };

    let mut g = match rooms().lock() { Ok(g)=>g, Err(_)=>{ game_error(&socket,"lock"); return; } };
    let room = match g.get_mut(&channel_id) { Some(r)=>r, None=>{ drop(g); game_error(&socket,"no game"); return; } };
    let sess = match room.session.as_mut() { Some(s)=>s, None=>{ drop(g); game_error(&socket,"no game"); return; } };
    if sess.status != GameStatus::Active { drop(g); game_error(&socket, "game not active"); return; }
    if x_raw >= sess.size as u64 || y_raw >= sess.size as u64 { drop(g); game_error(&socket, "out of bounds"); return; }
    let x = x_raw as u8;
    let y = y_raw as u8;
    let seat = if sess.seats[0] == Some(ident.user_id) { 0usize }
        else if sess.seats[1] == Some(ident.user_id) { 1usize }
        else { drop(g); game_error(&socket, "not a player"); return; };
    if seat != sess.to_play { drop(g); game_error(&socket, "not your turn"); return; }
    let color: i8 = if seat == 0 { 0 } else { 1 };
    let mut ko = sess.ko;
    if let Err(e) = apply_go_move(&mut sess.board, sess.size, x, y, color, &mut ko) {
        drop(g); game_error(&socket, &e); return;
    }
    sess.ko = ko;
    sess.moves.push(GoMove { x, y, pass: false });
    sess.consecutive_passes = 0;
    sess.to_play = 1 - sess.to_play;
    sess.revision += 1;
    let sess_clone = sess.clone();
    drop(g);
    broadcast_state(&io, &channel_id, &sess_clone);
}

pub async fn on_game_pass(socket: SocketRef, data: serde_json::Value, state: SioState, io: socketioxide::SocketIo) {
    let channel_id = data.get("channelId").and_then(serde_json::Value::as_str).unwrap_or("").to_string();
    if channel_id.is_empty() { game_error(&socket, "missing channelId"); return; }
    if !game_sync_enabled(&state).await { game_error(&socket, "Game Sync is disabled on this server"); return; }
    let Some(ident) = require_socket_channel(&socket, &state, &channel_id, "game:error").await else { return; };
    let mut g = match rooms().lock() { Ok(g)=>g, Err(_)=>{ game_error(&socket,"lock"); return; } };
    let room = match g.get_mut(&channel_id) { Some(r)=>r, None=>{ drop(g); game_error(&socket,"no game"); return; } };
    let sess = match room.session.as_mut() { Some(s)=>s, None=>{ drop(g); game_error(&socket,"no game"); return; } };
    if sess.status != GameStatus::Active { drop(g); game_error(&socket, "game not active"); return; }
    let seat = if sess.seats[0] == Some(ident.user_id) { 0usize }
        else if sess.seats[1] == Some(ident.user_id) { 1usize }
        else { drop(g); game_error(&socket, "not a player"); return; };
    if seat != sess.to_play { drop(g); game_error(&socket, "not your turn"); return; }
    sess.moves.push(GoMove { x: 0, y: 0, pass: true });
    sess.consecutive_passes += 1;
    sess.to_play = 1 - sess.to_play;
    // A pass lifts the ko ban (it only binds the immediately following move).
    sess.ko = None;
    if sess.consecutive_passes >= 2 {
        sess.status = GameStatus::Finished;
        let (b, w) = score_go(&sess.board, sess.size);
        let white_with_komi = w + 13; // doubled counts; 13 = 2 x komi 6.5
        let (winner, reason) = decide_winner(b, white_with_komi);
        sess.winner = Some(winner);
        sess.reason = reason.into();
        sess.score = Some(GoScore {
            black: b as f64 / 2.0,
            white: w as f64 / 2.0 + 6.5,
        });
    }
    sess.revision += 1;
    let sess_clone = sess.clone();
    drop(g);
    broadcast_state(&io, &channel_id, &sess_clone);
}

pub async fn on_game_resign(socket: SocketRef, data: serde_json::Value, state: SioState, io: socketioxide::SocketIo) {
    let channel_id = data.get("channelId").and_then(serde_json::Value::as_str).unwrap_or("").to_string();
    if channel_id.is_empty() { game_error(&socket, "missing channelId"); return; }
    if !game_sync_enabled(&state).await { game_error(&socket, "Game Sync is disabled on this server"); return; }
    let Some(ident) = require_socket_channel(&socket, &state, &channel_id, "game:error").await else { return; };
    let mut g = match rooms().lock() { Ok(g)=>g, Err(_)=>{ game_error(&socket,"lock"); return; } };
    let room = match g.get_mut(&channel_id) { Some(r)=>r, None=>{ drop(g); game_error(&socket,"no game"); return; } };
    let sess = match room.session.as_mut() { Some(s)=>s, None=>{ drop(g); game_error(&socket,"no game"); return; } };
    if sess.status != GameStatus::Active { drop(g); game_error(&socket, "game not active"); return; }
    let seat = if sess.seats[0] == Some(ident.user_id) { 0usize }
        else if sess.seats[1] == Some(ident.user_id) { 1usize }
        else { drop(g); game_error(&socket, "not a player"); return; };
    sess.status = GameStatus::Finished;
    sess.winner = Some(1 - seat);
    sess.reason = "resign".into();
    sess.revision += 1;
    let sess_clone = sess.clone();
    drop(g);
    broadcast_state(&io, &channel_id, &sess_clone);
}

#[cfg(test)]
mod game_ops_tests {
    use super::*;

    #[test]
    fn apply_move_basic() {
        let mut b = vec![-1i8; 9];
        let mut ko = None;
        assert!(apply_go_move(&mut b, 3, 1, 1, 0, &mut ko).is_ok());
        assert_eq!(b[4], 0);
    }

    #[test]
    fn suicide_rejected() {
        // surround a point by opponent, then try to play there
        let mut b = vec![-1i8; 9];
        let mut ko = None;
        // opponent stones around (1,1): top (1,0), left(0,1), right(2,1), bottom(1,2)
        for (x,y) in [(1u8,0u8),(0,1),(2,1),(1,2)] {
            assert!(apply_go_move(&mut b,3,x,y,1,&mut ko).is_ok(), "setup");
        }
        // now black tries to play center -> suicide (no captures), should err
        let mut ko2 = None;
        // ko is currently None likely; pass current ko? we overwrite; ko state doesn't matter for this test move much
        let res = apply_go_move(&mut b, 3, 1, 1, 0, &mut ko2);
        assert!(res.is_err(), "suicide should be rejected: {:?}", res);
    }

    #[test]
    fn simple_capture() {
        let mut b = vec![-1i8; 9];
        let mut ko = None;
        // white stone at (0,0), black plays (1,0) and (0,1) ... then (??) capture needs all sides.
        // Classic capture: white at (1,1); black surrounds on all 4 sides -> capture.
        // Place white center
        assert!(apply_go_move(&mut b, 3, 1, 1, 1, &mut ko).is_ok());
        let mut ko = None;
        // black around
        assert!(apply_go_move(&mut b, 3, 1, 0, 0, &mut ko).is_ok());
        let mut ko = None;
        assert!(apply_go_move(&mut b, 3, 0, 1, 0, &mut ko).is_ok());
        let mut ko = None;
        assert!(apply_go_move(&mut b, 3, 2, 1, 0, &mut ko).is_ok());
        let mut ko = None;
        // last side captures
        let r = apply_go_move(&mut b, 3, 1, 2, 0, &mut ko);
        assert!(r.is_ok(), "{:?}", r);
        assert_eq!(r.unwrap(), 1);
        // center now empty
        assert_eq!(b[4], -1);
    }

    #[test]
    fn scoring_counts_stone() {
        let b = vec![0i8, -1, -1, -1, -1, -1, -1, -1, -1];
        let (bs, ws) = score_go(&b, 3);
        assert!(bs > 0);
        assert_eq!(ws, 0);
    }

    #[test]
    fn komi_decides_half_point_games() {
        // Doubled counts: black 8 pts -> 16 halves; white 1 pt + 6.5 komi -> 15.
        assert_eq!(decide_winner(16, 15), (0, "area"));
        // Black 7 pts -> 14 halves; white 1 pt + 6.5 komi -> 15: white by half.
        assert_eq!(decide_winner(14, 15), (1, "area"));
        // Exact equality is unreachable with half-point komi but must stay
        // white-favoured, matching half-point komi semantics.
        assert_eq!(decide_winner(20, 20), (1, "tie-komi"));
    }
}
