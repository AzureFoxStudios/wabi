use super::WdbAdapter;
use wabidb::{
    domain::Message,
    error::Result,
    projections::messages::{MessagePageCursor, MessagesProjection},
};

impl WdbAdapter {
    /// One durable page in chronological order, with a directional continuation
    /// flag. The projection verifies that any cursor belongs to this channel.
    pub async fn list_messages_page(
        &self,
        channel_id: &str,
        cursor: MessagePageCursor<'_>,
        limit: usize,
    ) -> Result<(Vec<Message>, bool)> {
        let page = MessagesProjection::list_messages_page(
            &self.engine.projection_state(),
            channel_id,
            cursor,
            limit,
        )?;
        Ok((page.messages.into_iter().map(Message::from).collect(), page.has_more))
    }
}
