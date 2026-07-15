use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Authenticate {
    pub ticket: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Subscribe {
    pub topic: String,
    pub since_commit_seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SendMessage {
    pub channel_id: String,
    pub plaintext: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SendDm {
    pub recipient_user_id: u64,
    pub plaintext: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Ack {
    pub commit_seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Authenticated {
    pub session_id: String,
    pub user_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Subscribed {
    pub topic: String,
    pub from_commit_seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MessageCreated {
    pub channel_id: String,
    pub message_id: String,
    pub author_user_id: u64,
    pub commit_seq: u64,
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DmMessageCreated {
    pub dm_id: String,
    pub message_id: String,
    pub author_user_id: u64,
    pub commit_seq: u64,
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ServerError {
    pub code: u32,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ClientMessage {
    Authenticate(Authenticate),
    Subscribe(Subscribe),
    SendMessage(SendMessage),
    SendDm(SendDm),
    Ack(Ack),
    Ping,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ServerMessage {
    Authenticated(Authenticated),
    Subscribed(Subscribed),
    MessageCreated(MessageCreated),
    DmMessageCreated(DmMessageCreated),
    Error(ServerError),
    Pong,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip_client(msg: &ClientMessage) {
        let json = serde_json::to_string(msg).unwrap();
        let back: ClientMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(*msg, back);
    }

    fn roundtrip_server(msg: &ServerMessage) {
        let json = serde_json::to_string(msg).unwrap();
        let back: ServerMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(*msg, back);
    }

    #[test]
    fn client_authenticate() {
        roundtrip_client(&ClientMessage::Authenticate(Authenticate {
            ticket: "tkt_abc123".into(),
        }));
    }

    #[test]
    fn client_subscribe() {
        roundtrip_client(&ClientMessage::Subscribe(Subscribe {
            topic: "channel:ch_01".into(),
            since_commit_seq: 42,
        }));
    }

    #[test]
    fn client_send_message() {
        roundtrip_client(&ClientMessage::SendMessage(SendMessage {
            channel_id: "ch_01".into(),
            plaintext: b"hello world".to_vec(),
        }));
    }

    #[test]
    fn client_send_dm() {
        roundtrip_client(&ClientMessage::SendDm(SendDm {
            recipient_user_id: 99,
            plaintext: b"secret dm".to_vec(),
        }));
    }

    #[test]
    fn client_ack() {
        roundtrip_client(&ClientMessage::Ack(Ack { commit_seq: 100 }));
    }

    #[test]
    fn client_ping() {
        roundtrip_client(&ClientMessage::Ping);
    }

    #[test]
    fn server_authenticated() {
        roundtrip_server(&ServerMessage::Authenticated(Authenticated {
            session_id: "session_1".into(),
            user_id: 42,
        }));
    }

    #[test]
    fn server_subscribed() {
        roundtrip_server(&ServerMessage::Subscribed(Subscribed {
            topic: "channel:ch_01".into(),
            from_commit_seq: 42,
        }));
    }

    #[test]
    fn server_message_created() {
        roundtrip_server(&ServerMessage::MessageCreated(MessageCreated {
            channel_id: "ch_01".into(),
            message_id: "msg_01".into(),
            author_user_id: 42,
            commit_seq: 100,
            payload: b"hello".to_vec(),
        }));
    }

    #[test]
    fn server_dm_message_created() {
        roundtrip_server(&ServerMessage::DmMessageCreated(DmMessageCreated {
            dm_id: "dm_01".into(),
            message_id: "msg_01".into(),
            author_user_id: 42,
            commit_seq: 100,
            payload: b"dm content".to_vec(),
        }));
    }

    #[test]
    fn server_error() {
        roundtrip_server(&ServerMessage::Error(ServerError {
            code: 4401,
            message: "unauthorized".into(),
        }));
    }

    #[test]
    fn server_pong() {
        roundtrip_server(&ServerMessage::Pong);
    }

    #[test]
    fn all_client_variants_roundtrip() {
        let variants = vec![
            ClientMessage::Authenticate(Authenticate { ticket: "t".into() }),
            ClientMessage::Subscribe(Subscribe { topic: "t".into(), since_commit_seq: 0 }),
            ClientMessage::SendMessage(SendMessage { channel_id: "c".into(), plaintext: vec![1, 2, 3] }),
            ClientMessage::SendDm(SendDm { recipient_user_id: 1, plaintext: vec![] }),
            ClientMessage::Ack(Ack { commit_seq: 1 }),
            ClientMessage::Ping,
        ];
        for v in &variants {
            roundtrip_client(v);
        }
    }

    #[test]
    fn all_server_variants_roundtrip() {
        let variants = vec![
            ServerMessage::Authenticated(Authenticated { session_id: "s".into(), user_id: 1 }),
            ServerMessage::Subscribed(Subscribed { topic: "t".into(), from_commit_seq: 0 }),
            ServerMessage::MessageCreated(MessageCreated {
                channel_id: "c".into(), message_id: "m".into(),
                author_user_id: 1, commit_seq: 1, payload: vec![],
            }),
            ServerMessage::DmMessageCreated(DmMessageCreated {
                dm_id: "d".into(), message_id: "m".into(),
                author_user_id: 1, commit_seq: 1, payload: vec![],
            }),
            ServerMessage::Error(ServerError { code: 400, message: "bad".into() }),
            ServerMessage::Pong,
        ];
        for v in &variants {
            roundtrip_server(v);
        }
    }
}
