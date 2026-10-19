import type { EffortLevel } from "@octopus/protocol";

/** Rótulos do esforço de raciocínio (`effort` do SDK), do mais leve ao mais profundo. */
export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: "Baixo",
  medium: "Médio",
  high: "Alto",
  xhigh: "Muito alto",
  max: "Máximo",
};

export const EFFORT_LEVELS = Object.keys(EFFORT_LABELS) as EffortLevel[];

export function effortLabel(effort: EffortLevel | null | undefined): string {
  return effort ? EFFORT_LABELS[effort] : "padrão do modelo";
}
