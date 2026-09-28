use wabidb::engine::wabi_store::WabiStore;
use wabidb::error::WabiError;
use wabidb::projections::wiki::{encode_record, WikiProjection};

use super::{now_micros, WdbAdapter};

#[derive(Debug)]
pub enum WikiWriteError {
    Storage(WabiError),
    NotFound,
    Conflict,
}

impl From<WabiError> for WikiWriteError {
    fn from(error: WabiError) -> Self { Self::Storage(error) }
}

impl WdbAdapter {
    /// Compare and write under one adapter lock. Existing records keep their
    /// postcard layout; the monotonic update timestamp is the edit token.
    #[allow(clippy::too_many_arguments)]
    pub async fn update_wiki_page_checked(
        &self,
        channel_id: &str,
        page_id: &str,
        expected_updated_at_micros: i64,
        title: &str,
        body: &str,
        author_user_id: u64,
        parent_page_id: Option<&str>,
        slug: Option<&str>,
        order_index: Option<i64>,
    ) -> Result<(), WikiWriteError> {
        let _guard = self.wiki_write.lock().await;
        let page = WikiProjection::get_page(&self.engine.projection_state(), channel_id, page_id)?
            .filter(|page| !page.is_deleted)
            .ok_or(WikiWriteError::NotFound)?;
        if page.updated_at_micros != expected_updated_at_micros {
            return Err(WikiWriteError::Conflict);
        }
        WabiStore::update_wiki_page(
            self, channel_id, page_id, title, body, author_user_id,
            parent_page_id.unwrap_or(&page.parent_page_id),
            slug.unwrap_or(&page.slug), order_index.unwrap_or(page.order_index),
        ).await?;
        Ok(())
    }

    pub async fn delete_wiki_page_checked(
        &self,
        channel_id: &str,
        page_id: &str,
        expected_updated_at_micros: i64,
        actor_user_id: u64,
    ) -> Result<(), WikiWriteError> {
        let _guard = self.wiki_write.lock().await;
        let mut page = WikiProjection::get_page(&self.engine.projection_state(), channel_id, page_id)?
            .filter(|page| !page.is_deleted)
            .ok_or(WikiWriteError::NotFound)?;
        if page.updated_at_micros != expected_updated_at_micros {
            return Err(WikiWriteError::Conflict);
        }
        page.is_deleted = true;
        page.updated_at_micros = now_micros().max(page.updated_at_micros.saturating_add(1));
        self.run(
            actor_user_id, "delete_wiki_page", channel_id.to_owned(),
            "wiki_page_deleted", 6, encode_record(&page), true, None,
        ).await?;
        Ok(())
    }
}
