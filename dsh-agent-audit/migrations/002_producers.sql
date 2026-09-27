-- 老审计保持不变；会话/工作区事件不必关联模型运行。
ALTER TABLE audit.records ALTER COLUMN run_id DROP NOT NULL;
INSERT INTO audit.schema_migrations(version) VALUES(2);
