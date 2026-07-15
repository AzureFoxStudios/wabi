pub struct Namespace {
    pub tenant_id: String,
    pub resource_path: String,
}

pub fn parse_namespace(path: &str) -> Namespace {
    let path = path.trim_start_matches('/');
    let slash_pos = path.find('/');
    match slash_pos {
        Some(pos) => Namespace {
            tenant_id: path[..pos].to_string(),
            resource_path: path[pos + 1..].to_string(),
        },
        None => Namespace {
            tenant_id: path.to_string(),
            resource_path: String::new(),
        },
    }
}

pub fn format_path(ns: &Namespace) -> String {
    if ns.resource_path.is_empty() {
        format!("/{}", ns.tenant_id)
    } else {
        format!("/{}/{}", ns.tenant_id, ns.resource_path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_simple_path() {
        let ns = parse_namespace("/tenant1/resources");
        assert_eq!(ns.tenant_id, "tenant1");
        assert_eq!(ns.resource_path, "resources");
    }

    #[test]
    fn parse_path_without_leading_slash() {
        let ns = parse_namespace("tenant1/resources");
        assert_eq!(ns.tenant_id, "tenant1");
        assert_eq!(ns.resource_path, "resources");
    }

    #[test]
    fn parse_root_only() {
        let ns = parse_namespace("/tenant1");
        assert_eq!(ns.tenant_id, "tenant1");
        assert_eq!(ns.resource_path, "");
    }

    #[test]
    fn format_simple() {
        let ns = Namespace {
            tenant_id: "tenant1".into(),
            resource_path: "resources".into(),
        };
        assert_eq!(format_path(&ns), "/tenant1/resources");
    }

    #[test]
    fn format_root_only() {
        let ns = Namespace {
            tenant_id: "tenant1".into(),
            resource_path: String::new(),
        };
        assert_eq!(format_path(&ns), "/tenant1");
    }

    #[test]
    fn parse_format_round_trip() {
        let paths = vec![
            "/tenant1/resources",
            "/a/b",
            "/single",
            "/with/multiple/segments",
        ];
        for path in paths {
            let ns = parse_namespace(path);
            let formatted = format_path(&ns);
            assert_eq!(path, formatted, "round-trip failed for {path}");
        }
    }
}
