import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { clusterSymbols, getClusterLabels } from '../src/graph.js'

describe('Symbol-level clustering', () => {
  let db: Database.Database
  const projectHash = 'clustertest1'

  beforeAll(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE IF NOT EXISTS code_symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        exported INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL,
        project_hash TEXT NOT NULL DEFAULT 'global',
        cluster_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_code_symbols_file ON code_symbols(file_path, project_hash);
      CREATE INDEX IF NOT EXISTS idx_code_symbols_name ON code_symbols(name, kind);
      CREATE INDEX IF NOT EXISTS idx_code_symbols_project ON code_symbols(project_hash);

      CREATE TABLE IF NOT EXISTS symbol_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL,
        target_id INTEGER NOT NULL,
        edge_type TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        project_hash TEXT NOT NULL DEFAULT 'global',
        FOREIGN KEY (source_id) REFERENCES code_symbols(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES code_symbols(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_symbol_edges_source ON symbol_edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_symbol_edges_target ON symbol_edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_symbol_edges_type ON symbol_edges(edge_type);
    `)
  })

  afterAll(() => {
    db.close()
  })

  beforeEach(() => {
    db.exec('DELETE FROM symbol_edges')
    db.exec('DELETE FROM code_symbols')
  })

  function insertSymbol(name: string, kind: string, filePath: string): number {
    const stmt = db.prepare(`
      INSERT INTO code_symbols (name, kind, file_path, start_line, end_line, exported, content_hash, project_hash)
      VALUES (?, ?, ?, 1, 10, 1, 'hash123', ?)
    `)
    const result = stmt.run(name, kind, filePath, projectHash)
    return Number(result.lastInsertRowid)
  }

  function insertEdge(sourceId: number, targetId: number, edgeType: string = 'CALLS'): void {
    const stmt = db.prepare(`
      INSERT INTO symbol_edges (source_id, target_id, edge_type, confidence, project_hash)
      VALUES (?, ?, ?, 1.0, ?)
    `)
    stmt.run(sourceId, targetId, edgeType, projectHash)
  }

  function getSymbolCluster(symbolId: number): number | null {
    const row = db.prepare('SELECT cluster_id FROM code_symbols WHERE id = ?').get(symbolId) as { cluster_id: number | null } | undefined
    return row?.cluster_id ?? null
  }

  describe('clusterSymbols', () => {
    it('should cluster symbols and assign cluster IDs', () => {
      const authLogin = insertSymbol('login', 'function', '/src/auth/login.ts')
      const authLogout = insertSymbol('logout', 'function', '/src/auth/logout.ts')
      const authValidate = insertSymbol('validateToken', 'function', '/src/auth/validate.ts')
      const authSession = insertSymbol('createSession', 'function', '/src/auth/session.ts')
      const authRefresh = insertSymbol('refreshToken', 'function', '/src/auth/refresh.ts')

      const paymentProcess = insertSymbol('processPayment', 'function', '/src/payment/process.ts')
      const paymentRefund = insertSymbol('refundPayment', 'function', '/src/payment/refund.ts')
      const paymentValidate = insertSymbol('validateCard', 'function', '/src/payment/validate.ts')
      const paymentCharge = insertSymbol('chargeCard', 'function', '/src/payment/charge.ts')
      const paymentReceipt = insertSymbol('generateReceipt', 'function', '/src/payment/receipt.ts')

      const userCreate = insertSymbol('createUser', 'function', '/src/user/create.ts')
      const userUpdate = insertSymbol('updateUser', 'function', '/src/user/update.ts')
      const userDelete = insertSymbol('deleteUser', 'function', '/src/user/delete.ts')
      const userFind = insertSymbol('findUser', 'function', '/src/user/find.ts')
      const userList = insertSymbol('listUsers', 'function', '/src/user/list.ts')

      insertEdge(authLogin, authValidate)
      insertEdge(authLogin, authSession)
      insertEdge(authLogout, authSession)
      insertEdge(authRefresh, authValidate)
      insertEdge(authRefresh, authSession)
      insertEdge(authValidate, authSession)

      insertEdge(paymentProcess, paymentValidate)
      insertEdge(paymentProcess, paymentCharge)
      insertEdge(paymentProcess, paymentReceipt)
      insertEdge(paymentRefund, paymentValidate)
      insertEdge(paymentRefund, paymentReceipt)
      insertEdge(paymentCharge, paymentValidate)

      insertEdge(userCreate, userFind)
      insertEdge(userUpdate, userFind)
      insertEdge(userDelete, userFind)
      insertEdge(userList, userFind)
      insertEdge(userCreate, userList)

      const result = clusterSymbols(db, projectHash)

      expect(result.clusterCount).toBeGreaterThanOrEqual(2)
      expect(result.symbolsAssigned).toBeGreaterThan(0)

      const authCluster = getSymbolCluster(authLogin)
      const paymentCluster = getSymbolCluster(paymentProcess)
      const userCluster = getSymbolCluster(userCreate)

      expect(authCluster).not.toBeNull()
      expect(paymentCluster).not.toBeNull()
      expect(userCluster).not.toBeNull()

      expect(getSymbolCluster(authLogout)).toBe(authCluster)
      expect(getSymbolCluster(authValidate)).toBe(authCluster)
      expect(getSymbolCluster(authSession)).toBe(authCluster)

      expect(getSymbolCluster(userUpdate)).toBe(userCluster)
      expect(getSymbolCluster(userDelete)).toBe(userCluster)
      expect(getSymbolCluster(userFind)).toBe(userCluster)
    })

    it('should produce distinct clusters for isolated module groups', () => {
      const authLogin = insertSymbol('login', 'function', '/src/auth/login.ts')
      const authLogout = insertSymbol('logout', 'function', '/src/auth/logout.ts')
      const authValidate = insertSymbol('validateToken', 'function', '/src/auth/validate.ts')
      const authSession = insertSymbol('createSession', 'function', '/src/auth/session.ts')
      const authRefresh = insertSymbol('refreshToken', 'function', '/src/auth/refresh.ts')

      const paymentProcess = insertSymbol('processPayment', 'function', '/src/payment/process.ts')
      const paymentRefund = insertSymbol('refundPayment', 'function', '/src/payment/refund.ts')
      const paymentValidate = insertSymbol('validateCard', 'function', '/src/payment/validate.ts')
      const paymentCharge = insertSymbol('chargeCard', 'function', '/src/payment/charge.ts')
      const paymentReceipt = insertSymbol('generateReceipt', 'function', '/src/payment/receipt.ts')

      insertEdge(authLogin, authValidate)
      insertEdge(authLogin, authSession)
      insertEdge(authLogout, authSession)
      insertEdge(authRefresh, authValidate)
      insertEdge(authRefresh, authSession)
      insertEdge(authValidate, authSession)

      insertEdge(paymentProcess, paymentValidate)
      insertEdge(paymentProcess, paymentCharge)
      insertEdge(paymentProcess, paymentReceipt)
      insertEdge(paymentRefund, paymentValidate)
      insertEdge(paymentRefund, paymentReceipt)
      insertEdge(paymentCharge, paymentValidate)

      const result = clusterSymbols(db, projectHash)

      expect(result.clusterCount).toBeGreaterThanOrEqual(2)
      expect(result.symbolsAssigned).toBe(10)

      const authCluster = getSymbolCluster(authLogin)
      const paymentCluster = getSymbolCluster(paymentProcess)

      expect(authCluster).not.toBeNull()
      expect(paymentCluster).not.toBeNull()
      expect(authCluster).not.toBe(paymentCluster)

      expect(getSymbolCluster(authLogout)).toBe(authCluster)
      expect(getSymbolCluster(authValidate)).toBe(authCluster)
      expect(getSymbolCluster(authSession)).toBe(authCluster)
      expect(getSymbolCluster(authRefresh)).toBe(authCluster)
    })

    it('should return zero clusters when there are too few symbols', () => {
      const sym1 = insertSymbol('func1', 'function', '/src/a.ts')
      const sym2 = insertSymbol('func2', 'function', '/src/b.ts')

      insertEdge(sym1, sym2)

      const result = clusterSymbols(db, projectHash)

      expect(result.clusterCount).toBe(0)
      expect(result.symbolsAssigned).toBe(0)
    })

    it('should return zero clusters when there are no CALLS edges', () => {
      insertSymbol('func1', 'function', '/src/a.ts')
      insertSymbol('func2', 'function', '/src/b.ts')
      insertSymbol('func3', 'function', '/src/c.ts')
      insertSymbol('func4', 'function', '/src/d.ts')
      insertSymbol('func5', 'function', '/src/e.ts')

      const result = clusterSymbols(db, projectHash)

      expect(result.clusterCount).toBe(0)
      expect(result.symbolsAssigned).toBe(0)
    })

    it('should handle EXTENDS edges separately (not used for clustering)', () => {
      const base = insertSymbol('BaseClass', 'class', '/src/base.ts')
      const derived1 = insertSymbol('Derived1', 'class', '/src/derived1.ts')
      const derived2 = insertSymbol('Derived2', 'class', '/src/derived2.ts')
      const derived3 = insertSymbol('Derived3', 'class', '/src/derived3.ts')
      const derived4 = insertSymbol('Derived4', 'class', '/src/derived4.ts')
      const derived5 = insertSymbol('Derived5', 'class', '/src/derived5.ts')

      insertEdge(derived1, base, 'EXTENDS')
      insertEdge(derived2, base, 'EXTENDS')
      insertEdge(derived3, base, 'EXTENDS')
      insertEdge(derived4, base, 'EXTENDS')
      insertEdge(derived5, base, 'EXTENDS')

      const result = clusterSymbols(db, projectHash)

      expect(result.clusterCount).toBe(0)
    })
  })

  describe('getClusterLabels', () => {
    it('should generate labels from dominant directory names', () => {
      const authLogin = insertSymbol('login', 'function', '/src/auth/login.ts')
      const authLogout = insertSymbol('logout', 'function', '/src/auth/logout.ts')
      const authValidate = insertSymbol('validateToken', 'function', '/src/auth/validate.ts')
      const authSession = insertSymbol('createSession', 'function', '/src/auth/session.ts')
      const authRefresh = insertSymbol('refreshToken', 'function', '/src/auth/refresh.ts')

      const paymentProcess = insertSymbol('processPayment', 'function', '/src/payment/process.ts')
      const paymentRefund = insertSymbol('refundPayment', 'function', '/src/payment/refund.ts')
      const paymentValidate = insertSymbol('validateCard', 'function', '/src/payment/validate.ts')
      const paymentCharge = insertSymbol('chargeCard', 'function', '/src/payment/charge.ts')
      const paymentReceipt = insertSymbol('generateReceipt', 'function', '/src/payment/receipt.ts')

      insertEdge(authLogin, authValidate)
      insertEdge(authLogin, authSession)
      insertEdge(authLogout, authSession)
      insertEdge(authRefresh, authValidate)
      insertEdge(authRefresh, authSession)
      insertEdge(authValidate, authSession)

      insertEdge(paymentProcess, paymentValidate)
      insertEdge(paymentProcess, paymentCharge)
      insertEdge(paymentProcess, paymentReceipt)
      insertEdge(paymentRefund, paymentValidate)
      insertEdge(paymentRefund, paymentReceipt)
      insertEdge(paymentCharge, paymentValidate)

      clusterSymbols(db, projectHash)

      const labels = getClusterLabels(db, projectHash)

      expect(labels.size).toBeGreaterThan(0)

      const labelValues = Array.from(labels.values())
      const hasAuthLabel = labelValues.some(l => l.includes('auth'))
      const hasPaymentLabel = labelValues.some(l => l.includes('payment'))

      expect(hasAuthLabel || hasPaymentLabel).toBe(true)
    })

    it('should return empty map when no clusters exist', () => {
      insertSymbol('func1', 'function', '/src/a.ts')
      insertSymbol('func2', 'function', '/src/b.ts')

      const labels = getClusterLabels(db, projectHash)

      expect(labels.size).toBe(0)
    })

    it('should handle mixed directory symbols with kind suffix', () => {
      const func1 = insertSymbol('helper1', 'function', '/src/utils/helper1.ts')
      const func2 = insertSymbol('helper2', 'function', '/src/lib/helper2.ts')
      const func3 = insertSymbol('helper3', 'function', '/src/common/helper3.ts')
      const func4 = insertSymbol('helper4', 'function', '/src/shared/helper4.ts')
      const func5 = insertSymbol('helper5', 'function', '/src/misc/helper5.ts')

      insertEdge(func1, func2)
      insertEdge(func2, func3)
      insertEdge(func3, func4)
      insertEdge(func4, func5)
      insertEdge(func5, func1)

      clusterSymbols(db, projectHash)

      const labels = getClusterLabels(db, projectHash)

      for (const label of labels.values()) {
        expect(typeof label).toBe('string')
        expect(label.length).toBeGreaterThan(0)
      }
    })
  })

  describe('integration with different module structures', () => {
    it('should handle deeply nested directory structures', () => {
      const api1 = insertSymbol('getUsers', 'function', '/src/api/v1/users/get.ts')
      const api2 = insertSymbol('createUser', 'function', '/src/api/v1/users/create.ts')
      const api3 = insertSymbol('updateUser', 'function', '/src/api/v1/users/update.ts')
      const api4 = insertSymbol('deleteUser', 'function', '/src/api/v1/users/delete.ts')
      const api5 = insertSymbol('listUsers', 'function', '/src/api/v1/users/list.ts')

      const svc1 = insertSymbol('userService', 'function', '/src/services/user/service.ts')
      const svc2 = insertSymbol('userValidator', 'function', '/src/services/user/validator.ts')
      const svc3 = insertSymbol('userMapper', 'function', '/src/services/user/mapper.ts')
      const svc4 = insertSymbol('userCache', 'function', '/src/services/user/cache.ts')
      const svc5 = insertSymbol('userLogger', 'function', '/src/services/user/logger.ts')

      insertEdge(api1, svc1)
      insertEdge(api2, svc1)
      insertEdge(api2, svc2)
      insertEdge(api3, svc1)
      insertEdge(api3, svc2)
      insertEdge(api4, svc1)
      insertEdge(api5, svc1)

      insertEdge(svc1, svc2)
      insertEdge(svc1, svc3)
      insertEdge(svc1, svc4)
      insertEdge(svc1, svc5)
      insertEdge(svc2, svc3)

      const result = clusterSymbols(db, projectHash)

      expect(result.symbolsAssigned).toBeGreaterThan(0)

      const labels = getClusterLabels(db, projectHash)
      expect(labels.size).toBeGreaterThan(0)
    })
  })
})
