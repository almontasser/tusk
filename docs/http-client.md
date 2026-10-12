# HTTP client

## HTTP client

Requests live in `.http` files in the project, in the format PhpStorm and VS
Code's REST Client read, so you commit them and your team uses them too. Click
the globe icon in the tool window bar, or run **HTTP Client** from ⌘⇧A.

### The tool window

The **HTTP Client** tool window lists every request in the project's `.http` and
`.rest` files, grouped by file, with a filter box and the selected environment
at the top.

- Click a request to preview it in the **HTTP** tab. The next request you click
  takes the preview's place, until you edit or send it. Double-click a request
  to keep its tab open. Hover over it and click ▶ to send it.
- A dot after a request means its tab has unsaved changes, and a dot after a
  file means its editor tab does.
- The tree and the history work from the keyboard: ↓ in a filter box moves to
  its list, ↑ and ↓ move, → and ← open and close a file, typing a name jumps to
  it, and Enter opens a request (a history entry's response). On a request, ⌘⏎
  sends it, F2 renames it, and ⌘⌫ deletes it. When the files can't be listed,
  the tree says why, with **Retry**.
- Right-click a request to send, open in the editor, rename, duplicate, delete,
  or stress test it. Right-click a file to add a request to it, run all of its
  requests, sync it with the Laravel routes, or save it.
- **+** adds a request to a file you choose, or to a new file in `http/`.
- The import icon imports a curl command, such as one from your browser's
  developer tools (**Copy as cURL**), a Postman collection (v2 or v2.1), an
  Insomnia export (v4), or an OpenAPI 3 or Swagger 2 document, in JSON or YAML. A
  collection becomes one file in `http/`, with each request titled by its
  folders. Postman's variables become file variables, and its auth becomes
  headers; its scripts stay as comments, since they don't run here. An OpenAPI
  document gives a request per operation, titled `[tag] summary`, with
  `{{host}}` for the server, a variable per path parameter, and a JSON body
  from the example or the schema. Environment variables go to
  `http-client.env.json` (secrets, such as tokens, to
  `http-client.private.env.json`), keeping values you already have.
  **HTTP Client: Import…** in ⌘⇧A does the same.
- The run icon runs every request in the project, file by file.
- The method icon makes requests from `php artisan route:list`: one route, all
  API routes, or every route. Each gets `{{host}}` for the app's address and a
  variable for each route parameter. A `POST`, `PUT`, or `PATCH` request's JSON
  body lists the fields its controller validates, read from the FormRequest it
  takes, its `validate()` or `Validator::make()` call, or those calls in a
  method of the controller it calls with `$this->`, with a value of the right type for each. A web
  route gets Laravel session auth, and an API route behind `auth:sanctum` a
  bearer token. When artisan fails, such as on an error while the app boots,
  the message says why.
- **Sync with Laravel Routes** (right-click a file, the first row of the
  method icon's list, or **HTTP Client: Sync with Laravel Routes…** in ⌘⇧A)
  brings a file in line with the routes. It lists what would change, each with
  a checkbox:
  - **New routes** get a request each, with a body from their rules.
  - **Changed bodies** get fields that the rules add, with an example value,
    and lose fields that no rule validates. Values you typed stay.
  - **No matching route** lists requests to `{{host}}` that no route answers.
    These aren't ticked, so they're only deleted if you tick them.

  Requests go with routes by method and path, so a route whose path changed
  shows as one new and one missing. A file that calls only API routes syncs
  with the API routes; switch to **All routes** at the top. **View Diff** shows
  the file before and after, and **Apply** makes the ticked changes as one
  undoable edit. The file saves unless it had unsaved changes, which then stay
  unsaved with the sync. If the file changes before you apply, the list is
  worked out again for you to check.
- **History** lists the last 100 requests you sent in the project, with their
  responses, and a filter. Click one to see it again. Right-click one to send it
  again, pin it (pinned requests stay at the top and don't count toward the
  100), compare it with the response on screen, or copy it as cURL or Laravel
  code. The history file doesn't keep secrets: tokens, passwords, cookies, and
  API keys in requests, and cookie values in responses. In response bodies, it
  hides the values of JSON and form fields named like `token`, `password`,
  `secret`, or `api_key`; you see the body as it came until you close the
  project, and a notice says when a body from the history had secrets hidden.
  **Settings › HTTP Client › Response bodies in the history** can keep bodies
  as they came, or not keep them at all. **Send Again** sends a request from this session exactly as it
  went, and prepares one from an earlier session again from its file, running
  its scripts.
- **Go to Request** (⌥⇧⌘O) finds any request in the project by name. Search
  Everywhere lists requests too.

### The HTTP tab

Each request you open gets a tab at the top of the **HTTP** tab, showing its
method and title, and its file when two tabs have the same title. A preview
tab's title is in italics. Drag tabs to reorder them. Middle-click or ⌘W (with
the **HTTP** tab focused) closes one. Right-click a tab to close others, those
to the right, the saved ones, or all of them, to keep a preview open, to save
or revert it, to save every unsaved tab, or to show it in the editor or the
tool window. ← and → move between focused tabs. Each tab keeps its own
response, and a request goes on sending when you switch to another tab. The
tabs, their unsaved changes, the one you had open, and whether the **HTTP** tab
showed come back when you reopen the project, after a reload, or after you
quit.

The top bar holds the method, the URL, **Send** (⌘⏎ anywhere in the tab), a
menu, and the environment. Under the URL, you see it with its variables
replaced, and the names nothing defines. While a request runs, **Send** becomes
**Cancel** and the time it's taken counts up. **Send Again** from the history
shows the same progress and **Cancel**. When a request can't be sent, or its
body can't be read, the response area says why, with **Retry**. Drag the line
between the request and the response to resize them, or focus it and use ←
and →; double-click it to reset it.

When a request uses a variable nothing defines, **Send** asks for its value
first. **Send** uses the values you type, and can save them to the environment
in the private environment file. **Send Anyway** sends `{{name}}` as written.

Changes in the request's tabs belong to its request tab until you save it:
the tab shows a dot, and the `.http` file doesn't change. ⌘S (with the **HTTP**
tab focused) writes that request alone into the file, rewriting only the lines
it changes and keeping comments and a URL split over several lines, and saves
the file. Other tabs' changes stay unsaved, even in the same file. When the
file has unsaved changes in its editor tab, the request goes into those
instead, and you save the file there. Closing a tab with unsaved changes asks
whether to save them; auto-save doesn't save them. A tab without changes shows
edits made in the editor as you make them; a tab with changes keeps them, and
saving writes them over the file's version. Adding, duplicating, deleting, or
renaming a request from the tool window saves the file, unless its editor tab
has unsaved changes.

| Tab | What you set |
| --- | --- |
| Params | The URL's query parameters |
| Headers | Headers, each of which you can turn off (it's commented out in the file) |
| Body | None, JSON (with **Format**), form fields, multipart fields and files, text, or a file (`< ./path`, or `<@ ./path` to replace variables in it) |
| Auth | A bearer token, a user and password (`Authorization: Basic user password`, encoded when sent, as in PhpStorm), or a Laravel session |
| Scripts | Checks you set up without code, and JavaScript that runs before the request and after the response, with snippets for common tests |
| Settings | Title, name for scripts, redirects, cookies, TLS verification, history, timeouts, a time budget, a proxy, a client certificate and key, the HTTP version, and a file to save the response to |

The response shows its status, time, size, and test results. Choosing a request
shows its last response from the history. The response has these tabs:

- **Body**: formatted and highlighted, or raw. HTML and images also have a
  preview. Copy it, save it, open it in an editor tab, or compare it with an
  earlier response to the same request in a diff. A JSON body has a filter:
  type a path such as `$.data[*].id` to see only what it selects. When Laravel
  answers with an exception (with `APP_DEBUG` on), the body starts with its
  class, message, and the files and lines of the stack trace, which open when
  you click them. Paths in Sail's container map to the project.
- **Headers**, including each redirect on the way.
- **Cookies** the response set, and those kept for the environment.
- **Timing**: DNS lookup, connecting, TLS, waiting, and downloading.
- **Tests**: each test's result, and what scripts logged.
- **Request**: the request as sent, as a curl command and as Laravel `Http::`
  code, each with **Copy**, or as fetch, axios, or Guzzle code, chosen in a
  menu. Secrets, such as tokens, passwords, and cookies, are hidden until you
  choose **Show secrets**. Copying, here and from menus, uses what's shown.
  **Generate…** writes a feature test for the request.
- **Logs** lists what Laravel wrote to `storage/logs/laravel.log`, or to the
  newest daily `laravel-YYYY-MM-DD.log`, while the request ran: each entry's
  level, message, and time, with its stack trace folded. Click a file and line
  to open it; paths in Sail's container map to the project. Other requests
  running at the same time can add entries too.
- **Queries** lists the SQL a request ran when you send it with **Send with
  Profiler**: how many queries and how long they took, grouped by SQL with
  duplicates and N+1 queries flagged, and each run's bindings and time.

To save a value from a JSON response for later requests, right-click it and
choose **Save as Variable…**. The request's response handler saves it with
`client.global.set`, and later requests use it as `{{name}}` right away.

The menu next to **Send** also has:

- **Send with Debugger**: starts listening for Xdebug and sends the request
  with `XDEBUG_SESSION`, so it stops at your breakpoints. The server's PHP needs
  Xdebug in debug mode, as **Start Debug Server** runs it.
- **Send with Profiler**: sends the request to the profiling server, starting
  it if needed, and opens the request's profile.
- **Copy as cURL**, **Copy as Laravel HTTP**, **Copy as fetch**, **Copy as
  axios**, and **Copy as Guzzle**.
- **Generate Feature Test…**: writes a test for the request to `tests/Feature`:
  Pest when the project uses it, or else PHPUnit. It sends the request with
  Laravel's test helpers (`postJson`, `get`, and so on) and checks the last
  response's status and, for JSON, its structure. Name the file, such as
  `NotesTest.php`; an existing file gets the test added.
- **Run All Requests in File**, **Stress Test…**, and **Monitor…**.
- **Go to Controller**: opens the controller method of the route the request
  calls, matched by method and path.
- **Open in Editor**, **Duplicate**, and **Delete**.

In the editor, each request has **▶ Send Request** and **Open in HTTP Client**
above it, and the first shows the environment and **Run All**. The editor
completes methods, headers, header values, tags, and `{{variables}}`. Hover over
a variable to see its value and where it comes from. A variable nothing defines
is underlined.

```http
@api = {{host}}/api

### Log in
POST {{api}}/login
Content-Type: application/json

{"email": "{{email}}", "password": "{{password}}"}

> {%
    client.global.set("token", response.body.token);
    client.test("Logged in", () => client.assert(response.status === 200));
%}

### My posts
# @no-redirect
GET {{api}}/posts?filter[status]=draft
Authorization: Bearer {{token}}
```

### Variables

A request's `{{name}}` comes from the first of these that defines it:

1. A value the request's own pre-request script set (`request.variables.set`).
2. A global value a script saved (`client.global.set`). Globals last until you
   clear them with **HTTP Client: Global Variables…** in ⌘⇧A.
3. A file variable: `@name = value` in the `.http` file.
4. The selected environment, from `http-client.env.json`.
   `http-client.private.env.json` overrides it for secrets. **Edit Private
   Environments…** in the environment menu creates it and adds it to
   `.gitignore`. Values in a `$shared` environment apply to every environment.

Tusk looks for the environment files in the `.http` file's folder, then in each
parent folder up to the project root. The nearest folder with either file wins,
and files further up are ignored. For `http/admin/users.http`, that's
`http/admin`, then `http`, then the project root. The request and the
environment menu use the same files. A file that isn't valid JSON shows an
error that names it, and its environments are left out until you fix it.

Dynamic values change each time you send: `{{$uuid}}`, `{{$timestamp}}`,
`{{$isoTimestamp}}`, `{{$randomInt}}`, `{{$random.integer(1, 10)}}`,
`{{$random.float(0, 1)}}`, `{{$random.alphabetic(8)}}`,
`{{$random.alphanumeric(8)}}`, `{{$random.hexadecimal(8)}}`,
`{{$random.numeric(6)}}`, `{{$random.email}}`, and `{{$random.bool}}`.
`{{$dotenv.NAME}}` reads the project's `.env`, and `{{$projectRoot}}` is the
project's folder, such as in `< {{$projectRoot}}/data.json`.

In the query, after the `?`, a variable's value is URL-encoded, as in PhpStorm.
With `q` set to `C# & .NET`, `?q={{q}}` sends `?q=C%23%20%26%20.NET`. What you
type yourself is sent as written. `# @no-auto-encoding` sends the values as
they are, such as a variable that holds `a=1&b=2`.

```json
{ "local": { "host": "http://localhost:8000" }, "staging": { "host": "https://staging.example.com" } }
```

A nested object gives its values dotted names. With this file, `{{client.host}}`
is `https://dev.example.com`:

```json
{ "dev": { "client": { "host": "https://dev.example.com" } } }
```

**Edit Environments…** in the environment menu creates `http-client.env.json`
with a `local` environment for `APP_URL` from `.env`.

To edit every environment in one table, choose **Edit Environments…** in an
environment menu, or run **HTTP Client: Edit Environments**. Private variables
go in `http-client.private.env.json`, which is added to `.gitignore`, and the
rest go in `http-client.env.json`. Names that look secret start as private. A
nested object's values show with dotted names, such as `client.host`, and are
saved back in the object.
Empty cells that other environments fill are highlighted. **Open JSON** and
**Open Private JSON** open the files.

**Detect App Address…**, in the environment menu or as **HTTP Client: Detect
App Address** in ⌘⇧A, finds where the app answers and sets it as `host` in the
selected environment: Sail's `APP_PORT`, a Herd or Valet site for the project
(https when it's secured), a PHP server such as `artisan serve`, or `APP_URL`.
A new environment file starts with the best of these.

### Scripts and tests

Scripts are JavaScript, as in PhpStorm. They run in a worker without access to
the editor, and stop after 5 seconds.

| Object | What it offers |
| --- | --- |
| `client` | `global.set/get/clear/clearAll/isEmpty`, `test(name, fn)`, `assert(condition, message)`, `log(...)` |
| `response` | `status`, `body` (parsed when it's JSON), `headers.valueOf(name)`, `headers.valuesOf(name)`, `contentType.mimeType` |
| `request` | `method`, `url`, `body`, `headers`, `variables.set/get`, `environment.get` |
| `jsonPath(value, path)` | Reads a path such as `$.data[0].id` |

`> ./script.js` and `< ./script.js` run a script from a file instead.

**Checks** at the top of the Scripts tab test the response without code: *Status
is*, *JSON path exists*, *JSON path equals*, *Header contains*, *Response time
under (ms)*, and *Body contains*. They're saved as `client.test()` calls between
`// checks:start` and `// checks:end` in the response handler, so your own code
around them stays. Scripts can read `response.time` in milliseconds.

### Tags

Put these comments above the request line:

| Tag | Effect |
| --- | --- |
| `# @name login` | A name for scripts and the tool window |
| `# @no-redirect` | Don't follow redirects. Without it, a POST becomes a GET after a 301, 302, or 303, as in a browser. Other methods stay the same on every redirect, unless curl 8.16 or later sends the request: then a 303 continues with a GET |
| `# @no-auto-encoding` | Send variable values in the query as they are, rather than URL-encoded |
| `# @no-cookie-jar` | Don't send or keep cookies |
| `# @no-log` | Leave it out of the history |
| `# @timeout 5` | Seconds without new data before giving up (60 by default). A slow download that keeps going isn't cut off |
| `# @connection-timeout 2` | Seconds to wait for the connection |
| `# @insecure` | Accept any TLS certificate. PhpStorm reads it as a comment |
| `# @laravel-session` | Sign in with Laravel's session, as **Auth** > **Laravel session** sets it. A path after it, such as `/csrf`, is where to get the XSRF token. PhpStorm reads it as a comment |
| `# @proxy http://127.0.0.1:8888` | Send through a proxy. A `"$proxy"` value in the environment applies to every request without the tag. PhpStorm reads it as a comment |
| `# @client-cert ./client.pem` | A client certificate for mutual TLS, relative to the `.http` file. PhpStorm reads it as a comment |
| `# @client-key ./client.key` | The client certificate's key. PhpStorm reads it as a comment |
| `# @http2`, `# @http1` | Use HTTP/2 or HTTP/1.1. Without them, curl asks for HTTP/2 over HTTPS and uses HTTP/1.1 otherwise. `HTTP/2` on the request line, as PhpStorm writes it, works too. PhpStorm reads the tags as comments |
| `# @budget 300` | Milliseconds the response may take. A slower response shows **Over budget** and fails in **Run All**. PhpStorm reads it as a comment |

An environment's `"$proxy"` starts with `$` so it can't clash with a variable
of your own:

```json
{ "office": { "host": "https://staging.example.com", "$proxy": "http://proxy.internal:3128" } }
```

A `POST` without a body sends `Content-Length: 0` and no `Content-Type`, unless
you set one.

After the body, `>> ./out.json` saves the response to a file, adding a number
when it exists, and `>>! ./out.json` replaces it. The path can use variables,
such as `>> {{outDir}}/out.json` or `>> {{$projectRoot}}/out.json`, which get
the same values as the request's.

Cookies work like a browser's: responses' cookies are kept per environment and
sent with later requests. **HTTP Client: Clear Cookies** in ⌘⇧A forgets them.

### Laravel session auth

Web routes and Sanctum's SPA authentication check a session cookie and a CSRF
token, as a browser sends them. With **Laravel session** auth, a request first
gets Laravel's `XSRF-TOKEN` cookie from `/sanctum/csrf-cookie` (or `/`) when the
environment's cookies don't have one, then sends it back as `X-XSRF-TOKEN`, with
`Origin`, `Referer`, and `Accept: application/json`. Send your login request,
such as `POST /login` with an email and password, with this auth, and the
requests after it with the same auth use the session.

### GraphQL

A `GRAPHQL` request sends a query, and optionally variables, as a JSON `POST`.
Its Body tab has a Query editor and a Variables editor. In the file, the
variables are a JSON object after a blank line:

```http
GRAPHQL {{host}}/graphql

query Posts($first: Int) { posts(first: $first) { id title } }

{"first": 10}
```

The Query editor highlights GraphQL and completes fields and arguments from the
endpoint's schema, with their types and descriptions. Hover over a field to see
its type. The first completion fetches the schema with an introspection query,
sent with the request's URL, headers, and variables, and keeps it for the
session. **Refresh Schema** fetches it again. Completion works in `GRAPHQL`
requests in the editor too.

### WebSockets

A `WEBSOCKET` request connects when you click **Connect**, and the response
side becomes a console: what you send and receive, with times and formatted
JSON, and a box to send more (⌘⏎). The file's messages, each after a line of
`===`, are sent once connected. A line of `=== wait-for-server` waits for a
message from the server before the next. Pings from Pusher and Laravel Reverb
are answered, so the connection stays open. The request's headers, such as
`Authorization`, go with the opening handshake, and `# @insecure` accepts any
TLS certificate for `wss://`.

```http
WEBSOCKET ws://localhost:8080/app/{{reverbKey}}
===
{"event": "pusher:subscribe", "data": {"channel": "posts"}}
```

### gRPC

A `GRPC` request calls a method, written as `host:port/package.Service/Method`
in JetBrains' format, with the request message as JSON. Use `grpcs://` before
the address for TLS. Headers go as metadata.

```http
GRPC localhost:50051/helloworld.Greeter/SayHello
Authorization: Bearer {{token}}

{"name": "Ada"}
```

The message types come from the server's reflection service. When the server
doesn't have one, the project's `.proto` files are compiled instead, with
imports found from the file's folder and each folder above it. There's nothing
to install: no `protoc`. The response shows as JSON, with every field, and a
server streaming method's messages as an array. While a server stream runs,
each message shows as it arrives, with a count, and **Cancel** stops the call. For a client streaming method,
write the messages one after another. The status shows as the HTTP status gRPC
maps to, such as `404 NOT_FOUND`, with `grpc-status` and `grpc-message` among
the headers, so scripts and the runner treat a failed call as a failed request.
After the address and `/`, completion lists the server's methods.

### Running a file

**Run All Requests in File** sends each request in order, so a login request's
token reaches the requests after it. The **HTTP Runner** tab lists each result,
with its status, time, and tests. Click one to see its response.

### Running requests in CI

**Run All Requests in File**, and **HTTP Client: Run All Requests in Project**
in ⌘⇧A, show each request's status, time, and tests. **Save Report…** writes
the results as JUnit XML: a test suite per file and a test case per request. A
request fails on a status of 400 or more, no response, a failed `client.test`,
or a response over its budget, and its failure lists every test's result.

To run the same files in CI, use JetBrains' free `ijhttp` command-line client:

```sh
ijhttp --env-file http-client.env.json --env local --report http/*.http
```

`--report` writes JUnit XML to `reports/`. To run it in Docker, use the
`jetbrains/intellij-http-client` image:

```sh
docker run --rm -v "$PWD":/workdir jetbrains/intellij-http-client \
  --env-file http-client.env.json --env local --report http/*.http
```

ijhttp may not understand the tags and request types only this editor adds,
such as `# @insecure`, `# @laravel-session`, `# @budget`, and `WEBSOCKET`.
**HTTP Client: Export to OpenAPI…** writes the project's requests as an OpenAPI
3.0 document.

### Stress testing

**Stress Test…** sends one request many times at once and shows, as it runs,
requests per second, failures, the median, 95th, and 99th percentile response
times, requests completed each second, a histogram of response times, and the
status codes. Choose a number of requests or a number of seconds, and how many
run at a time (up to 500). Scripts don't run, and the environment's cookies are
sent. Only test servers you're allowed to load.

**Ramp up** steps through 1, 2, 5, 10, 20, 50, and more requests at a time, up
to the number you choose, for the seconds per step you choose. It charts
requests per second and the 95th percentile response time at each step, marking
steps with failures, so you see where the server slows down.

### Monitoring

**Monitor…** sends the request every few seconds, such as to watch an endpoint
during a deploy. The **Monitor** tab shows the last status, how often it was
up, the median, 95th percentile, and slowest response times, a chart of the
last 60 checks with failures in red, and the latest checks. Scripts don't run,
and checks stay out of the history.

