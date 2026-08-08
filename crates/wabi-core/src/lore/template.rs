//! File template types for scaffolding new files.

use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

/// A file template: either a built-in scaffold or a repo-local template.
#[derive(Debug, Clone, Serialize, Deserialize, )]
#[cfg_attr(feature = "ts", derive(TS))]
#[cfg_attr(feature = "ts", ts(export))]
pub struct FileTemplate {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub file_path: String,
    pub content: String,
    pub language: Option<String>,
    pub category: TemplateCategory,
    pub source: TemplateSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, )]
#[cfg_attr(feature = "ts", derive(TS))]
#[cfg_attr(feature = "ts", ts(export))]
pub enum TemplateCategory {
    Language,
    Config,
    Documentation,
    Test,
    Script,
    Custom(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, )]
#[cfg_attr(feature = "ts", derive(TS))]
#[cfg_attr(feature = "ts", ts(export))]
pub enum TemplateSource {
    BuiltIn,
    RepoLocal,
    Workspace,
}

/// A scaffold pack: multiple files created as one operation.
#[derive(Debug, Clone, Serialize, Deserialize, )]
#[cfg_attr(feature = "ts", derive(TS))]
#[cfg_attr(feature = "ts", ts(export))]
pub struct ScaffoldPack {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub files: Vec<ScaffoldFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, )]
#[cfg_attr(feature = "ts", derive(TS))]
#[cfg_attr(feature = "ts", ts(export))]
pub struct ScaffoldFile {
    pub path: String,
    pub content_template: String,
    pub language: Option<String>,
}

/// Built-in templates for common languages.
pub fn builtin_templates() -> Vec<FileTemplate> {
    vec![
        FileTemplate {
            id: "rust-lib".to_string(),
            name: "Rust Library".to_string(),
            description: Some("Rust library crate with Cargo.toml".to_string()),
            file_path: "src/lib.rs".to_string(),
            content: r#"//! {name}

pub fn hello() -> &'static str {
    "Hello from {name}!"
}

#[cfg(test)]
mod tests {{
    use super::*;

    #[test]
    fn test_hello() {{
        assert_eq!(hello(), "Hello from {{name}}!");
    }}
}}
"#.to_string(),
            language: Some("rust".to_string()),
            category: TemplateCategory::Language,
            source: TemplateSource::BuiltIn,
        },
        FileTemplate {
            id: "typescript-module".to_string(),
            name: "TypeScript Module".to_string(),
            description: Some("TypeScript module with exports".to_string()),
            file_path: "src/{name}.ts".to_string(),
            content: r#"/**
 * {name}
 */

export interface Config {{
  // Add configuration options
}}

export function init(config: Config): void {{
  // Implementation
}}
"#.to_string(),
            language: Some("typescript".to_string()),
            category: TemplateCategory::Language,
            source: TemplateSource::BuiltIn,
        },
        FileTemplate {
            id: "python-module".to_string(),
            name: "Python Module".to_string(),
            description: Some("Python module with docstring".to_string()),
            file_path: "{name}.py".to_string(),
            content: r#"""{name}"""

def main() -> None:
    """Entry point."""
    pass

if __name__ == "__main__":
    main()
"#.to_string(),
            language: Some("python".to_string()),
            category: TemplateCategory::Language,
            source: TemplateSource::BuiltIn,
        },
        FileTemplate {
            id: "readme".to_string(),
            name: "README".to_string(),
            description: Some("Markdown README".to_string()),
            file_path: "README.md".to_string(),
            content: r#"# {name}

## Description

TODO

## Getting Started

TODO

## License

TODO
"#.to_string(),
            language: Some("markdown".to_string()),
            category: TemplateCategory::Documentation,
            source: TemplateSource::BuiltIn,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_builtin_templates() {
        let templates = builtin_templates();
        assert!(!templates.is_empty());
        assert!(templates.iter().all(|t| !t.id.is_empty()));
        assert!(templates.iter().all(|t| !t.name.is_empty()));
    }

    #[test]
    fn test_template_has_content() {
        let templates = builtin_templates();
        for t in templates {
            assert!(!t.content.is_empty(), "Template {} has no content", t.id);
        }
    }
}