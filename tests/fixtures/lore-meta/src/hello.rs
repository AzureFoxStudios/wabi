//! Minimal Wabi-on-Wabi Lore smoke-test source.

pub fn greeting(name: &str) -> String {
    format!("Hello from Wabi, {name}!")
}

#[cfg(test)]
mod tests {
    use super::greeting;

    #[test]
    fn greeting_is_stable() {
        assert_eq!(greeting("Lore"), "Hello from Wabi, Lore!");
    }
}

// Citation target: ^c/src/hello.rs:3-5
// Later revisions can change this implementation for comparison tests.
