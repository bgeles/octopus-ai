-- Fase 8: confiança por papel e aprovação em cadeia.
-- Cargo: defaults de confiança (NULL = supervisionado, sem delegar, sem aprovar).
ALTER TABLE role ADD COLUMN default_autonomy TEXT;
ALTER TABLE role ADD COLUMN default_can_assign_tasks INTEGER;
ALTER TABLE role ADD COLUMN default_can_approve INTEGER;
-- Membro: override por membro (NULL = herda do cargo).
ALTER TABLE agent_profile ADD COLUMN autonomy TEXT;
ALTER TABLE agent_profile ADD COLUMN can_assign_tasks INTEGER;
ALTER TABLE agent_profile ADD COLUMN can_approve INTEGER;
-- Task: quem está revisando (status 'review'), quantas vezes foi devolvida por agentes e quantas
-- tentativas de run de revisão já houve (para escalar para você).
ALTER TABLE task ADD COLUMN approver_agent_id TEXT REFERENCES agent_profile(id) ON DELETE SET NULL;
ALTER TABLE task ADD COLUMN return_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task ADD COLUMN review_attempts INTEGER NOT NULL DEFAULT 0;

INSERT INTO role (id, scope, title, specialty, responsibilities_md, default_permission_mode, default_tools_json, icon, position, created_at, updated_at, default_autonomy, default_can_assign_tasks, default_can_approve) VALUES
('role_gestor_produto', 'global', 'Gestor de produto', 'Prioridades e delegação',
 '- Transformar objetivos em tasks pequenas e claras, com critérios de aceite.
- Delegar para quem reporta a você e acompanhar o andamento no board.
- Revisar as entregas do seu time: aprovar o que cumpre os critérios, devolver com nota o que não cumpre.
- Não alterar código: só ler, investigar, planejar e decidir.', 'plan', '["Read","Glob","Grep"]', 'compass', 8, '2026-10-23T00:00:00Z', '2026-10-23T00:00:00Z', 'autonomous', 1, 1);
