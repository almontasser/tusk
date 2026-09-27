//! The project's Mago configuration (`mago.toml`): which files are library code, the analyzer's switches and
//! ignored problems, and the linter's integrations and rules. Only what the server uses is read, so options
//! for Mago's other tools don't stop it from loading.

use std::path::{Path, PathBuf};

use globset::{Glob, GlobSet, GlobSetBuilder};
use mago_linter::integration::{Integration, IntegrationSet};
use mago_linter::settings::RulesSettings;
use mago_php_version::PHPVersion;
use serde::Deserialize;

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "kebab-case")]
struct File {
    php_version: Option<String>,
    source: Source,
    analyzer: Analyzer,
    linter: Linter,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct Source {
    includes: Vec<String>,
    excludes: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "kebab-case")]
struct Analyzer {
    excludes: Vec<String>,
    ignore: Vec<Ignore>,
    find_unused_expressions: Option<bool>,
    find_unused_parameters: Option<bool>,
    check_missing_override: Option<bool>,
    check_missing_type_hints: Option<bool>,
    check_throws: Option<bool>,
    allow_possibly_undefined_array_keys: Option<bool>,
    strict_list_index_checks: Option<bool>,
    check_property_initialization: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Ignore {
    Code(String),
    Scoped {
        code: String,
        #[serde(rename = "in", default)]
        paths: Vec<String>,
    },
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct Linter {
    excludes: Vec<String>,
    integrations: Vec<Integration>,
    rules: RulesSettings,
}

/// The configuration, ready to use.
pub struct MagoConfig {
    pub php_version: Option<PHPVersion>,
    /// Library code to index, relative to the root or absolute.
    pub includes: Vec<PathBuf>,
    /// Paths the index skips, as globs relative to the root.
    pub excludes: Vec<String>,
    pub linter: mago_linter::settings::Settings,
    analyzer: Analyzer,
    analyzer_excludes: GlobSet,
    linter_excludes: GlobSet,
    /// Ignored problem codes, each with the paths it applies to (all when empty).
    ignored: Vec<(String, GlobSet)>,
}

fn globs(patterns: &[String]) -> GlobSet {
    let mut set = GlobSetBuilder::new();
    for p in patterns {
        let p = p.trim_start_matches("./").trim_end_matches('/');
        for pattern in [p.to_string(), format!("{p}/**")] {
            if let Ok(g) = Glob::new(&pattern) {
                set.add(g);
            }
        }
    }
    set.build().unwrap_or_else(|_| GlobSet::empty())
}

impl Default for MagoConfig {
    fn default() -> Self {
        Self::parse("", Path::new("/")).unwrap_or_else(|_| unreachable!("an empty configuration parses"))
    }
}

impl MagoConfig {
    /// Reads `path`. A missing file is the default configuration; a malformed one is an error.
    pub fn load(path: &Path, root: &Path) -> Result<Self, String> {
        match std::fs::read_to_string(path) {
            Ok(text) => Self::parse(&text, root),
            Err(_) => Ok(Self::default()),
        }
    }

    pub fn parse(text: &str, root: &Path) -> Result<Self, String> {
        let file: File = toml::from_str(text).map_err(|e| format!("mago.toml: {e}"))?;
        let php_version = file.php_version.as_deref().and_then(crate::server::parse_php_version);
        let mut integrations = IntegrationSet::empty();
        for i in &file.linter.integrations {
            integrations.insert(*i);
        }
        let linter = mago_linter::settings::Settings {
            php_version: php_version.unwrap_or(PHPVersion::PHP84),
            integrations,
            rules: file.linter.rules,
            glob: Default::default(),
        };
        let ignored = file
            .analyzer
            .ignore
            .iter()
            .map(|i| match i {
                Ignore::Code(code) => (code.clone(), GlobSet::empty()),
                Ignore::Scoped { code, paths } => (code.clone(), globs(paths)),
            })
            .collect();
        let includes = file
            .source
            .includes
            .iter()
            .filter(|i| *i != "vendor")
            .map(|i| if Path::new(i).is_absolute() { PathBuf::from(i) } else { root.join(i) })
            .collect();
        Ok(Self {
            php_version,
            includes,
            excludes: file.source.excludes.clone(),
            analyzer_excludes: globs(&file.analyzer.excludes),
            linter_excludes: globs(&file.linter.excludes),
            linter,
            analyzer: file.analyzer,
            ignored,
        })
    }

    /// The analyzer's settings for this configuration.
    pub fn analyzer_settings(&self, version: PHPVersion) -> mago_analyzer::settings::Settings {
        let a = &self.analyzer;
        let mut s = crate::analysis::settings(version);
        let set = |field: &mut bool, value: Option<bool>| {
            if let Some(v) = value {
                *field = v;
            }
        };
        set(&mut s.find_unused_expressions, a.find_unused_expressions);
        set(&mut s.find_unused_parameters, a.find_unused_parameters);
        set(&mut s.check_missing_override, a.check_missing_override);
        set(&mut s.check_missing_type_hints, a.check_missing_type_hints);
        set(&mut s.check_throws, a.check_throws);
        set(&mut s.allow_possibly_undefined_array_keys, a.allow_possibly_undefined_array_keys);
        set(&mut s.strict_list_index_checks, a.strict_list_index_checks);
        set(&mut s.check_property_initialization, a.check_property_initialization);
        s
    }

    /// Whether the analyzer's problem `code` in the file at `rel` (relative to the root) should be reported.
    pub fn reports_analysis(&self, rel: &Path, code: Option<&str>) -> bool {
        if self.analyzer_excludes.is_match(rel) {
            return false;
        }
        let Some(code) = code else { return true };
        !self.ignored.iter().any(|(c, paths)| c == code && (paths.is_empty() || paths.is_match(rel)))
    }

    /// Whether the linter checks the file at `rel`.
    pub fn lints(&self, rel: &Path) -> bool {
        !self.linter_excludes.is_match(rel)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUNDLED: &str = include_str!("../../src-tauri/resources/mago.toml");

    #[test]
    fn reads_the_editors_bundled_configuration() {
        let config = MagoConfig::parse(BUNDLED, Path::new("/p")).unwrap();
        assert!(config.linter.integrations.contains(Integration::Laravel));
        assert_eq!(config.excludes, vec![".*", "node_modules", "storage", "bootstrap/cache"]);
    }

    #[test]
    fn applies_ignores_and_excludes() {
        let config = MagoConfig::parse(
            "php-version = \"8.2\"\n[analyzer]\nexcludes = [\"legacy\"]\nignore = [\"mixed-assignment\", { code = \"possibly-null-argument\", in = [\"tests/\"] }]\nfind-unused-expressions = false\n",
            Path::new("/p"),
        )
        .unwrap();
        assert_eq!(config.php_version, Some(PHPVersion::new(8, 2, 0)));
        assert!(!config.reports_analysis(Path::new("legacy/a.php"), Some("x")));
        assert!(!config.reports_analysis(Path::new("app/a.php"), Some("mixed-assignment")));
        assert!(!config.reports_analysis(Path::new("tests/a.php"), Some("possibly-null-argument")));
        assert!(config.reports_analysis(Path::new("app/a.php"), Some("possibly-null-argument")));
        assert!(!config.analyzer_settings(PHPVersion::PHP84).find_unused_expressions);
        assert!(MagoConfig::parse("[linter\n", Path::new("/p")).is_err());
    }
}
