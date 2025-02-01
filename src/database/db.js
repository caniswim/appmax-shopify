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
    this.db.run(`
      CREATE TABLE IF NOT EXISTS orders (
        appmax_id INTEGER PRIMARY KEY,
        shopify_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, (err) => {
      if (err) {
        logger.error('Erro ao criar tabela orders:', err);
      } else {
        logger.info('Tabela orders criada/verificada com sucesso');
      }
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
}

module.exports = new Database(); 