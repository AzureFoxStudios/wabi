use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MapTokenRecord {
    pub id: String,
    pub place_id: String,
    pub layer_id: Option<String>,
    pub x: f32,
    pub y: f32,
    pub label: String,
    pub glyph: String,
    pub color: String,
    pub owner_id: Option<String>,
    pub visibility: String,
    pub updated_at: i64,
}

impl MapTokenRecord {
    pub fn move_to(&mut self, x: f32, y: f32, updated_at: i64) {
        self.x = x.clamp(0.0, 1.0);
        self.y = y.clamp(0.0, 1.0);
        self.updated_at = updated_at;
    }
}
