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
          // Verifica se a tabela existe
          this.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='orders'", async (err, row) => {
            if (err) {
              logger.error('Erro ao verificar tabela:', err);
              reject(err);
              return;
            }

            if (!row) {
              // Cria a tabela se não existir
              this.db.run(`
                CREATE TABLE orders (
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
            } else {
              // Verifica e adiciona colunas faltantes
              const columns = await this.getTableColumns('orders');
              const missingColumns = {
                woocommerce_id: 'TEXT',
                session_id: 'TEXT',
                platform: 'TEXT',
                metadata: 'TEXT'
              };

              for (const [column, type] of Object.entries(missingColumns)) {
                if (!columns.includes(column)) {
                  try {
                    await this.addColumn('orders', column, type);
                    logger.info(`Coluna ${column} adicionada com sucesso`);
                  } catch (error) {
                    logger.warn(`Erro ao adicionar coluna ${column}:`, error);
                  }
                }
              }
            }

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
          });
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  // Método auxiliar para obter colunas de uma tabela
  async getTableColumns(tableName) {
    return new Promise((resolve, reject) => {
      this.db.all(`PRAGMA table_info(${tableName})`, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows.map(row => row.name));
        }
      });
    });
  }

  // Método auxiliar para adicionar coluna
  async addColumn(tableName, columnName, columnType) {
    return new Promise((resolve, reject) => {
      this.db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
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
        `INSERT INTO orders (appmax_id, shopify_id, platform) 
         VALUES (?, ?, ?)
         ON CONFLICT(appmax_id) DO UPDATE SET 
         shopify_id = excluded.shopify_id,
         platform = excluded.platform,
         updated_at = CURRENT_TIMESTAMP`,
        [appmaxId, shopifyId, 'shopify'],
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

    // Garante que temos pelo menos um ID para identificar o pedido
    if (!appmaxId && !shopifyId && !woocommerceId && !sessionId) {
      throw new Error('Pelo menos um ID (appmax, shopify, woocommerce ou session) é obrigatório');
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
          const updateFields = [];
          const updateValues = [];

          // Adiciona campos apenas se tiverem valor
          if (appmaxId) {
            updateFields.push('appmax_id = ?');
            updateValues.push(appmaxId);
          }
          if (shopifyId) {
            updateFields.push('shopify_id = ?');
            updateValues.push(shopifyId);
          }
          if (woocommerceId) {
            updateFields.push('woocommerce_id = ?');
            updateValues.push(woocommerceId);
          }
          if (sessionId) {
            updateFields.push('session_id = ?');
            updateValues.push(sessionId);
          }

          updateFields.push('platform = ?');
          updateFields.push('status = ?');
          updateFields.push('metadata = ?');
          updateFields.push('updated_at = CURRENT_TIMESTAMP');
          updateValues.push(platform, status, metadataStr);

          const query = `
            UPDATE orders 
            SET ${updateFields.join(', ')}
            WHERE id = ?
          `;
          updateValues.push(existingOrder.id);

          this.db.run(query, updateValues, (err) => {
            if (err) {
              logger.error('Erro ao atualizar pedido:', err);
              reject(err);
            } else {
              logger.info(`Pedido atualizado: ID ${existingOrder.id}`);
              resolve(existingOrder.id);
            }
          });
        } else {
          // Prepara campos e valores para inserção
          const fields = ['platform', 'status', 'metadata'];
          const values = [platform, status, metadataStr];
          const placeholders = ['?', '?', '?'];

          // Adiciona campos opcionais apenas se tiverem valor
          if (appmaxId) {
            fields.push('appmax_id');
            values.push(appmaxId);
            placeholders.push('?');
          }
          if (shopifyId) {
            fields.push('shopify_id');
            values.push(shopifyId);
            placeholders.push('?');
          }
          if (woocommerceId) {
            fields.push('woocommerce_id');
            values.push(woocommerceId);
            placeholders.push('?');
          }
          if (sessionId) {
            fields.push('session_id');
            values.push(sessionId);
            placeholders.push('?');
          }

          const query = `
            INSERT INTO orders (${fields.join(', ')})
            VALUES (${placeholders.join(', ')})
          `;

          this.db.run(query, values, function(err) {
            if (err) {
              logger.error('Erro ao inserir novo pedido:', err);
              reject(err);
            } else {
              logger.info(`Novo pedido inserido: ID ${this.lastID}`);
              resolve(this.lastID);
            }
          });
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

  async saveShopifyOrder(appmaxId, shopifyId, status = 'pending', metadata = {}) {
    return this.saveOrder({
      appmaxId,
      shopifyId,
      platform: 'shopify',
      status,
      metadata: {
        ...metadata,
        integration_type: 'shopify'
      }
    });
  }

  async saveAppmaxOrder(appmaxId, status = 'pending', metadata = {}) {
    // Verifica se é um evento que deve ser ignorado
    if (metadata.event === 'CustomerInterested') {
      logger.info(`Ignorando salvamento do evento ${metadata.event} para o pedido #${appmaxId}`);
      return null;
    }

    return this.saveOrder({
      appmaxId,
      platform: 'appmax',
      status,
      metadata: {
        ...metadata,
        integration_type: 'appmax'
      }
    });
  }

  /**
   * Atualiza os IDs relacionados a um pedido Appmax
   * @param {string} appmaxId - ID do pedido na Appmax
   * @param {Object} ids - Objeto com os IDs a serem atualizados
   * @returns {Promise<void>}
   */
  async updateOrderIds(appmaxId, { woocommerce_id, shopify_id, session_id }) {
    const db = await this.getConnection();
    
    try {
      // Prepara os campos e valores para atualização
      const updates = [];
      const values = [];
      
      if (woocommerce_id !== undefined) {
        updates.push('woocommerce_id = ?');
        values.push(woocommerce_id);
      }
      
      if (shopify_id !== undefined) {
        updates.push('shopify_id = ?');
        values.push(shopify_id);
      }
      
      if (session_id !== undefined) {
        updates.push('session_id = ?');
        values.push(session_id);
      }
      
      // Se não houver campos para atualizar, retorna
      if (updates.length === 0) {
        return;
      }
      
      // Adiciona o appmaxId aos valores
      values.push(appmaxId);
      
      // Monta e executa a query
      const query = `
        UPDATE orders 
        SET ${updates.join(', ')}
        WHERE appmax_id = ?
      `;
      
      await db.run(query, values);
      
      logger.info('IDs atualizados no banco:', {
        appmax_id: appmaxId,
        woocommerce_id,
        shopify_id,
        session_id,
        query,
        values
      });
      
    } catch (error) {
      logger.error('Erro ao atualizar IDs no banco:', {
        error: error.message,
        appmax_id: appmaxId,
        ids: { woocommerce_id, shopify_id, session_id }
      });
      throw error;
    }
  }
}

module.exports = new Database(); 