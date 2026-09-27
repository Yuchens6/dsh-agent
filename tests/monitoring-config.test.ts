import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ChatRepository } from "../dsh-agent-chat/src/repository.js";
import { WorkspaceRepository } from "../dsh-agent-workspace/src/repository.js";
import { RunRepository } from "../dsh-agent-run-control/src/repository.js";
import { serviceDatabase, MemoryBlobs } from "./workspace-catalog-helpers.js";
import { testBinding } from "./helpers.js";

// Only structural/reference validation; PromQL semantics require promtool.
test("监控模板：独立凭据、内部目标、告警引用与实际指标一致", async t => {
  const read = async (name: string) => JSON.parse(await readFile(new URL(`../dsh-agent-deploy/monitoring/${name}`, import.meta.url), "utf8"));
  const config = await read("prometheus.yaml"), alerts = await read("alerts.yaml"), fixtures = await read("rules.test.yaml");
  const { pg, db } = await serviceDatabase("chat", "workspace", "run_control");
  t.after(() => pg.close());
  const snapshots = {
    chat: await new ChatRepository(db, testBinding).metrics(),
    workspace: await new WorkspaceRepository(db, new MemoryBlobs()).metrics(),
    run_control: await new RunRepository(db).metrics(),
  };
  const metrics = new Set(Object.entries(snapshots).flatMap(([service, values]) => Object.keys(values).map(key => `dsh_${service}_${key}`)));
  assert.deepEqual(config.rule_files, ["alerts.yaml"]);
  assert.deepEqual(config.scrape_configs.map((job: { job_name: string }) => job.job_name), ["dsh-chat", "dsh-workspace", "dsh-run-control"]);
  for (const job of config.scrape_configs) {
    const service = job.job_name.slice(4);
    assert.equal(job.metrics_path, "/metrics");
    assert.equal(job.follow_redirects, false);
    assert.deepEqual(job.authorization, { type: "Bearer", credentials_file: `/etc/prometheus/secrets/${service}` });
    assert.deepEqual(job.static_configs, [{ targets: [`dsh-agent-${service}.agent-platform.svc.cluster.local:8080`] }]);
  }
  const names = new Set<string>();
  for (const group of alerts.groups) for (const rule of group.rules) {
    assert.ok(!names.has(rule.alert)); names.add(rule.alert);
    assert.match(rule.for, /^\d+m$/);
    assert.ok(["warning", "critical"].includes(rule.labels.severity));
    assert.ok(rule.annotations.summary.length > 0);
    for (const metric of rule.expr.match(/\bdsh_[a-z_]+\b/g) ?? []) assert.ok(metrics.has(metric), `unknown metric: ${metric}`);
    assert.doesNotMatch(rule.expr, /\bsum\s*\(/); // Database-wide gauges must not multiply with replicas.
  }
  assert.equal(names.size, 7);
  assert.deepEqual(fixtures.rule_files, config.rule_files);
  for (const fixture of fixtures.tests) {
    for (const series of fixture.input_series) assert.ok(metrics.has(series.series.split("{")[0]));
    for (const expected of fixture.alert_rule_test) assert.ok(names.has(expected.alertname));
  }
});
