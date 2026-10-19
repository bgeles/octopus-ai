-- Orçamento ao vivo: custo estimado enquanto o run anda e motivo de parada imposta pelo Octopus.
ALTER TABLE run ADD COLUMN est_cost_usd REAL NOT NULL DEFAULT 0;
-- `budget` quando o Octopus interrompeu o run por orçamento esgotado.
ALTER TABLE run ADD COLUMN stop_cause TEXT;

-- Mensagens do modelo já somadas na estimativa: o SDK repete o mesmo uso em cada bloco da
-- mensagem, e subagentes em paralelo intercalam mensagens.
CREATE TABLE run_usage_message (
    run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    PRIMARY KEY (run_id, message_id)
);
