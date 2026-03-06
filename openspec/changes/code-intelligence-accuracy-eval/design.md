## Context

nano-brain has code intelligence capabilities: Tree-sitter AST parsing, symbol graph (code_symbols, symbol_edges tables), flow detection (execution_flows, flow_steps tables), and 3 MCP tools (code_context, code_impact, code_detect_changes). We have 99 unit tests that verify individual functions work correctly, but no end-to-end accuracy evaluation.

Current state:
- Unit tests verify: "does this function return expected output for this input?"
- Missing: "does the full pipeline produce CORRECT results on real code?"
- Edge types: CALLS (confidence 0.8-1.0), EXTENDS, IMPLEMENTS
- Flow types: intra_community, cross_community
- Languages: TypeScript, JavaScript (via TSX parser), Python

Existing bench infrastructure:
- `src/bench.ts`: CLI bench with --save/--compare for regression tracking
- `test/bench/fixtures.ts`: Shared fixture setup with deterministic RNG
- Pattern: save JSON baselines, compare across runs, human-readable + JSON output

## Goals / Non-Goals

**Goals:**
- Measure precision, recall, and F1 for symbol extraction, edge resolution, flow detection
- Create golden fixtures with manually-defined ground truth that catch real bugs
- Enable regression tracking: detect accuracy degradation across commits
- Measure confidence calibration: verify 0.8 confidence means ~80% correct

**Non-Goals:**
- Performance benchmarking (already covered by existing bench infrastructure)
- Testing individual functions (already covered by unit tests)
- Supporting languages beyond TypeScript/JavaScript and Python
- Automated ground truth generation (defeats the purpose)

## Decisions

### Decision 1: Golden Fixture Approach

**Choice:** Create small but realistic codebases with manually-defined ground truth JSON.

**Alternatives considered:**
- A) Use existing open-source projects as fixtures → Rejected: ground truth would need to be manually verified anyway, and real projects are too large
- B) Generate synthetic code programmatically → Rejected: synthetic code doesn't catch real-world edge cases
- C) Use snapshot testing (record actual output as ground truth) → Rejected: doesn't verify correctness, just consistency

**Rationale:** Golden fixtures must be small enough to manually verify every symbol, edge, and flow, but realistic enough to include edge cases: cross-file calls, inheritance, re-exports, dynamic imports, method chaining, callbacks, etc.

### Decision 2: Fixture Structure

**Choice:** Each golden fixture is a directory containing:
```
test/eval/fixtures/<fixture-name>/
├── src/                    # Source code files
│   ├── index.ts
│   └── ...
├── ground-truth.json       # Expected symbols, edges, flows
└── fixture.json            # Metadata (language, description)
```

**Ground truth JSON schema:**
```typescript
interface GroundTruth {
  symbols: Array<{
    name: string
    kind: 'function' | 'class' | 'method' | 'variable' | 'interface' | 'type'
    filePath: string  // relative to fixture src/
    startLine: number
    exported: boolean
  }>
  edges: Array<{
    source: string  // "file:name" format
    target: string  // "file:name" format
    edgeType: 'CALLS' | 'EXTENDS' | 'IMPLEMENTS'
    expectedConfidence?: { min: number; max: number }  // for CALLS edges
  }>
  flows: Array<{
    label: string
    flowType: 'intra_community' | 'cross_community'
    entrySymbol: string  // "file:name" format
    terminalSymbol: string
    expectedSteps: string[]  // ordered list of "file:name"
  }>
}
```

### Decision 3: Evaluation Harness Architecture

**Choice:** vitest-based evaluation that runs as `npm run eval` or `vitest run test/eval/`.

**Flow:**
1. Load golden fixture
2. Create temporary database
3. Run full indexing pipeline: parse → extract symbols → resolve edges → detect flows
4. Compare output vs ground truth
5. Calculate metrics per dimension
6. Output results (human-readable + JSON)

**Rationale:** Using vitest allows integration with existing test infrastructure, CI, and familiar patterns. Separate from unit tests to avoid conflating correctness testing with accuracy measurement.

### Decision 4: Metrics Calculation

**Choice:** Standard precision/recall/F1 per dimension.

**Symbols:**
- True Positive: symbol in output matches ground truth (name, kind, file, line within ±2)
- False Positive: symbol in output not in ground truth
- False Negative: symbol in ground truth not in output

**Edges:**
- True Positive: edge in output matches ground truth (source, target, type)
- False Positive: edge in output not in ground truth
- False Negative: edge in ground truth not in output

**Flows:**
- True Positive: flow in output matches ground truth (entry, terminal, steps match ≥80%)
- Partial match scoring for step sequences

**Confidence calibration:**
- Group CALLS edges by confidence bucket (0.8-0.85, 0.85-0.9, 0.9-0.95, 0.95-1.0)
- For each bucket, calculate actual accuracy
- Report calibration error: |expected - actual| per bucket

### Decision 5: Regression Tracking

**Choice:** Follow existing bench.ts pattern with --save/--compare.

**Storage:** `~/.nano-brain/eval-baselines/<timestamp>.json`

**Comparison output:**
```
Accuracy Comparison
═══════════════════════════════════════════════════
  Dimension        Baseline    Current     Delta
  ──────────────   ──────────  ──────────  ───────
  Symbols F1       0.95        0.93        -0.02 ↓
  Edges F1         0.88        0.90        +0.02 ↑
  Flows F1         0.82        0.82        ≈ same
```

### Decision 6: Golden Fixture Complexity

**Choice:** Create 3 fixtures of increasing complexity:

1. **ts-simple**: Single-file TypeScript with basic function calls
   - 5-10 symbols, 3-5 edges, 1-2 flows
   - Tests: basic symbol extraction, direct calls

2. **ts-complex**: Multi-file TypeScript with classes, inheritance, re-exports
   - 20-30 symbols, 15-25 edges, 5-10 flows
   - Tests: cross-file resolution, EXTENDS/IMPLEMENTS, re-exports, method chaining

3. **py-mixed**: Python with classes, decorators, dynamic patterns
   - 15-20 symbols, 10-15 edges, 3-5 flows
   - Tests: Python-specific patterns, decorator handling, dynamic imports

## Risks / Trade-offs

**[Risk] Ground truth maintenance burden** → Mitigation: Keep fixtures small (max 30 symbols each). Document each fixture's purpose. Review ground truth in PRs.

**[Risk] Flaky line number matching** → Mitigation: Allow ±2 line tolerance for symbol matching. Use name+kind+file as primary key.

**[Risk] Over-fitting to fixtures** → Mitigation: Fixtures should represent real patterns, not edge cases we specifically handle. Add new fixtures when real bugs are found.

**[Risk] Confidence calibration requires many samples** → Mitigation: Start with aggregate calibration across all fixtures. Add per-fixture calibration later if needed.

**[Trade-off] Manual ground truth vs automated** → Accepted: Manual verification is the point. Automated ground truth would just test consistency, not correctness.

**[Trade-off] Small fixtures vs realistic size** → Accepted: Small fixtures enable complete manual verification. Real-world accuracy can be spot-checked separately.
