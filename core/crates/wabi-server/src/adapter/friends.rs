use super::WdbAdapter;
use wabidb::{
    error::Result,
    projections::friends::{self, FriendRelationship},
};

impl WdbAdapter {
    pub async fn get_friend_relationship(
        &self,
        a: u64,
        b: u64,
    ) -> Result<Option<FriendRelationship>> {
        friends::get(&self.engine.projection_state(), a, b)
    }

    pub async fn list_friend_relationships(&self, user_id: u64) -> Result<Vec<FriendRelationship>> {
        friends::list_for(&self.engine.projection_state(), user_id)
    }

    pub async fn save_friend_relationship(
        &self,
        actor: u64,
        row: &FriendRelationship,
    ) -> Result<()> {
        let payload =
            serde_json::to_vec(row).map_err(|error| wabidb::error::WabiError::Validation {
                command: "friend_relationship".into(),
                reason: error.to_string(),
            })?;
        self.run(
            actor,
            "friend_relationship",
            format!("friends:{}:{}", row.low_user_id, row.high_user_id),
            friends::EVENT,
            6,
            payload,
            true,
            None,
        )
        .await?;
        Ok(())
    }
}
