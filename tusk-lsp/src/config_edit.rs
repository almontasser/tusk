//! Edits a TOML file in place, keeping its comments, key order, and every key it doesn't touch. The editor's settings
//! pages write `mago.toml` and `_typos.toml` through it.

use serde::Deserialize;
use serde_json::Value;
use toml_edit::{DocumentMut, InlineTable, Item, Table, TableLike};

/// Sets the value at `path`, such as `["linter", "rules", "no-empty", "enabled"]`, or removes it when `value` is null.
/// Removing the last key of a table removes the table too.
#[derive(Debug, Deserialize)]
pub struct Edit {
    pub path: Vec<String>,
    #[serde(default)]
    pub value: Option<Value>,
    /// Write a table this edit creates for the value's parent inline, as `no-empty = { enabled = false }`.
    #[serde(default)]
    pub inline: bool,
}

/// Applies `edits` to a TOML document's text.
pub fn edit(text: &str, edits: &[Edit]) -> Result<String, String> {
    let mut doc: DocumentMut = text.parse().map_err(|e: toml_edit::TomlError| e.to_string().trim().to_string())?;
    for e in edits {
        if e.path.is_empty() {
            return Err("an edit needs a key".into());
        }
        apply(doc.as_table_mut(), &e.path, e.value.as_ref(), e.inline, true)?;
    }
    Ok(doc.to_string())
}

fn apply(table: &mut dyn TableLike, path: &[String], value: Option<&Value>, inline: bool, root: bool) -> Result<(), String> {
    let (key, rest) = path.split_first().expect("a non-empty path");
    if rest.is_empty() {
        match value {
            None => {
                table.remove(key);
            }
            Some(v) => {
                let mut new = to_toml(v)?;
                match table.get_mut(key) {
                    Some(Item::Value(old)) => {
                        // Keep the comment after the value, and the spacing around it.
                        *new.decor_mut() = old.decor().clone();
                        *old = new;
                    }
                    _ => {
                        table.insert(key, Item::Value(new));
                    }
                }
            }
        }
        return Ok(());
    }
    if table.get(key).is_none() {
        if value.is_none() {
            return Ok(());
        }
        let item = if inline && rest.len() == 1 && !root {
            Item::Value(toml_edit::Value::InlineTable(InlineTable::new()))
        } else {
            let mut t = Table::new();
            // A table that holds only other tables needs no header of its own.
            t.set_implicit(true);
            Item::Table(t)
        };
        table.insert(key, item);
    }
    let child = table.get_mut(key).and_then(Item::as_table_like_mut).ok_or_else(|| format!("`{key}` isn't a table"))?;
    apply(child, rest, value, inline, false)?;
    if value.is_none() && child.is_empty() {
        table.remove(key);
    }
    Ok(())
}

fn to_toml(v: &Value) -> Result<toml_edit::Value, String> {
    Ok(match v {
        Value::Bool(b) => (*b).into(),
        Value::Number(n) => match n.as_i64() {
            Some(i) => i.into(),
            None => n.as_f64().ok_or("an invalid number")?.into(),
        },
        Value::String(s) => s.as_str().into(),
        Value::Array(items) => {
            let mut array = toml_edit::Array::new();
            for item in items {
                array.push(to_toml(item)?);
            }
            toml_edit::Value::Array(array)
        }
        Value::Object(map) => {
            let mut t = InlineTable::new();
            for (k, item) in map {
                t.insert(k, to_toml(item)?);
            }
            toml_edit::Value::InlineTable(t)
        }
        Value::Null => return Err("null can only remove a key".into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn e(path: &[&str], value: Value) -> Edit {
        Edit { path: path.iter().map(|s| s.to_string()).collect(), value: (!value.is_null()).then_some(value), inline: false }
    }

    #[test]
    fn keeps_comments_and_other_keys() {
        let text = "# The project's rules.\n[linter]\nintegrations = [\"laravel\"] # Laravel\n\n[linter.rules]\n# Too noisy.\nstrict-types = { enabled = false }\nno-empty = { level = \"warning\" }\n\n[formatter]\nprint-width = 120\n";
        let mut enable = e(&["linter", "rules", "strict-types", "enabled"], json!(true));
        enable.inline = true;
        let mut new = e(&["linter", "rules", "no-isset", "enabled"], json!(false));
        new.inline = true;
        let out = edit(text, &[enable, new, e(&["linter", "rules", "no-empty", "level"], Value::Null)]).unwrap();
        assert_eq!(
            out,
            "# The project's rules.\n[linter]\nintegrations = [\"laravel\"] # Laravel\n\n[linter.rules]\n# Too noisy.\nstrict-types = { enabled = true }\nno-isset = { enabled = false }\n\n[formatter]\nprint-width = 120\n"
        );
    }

    #[test]
    fn creates_tables_and_words() {
        let out = edit("", &[e(&["default", "extend-words", "teh"], json!("teh")), e(&["php-version", ], json!("8.3"))]).unwrap();
        assert_eq!(out, "php-version = \"8.3\"\n\n[default.extend-words]\nteh = \"teh\"\n");
        let out = edit(&out, &[e(&["default", "extend-words", "teh"], Value::Null)]).unwrap();
        assert_eq!(out, "php-version = \"8.3\"\n");
        let out = edit("[analyzer]\nexcludes = [\"a\"]\n", &[e(&["analyzer", "excludes"], json!(["a", "b"])), e(&["analyzer", "check-throws"], json!(true))]).unwrap();
        assert_eq!(out, "[analyzer]\nexcludes = [\"a\", \"b\"]\ncheck-throws = true\n");
    }

    #[test]
    fn refuses_bad_files_and_paths() {
        assert!(edit("[linter\n", &[]).is_err());
        assert!(edit("linter = 1\n", &[e(&["linter", "rules"], json!(1))]).unwrap_err().contains("isn't a table"));
    }
}
