import type { Store } from '../types.js';

export class ReconciliationRunner {
  constructor(private store: Store) {}

  async applyPendingDecisions(dryRun = false): Promise<{ applied: number; skipped: number; errors: number }> {
    let applied = 0;
    let skipped = 0;
    let errors = 0;

    this.store.markNoopLogsApplied();

    const pending = this.store.getPendingConsolidationActions();

    for (const entry of pending) {
      const srcStatus = this.store.getDocumentActiveStatus(entry.document_id);
      if (!srcStatus) {
        this.store.markConsolidationLogError(entry.id, 'source document not found');
        errors++;
        continue;
      }
      if (!srcStatus.active) {
        this.store.markConsolidationLogError(entry.id, 'source document inactive');
        errors++;
        continue;
      }
      if (srcStatus.supersededBy != null) {
        this.store.markConsolidationLogError(entry.id, 'source document already superseded');
        errors++;
        continue;
      }

      const tgtStatus = this.store.getDocumentActiveStatus(entry.target_doc_id);
      if (!tgtStatus) {
        this.store.markConsolidationLogError(entry.id, 'target document not found');
        errors++;
        continue;
      }
      if (!tgtStatus.active) {
        this.store.markConsolidationLogError(entry.id, 'target document inactive');
        errors++;
        continue;
      }

      if (dryRun) {
        skipped++;
        continue;
      }

      try {
        this.store.supersedeDocument(entry.document_id, entry.target_doc_id);
        this.store.markConsolidationLogApplied(entry.id);
        applied++;
      } catch (err) {
        this.store.markConsolidationLogError(entry.id, err instanceof Error ? err.message : String(err));
        errors++;
      }
    }

    return { applied, skipped, errors };
  }
}
