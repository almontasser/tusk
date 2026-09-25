/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { servicesMounting } from "./sail.ts";

test("finds the Compose services that mount the project, PHP first", () => {
  const config = {
    services: {
      nginx: { image: "nginx", volumes: [{ type: "bind", source: "/p/app", target: "/var/www" }] },
      php: { image: "php:8.4-fpm", volumes: [{ type: "bind", source: "/p", target: "/srv" }] },
      db: { image: "mysql", volumes: [{ type: "volume", target: "/var/lib/mysql" }] },
      other: { image: "node", volumes: [{ type: "bind", source: "/p/application", target: "/x" }] },
    },
  };
  assert.deepEqual(servicesMounting("/p/app", config), [{ name: "php", workdir: "/srv/app", php: true }, { name: "nginx", workdir: "/var/www", php: false }]);
  assert.deepEqual(servicesMounting("/p/app", {}), []);
});
