/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { contextAt, schemaFrom, type Schema } from "./graphqlschema.ts";

const named = (name: string) => ({ kind: "OBJECT", name });
const nonNull = (ofType: object) => ({ kind: "NON_NULL", name: null, ofType });
const list = (ofType: object) => ({ kind: "LIST", name: null, ofType });
const scalar = (name: string) => ({ kind: "SCALAR", name });

const schema = schemaFrom({
  data: {
    __schema: {
      queryType: { name: "Query" },
      mutationType: { name: "Mutation" },
      subscriptionType: null,
      types: [
        {
          kind: "OBJECT",
          name: "Query",
          fields: [
            { name: "user", description: "One user", type: named("User"), args: [{ name: "id", description: "The ID", type: nonNull(scalar("ID")), defaultValue: null }] },
            { name: "users", type: nonNull(list(nonNull(named("User")))), args: [{ name: "first", type: scalar("Int"), defaultValue: "10" }] },
          ],
        },
        { kind: "OBJECT", name: "Mutation", fields: [{ name: "createPost", type: named("Post"), args: [{ name: "title", type: nonNull(scalar("String")) }] }] },
        { kind: "OBJECT", name: "User", fields: [{ name: "name", type: scalar("String"), args: [] }, { name: "posts", type: list(named("Post")), args: [] }] },
        { kind: "OBJECT", name: "Post", fields: [{ name: "title", type: scalar("String"), args: [] }, { name: "author", type: nonNull(named("User")), args: [] }] },
      ],
    },
  },
}) as Schema;

/** The context at the | in `doc`. */
const at = (doc: string) => {
  const c = contextAt(schema, doc.replace("|", ""), doc.indexOf("|"));
  return c && (c.kind === "fields" ? `fields ${c.type.name}` : `args ${c.type.name}.${c.field.name}`);
};

test("schemaFrom reads types, fields, and arguments with GraphQL type strings", () => {
  const users = schema.types.get("Query")!.fields[1];
  assert.equal(users.type, "[User!]!");
  assert.equal(users.typeName, "User");
  assert.deepEqual(users.args[0], { name: "first", description: "", type: "Int", defaultValue: "10" });
  assert.equal(schema.query, "Query");
  assert.equal(schema.subscription, undefined);
  assert.equal(schemaFrom({ errors: [] }), null);
});

test("contextAt follows the selection set from the operation's root type", () => {
  assert.equal(at("{ |"), "fields Query");
  assert.equal(at("query { us|"), "fields Query");
  assert.equal(at("query Q($id: ID!) { user(id: $id) { |"), "fields User");
  assert.equal(at("{ users { posts { author { na| } } } }"), "fields User");
  assert.equal(at("{ users { posts { title } | } }"), "fields User");
  assert.equal(at("mutation { createPost(title: \"x\") { | } }"), "fields Post");
  assert.equal(at("{ me: user(id: 1) { posts { | } } }"), "fields Post");
});

test("contextAt finds arguments, but not in values or strings", () => {
  assert.equal(at("{ user(|) }"), "args Query.user");
  assert.equal(at("{ users(first: 2, |) }"), "args Query.users");
  assert.equal(at("{ users(first: |) }"), null);
  assert.equal(at("{ user(id: \"a|\") }"), null);
  assert.equal(at("query Q(|) { user }"), null);
});

test("contextAt follows fragments, inline fragments, directives, and comments", () => {
  assert.equal(at("fragment F on Post { author { | } }"), "fields User");
  assert.equal(at("{ user(id: 1) { ... on User { posts { | } } } }"), "fields Post");
  assert.equal(at("{ user(id: 1) @include(if: true) { | } }"), "fields User");
  assert.equal(at("{ # user {\n users { | } }"), "fields User");
  assert.equal(at("{ user } |"), null);
});
