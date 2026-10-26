-- Fase 9: estado do membro (pausado não recebe trabalho novo) e índice para o feed de atividade.
ALTER TABLE agent_profile ADD COLUMN paused_at TEXT;
CREATE INDEX task_event_at_idx ON task_event(at DESC);
