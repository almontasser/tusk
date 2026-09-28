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

#[derive(Debug, Deserialize, serde::Serialize)]
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

/// The analyzer's switches that `mago.toml` can set, as its keys name them.
const ANALYZER_SWITCHES: [&str; 8] = [
    "find-unused-expressions",
    "find-unused-parameters",
    "check-missing-override",
    "check-missing-type-hints",
    "check-throws",
    "allow-possibly-undefined-array-keys",
    "strict-list-index-checks",
    "check-property-initialization",
];

/// What the editor's PHP Analysis settings show for a `mago.toml`'s text: the PHP version it sets and the one
/// `composer.json` gives, the analyzer's switches (each with its value in the file, if any, and its default), its
/// excludes and ignored codes, the linter's excludes, and every linter rule that applies to the configured PHP
/// version and integrations, with Mago's own name, description, and category, whether it's on, and its level.
pub fn describe(text: &str, root: &Path) -> Result<serde_json::Value, String> {
    use serde_json::json;
    let file: File = toml::from_str(text).map_err(|e| format!("mago.toml: {}", e.message()))?;
    let composer = crate::server::composer_php_version(root);
    let version = file.php_version.as_deref().and_then(crate::server::parse_php_version).or(composer).unwrap_or(PHPVersion::PHP84);
    let defaults = crate::analysis::settings(version);
    let a = &file.analyzer;
    let values = [
        (a.find_unused_expressions, defaults.find_unused_expressions),
        (a.find_unused_parameters, defaults.find_unused_parameters),
        (a.check_missing_override, defaults.check_missing_override),
        (a.check_missing_type_hints, defaults.check_missing_type_hints),
        (a.check_throws, defaults.check_throws),
        (a.allow_possibly_undefined_array_keys, defaults.allow_possibly_undefined_array_keys),
        (a.strict_list_index_checks, defaults.strict_list_index_checks),
        (a.check_property_initialization, defaults.check_property_initialization),
    ];
    let analyzer: Vec<_> = ANALYZER_SWITCHES.iter().zip(values).map(|(key, (value, default))| json!({ "key": key, "value": value, "default": default })).collect();
    let mut integrations = IntegrationSet::empty();
    for i in &file.linter.integrations {
        integrations.insert(*i);
    }
    let settings = mago_linter::settings::Settings { php_version: version, integrations, rules: file.linter.rules, glob: Default::default() };
    let configured = mago_linter::rule::filter_rules_settings(&settings.rules, version, integrations);
    let registry = mago_linter::registry::RuleRegistry::build(&settings, None, true);
    let mut rules: Vec<_> = registry
        .rules()
        .iter()
        .filter_map(|rule| {
            let meta = rule.meta();
            let current = configured.get(meta.code)?;
            let level = |l: String| l.to_lowercase();
            Some(json!({
                "code": meta.code,
                "name": meta.name,
                "description": meta.description.trim(),
                "category": meta.category.as_str(),
                "enabled": current.get("enabled").and_then(|e| e.as_bool()).unwrap_or(rule.default_enabled()),
                "level": current.get("level").and_then(|l| l.as_str()).map(|l| level(l.to_string())).unwrap_or_else(|| level(rule.default_level().to_string())),
                "defaultEnabled": rule.default_enabled(),
                "defaultLevel": level(rule.default_level().to_string()),
            }))
        })
        .collect();
    rules.sort_by(|a, b| a["code"].as_str().cmp(&b["code"].as_str()));
    Ok(json!({
        "phpVersion": file.php_version,
        "composerPhpVersion": composer.map(|v| format!("{}.{}", v.major(), v.minor())),
        "analyzer": analyzer,
        "analyzerExcludes": file.analyzer.excludes,
        "ignore": file.analyzer.ignore,
        "linterExcludes": file.linter.excludes,
        "integrations": file.linter.integrations.iter().map(|i| i.to_string().to_lowercase()).collect::<Vec<_>>(),
        "rules": rules,
    }))
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
    fn describes_rules_and_switches_for_the_settings_page() {
        let d = describe(BUNDLED, Path::new("/nonexistent")).unwrap();
        let rules = d["rules"].as_array().unwrap();
        let rule = |code: &str| rules.iter().find(|r| r["code"] == code).cloned();
        let strict = rule("strict-types").unwrap();
        assert_eq!((strict["enabled"].as_bool(), strict["defaultEnabled"].as_bool()), (Some(false), Some(true)));
        assert!(!strict["description"].as_str().unwrap().is_empty());
        assert_eq!(rule("no-empty").unwrap()["level"], "warning");
        // Laravel's rules apply, Symfony's don't.
        assert!(rules.iter().any(|r| r["code"].as_str().unwrap().contains("eloquent") || r["code"] == "middleware-in-routes"));
        assert!(d["analyzer"].as_array().unwrap().iter().any(|a| a["key"] == "check-throws" && a["value"].is_null()));
        let d = describe("php-version = \"8.2.0\"\n[analyzer]\ncheck-throws = true\nignore = [\"mixed-assignment\"]\n", Path::new("/p")).unwrap();
        assert_eq!(d["phpVersion"], "8.2.0");
        assert!(d["analyzer"].as_array().unwrap().iter().any(|a| a["key"] == "check-throws" && a["value"] == true));
        assert_eq!(d["ignore"], serde_json::json!(["mixed-assignment"]));
        assert!(describe("[linter\n", Path::new("/p")).is_err());
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
