<?php

/*
 * A language server for Filament. It understands the strings Filament resolves against
 * Eloquent models, which general PHP servers can't:
 *
 *   TextInput::make('title')                 field and column names
 *   TextColumn::make('author.name')          relationship paths
 *   Select::make('author_id')
 *       ->relationship('author', 'name')     relationship names and related columns
 *   Select::make('status')
 *       ->options(Status::class)             the enum the model casts the field to
 *       ->default('draft')                   the field's option values
 *   $get('status')                           the form's field names (state paths)
 *
 * It offers completion, go to definition, diagnostics for unknown relationships, and
 * code lenses that link resources, pages, relation managers, and models.
 *
 * Run it in the project root: php server.php. It speaks LSP over standard input and output.
 * Project classes are read by introspect.php in a separate process (see there).
 */

declare(strict_types=1);

const INTROSPECT = __DIR__ . '/introspect.php';

$root = getcwd();
/** @var array<string, string> Open documents by URI. */
$documents = [];
/** @var array<string, array> Introspection results, cleared whenever a file is saved. */
$cache = [];

// ---- Transport ----

function readMessage(): ?array
{
    $length = null;
    while (($line = fgets(STDIN)) !== false) {
        $line = rtrim($line, "\r\n");
        if ($line === '') {
            break;
        }
        if (stripos($line, 'Content-Length:') === 0) {
            $length = (int) trim(substr($line, 15));
        }
    }
    if ($line === false || $length === null) {
        return null;
    }
    $body = '';
    while (strlen($body) < $length && !feof(STDIN)) {
        $body .= fread(STDIN, $length - strlen($body));
    }
    return json_decode($body, true);
}

function send(array $message): void
{
    $json = json_encode(['jsonrpc' => '2.0'] + $message, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    fwrite(STDOUT, 'Content-Length: ' . strlen($json) . "\r\n\r\n" . $json);
    fflush(STDOUT);
}

// ---- Paths and positions ----

function uriToPath(string $uri): string
{
    return rawurldecode(preg_replace('#^file://#', '', $uri));
}

function pathToUri(string $path): string
{
    return 'file://' . implode('/', array_map('rawurlencode', explode('/', $path)));
}

/** Length of a UTF-8 string in UTF-16 code units, which LSP positions count. */
function utf16Length(string $s): int
{
    return preg_match_all('/./us', $s) + preg_match_all('/[\x{10000}-\x{10FFFF}]/u', $s);
}

/** Byte offset in `$line` of an LSP character position. */
function byteOffset(string $line, int $character): int
{
    $units = 0;
    $bytes = 0;
    foreach (preg_split('//u', $line, -1, PREG_SPLIT_NO_EMPTY) as $ch) {
        if ($units >= $character) {
            break;
        }
        $units += strlen($ch) === 4 ? 2 : 1;
        $bytes += strlen($ch);
    }
    return $bytes;
}

function lspRange(int $line, int $start, int $end): array
{
    return ['start' => ['line' => $line, 'character' => $start], 'end' => ['line' => $line, 'character' => $end]];
}

// ---- Project context ----

function classOf(string $source): ?string
{
    if (preg_match('/^namespace\s+([^;]+);/m', $source, $ns) && preg_match('/^\s*(?:final\s+|abstract\s+|readonly\s+)*class\s+(\w+)/m', $source, $cls)) {
        return $ns[1] . '\\' . $cls[1];
    }
    return null;
}

/** 0-based line of the class declaration. */
function classLine(string $source): int
{
    foreach (explode("\n", $source) as $i => $line) {
        if (preg_match('/^\s*(?:final\s+|abstract\s+|readonly\s+)*class\s+\w+/', $line)) {
            return $i;
        }
    }
    return 0;
}

function introspect(string ...$args): array
{
    global $root, $cache;
    $key = implode('|', $args);
    if (!isset($cache[$key])) {
        $command = [PHP_BINARY, INTROSPECT, $root, ...$args];
        $output = shell_exec(implode(' ', array_map('escapeshellarg', $command)) . ' 2>/dev/null');
        $cache[$key] = json_decode((string) $output, true) ?: ['error' => 'introspection failed'];
    }
    return $cache[$key];
}

/**
 * The resource a file belongs to: the file itself if it's a resource, otherwise the first
 * `*Resource.php` in its folder or a parent folder (Filament 4 keeps pages, schemas, tables,
 * and relation managers in subfolders of the resource's folder).
 */
function resourceFile(string $path, string $source): ?string
{
    global $root;
    if (preg_match('/class\s+\w+\s+extends\s+Resource\b/', $source)) {
        return $path;
    }
    for ($dir = dirname($path); str_starts_with($dir, $root . '/app/'); $dir = dirname($dir)) {
        foreach (glob($dir . '/*Resource.php') ?: [] as $file) {
            return $file;
        }
    }
    return null;
}

/** Introspection for the resource that `$path` belongs to, or null outside Filament resources. */
function context(string $path, string $source): ?array
{
    $file = resourceFile($path, $source);
    $resource = $file ? classOf((string) file_get_contents($file)) : null;
    if (!$resource) {
        return null;
    }
    $data = introspect('resource', $resource, classOf($source) ?? '');
    return isset($data['error']) ? null : $data;
}

function relation(?array $model, string $name): ?array
{
    foreach ($model['relations'] ?? [] as $relation) {
        if ($relation['name'] === $name) {
            return $relation;
        }
    }
    return null;
}

/** A class name as written in `$source`, resolved through its `use` statements and namespace. */
function resolveClass(string $source, string $name): string
{
    if ($name[0] === '\\') {
        return substr($name, 1);
    }
    $quoted = preg_quote($name, '/');
    if (preg_match("/^use\\s+([\\w\\\\]+\\\\$quoted)\\s*;/m", $source, $use) || preg_match("/^use\\s+([\\w\\\\]+)\\s+as\\s+$quoted\\s*;/m", $source, $use)) {
        return $use[1];
    }
    return preg_match('/^namespace\s+([^;]+);/m', $source, $ns) ? "$ns[1]\\$name" : $name;
}

/** How to write a class in `$source`: its short name when imported or in the same namespace, otherwise fully qualified. */
function classReference(string $source, string $class): string
{
    $short = substr($class, (int) strrpos("\\$class", '\\'));
    return resolveClass($source, $short) === $class ? $short : "\\$class";
}

/**
 * The field whose method chain contains byte `$offset`: `Select::make('status')` up to the next
 * field or the end of the statement. ponytail: a `;` inside a closure in the chain ends it early.
 */
function fieldAt(string $source, int $offset): ?array
{
    if (!preg_match_all('/\b(\w+)::make\(\s*[\'"]([\w.]+)[\'"]/', substr($source, 0, $offset), $all, PREG_OFFSET_CAPTURE | PREG_SET_ORDER)) {
        return null;
    }
    $make = end($all);
    $rest = substr($source, $make[0][1]);
    $end = preg_match('/::make\(|;/', $rest, $next, PREG_OFFSET_CAPTURE, strlen($make[0][0])) ? $next[0][1] : strlen($rest);
    return $make[0][1] + $end < $offset ? null : ['name' => $make[2][0], 'chain' => substr($rest, 0, $end)];
}

/** The field's enum: from `->options(X::class)` or `->enum(X::class)`, or else the model's cast of the field. */
function fieldEnum(string $path, string $source, array $field): ?string
{
    if (preg_match('/->(?:options|enum)\(\s*([\\\\\w]+)::class/', $field['chain'], $m)) {
        return resolveClass($source, $m[1]);
    }
    $cast = context($path, $source)['model']['casts'][$field['name']] ?? null;
    return is_string($cast) && !isset(introspect('enum', $cast)['error']) ? $cast : null;
}

/** Completion for option values and state paths, or null when the cursor isn't in one. */
function valueCompletion(string $path, string $source, int $offset, array $position): ?array
{
    $prefix = substr($source, 0, $offset);
    $item = fn(string $label, int $kind, string $detail, string $typed) => [
        'label' => $label, 'kind' => $kind, 'detail' => $detail,
        'textEdit' => ['range' => lspRange($position['line'], $position['character'] - utf16Length($typed), $position['character']), 'newText' => $label],
    ];

    // $get('…') and $set('…') in a form: the names of its fields.
    if (preg_match('/\$(?:get|set)\(\s*[\'"]([\w.]*)$/', $prefix, $m)) {
        preg_match_all('/::make\(\s*[\'"]([\w.]+)[\'"]/', $source, $names);
        return array_map(fn($n) => $item($n, 5, 'field', $m[1]), array_values(array_unique($names[1])));
    }
    if (!preg_match('/->(default|options|enum)\(\s*([\'"]?)([\w\\\\:]*)$/', $prefix, $m) || !($field = fieldAt($source, $offset))) {
        return null;
    }
    [, $method, $quote, $typed] = $m;
    $enum = fieldEnum($path, $source, $field);

    // ->options( and ->enum(: the enum the model casts the field to.
    if ($method !== 'default') {
        return $enum && !$quote ? [$item(classReference($source, $enum) . '::class', 13, "cast of {$field['name']}", $typed)] : [];
    }
    if ($enum) {
        $cases = introspect('enum', $enum);
        $class = classReference($source, $enum);
        return $quote
            ? array_map(fn($c) => $item((string) $c['value'], 20, "$class::{$c['name']}", $typed), array_filter($cases, fn($c) => $c['value'] !== null))
            : array_map(fn($c) => $item("$class::{$c['name']}", 20, $c['value'] === null ? 'case' : "= {$c['value']}", $typed), $cases);
    }
    // Keys of a literal options array.
    if ($quote && preg_match('/->options\(\s*\[(.*?)\]\s*\)/s', $field['chain'], $options)) {
        preg_match_all('/[\'"]([^\'"]+)[\'"]\s*=>\s*(?:[\'"]([^\'"]*)[\'"])?/', $options[1], $keys, PREG_SET_ORDER);
        return array_map(fn($k) => $item($k[1], 20, $k[2] ?? 'option', $typed), $keys);
    }
    return [];
}

// ---- Features ----

/** Completion items for the string being typed at the cursor. */
function completion(string $path, string $source, array $position): array
{
    $lines = explode("\n", $source);
    $line = $lines[$position['line']] ?? '';
    $prefix = substr($line, 0, byteOffset($line, $position['character']));
    $offset = strlen(implode("\n", array_slice($lines, 0, $position['line']))) + ($position['line'] ? 1 : 0) + strlen($prefix);
    $values = valueCompletion($path, $source, $offset, $position);
    if ($values !== null) {
        return array_values($values);
    }

    $patterns = [
        'relatedColumn' => '/->relationship\(\s*[\'"](\w+)[\'"]\s*,\s*[\'"](\w*)$/',
        'relationship' => '/->relationship\(\s*[\'"](\w*)$/',
        'field' => '/::make\(\s*[\'"]([\w.]*)$/',
    ];
    foreach ($patterns as $kind => $pattern) {
        if (preg_match($pattern, $prefix, $m)) {
            break;
        }
        $kind = null;
    }
    if (!$kind || !($ctx = context($path, $source)) || !($model = $ctx['model'])) {
        return [];
    }

    $typed = end($m);
    $word = substr($typed, (int) strrpos('.' . $typed, '.'));
    $edit = lspRange($position['line'], $position['character'] - utf16Length($word), $position['character']);
    $columnItems = fn(array $columns, string $of) => array_map(fn($c) => ['label' => $c, 'kind' => 5, 'detail' => "column of $of", 'textEdit' => ['range' => $edit, 'newText' => $c], 'sortText' => "1$c"], $columns);
    $relationItems = fn(array $relations) => array_map(fn($r) => [
        'label' => is_array($r) ? $r['name'] : $r,
        'kind' => 18,
        'detail' => is_array($r) ? "{$r['type']} {$r['related']}" : 'relationship',
        'textEdit' => ['range' => $edit, 'newText' => is_array($r) ? $r['name'] : $r],
        'sortText' => '0' . (is_array($r) ? $r['name'] : $r),
    ], $relations);

    if ($kind === 'relationship') {
        return $relationItems($model['relations']);
    }
    if ($kind === 'relatedColumn') {
        $related = relation($model, $m[1]);
        return $related ? $columnItems($related['columns'], $related['related']) : [];
    }
    // A field name: columns and relationships, or the related model's after a dot.
    $segments = explode('.', $typed);
    if (count($segments) === 1) {
        return [...$relationItems($model['relations']), ...$columnItems($model['columns'], $model['class'])];
    }
    $related = relation($model, $segments[0]);
    return $related && count($segments) === 2 ? [...$relationItems($related['relations']), ...$columnItems($related['columns'], $related['related'])] : [];
}

/**
 * Relationship names written in strings: `->relationship('name')` and the first segment of
 * dotted `::make('name.column')`. Yields [line, start, end, name] with UTF-16 positions.
 */
function relationshipStrings(string $source): Generator
{
    $pattern = '/(?:->relationship\(\s*|::make\(\s*)([\'"])(\w+)(?=\.|\1)/';
    foreach (explode("\n", $source) as $i => $line) {
        if (!preg_match_all($pattern, $line, $matches, PREG_OFFSET_CAPTURE | PREG_SET_ORDER)) {
            continue;
        }
        foreach ($matches as $m) {
            $isMake = str_contains($m[0][0], '::make');
            $dotted = substr($line, $m[2][1] + strlen($m[2][0]), 1) === '.';
            if ($isMake && !$dotted) {
                continue; // A plain field name, which may be a column.
            }
            $start = utf16Length(substr($line, 0, $m[2][1]));
            yield [$i, $start, $start + utf16Length($m[2][0]), $m[2][0]];
        }
    }
}

function definition(string $path, string $source, array $position): ?array
{
    foreach (relationshipStrings($source) as [$line, $start, $end, $name]) {
        if ($line === $position['line'] && $position['character'] >= $start && $position['character'] <= $end) {
            $relation = relation(context($path, $source)['model'] ?? null, $name);
            return $relation ? ['uri' => pathToUri($relation['file']), 'range' => lspRange($relation['line'] - 1, 0, 0)] : null;
        }
    }
    return null;
}

function diagnostics(string $path, string $source): array
{
    $ctx = context($path, $source);
    if (!($model = $ctx['model'] ?? null)) {
        return [];
    }
    $found = [];
    foreach (relationshipStrings($source) as [$line, $start, $end, $name]) {
        if (!relation($model, $name)) {
            $found[] = [
                'range' => lspRange($line, $start, $end),
                'severity' => 2,
                'source' => 'filament',
                'message' => "{$model['class']} has no relationship method $name().",
            ];
        }
    }
    return $found;
}

function lens(int $line, string $title, ?string $file, int $target = 1): ?array
{
    return $file ? ['range' => lspRange($line, 0, 0), 'command' => ['title' => $title, 'command' => 'phpEditor.open', 'arguments' => [pathToUri($file), $target]]] : null;
}

function codeLenses(string $path, string $source): array
{
    $class = classOf($source);
    $line = classLine($source);
    $short = fn(string $fqcn) => substr($fqcn, (int) strrpos($fqcn, '\\') + 1);

    // A model links to its resources.
    if ($class && preg_match('/class\s+\w+\s+extends\s+(?:\\\\?Illuminate\\\\Database\\\\Eloquent\\\\)?(?:Model|Authenticatable|Pivot)\b/', $source)) {
        $resources = introspect('resources')[$class] ?? [];
        return array_values(array_filter(array_map(fn($r) => lens($line, 'Filament: ' . $short($r['class']), $r['file'], $r['line']), $resources)));
    }

    $ctx = context($path, $source);
    if (!$ctx) {
        return [];
    }
    $isResource = $ctx['resource']['file'] === $path;
    if (!$isResource) {
        return [lens($line, 'Resource: ' . $short($ctx['resource']['class']), $ctx['resource']['file'], $ctx['resource']['line'])];
    }
    $lenses = [lens($line, 'Model: ' . $short($ctx['resourceModel']), $ctx['model']['file'] ?? null, $ctx['model']['line'] ?? 1)];
    foreach ($ctx['pages'] as $page) {
        $lenses[] = lens($line, $short($page['class']), $page['file'], $page['line']);
    }
    foreach ($ctx['relationManagers'] as $manager) {
        $lenses[] = lens($line, $short($manager['class']), $manager['file'], $manager['line']);
    }
    return array_values(array_filter($lenses));
}

function publishDiagnostics(string $uri): void
{
    global $documents;
    send(['method' => 'textDocument/publishDiagnostics', 'params' => ['uri' => $uri, 'diagnostics' => diagnostics(uriToPath($uri), $documents[$uri])]]);
}

// ---- Main loop ----

if (PHP_SAPI !== 'cli' || realpath($_SERVER['SCRIPT_FILENAME'] ?? '') !== __FILE__) {
    return; // Included by the tests.
}

while (($message = readMessage()) !== null) {
    $method = $message['method'] ?? null;
    $params = $message['params'] ?? [];
    $uri = $params['textDocument']['uri'] ?? null;
    $path = $uri ? uriToPath($uri) : '';
    $result = null;
    try {
        switch ($method) {
            case 'initialize':
                $result = ['capabilities' => [
                    'textDocumentSync' => ['openClose' => true, 'change' => 1, 'save' => true],
                    'completionProvider' => ['triggerCharacters' => ["'", '"', '.', '(']],
                    'definitionProvider' => true,
                    'codeLensProvider' => ['resolveProvider' => false],
                ], 'serverInfo' => ['name' => 'filament-lsp']];
                break;
            case 'textDocument/didOpen':
                $documents[$uri] = $params['textDocument']['text'];
                publishDiagnostics($uri);
                break;
            case 'textDocument/didChange':
                $documents[$uri] = end($params['contentChanges'])['text'];
                publishDiagnostics($uri); // Cheap: introspection is cached until a save.
                break;
            case 'textDocument/didSave':
                $cache = []; // Models, resources, or the database may have changed.
                foreach (array_keys($documents) as $open) {
                    publishDiagnostics($open);
                }
                break;
            case 'textDocument/didClose':
                unset($documents[$uri]);
                break;
            case 'textDocument/completion':
                $result = completion($path, $documents[$uri] ?? '', $params['position']);
                break;
            case 'textDocument/definition':
                $result = definition($path, $documents[$uri] ?? '', $params['position']);
                break;
            case 'textDocument/codeLens':
                $result = codeLenses($path, $documents[$uri] ?? '');
                break;
            case 'exit':
                exit(0);
        }
    } catch (Throwable $e) {
        if (isset($message['id'])) {
            send(['id' => $message['id'], 'error' => ['code' => -32603, 'message' => $e->getMessage()]]);
        }
        continue;
    }
    if (isset($message['id'])) {
        send(['id' => $message['id'], 'result' => $result]);
    }
}
