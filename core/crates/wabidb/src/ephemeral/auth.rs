use crate::error::{Result, WabiError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EphemeralAction {
    SendTyping,
    JoinCall,
    MoveCursor,
}

pub fn check_ephemeral_auth(user_id: u64, action: EphemeralAction) -> Result<()> {
    match action {
        EphemeralAction::SendTyping => {
            if user_id == 0 {
                return Err(WabiError::Forbidden {
                    user_id,
                    command: "send_typing".into(),
                });
            }
            Ok(())
        }
        EphemeralAction::JoinCall => {
            if user_id == 0 {
                return Err(WabiError::Forbidden {
                    user_id,
                    command: "join_call".into(),
                });
            }
            Ok(())
        }
        EphemeralAction::MoveCursor => {
            if user_id == 0 {
                return Err(WabiError::Forbidden {
                    user_id,
                    command: "move_cursor".into(),
                });
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_typing_requires_valid_auth() {
        assert!(check_ephemeral_auth(1, EphemeralAction::SendTyping).is_ok());
        assert!(check_ephemeral_auth(0, EphemeralAction::SendTyping).is_err());
    }

    #[test]
    fn join_call_requires_membership() {
        assert!(check_ephemeral_auth(42, EphemeralAction::JoinCall).is_ok());
        assert!(check_ephemeral_auth(0, EphemeralAction::JoinCall).is_err());
    }

    #[test]
    fn move_cursor_requires_write_access() {
        assert!(check_ephemeral_auth(7, EphemeralAction::MoveCursor).is_ok());
        assert!(check_ephemeral_auth(0, EphemeralAction::MoveCursor).is_err());
    }

    #[test]
    fn each_action_has_rules() {
        for action in &[
            EphemeralAction::SendTyping,
            EphemeralAction::JoinCall,
            EphemeralAction::MoveCursor,
        ] {
            let result = check_ephemeral_auth(0, *action);
            assert!(result.is_err(), "user 0 should be rejected for {action:?}");
        }
    }
}
