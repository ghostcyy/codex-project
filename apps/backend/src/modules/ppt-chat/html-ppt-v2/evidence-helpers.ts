import type { EvidencePack } from "./ir";

export function visibleEvidenceFacts(evidence: EvidencePack): EvidencePack["facts"] {
  return evidence.facts.filter((fact) => !fact.internalOnly);
}

export function visibleEvidenceDataPoints(evidence: EvidencePack): EvidencePack["dataPoints"] {
  return evidence.dataPoints.filter((point) => !point.internalOnly);
}

export function visibleEvidenceTerminology(evidence: EvidencePack): EvidencePack["terminology"] {
  return evidence.terminology.filter((term) => !term.internalOnly);
}

export function visibleEvidenceCitationKeys(evidence: EvidencePack): string[] {
  return [
    ...visibleEvidenceFacts(evidence).map((fact) => fact.citationKey),
    ...visibleEvidenceDataPoints(evidence).map((point) => point.citationKey)
  ];
}
