use blake3::Hash;

/// Compute a 60-digit safety number from two identity public keys.
///
/// The safety number is a decimal string of exactly 60 digits, split into
/// 12 groups of 5 digits separated by dashes for readability (e.g.,
/// `"12345-67890-12345-..."`).
///
/// ## Algorithm
///
/// 1. Sort the two public key bytes lexicographically.
/// 2. Compute `BLAKE3(sorted_key1 || sorted_key2)`.
/// 3. Interpret the hash as a stream of decimal digits (each byte produces
///    two decimal digits via `byte % 10` and `byte / 10 % 10`).
/// 4. Take the first 60 digits and format them as 12 groups of 5.
pub fn compute_safety_number(local_pubkey: &[u8], remote_pubkey: &[u8]) -> String {
    let (first, second) = if local_pubkey <= remote_pubkey {
        (local_pubkey, remote_pubkey)
    } else {
        (remote_pubkey, local_pubkey)
    };

    let mut hasher = blake3::Hasher::new();
    hasher.update(first);
    hasher.update(second);
    let hash: Hash = hasher.finalize();

    let hash_bytes = hash.as_bytes();

    // Generate 60 decimal digits from the hash bytes.
    let mut digits = [0u8; 60];
    for i in 0..30 {
        let b = hash_bytes[i % hash_bytes.len()];
        digits[i * 2] = b % 10;
        digits[i * 2 + 1] = (b / 10) % 10;
    }

    // Format as 12 groups of 5 digits.
    let mut result = String::with_capacity(71);
    for group in 0..12 {
        if group > 0 {
            result.push('-');
        }
        let start = group * 5;
        for j in 0..5 {
            result.push((b'0' + digits[start + j]) as char);
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_keys_produce_same_number() {
        let key_a = b"alice_identity_key_32_bytes!!";
        let key_b = b"bob_identity_key_32_bytes!!!!";
        let n1 = compute_safety_number(key_a, key_b);
        let n2 = compute_safety_number(key_a, key_b);
        assert_eq!(n1, n2, "same keys must produce same safety number");
    }

    #[test]
    fn commutative() {
        let key_a = b"alice_key_here_1234567890";
        let key_b = b"bob_key_here_0987654321";
        let n1 = compute_safety_number(key_a, key_b);
        let n2 = compute_safety_number(key_b, key_a);
        assert_eq!(
            n1, n2,
            "safety number must be commutative (order-independent)"
        );
    }

    #[test]
    fn different_keys_produce_different_numbers() {
        let key_a = b"aaaaaaaaaaaaaaaaaaaaaaaa";
        let key_b = b"bbbbbbbbbbbbbbbbbbbbbbbb";
        let key_c = b"cccccccccccccccccccccccc";
        let n_ab = compute_safety_number(key_a, key_b);
        let n_ac = compute_safety_number(key_a, key_c);
        assert_ne!(
            n_ab, n_ac,
            "different key pairs must produce different safety numbers"
        );
    }

    #[test]
    fn format_is_correct() {
        let key_a = b"key_a_for_format_test_1234";
        let key_b = b"key_b_for_format_test_5678";
        let number = compute_safety_number(key_a, key_b);

        // Should be 71 characters: 60 digits + 11 dashes.
        assert_eq!(number.len(), 71, "60 digits + 11 dashes = 71 chars");

        // Should be 12 groups of 5 digits separated by dashes.
        let groups: Vec<&str> = number.split('-').collect();
        assert_eq!(groups.len(), 12, "must have 12 groups");
        for (i, group) in groups.iter().enumerate() {
            assert_eq!(group.len(), 5, "group {i} must have 5 digits");
            assert!(
                group.chars().all(|c| c.is_ascii_digit()),
                "group {i} must contain only digits"
            );
        }
    }

    #[test]
    fn all_digits() {
        let key_a = b"test_all_digits_key_one____";
        let key_b = b"test_all_digits_key_two____";
        let number = compute_safety_number(key_a, key_b);
        // Verify all 71 chars are digits or dashes.
        assert!(number.chars().all(|c| c.is_ascii_digit() || c == '-'));
    }

    #[test]
    fn exactly_60_digits() {
        let key_a = b"count_digits_test_key_aaaaa";
        let key_b = b"count_digits_test_key_bbbbb";
        let number = compute_safety_number(key_a, key_b);
        let digit_count = number.chars().filter(|c| c.is_ascii_digit()).count();
        assert_eq!(digit_count, 60, "must have exactly 60 digits");
    }
}
