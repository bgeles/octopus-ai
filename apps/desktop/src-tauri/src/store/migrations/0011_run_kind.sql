-- Fase 4: tipo do run (agent = pedido do usuário/scheduler; consolidation = passo de memória com Haiku).

ALTER TABLE run ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent';
