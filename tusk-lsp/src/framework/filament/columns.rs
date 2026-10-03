//! Table columns and infolist entries named after attributes and relationships: hover on a relationship in
//! `TextColumn::make('author.name')`, and problems with `->searchable()` and `->sortable()` on a name the query
//! can't search or sort by, such as an accessor, since Filament puts the name in SQL.

use lsp_types::{Diagnostic, DiagnosticSeverity, Hover, HoverContents, MarkupContent, MarkupKind, NumberOrString};
use mago_span::HasSpan;
use mago_syntax::cst::{Argument, Expression, Literal, Node};
use serde_json::Value;

use super::closures::walk;
use super::{context, relation, relationship_name, short, string_arg_at, strings};
use crate::features::Ctx;

/// Hover on a relationship name in `->relationship('author')` or `make('author.name')`: its type and related model.
pub fn hover(ctx: &Ctx<'_>, offset: u32) -> Option<Hover> {
    let arg = string_arg_at(ctx, offset)?;
    let (start, end, name) = relationship_name(&arg)?;
    if !(start <= offset && offset <= end) {
        return None;
    }
    let context = context(ctx)?;
    let model = &context["model"];
    let r = relation(model, &name)?;
    let related = r["related"].as_str().unwrap_or_default();
    let mut value = format!("**{name}()** · {} `{}` of `{}`", r["type"].as_str().unwrap_or("relationship"), short(related), short(model["class"].as_str().unwrap_or_default()));
    let columns = strings(&r["columns"]);
    if !columns.is_empty() && r["columnsGuessed"] == false {
        value.push_str(&format!("\n\nColumns: {}", columns.iter().map(|c| format!("`{c}`")).collect::<Vec<_>>().join(", ")));
    }
    Some(Hover { contents: HoverContents::Markup(MarkupContent { kind: MarkupKind::Markdown, value }), range: Some(ctx.doc.range(start, end)) })
}

/// Code that changes a table's query, so that it can select names that aren't columns, such as `withCount()`.
const QUERY_CHANGES: &[&str] = &[
    "->query(",
    "modifyQueryUsing",
    "getEloquentQuery",
    "getTableQuery",
    "select(",
    "selectRaw",
    "addSelect",
    "selectSub",
    "join(",
    "withCount",
    "withSum",
    "withAvg",
    "withMin",
    "withMax",
    "withExists",
    "withAggregate",
];

/// Column methods that make its state an aggregate of a relationship, which Filament selects itself.
const AGGREGATES: &[&str] = &["counts", "exists", "avg", "sum", "min", "max"];

/// `->searchable()` and `->sortable()` on a table column whose name isn't one of its table's columns, when the
/// database told the columns: Filament adds the name to the query's `where` or `orderBy`, which fails.
pub fn diagnostics(ctx: &Ctx<'_>) -> Vec<Diagnostic> {
    let text = ctx.parsed.text();
    if !text.contains("searchable(") && !text.contains("sortable(") {
        return vec![];
    }
    // A table whose query the file or its resource changes can select other names.
    if QUERY_CHANGES.iter().any(|q| text.contains(q)) {
        return vec![];
    }
    let mut found = vec![];
    walk(&ctx.parsed, |node, ancestors| {
        let Node::StaticMethodCall(make) = node else { return };
        if &text[make.method.span().start.offset as usize..make.method.span().end.offset as usize] != "make" {
            return;
        }
        let Expression::Identifier(id) = make.class else { return };
        let class = ctx.parsed.names.resolve(&id.span()).map(|n| String::from_utf8_lossy(n).into_owned()).unwrap_or_default();
        if !ctx.index.codebase.is_instance_of(class.as_bytes(), b"Filament\\Tables\\Columns\\Column") {
            return;
        }
        let Some(Argument::Positional(first)) = make.argument_list.arguments.iter().next() else { return };
        let Expression::Literal(Literal::String(s)) = first.value else { return };
        let name = text[s.span.start.offset as usize + 1..s.span.end.offset as usize - 1].to_string();
        // The calls after `make()`.
        let mut calls = vec![];
        let mut current = node.span();
        for n in ancestors.iter().rev() {
            match n {
                Node::MethodCall(m) if m.object.span() == current => {
                    calls.push(*m);
                    current = m.span();
                }
                n if n.span() == current => {}
                _ => break,
            }
        }
        let method = |m: &mago_syntax::cst::MethodCall<'_>| text[m.method.span().start.offset as usize..m.method.span().end.offset as usize].to_string();
        if calls.iter().any(|m| AGGREGATES.contains(&method(m).as_str())) {
            return;
        }
        for m in &calls {
            let which = method(m);
            if which != "searchable" && which != "sortable" {
                continue;
            }
            // Only flags such as `isIndividual: true`: columns, or a query, say what to use.
            let flags = m.argument_list.arguments.iter().all(|a| {
                let value = match a {
                    Argument::Positional(p) => p.value,
                    Argument::Named(n) => n.value,
                };
                matches!(value, Expression::Literal(Literal::True(_) | Literal::False(_)))
            });
            let off = m.argument_list.arguments.iter().any(|a| matches!(a, Argument::Positional(p) if matches!(p.value, Expression::Literal(Literal::False(_)))));
            if flags && !off {
                found.push((which, name.clone(), s.span.start.offset + 1, s.span.end.offset - 1));
            }
        }
    });
    if found.is_empty() {
        return vec![];
    }
    let Some(context) = context(ctx) else { return vec![] };
    // Its resource and pages can change the query too, as a list page's `getTableQuery()` does.
    let files = std::iter::once(&context["resource"]).chain(context["pages"].as_array().into_iter().flatten());
    if files.filter_map(|f| f["file"].as_str()).filter_map(|f| ctx.snap.read(std::path::Path::new(f))).any(|t| QUERY_CHANGES.iter().any(|q| t.contains(q))) {
        return vec![];
    }
    let model = &context["model"];
    found
        .into_iter()
        .filter_map(|(which, name, start, end)| {
            let (table_of, column) = missing(model, &name)?;
            let verb = if which == "searchable" { "searching" } else { "sorting" };
            let clause = if which == "searchable" { "`where`" } else { "`orderBy`" };
            Some(Diagnostic {
                range: ctx.doc.range(start, end),
                severity: Some(DiagnosticSeverity::WARNING),
                code: Some(NumberOrString::String("filament-virtual-column".into())),
                source: Some("filament".into()),
                message: format!(
                    "`{column}` isn't a column of {table_of}, so {verb} by it fails: Filament puts it in the query's {clause}. Pass the columns to use, as `{which}(['…'])`, or a query."
                ),
                ..Default::default()
            })
        })
        .collect()
}

/// The model a column name is missing from and the missing name, if the database surely lacks it: a plain name
/// that isn't a column or relationship, or `relationship.name` whose related model lacks the column.
fn missing(model: &Value, name: &str) -> Option<(String, String)> {
    let aggregate = |n: &str| ["_count", "_exists", "_sum", "_avg", "_min", "_max"].iter().any(|s| n.contains(s));
    match name.split('.').collect::<Vec<_>>().as_slice() {
        [column] => {
            if model["columnsGuessed"] != false || strings(&model["columns"]).iter().any(|c| c == column) || relation(model, column).is_some() || aggregate(column) {
                return None;
            }
            Some((format!("`{}`", short(model["class"].as_str()?)), column.to_string()))
        }
        [first, column] => {
            let r = relation(model, first)?;
            if r["columnsGuessed"] != false || strings(&r["columns"]).iter().any(|c| c == column) || aggregate(column) {
                return None;
            }
            Some((format!("`{}` (`{first}`)", short(r["related"].as_str()?)), column.to_string()))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::with_ctx;
    use crate::testing::{Fixture, ROOT, uri};
    use serde_json::json;

    const COLUMNS: &str = "<?php\nnamespace Filament\\Tables\\Columns;\nclass Column {\n    public static function make(string $name): static { return new static; }\n    public function sortable($condition = true, ?array $columns = null, $query = null): static { return $this; }\n    public function searchable($condition = true, $columns = null, $query = null, bool $isIndividual = false): static { return $this; }\n    public function counts($relationships): static { return $this; }\n}\nclass TextColumn extends Column {}\n";
    const TABLE: &str = "app/Filament/Resources/Posts/Tables/PostsTable.php";

    fn context(guessed: bool) -> Value {
        json!({
            "resource": {"class": "App\\Filament\\Resources\\Posts\\PostResource", "file": format!("{ROOT}/app/Filament/Resources/Posts/PostResource.php"), "line": 4},
            "model": {
                "class": "App\\Models\\Post", "columns": ["id", "title", "author_id"], "columnsGuessed": guessed, "casts": {},
                "relations": [{"name": "author", "type": "BelongsTo", "related": "App\\Models\\User", "columns": ["id", "name"], "columnsGuessed": guessed, "relations": []}],
            },
            "pages": [],
        })
    }

    fn fixture(columns: &str, guessed: bool) -> Fixture {
        let table = format!("<?php\nnamespace App\\Filament\\Resources\\Posts\\Tables;\nuse Filament\\Tables\\Columns\\TextColumn;\nclass PostsTable\n{{\n    public static function configure($table)\n    {{\n        return $table->columns([\n            {columns}\n        ]);\n    }}\n}}\n");
        let fx = Fixture::new(&[
            ("vendor/columns.php", COLUMNS),
            ("app/Filament/Resources/Posts/PostResource.php", "<?php\nnamespace App\\Filament\\Resources\\Posts;\nclass PostResource extends \\Filament\\Resources\\Resource {}\n"),
            (TABLE, &table),
        ]);
        fx.snap.framework.seed("filament:active", Value::Bool(true));
        fx.snap.framework.seed("filament:resource|App\\Filament\\Resources\\Posts\\PostResource|App\\Filament\\Resources\\Posts\\Tables\\PostsTable", context(guessed));
        fx
    }

    fn problems(columns: &str, guessed: bool) -> Vec<String> {
        let fx = fixture(columns, guessed);
        with_ctx(&fx.snap, &uri(TABLE), diagnostics).unwrap().into_iter().map(|d| d.message).collect()
    }

    #[test]
    fn reports_searching_and_sorting_by_names_that_arent_columns() {
        let found = problems("TextColumn::make('excerpt')->sortable(), TextColumn::make('author.email')->searchable(isIndividual: true), TextColumn::make('title')->sortable()->searchable()", false);
        assert_eq!(
            found,
            vec![
                "`excerpt` isn't a column of `Post`, so sorting by it fails: Filament puts it in the query's `orderBy`. Pass the columns to use, as `sortable(['…'])`, or a query.",
                "`email` isn't a column of `User` (`author`), so searching by it fails: Filament puts it in the query's `where`. Pass the columns to use, as `searchable(['…'])`, or a query.",
            ]
        );
        // Columns given, a query, an aggregate, a relationship, `false`, or columns guessed without the database.
        for ok in [
            "TextColumn::make('excerpt')->sortable(['title'])",
            "TextColumn::make('excerpt')->searchable(query: fn ($q) => $q)",
            "TextColumn::make('comments_count')->sortable()",
            "TextColumn::make('comments')->counts('comments')->sortable()",
            "TextColumn::make('author')->sortable()",
            "TextColumn::make('excerpt')->sortable(false)",
            "TextColumn::make('meta.title')->sortable()",
        ] {
            assert!(problems(ok, false).is_empty(), "{ok}");
        }
        assert!(problems("TextColumn::make('excerpt')->sortable()", true).is_empty());
        // A table whose query changes may select it.
        assert!(problems("TextColumn::make('excerpt')->sortable()]); $table->modifyQueryUsing(fn ($q) => $q->selectRaw('1 as excerpt')); ([", false).is_empty());
    }

    #[test]
    fn hovers_relationships_in_column_names() {
        let fx = fixture("TextColumn::make('author.name')", false);
        let text = fx.doc(TABLE).text.clone();
        let at = text.find("author.name").unwrap() as u32 + 2;
        let shown = with_ctx(&fx.snap, &uri(TABLE), |ctx| hover(ctx, at)).flatten().expect("a hover");
        let HoverContents::Markup(m) = shown.contents else { panic!() };
        assert_eq!(m.value, "**author()** · BelongsTo `User` of `Post`\n\nColumns: `id`, `name`");
    }
}
