const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const logger = require('../utils/logger');

class Database {
  constructor() {
    this.initPromise = new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(
        path.join(__dirname, 'orders.db'),
        (err) => {
          if (err) {
            logger.error('Erro ao conectar ao banco de dados:', err);
            reject(err);
          } else {
            logger.info('Conectado ao banco de dados SQLite');
            this.init().then(resolve).catch(reject);
          }
        }
      );
    });
  }

  async init() {
    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        try {
          // Tabela de pedidos existente
          this.db.run(`
            CREATE TABLE IF NOT EXISTS orders (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              appmax_id INTEGER UNIQUE,
              shopify_id TEXT,
              woocommerce_id TEXT,
              session_id TEXT,
              platform TEXT NOT NULL,
              status TEXT,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              metadata TEXT
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
              reject(err);
            } else {
              logger.info('Tabelas criadas/verificadas com sucesso');
              resolve();
            }
          });
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  async waitForInit() {
    return this.initPromise;
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

  async findOrderById(id, type = 'appmax') {
    const fieldMap = {
      'appmax': 'appmax_id',
      'shopify': 'shopify_id',
      'woocommerce': 'woocommerce_id',
      'session': 'session_id'
    };

    const field = fieldMap[type] || 'id';
    
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT * FROM orders WHERE ${field} = ?`,
        [id],
        (err, row) => {
          if (err) {
            logger.error(`Erro ao buscar pedido por ${type}_id:`, err);
            reject(err);
          } else {
            if (row && row.metadata) {
              try {
                row.metadata = JSON.parse(row.metadata);
              } catch (e) {
                logger.warn(`Erro ao fazer parse do metadata do pedido ${row.id}:`, e);
                row.metadata = {};
              }
            }
            resolve(row);
          }
        }
      );
    });
  }

  async saveOrder({
    appmaxId = null,
    shopifyId = null,
    woocommerceId = null,
    sessionId = null,
    platform,
    status = 'pending',
    metadata = {}
  }) {
    if (!platform) {
      throw new Error('Platform é obrigatório');
    }

    const metadataStr = JSON.stringify(metadata);

    return new Promise((resolve, reject) => {
      // Primeiro tenta encontrar um pedido existente por qualquer um dos IDs
      const findExisting = async () => {
        if (appmaxId) return await this.findOrderById(appmaxId, 'appmax');
        if (shopifyId) return await this.findOrderById(shopifyId, 'shopify');
        if (woocommerceId) return await this.findOrderById(woocommerceId, 'woocommerce');
        if (sessionId) return await this.findOrderById(sessionId, 'session');
        return null;
      };

      findExisting().then(existingOrder => {
        if (existingOrder) {
          // Atualiza o pedido existente
          this.db.run(
            `UPDATE orders 
             SET appmax_id = COALESCE(?, appmax_id),
                 shopify_id = COALESCE(?, shopify_id),
                 woocommerce_id = COALESCE(?, woocommerce_id),
                 session_id = COALESCE(?, session_id),
                 platform = ?,
                 status = ?,
                 metadata = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [appmaxId, shopifyId, woocommerceId, sessionId, platform, status, metadataStr, existingOrder.id],
            (err) => {
              if (err) {
                logger.error('Erro ao atualizar pedido:', err);
                reject(err);
              } else {
                logger.info(`Pedido atualizado: ID ${existingOrder.id}`);
                resolve(existingOrder.id);
              }
            }
          );
        } else {
          // Insere novo pedido
          this.db.run(
            `INSERT INTO orders (
              appmax_id, shopify_id, woocommerce_id, session_id,
              platform, status, metadata
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [appmaxId, shopifyId, woocommerceId, sessionId, platform, status, metadataStr],
            function(err) {
              if (err) {
                logger.error('Erro ao inserir novo pedido:', err);
                reject(err);
              } else {
                logger.info(`Novo pedido inserido: ID ${this.lastID}`);
                resolve(this.lastID);
              }
            }
          );
        }
      }).catch(reject);
    });
  }

  async updateOrderStatus(orderId, status, metadata = {}) {
    return new Promise((resolve, reject) => {
      const currentMetadata = {};
      Object.assign(currentMetadata, metadata);
      
      this.db.run(
        `UPDATE orders 
         SET status = ?,
             metadata = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [status, JSON.stringify(currentMetadata), orderId],
        (err) => {
          if (err) {
            logger.error('Erro ao atualizar status do pedido:', err);
            reject(err);
          } else {
            resolve();
          }
        }
      );
    });
  }

  async getOrdersByDateRange(startDate, endDate, platform = null) {
    return new Promise((resolve, reject) => {
      let query = `
        SELECT * FROM orders 
        WHERE created_at BETWEEN ? AND ?
      `;
      const params = [startDate, endDate];

      if (platform) {
        query += ` AND platform = ?`;
        params.push(platform);
      }

      query += ` ORDER BY created_at DESC`;

      this.db.all(query, params, (err, rows) => {
        if (err) {
          logger.error('Erro ao buscar pedidos por data:', err);
          reject(err);
        } else {
          resolve(rows.map(row => ({
            ...row,
            metadata: row.metadata ? JSON.parse(row.metadata) : {}
          })));
        }
      });
    });
  }
}

module.exports = new Database(); 