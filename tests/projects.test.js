import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { defaultConfig } from "../core/config.js";
import { isInside, ProjectStore } from "../core/projects.js";

let root;
let store;

const withRoot = (value) => {
  const config = structuredClone(defaultConfig());
  config.projects.root = value;
  return new ProjectStore(config, (recent) => {
    config.projects.recent = recent;
  });
};

suite("projects", () => {
  test("isInside blocks traversal and equal paths work", () => {
    const parent = path.resolve("a", "b");
    assert.ok(isInside(parent, path.join(parent, "c")));
    assert.ok(isInside(parent, parent));
    assert.ok(!isInside(parent, path.join(parent + "b", "c")));
    assert.ok(!isInside(parent, path.resolve("a", "c")));
    assert.ok(!isInside(parent, path.join(parent, "..", "..", "x")));
  });

  test("create: valid name, duplicate rejected, git optional", async () => {
    root = path.join(import.meta.dirname, ".tmp-projects");
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    store = withRoot(root);
    const created = store.create("my.project-1");
    assert.equal(created.name, "my.project-1");
    assert.ok(fs.existsSync(created.path));
    assert.equal(created.isGitRepo, false);
    // Duplicate
    assert.throws(() => store.create("my.project-1"), /already exists/);
    // Invalid names
    assert.throws(() => store.create("../escape"), /invalid_name|Project name/);
    assert.throws(() => store.create("a/b"), /invalid_name|Project name/);
    assert.throws(() => store.create(""), /invalid_name|Project name/);
    assert.throws(() => store.create(".hidden"), /invalid_name|Project name/);
  });

  test("list: skips hidden entries and marks recents", async () => {
    fs.mkdirSync(path.join(root, "second"), { recursive: true });
    fs.mkdirSync(path.join(root, ".secret"), { recursive: true });
    // Open one project so it becomes recent.
    store.open("my.project-1");
    const listed = store.list();
    assert.equal(listed.length, 2);
    const first = listed.find((entry) => entry.name === "my.project-1");
    const second = listed.find((entry) => entry.name === "second");
    assert.equal(first.recent, 0);
    assert.equal(second.recent, undefined);
    assert.equal(
      listed.some((entry) => entry.name === ".secret"),
      false,
    );
  });

  test("open: name or absolute path inside the root, recent updated", async () => {
    const byAbsolute = path.join(root, "second");
    const absolute = store.open(byAbsolute);
    assert.equal(absolute, byAbsolute);
    const recent = store.recent();
    assert.ok(recent.includes(byAbsolute));
    assert.equal(recent[0], byAbsolute);
  });

  test("open: path traversal is refused, not escaped", async () => {
    assert.throws(() => store.open("..\\escape"), /not found|inside the projects root/);
    assert.throws(() => store.open("../../elsewhere"), /not found|inside the projects root/);
  });

  test("open: outside-the-root absolute paths are refused", async () => {
    const outside = path.join(import.meta.dirname, "outside");
    fs.mkdirSync(outside, { recursive: true });
    assert.throws(() => store.open(outside), /not found|inside the projects root/);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  test("open: unknown project", async () => {
    assert.throws(() => store.open("does-not-exist"), /Project not found/);
  });
});
