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
    formatter: toml::Table,
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
    /// The linter's rules, built once.
    pub rules: std::sync::Arc<mago_linter::registry::RuleRegistry>,
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
    /// The formatter's settings, or why `[formatter]` can't be read.
    pub format: Result<mago_formatter::settings::FormatSettings, String>,
    format_excludes: GlobSet,
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

impl std::fmt::Debug for MagoConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MagoConfig").field("includes", &self.includes).field("excludes", &self.excludes).finish_non_exhaustive()
    }
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
        let rules = std::sync::Arc::new(mago_linter::registry::RuleRegistry::build(&linter, None, false));
        let (format, format_excludes) = formatter(file.formatter);
        Ok(Self {
            rules,
            php_version,
            includes,
            excludes: file.source.excludes.clone(),
            analyzer_excludes: globs(&file.analyzer.excludes),
            linter_excludes: globs(&file.linter.excludes),
            linter,
            analyzer: file.analyzer,
            ignored,
            format,
            format_excludes,
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

    /// Whether the formatter formats the file at `rel`.
    pub fn formats(&self, rel: &Path) -> bool {
        !self.format_excludes.is_match(rel)
    }

    /// Whether the linter checks the file at `rel`.
    pub fn lints(&self, rel: &Path) -> bool {
        !self.linter_excludes.is_match(rel)
    }
}

/// `[formatter]`: a `preset` (Mago's default when missing) with the other options over it, and `excludes`. An
/// option the formatter doesn't know makes the settings an error, as Mago's command line refuses them.
fn formatter(mut table: toml::Table) -> (Result<mago_formatter::settings::FormatSettings, String>, GlobSet) {
    let excludes: Vec<String> = table
        .remove("excludes")
        .and_then(|v| v.try_into().ok())
        .unwrap_or_default();
    let settings = (|| {
        let preset = match table.remove("preset") {
            Some(toml::Value::String(name)) => name.parse::<mago_formatter::presets::FormatterPreset>().map_err(|_| format!("unknown preset `{name}`"))?,
            Some(_) => return Err("`preset` must be a string".to_string()),
            None => Default::default(),
        };
        let toml::Value::Table(mut merged) = toml::Value::try_from(preset.settings()).map_err(|e| e.to_string())? else {
            return Err("the preset isn't a table".into());
        };
        merged.extend(table);
        toml::Value::Table(merged).try_into::<mago_formatter::settings::FormatSettings>().map_err(|e| e.to_string())
    })()
    .map_err(|e| format!("mago.toml's [formatter]: {e}"));
    (settings, globs(&excludes))
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

    #[test]
    fn reads_the_formatters_preset_and_options() {
        let config = MagoConfig::parse("[formatter]\npreset = \"psr-12\"\nprint-width = 100\nexcludes = [\"legacy\"]\n", Path::new("/p")).unwrap();
        let settings = config.format.as_ref().unwrap();
        assert_eq!(settings.print_width, 100);
        assert!(!config.formats(Path::new("legacy/a.php")));
        assert!(config.formats(Path::new("app/a.php")));
        assert_eq!(MagoConfig::default().format.unwrap().print_width, mago_formatter::settings::FormatSettings::default().print_width);
        // A bad option spoils the formatter only.
        let config = MagoConfig::parse("[formatter]\nno-such-option = 1\n", Path::new("/p")).unwrap();
        assert!(config.format.unwrap_err().contains("no-such-option"));
    }
}
