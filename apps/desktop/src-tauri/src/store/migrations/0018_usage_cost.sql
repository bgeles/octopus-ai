-- Custo já somado por mensagem: com streaming o mesmo id pode chegar mais de uma vez, com a
-- saída crescendo; o core soma só a diferença para o maior valor visto.
ALTER TABLE run_usage_message ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
