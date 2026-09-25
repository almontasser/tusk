// Runs .http request scripts (PhpStorm's `client`, `request`, and `response` objects) in a worker, so a script in
// a project file can't reach the app's commands, and a script that never ends can be stopped.

type Input = {
  code: string;
  globals: Record<string, string>;
  variables: Record<string, string>;
  environment: Record<string, string>;
  request: { method: string; url: string; headers: [string, string][]; body: string };
  response?: { status: number; headers: [string, string][]; body: string; contentType: string };
};
export type Test = { name: string; passed: boolean; message?: string };
export type Output = { globals: Record<string, string>; variables: Record<string, string>; tests: Test[]; logs: string[]; error?: string };

const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/** Reads a simple JSONPath, such as $.data[0].id, from a value. */
function jsonPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const [, key, index] of path.replace(/^\$\.?/, "").matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key ?? index];
  }
  return current;
}

self.onmessage = ({ data }: MessageEvent<Input>) => {
  const globals = { ...data.globals };
  const variables = { ...data.variables };
  const tests: Test[] = [];
  const logs: string[] = [];
  const headers = (list: [string, string][]) => ({
    valueOf: (name: string) => list.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1] ?? null,
    valuesOf: (name: string) => list.filter(([k]) => k.toLowerCase() === name.toLowerCase()).map(([, v]) => v),
    all: () => list.map(([name, value]) => ({ name, value })),
  });
  const client = {
    global: {
      set: (name: string, value: unknown) => (globals[name] = text(value)),
      get: (name: string) => globals[name] ?? null,
      isEmpty: () => !Object.keys(globals).length,
      clear: (name: string) => delete globals[name],
      clearAll: () => Object.keys(globals).forEach((k) => delete globals[k]),
    },
    test(name: string, fn: () => void) {
      try {
        fn();
        tests.push({ name, passed: true });
      } catch (e) {
        tests.push({ name, passed: false, message: e instanceof Error ? e.message : String(e) });
      }
    },
    assert(condition: unknown, message = "Assertion failed") {
      if (!condition) throw new Error(message);
    },
    log: (...values: unknown[]) => logs.push(values.map(text).join(" ")),
  };
  let body: unknown = data.response?.body;
  if (data.response && /json/i.test(data.response.contentType)) {
    try {
      body = JSON.parse(data.response.body);
    } catch {
      // Leave the text as it is.
    }
  }
  const request = {
    ...data.request,
    variables: { set: (name: string, value: unknown) => (variables[name] = text(value)), get: (name: string) => variables[name] ?? null },
    environment: { get: (name: string) => data.environment[name] ?? null },
    headers: headers(data.request.headers),
  };
  const response = data.response && {
    status: data.response.status,
    body,
    headers: headers(data.response.headers),
    contentType: { mimeType: data.response.contentType.split(";")[0].trim(), charset: data.response.contentType.match(/charset=([^;]+)/)?.[1] ?? "utf-8" },
  };
  let error: string | undefined;
  try {
    new Function("client", "request", "response", "jsonPath", data.code)(client, request, response, jsonPath);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  postMessage({ globals, variables, tests, logs, error } satisfies Output);
};
