-- Fase 8: entrega da task (resultado em markdown, arquivos alterados, run que entregou, commit base para o diff).

ALTER TABLE task ADD COLUMN result_md TEXT;
ALTER TABLE task ADD COLUMN files_changed_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE task ADD COLUMN result_run_id TEXT;
ALTER TABLE task ADD COLUMN base_commit TEXT;
