const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const logger = require('../utils/logger');

class Database {
  constructor() {
    this.db = new sqlite3.Database(
      path.join(__dirname, 'orders.db'),
      (err) => {
        if (err) {
          logger.error('Erro ao conectar ao banco de dados:', err);
        } else {
          logger.info('Conectado ao banco de dados SQLite');
          this.init();
        }
      }
    );
  }

  init() {
    this.db.serialize(() => {
      // Tabela de pedidos existente
      this.db.run(`
        CREATE TABLE IF NOT EXISTS orders (
          appmax_id INTEGER PRIMARY KEY,
          shopify_id TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Nova tabela para a fila
      this.db.run(`
        CREATE TABLE IF NOT EXISTS request_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          appmax_id INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          status TEXT NOT NULL,
          financial_status TEXT NOT NULL,
          request_data TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          processed_at DATETIME,
          attempts INTEGER DEFAULT 0,
          error TEXT,
          FOREIGN KEY (appmax_id) REFERENCES orders(appmax_id)
        )
      `, (err) => {
        if (err) {
          logger.error('Erro ao criar tabela request_queue:', err);
        } else {
          logger.info('Tabelas criadas/verificadas com sucesso');
        }
      });
    });
  }

  async findShopifyOrderId(appmaxId) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT shopify_id FROM orders WHERE appmax_id = ?',
        [appmaxId],
        (err, row) => {
          if (err) {
            logger.error('Erro ao buscar pedido:', err);
            reject(err);
          } else {
            resolve(row ? row.shopify_id : null);
          }
        }
      );
    });
  }

  async saveOrderMapping(appmaxId, shopifyId) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO orders (appmax_id, shopify_id) 
         VALUES (?, ?)
         ON CONFLICT(appmax_id) DO UPDATE SET 
         shopify_id = excluded.shopify_id,
         updated_at = CURRENT_TIMESTAMP`,
        [appmaxId, shopifyId],
        (err) => {
          if (err) {
            logger.error('Erro ao salvar mapeamento de pedido:', err);
            reject(err);
          } else {
            logger.info(`Mapeamento salvo: Appmax #${appmaxId} -> Shopify #${shopifyId}`);
            resolve();
          }
        }
      );
    });
  }

  async saveQueueRequest({ appmaxId, eventType, status, financialStatus, requestData }) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO request_queue (
          appmax_id, event_type, status, financial_status, request_data
        ) VALUES (?, ?, ?, ?, ?)`,
        [appmaxId, eventType, status, financialStatus, JSON.stringify(requestData)],
        function(err) {
          if (err) {
            logger.error('Erro ao salvar requisição na fila:', err);
            reject(err);
          } else {
            logger.info(`Requisição salva na fila: ID ${this.lastID}, Appmax #${appmaxId}`);
            resolve(this.lastID);
          }
        }
      );
    });
  }

  async getUnprocessedRequests() {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT * FROM request_queue 
         WHERE processed_at IS NULL 
         AND attempts < 3
         ORDER BY created_at ASC`,
        (err, rows) => {
          if (err) {
            logger.error('Erro ao buscar requisições não processadas:', err);
            reject(err);
          } else {
            resolve(rows.map(row => ({
              ...row,
              request_data: JSON.parse(row.request_data)
            })));
          }
        }
      );
    });
  }

  async markRequestAsProcessed(requestId, error = null) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE request_queue 
         SET processed_at = CURRENT_TIMESTAMP,
         attempts = attempts + 1,
         error = ?
         WHERE id = ?`,
        [error, requestId],
        (err) => {
          if (err) {
            logger.error('Erro ao marcar requisição como processada:', err);
            reject(err);
          } else {
            resolve();
          }
        }
      );
    });
  }

  async getRequestStatus(requestId) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT processed_at, error FROM request_queue WHERE id = ?',
        [requestId],
        (err, row) => {
          if (err) {
            logger.error('Erro ao buscar status da requisição:', err);
            reject(err);
          } else {
            resolve(row || { processed_at: null, error: null });
          }
        }
      );
    });
  }
}

module.exports = new Database(); 