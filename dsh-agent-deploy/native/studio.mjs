// Explicit local Studio setup. Does not grant extra roles to existing users or change their passwords.
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { state, root, settings, systemEnvironment } from "./platform.mjs";

async function setup() {
  const config = await settings();
  const native = parseEnv(await readFile(resolve(state, ".env"), "utf8"));
  const tokenResponse = await fetch("http://127.0.0.1:8081/realms/master/protocol/openid-connect/token", { method: "POST", redirect: "error",
    signal: AbortSignal.timeout(15000), body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: config.admin.username, password: config.admin.password }) });
  assert.equal(tokenResponse.status, 200, "Local IAM administrator login failed");
  const { access_token } = await tokenResponse.json();
  const admin = async (path, method = "GET", data, allowMissing = false) => {
    const response = await fetch("http://127.0.0.1:8081/admin/realms/agent-local" + path, { method, redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { authorization: "Bearer " + access_token, ...(data === undefined ? {} : { "content-type": "application/json" }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    if (!response.ok && !(allowMissing && response.status === 404)) { await response.body?.cancel(); throw new Error(`IAM setup operation failed: HTTP ${response.status}`); }
    return response;
  };
  let roleResponse = await admin("/roles/tenant-admin", "GET", undefined, true);
  if (roleResponse.status === 404) {
    await roleResponse.body?.cancel(); await (await admin("/roles", "POST", { name: "tenant-admin", description: "Publish constrained definitions for the active tenant" })).body?.cancel();
    roleResponse = await admin("/roles/tenant-admin");
  }
  const role = await roleResponse.json();
  let user = config.users.find(value => value.username === "studio-admin");
  if (!user) {
    const existing = await (await admin("/users?username=studio-admin&exact=true")).json();
    assert.equal(existing.length, 0, "studio-admin already exists outside managed local settings; refusing to take it over");
    user = { uid: randomUUID(), username: "studio-admin", password: randomBytes(24).toString("base64url"), roles: ["user", "tenant-admin"] };
    config.users.push(user);
    // Persist recovery credentials before provisioning, within the existing private directory ACL.
    await writeFile(resolve(state, "platform.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  }
  const found = await (await admin("/users?username=studio-admin&exact=true")).json();
  if (!found.length) {
    await (await admin("/users", "POST", { id: user.uid, username: user.username, enabled: true, emailVerified: true,
      email: "studio-admin@example.invalid", firstName: "Studio", lastName: "Admin", requiredActions: [],
      credentials: [{ type: "password", value: user.password, temporary: false }] })).body?.cancel();
    // The IAM server, not the client, is authoritative for the persisted subject ID.
    const created = await (await admin("/users?username=studio-admin&exact=true")).json();
    assert.equal(created.length, 1, "Studio user creation could not be confirmed");
    user.uid = created[0].id;
    await writeFile(resolve(state, "platform.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  } else assert.equal(found[0].id, user.uid, "Managed studio user identity mismatch");
  const memberRole = await (await admin("/roles/user")).json();
  await (await admin(`/users/${user.uid}/role-mappings/realm`, "POST", [memberRole, role])).body?.cancel();
  const assigned = await (await admin(`/users/${user.uid}/role-mappings/realm`)).json();
  assert.ok(["user", "tenant-admin"].every(name => assigned.some(value => value.name === name)), "Studio administrator role assignment could not be confirmed");
  await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [resolve(root, "dsh-agent-catalog/dist/migrate.js")], {
      cwd: root, env: { ...systemEnvironment(), DATABASE_URL: native.CATALOG_DATABASE_URL }, windowsHide: true, stdio: "inherit" });
    child.once("error", reject); child.once("exit", code => code === 0 ? accept() : reject(new Error("Catalog migration failed")));
  });
  config.studioEnabled = true;
  await writeFile(resolve(state, "platform.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  console.log("Studio enabled. Separate local account: studio-admin. Credentials remain in .local/native/platform.json; not printed. Existing users unchanged.");
  console.log("Restart catalog, chat, api and web using platform.ps1 -Action Restart -Services catalog,chat,api,web.");
}
if (process.argv[2] !== "setup") throw new Error("Usage: node dsh-agent-deploy/native/studio.mjs setup");
try { await setup(); } catch { console.error("Local Studio setup failed. State retained; check IAM availability, credentials and migrations without sharing secrets."); process.exitCode = 1; }
