ALTER TABLE chat.conversation_messages DROP CONSTRAINT conversation_messages_role_check;
ALTER TABLE chat.conversation_messages ALTER COLUMN idempotency_key DROP NOT NULL;
ALTER TABLE chat.conversation_messages ADD COLUMN run_id uuid UNIQUE;
ALTER TABLE chat.conversation_messages ADD COLUMN reply_to_message_id uuid UNIQUE
  REFERENCES chat.conversation_messages(id);
ALTER TABLE chat.conversation_messages ADD CONSTRAINT message_origin CHECK (
  (role='user' AND idempotency_key IS NOT NULL AND run_id IS NULL AND reply_to_message_id IS NULL) OR
  (role='assistant' AND idempotency_key IS NULL AND run_id IS NOT NULL AND reply_to_message_id IS NOT NULL)
);
-- 历史数据保持原 UUID 排序；新消息在会话锁内获取数据库序号，不依赖不同进程的时钟。
CREATE SEQUENCE chat.message_position;
ALTER TABLE chat.conversation_messages ADD COLUMN position bigint;
WITH ordered AS (SELECT id,row_number() OVER (ORDER BY id) AS position FROM chat.conversation_messages)
UPDATE chat.conversation_messages m SET position=o.position FROM ordered o WHERE m.id=o.id;
SELECT setval('chat.message_position',COALESCE((SELECT max(position) FROM chat.conversation_messages),0)+1,false);
ALTER TABLE chat.conversation_messages ALTER COLUMN position SET DEFAULT nextval('chat.message_position');
ALTER TABLE chat.conversation_messages ALTER COLUMN position SET NOT NULL;
ALTER SEQUENCE chat.message_position OWNED BY chat.conversation_messages.position;
CREATE UNIQUE INDEX messages_position ON chat.conversation_messages(position);
CREATE INDEX messages_session_position ON chat.conversation_messages(session_id,position);
INSERT INTO chat.schema_migrations(version) VALUES (2);
