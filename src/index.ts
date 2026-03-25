/**
 * citation-guard
 * Post-generation citation verification for RAG systems.
 * Eliminates hallucinated references before they reach users.
 *
 * @author Igor Eduardo
 * @license MIT
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CitationGuardConfig {
  mode: 'strip' | 'flag' | 'strict';
  citationFormat: 'numeric' | 'author-year' | 'custom';
  customPattern?: RegExp;
  semanticVerification?: boolean;
  embeddingFn?: (text: string) => Promise<number[]>;
  semanticThreshold?: number;
  onHallucination?: (citation: string, context: string) => void;
}

export interface RetrievedDocument {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface VerificationResult {
  cleanResponse: string;
  stats: {
    total: number;
    verified: number;
    removed: number;
    hallucinationRate: number;
  };
  citations: CitationDetail[];
}

export interface CitationDetail {
  marker: string;
  documentId: string | null;
  verified: boolean;
  context: string;
}

// ─── Core ────────────────────────────────────────────────────────────────────

export class CitationGuard {
  private config: CitationGuardConfig;
  private pattern: RegExp;

  constructor(config: CitationGuardConfig) {
    this.config = {
      semanticThreshold: 0.50,
      ...config,
    };

    this.pattern = this.buildPattern();
  }

  /**
   * Verify all citations in an LLM response against retrieved documents.
   */
  verify(response: string, retrievedDocs: RetrievedDocument[]): VerificationResult {
    const docMap = new Map(retrievedDocs.map(doc => [doc.id, doc]));
    const citations = this.extractCitations(response);

    const details: CitationDetail[] = [];
    let cleanResponse = response;
    let verified = 0;
    let removed = 0;

    // Process citations in reverse order to preserve string positions
    const sortedCitations = [...citations].sort((a, b) => b.position - a.position);

    for (const citation of sortedCitations) {
      const docId = this.extractDocId(citation.marker);
      const doc = docId ? docMap.get(docId) : null;
      const isVerified = doc !== null && doc !== undefined;

      details.push({
        marker: citation.marker,
        documentId: docId,
        verified: isVerified,
        context: this.getSurroundingContext(response, citation.position),
      });

      if (isVerified) {
        verified++;
      } else {
        removed++;

        if (this.config.onHallucination) {
          this.config.onHallucination(
            citation.marker,
            this.getSurroundingContext(response, citation.position)
          );
        }

        if (this.config.mode === 'strict') {
          return {
            cleanResponse: '',
            stats: {
              total: citations.length,
              verified,
              removed: citations.length - verified,
              hallucinationRate: (citations.length - verified) / citations.length,
            },
            citations: details,
          };
        }

        if (this.config.mode === 'strip') {
          cleanResponse = this.stripCitation(cleanResponse, citation);
        } else if (this.config.mode === 'flag') {
          cleanResponse = this.flagCitation(cleanResponse, citation);
        }
      }
    }

    // Clean up extra whitespace left by stripped citations
    cleanResponse = cleanResponse.replace(/\s{2,}/g, ' ').trim();

    const total = citations.length;

    return {
      cleanResponse,
      stats: {
        total,
        verified,
        removed,
        hallucinationRate: total > 0 ? removed / total : 0,
      },
      citations: details.reverse(),
    };
  }

  // ─── Private: Pattern Building ──────────────────────────────────────────

  private buildPattern(): RegExp {
    switch (this.config.citationFormat) {
      case 'numeric':
        return /\[(\d+)\]/g;
      case 'author-year':
        return /\(([A-Za-z\s]+(?:et al\.?)?,?\s*\d{4})\)/g;
      case 'custom':
        if (!this.config.customPattern) {
          throw new Error('Custom citation format requires a customPattern regex');
        }
        return new RegExp(this.config.customPattern.source, 'g');
      default:
        return /\[(\d+)\]/g;
    }
  }

  // ─── Private: Citation Extraction ───────────────────────────────────────

  private extractCitations(text: string): Array<{ marker: string; position: number }> {
    const citations: Array<{ marker: string; position: number }> = [];
    const regex = new RegExp(this.pattern.source, this.pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      citations.push({
        marker: match[0],
        position: match.index,
      });
    }

    return citations;
  }

  private extractDocId(marker: string): string | null {
    if (this.config.citationFormat === 'numeric') {
      const match = marker.match(/\[(\d+)\]/);
      return match ? match[1] : null;
    }

    if (this.config.citationFormat === 'author-year') {
      const match = marker.match(/\((.+)\)/);
      return match ? match[1].trim() : null;
    }

    // Custom: return the full captured group
    const regex = new RegExp(this.pattern.source);
    const match = marker.match(regex);
    return match && match[1] ? match[1] : marker;
  }

  // ─── Private: Citation Actions ──────────────────────────────────────────

  private stripCitation(
    text: string,
    citation: { marker: string; position: number }
  ): string {
    const before = text.slice(0, citation.position);
    const after = text.slice(citation.position + citation.marker.length);
    return before + after;
  }

  private flagCitation(
    text: string,
    citation: { marker: string; position: number }
  ): string {
    const flagged = citation.marker.replace(/\]$/, ' \u26a0\ufe0f unverified]');
    const before = text.slice(0, citation.position);
    const after = text.slice(citation.position + citation.marker.length);
    return before + flagged + after;
  }

  // ─── Private: Context ─────────────────────────────────────────────────

  private getSurroundingContext(text: string, position: number, windowSize: number = 80): string {
    const start = Math.max(0, position - windowSize);
    const end = Math.min(text.length, position + windowSize);
    return text.slice(start, end).trim();
  }
}
