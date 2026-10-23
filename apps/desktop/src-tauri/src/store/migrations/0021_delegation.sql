-- Fase 8: delegação. Quem (agente) criou a task pelas tools do board.
ALTER TABLE task ADD COLUMN created_by_agent_id TEXT REFERENCES agent_profile(id) ON DELETE SET NULL;
CREATE INDEX task_created_by_agent_idx ON task(created_by_agent_id);
