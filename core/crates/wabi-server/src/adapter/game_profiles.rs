//! Dedicated profile writes: serial CAS, durable receipt, NO subscription fan-out.
use super::*;
use crate::error::{AppError,Result as ApiResult};
use wabidb::projections::game_profiles::{self,GameProfileRecord};
// Data lives in each adapter's WabiDB. This mutex only serializes the low-volume
// new profile writers; it stores no tenant/session data and is never bypassed.
pub(crate) static GAME_PROFILE_WRITES:tokio::sync::Mutex<()>=tokio::sync::Mutex::const_new(());
impl WdbAdapter {
    pub fn get_game_profile(&self,user_id:u64)->ApiResult<GameProfileRecord> {
        self.engine.projection_state().get(game_profiles::INDEX,&user_id.to_be_bytes())
            .map(|v|game_profiles::decode(&v)).transpose().map_err(AppError::from)
            .map(|r|r.unwrap_or_else(||GameProfileRecord::empty(user_id)))
    }
    pub async fn mutate_game_profile<F>(&self,user_id:u64,expected:&str,mutate:F)->ApiResult<GameProfileRecord>
    where F:FnOnce(&mut GameProfileRecord)->ApiResult<()> + Send {
        let _guard=GAME_PROFILE_WRITES.lock().await;
        if expected.len()>64 {return Err(AppError::BadRequest("Invalid profile revision".into()));}
        let owner=self.get_user(user_id).await?.ok_or_else(||AppError::NotFound("Account not found".into()))?;
        if !owner.is_active || owner.password_hash.is_empty() {return Err(AppError::Forbidden("Registered account required".into()));}
        let mut row=self.get_game_profile(user_id)?;
        if row.revision!=expected {return Err(AppError::Conflict("Game selections changed. Reload before saving; your draft has not been applied.".into()));}
        mutate(&mut row)?;
        row.revision=uuid::Uuid::new_v4().to_string();
        let plaintext=serde_json::to_vec(&row).map_err(|_|AppError::Internal("Could not encode game selections".into()))?;
        // Reject any record the projection cannot decode BEFORE submitting durability.
        // A malformed/oversized durable event would stop the applied prefix.
        game_profiles::decode(&plaintext).map_err(|_|AppError::BadRequest("Game board exceeds the supported storage limits".into()))?;
        let stream_id=format!("game-profile:{user_id}");
        self.engine.get_or_create_stream_key(&stream_id).await?;
        let cmd=CommandCommit {caller_user_id:user_id,caller_device_id:"primary".into(),command_name:"replace_game_profile_v1".into(),idempotency_key:None,
            events:vec![EventToWrite {stream_id,event_type:game_profiles::EVENT.into(),stream_kind:6,record_kind:RecordKind::Event,plaintext}],
            essential:true,response_tx:tokio::sync::oneshot::channel().0};
        self.engine.run_command(cmd).await?;
        // No deliver_event: the record contains a private account association.
        // API reads construct viewer-safe data. Event logs remain operator-readable.
        if self.get_user(user_id).await?.is_none() {return Err(AppError::NotFound("Account no longer exists".into()));}
        Ok(row)
    }
}
#[cfg(test)] mod tests {
    use super::*;
    #[tokio::test] async fn game_profile_cas_clear_and_readback() {
        let directory=tempfile::tempdir().unwrap();
        let store=WdbAdapter::open(directory.path()).await.unwrap();
        let uid=store.create_user("steam-test",None,"not-a-guest").await.unwrap();
        let original=store.get_game_profile(uid).unwrap();assert_eq!(original.revision,"0");
        let linked=store.mutate_game_profile(uid,"0",|r|{r.steam_id=Some("76561198000000000".into());Ok(())}).await.unwrap();
        assert!(store.mutate_game_profile(uid,"0",|_|Ok(())).await.is_err());
        let clear=store.mutate_game_profile(uid,&linked.revision,|r|{r.steam_id=None;Ok(())}).await.unwrap();
        assert_eq!(store.get_game_profile(uid).unwrap(),clear);
        let before=store.get_game_profile(uid).unwrap();
        assert!(store.mutate_game_profile(uid,&before.revision,|r|{r.revision="".into();r.steam_id=Some("x".repeat(131072));Ok(())}).await.is_err());
        assert_eq!(store.get_game_profile(uid).unwrap(),before);
        assert!(store.is_healthy(),"invalid application data must never poison the writer");
        // Actual shutdown/reopen must use the engine's supported lifecycle in CI;
        // this test proves immediate committed readback, not restart by itself.
    }
}
