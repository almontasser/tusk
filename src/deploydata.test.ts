/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { hostKeyProblem, joinRemote, localFor, newServer, readServers, remoteFor, serverProblem, transient, webUrlFor, writeServer } from "./deploydata.ts";

const server = (over = {}) => ({ ...newServer("staging"), host: "example.com", rootPath: "/var/www/app", ...over });

test("joins server paths", () => {
  assert.equal(joinRemote("/var/www/", "./app/", "x.php"), "/var/www/app/x.php");
  assert.equal(joinRemote("", "public_html"), "public_html");
  assert.equal(joinRemote("/", ""), "/");
  assert.equal(joinRemote("/var/www", "../html"), "/var/html");
  assert.equal(joinRemote("", ""), "");
});

test("places project files on the server through the deepest mapping", () => {
  const s = server({ mappings: [{ local: "", remote: "" }, { local: "public/", remote: "/home/site/public_html" }] });
  assert.equal(remoteFor(s, "/p", "/p/app/User.php")?.remote, "/var/www/app/app/User.php");
  assert.equal(remoteFor(s, "/p", "/p")?.remote, "/var/www/app");
  assert.equal(remoteFor(s, "/p", "/p/public/index.php")?.remote, "/home/site/public_html/index.php");
  assert.equal(remoteFor(s, "/p", "/p/public")?.remote, "/home/site/public_html");
  assert.equal(remoteFor(s, "/p", "/other/x.php"), null);
  // A folder whose name starts like a mapped one isn't inside it.
  const only = server({ mappings: [{ local: "app", remote: "code" }] });
  assert.equal(remoteFor(only, "/p", "/p/application/x.php"), null);
  assert.equal(remoteFor(only, "/p", "/p/app/x.php")?.remote, "/var/www/app/code/x.php");
  // Without a root path, paths are relative to the login folder.
  assert.equal(remoteFor(server({ rootPath: "" }), "/p", "/p/a.php")?.remote, "a.php");
});

test("places server files in the project", () => {
  const s = server({ mappings: [{ local: "", remote: "" }, { local: "public", remote: "/home/site/public_html" }] });
  assert.equal(localFor(s, "/p", "/var/www/app/app/User.php")?.local, "/p/app/User.php");
  assert.equal(localFor(s, "/p", "/var/www/app")?.local, "/p");
  assert.equal(localFor(s, "/p", "/home/site/public_html/css/a.css")?.local, "/p/public/css/a.css");
  assert.equal(localFor(s, "/p", "/var/www/application/x"), null);
  assert.equal(localFor(s, "/p", "/etc/passwd"), null);
  assert.equal(localFor(server({ rootPath: "" }), "/p", "public_html/a.php")?.local, "/p/public_html/a.php");
  assert.equal(localFor(server({ rootPath: "" }), "/p", "/abs/a.php"), null);
});

test("links deployed files to the site, serving public/ at its root", () => {
  const s = server({ webUrl: "https://staging.example.com/" });
  assert.equal(webUrlFor(s, "/var/www/app/public/css/app.css"), "https://staging.example.com/css/app.css");
  assert.equal(webUrlFor(s, "/var/www/app/docs/a b.html"), "https://staging.example.com/docs/a%20b.html");
  assert.equal(webUrlFor(s, "/etc/x"), null);
  assert.equal(webUrlFor(server(), "/var/www/app/x"), null);
});

test("reads stored servers, dropping what's malformed, and writes them back short", () => {
  const read = readServers([{ name: "a", protocol: "ftp", host: "h", port: "99999" }, { name: "a" }, null, { host: "no name" }, { name: "b", auth: "nope", passive: false }]);
  assert.deepEqual(read.map((s) => [s.name, s.protocol, s.port, s.auth, s.passive]), [["a", "ftp", 21, "agent", true], ["b", "sftp", 22, "agent", false]]);
  assert.deepEqual(readServers("x"), []);
  const written = writeServer(server({ protocol: "ftps", port: 21, insecureTls: true, keyFile: "/k" }));
  assert.deepEqual(Object.keys(written), ["name", "protocol", "host", "insecureTls", "rootPath", "mappings", "excludes"]);
  assert.deepEqual(readServers([written])[0], server({ protocol: "ftps", port: 21, insecureTls: true, auth: "agent", keyFile: "" }));
});

test("checks servers before saving", () => {
  const a = server();
  assert.equal(serverProblem(a, [a]), "");
  assert.match(serverProblem(server({ host: "" }), []), /host/);
  assert.match(serverProblem(server({ host: "sftp://example.com" }), []), /name or address only/);
  assert.match(serverProblem(server({ mappings: [] }), []), /Add a mapping/);
  assert.match(serverProblem(server({ mappings: [{ local: "app", remote: "a" }, { local: "app/", remote: "b" }] }), []), /twice/);
  assert.match(serverProblem(server({ mappings: [{ local: "../x", remote: "" }] }), []), /inside the project/);
  const b = server();
  assert.match(serverProblem(b, [a, b]), /Another server/);
});

test("reads host key problems from deploy.rs's errors", () => {
  const p = hostKeyProblem(`host-key:{"kind":"changed","host":"h","port":22,"algorithm":"ssh-ed25519","fingerprint":"SHA256:x","key":"ssh-ed25519 AAAA","line":3}`);
  assert.equal(p?.kind, "changed");
  assert.equal(p?.line, 3);
  assert.equal(hostKeyProblem("The server refused the password"), null);
  assert.equal(hostKeyProblem("host-key:{bad"), null);
});

test("retries the network's errors, not the server's refusals", () => {
  assert.ok(transient("Connection reset by peer"));
  assert.ok(transient("example.com:22 didn't answer within 20 seconds."));
  assert.ok(!transient("The server refused the connection. Check the host and port."));
  assert.ok(!transient("/x: the server refused it (550: no such file, or permission denied)"));
});
