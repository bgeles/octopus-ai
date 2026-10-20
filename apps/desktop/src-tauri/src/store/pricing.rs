//! Estimativa de custo ao vivo de um run a partir do uso de tokens de cada resposta.
//!
//! O custo exato só chega no `result` do SDK; enquanto o run anda, o Octopus soma uma estimativa
//! por mensagem com a tabela de preços públicos da API (US$ por milhão de tokens). Modelo
//! desconhecido usa o preço do Opus 5, para errar para o lado de parar antes.

use crate::protocol::Usage;

/// Preços em US$ por milhão de tokens.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    /// Escrita de cache com TTL de 1 hora (2× a entrada), que é o que o Claude Code usa:
    /// medido num run real em 20/10/2026 (com 1,25× a estimativa ficava ~⅓ abaixo do custo final).
    pub cache_write: f64,
}

const fn price(input: f64, output: f64, cache_read: f64) -> Price {
    Price {
        input,
        output,
        cache_read,
        cache_write: input * 2.0,
    }
}

/// Opus 5 / 4.8 / 4.7 / 4.6 / 4.5: também é o preço de modelo desconhecido.
const OPUS_5: Price = price(5.0, 25.0, 0.5);

/// Tabela por família, da mais específica para a mais genérica (`fable-5-1` antes de `fable-5`).
const TABLE: &[(&str, Price)] = &[
    ("fable-5-1", price(10.0, 50.0, 0.25)),
    ("mythos-5-1", price(10.0, 50.0, 0.25)),
    ("fable", price(10.0, 50.0, 1.0)),
    ("mythos", price(10.0, 50.0, 1.0)),
    ("opus-5-5", price(4.0, 20.0, 0.2)),
    ("opus-5", OPUS_5),
    ("opus-4-8", OPUS_5),
    ("opus-4-7", OPUS_5),
    ("opus-4-6", OPUS_5),
    ("opus-4-5", OPUS_5),
    ("opus-4", price(15.0, 75.0, 1.5)),
    ("opus", price(4.0, 20.0, 0.2)),
    ("sonnet-5", price(2.0, 10.0, 0.2)),
    ("sonnet-4", price(3.0, 15.0, 0.3)),
    ("sonnet-3", price(3.0, 15.0, 0.3)),
    ("sonnet", price(2.0, 10.0, 0.2)),
    ("haiku-5", price(0.1, 0.5, 0.01)),
    ("haiku-4", price(1.0, 5.0, 0.1)),
    ("haiku-3-5", price(0.8, 4.0, 0.08)),
    ("haiku", price(0.1, 0.5, 0.01)),
];

/// Preço do modelo pelo nome (aceita ids completos, prefixos de provedor, `[1m]` e aliases).
pub fn price_for(model: Option<&str>) -> Price {
    let Some(model) = model else { return OPUS_5 };
    let m = model.to_ascii_lowercase();
    TABLE
        .iter()
        .find(|(key, _)| m.contains(key))
        .map(|(_, p)| *p)
        .unwrap_or(OPUS_5)
}

/// Custo estimado de uma resposta do modelo.
pub fn estimate_usd(model: Option<&str>, usage: &Usage) -> f64 {
    let p = price_for(model);
    (usage.input_tokens as f64 * p.input
        + usage.output_tokens as f64 * p.output
        + usage.cache_read_tokens as f64 * p.cache_read
        + usage.cache_creation_tokens as f64 * p.cache_write)
        / 1_000_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(input: u64, output: u64, read: u64, write: u64) -> Usage {
        Usage {
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: read,
            cache_creation_tokens: write,
        }
    }

    #[test]
    fn picks_the_most_specific_family() {
        assert_eq!(price_for(Some("claude-fable-5-1")).cache_read, 0.25);
        assert_eq!(price_for(Some("claude-fable-5")).cache_read, 1.0);
        assert_eq!(price_for(Some("claude-opus-5-5")).input, 4.0);
        assert_eq!(price_for(Some("claude-opus-5")).input, 5.0);
        assert_eq!(price_for(Some("claude-opus-4-1-20250805")).input, 15.0);
        assert_eq!(
            price_for(Some("us.anthropic.claude-sonnet-5-5[1m]")).input,
            2.0
        );
        assert_eq!(price_for(Some("claude-sonnet-4-6")).input, 3.0);
        assert_eq!(price_for(Some("claude-haiku-5-5")).output, 0.5);
        assert_eq!(price_for(Some("claude-haiku-4-5")).input, 1.0);
        assert_eq!(price_for(Some("sonnet")).input, 2.0);
    }

    #[test]
    fn unknown_model_errs_on_the_expensive_side() {
        assert_eq!(price_for(None), OPUS_5);
        assert_eq!(price_for(Some("modelo-novo")), OPUS_5);
    }

    #[test]
    fn estimates_all_token_kinds() {
        // Sonnet 5.5: 1M de entrada (2) + 100k de saída (1) + 1M lidos do cache (0,2) + 100k escritos (0,4)
        let cost = estimate_usd(
            Some("claude-sonnet-5-5"),
            &usage(1_000_000, 100_000, 1_000_000, 100_000),
        );
        assert!((cost - 3.6).abs() < 1e-9, "{cost}");
        // Run real (Haiku 5.5) de 20/10/2026: custo final US$ 0,00119.
        let real = estimate_usd(Some("claude-haiku-5-5"), &usage(2, 17, 25_365, 4_474));
        assert!((real - 0.00119).abs() < 0.00005, "{real}");
    }
}
