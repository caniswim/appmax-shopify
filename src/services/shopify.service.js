const axios = require('axios');
const logger = require('../utils/logger');

class ShopifyService {
  constructor() {
    this.client = axios.create({
      baseURL: `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2024-01`,
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    });
  }

  async createOrUpdateOrder({ appmaxOrder, status, financialStatus }) {
    try {
      // Verifica se o pedido já existe na Shopify
      const existingOrder = await this.findOrderByAppmaxId(appmaxOrder.id);
      
      if (existingOrder) {
        return this.updateOrder(existingOrder.id, { appmaxOrder, status, financialStatus });
      }

      const orderData = this.formatOrderData(appmaxOrder, status, financialStatus);
      const { data } = await this.client.post('/orders.json', orderData);
      
      return data.order;
    } catch (error) {
      logger.error('Erro ao criar/atualizar pedido na Shopify:', error);
      throw error;
    }
  }

  formatOrderData(appmaxOrder, status, financialStatus) {
    const lineItems = [];

    if (appmaxOrder.bundles && Array.isArray(appmaxOrder.bundles)) {
      appmaxOrder.bundles.forEach(bundle => {
        if (bundle.products) {
          bundle.products.forEach(product => {
            lineItems.push({
              title: product.name,
              quantity: product.quantity,
              price: product.price,
              sku: product.sku
            });
          });
        }
      });
    }

    return {
      order: {
        line_items: lineItems,
        customer: {
          first_name: appmaxOrder.customer.firstname,
          last_name: appmaxOrder.customer.lastname,
          email: appmaxOrder.customer.email,
          phone: appmaxOrder.customer.telephone
        },
        shipping_address: {
          first_name: appmaxOrder.customer.firstname,
          last_name: appmaxOrder.customer.lastname,
          address1: appmaxOrder.customer.address_street,
          address2: appmaxOrder.customer.address_street_complement,
          city: appmaxOrder.customer.address_city,
          province: appmaxOrder.customer.address_state,
          zip: appmaxOrder.customer.postcode,
          country: 'BR'
        },
        financial_status: financialStatus,
        note: `Pedido Appmax #${appmaxOrder.id}`,
        note_attributes: [
          {
            name: 'appmax_id',
            value: appmaxOrder.id.toString()
          }
        ]
      }
    };
  }

  async findOrderByAppmaxId(appmaxId) {
    try {
      const { data } = await this.client.get('/orders.json', {
        params: {
          note: `Pedido Appmax #${appmaxId}`
        }
      });

      return data.orders.find(order => 
        order.note_attributes.some(attr => 
          attr.name === 'appmax_id' && attr.value === appmaxId.toString()
        )
      );
    } catch (error) {
      logger.error('Erro ao buscar pedido na Shopify:', error);
      throw error;
    }
  }

  async updateOrder(orderId, { appmaxOrder, status, financialStatus }) {
    try {
      const orderData = this.formatOrderData(appmaxOrder, status, financialStatus);
      const { data } = await this.client.put(`/orders/${orderId}.json`, orderData);
      return data.order;
    } catch (error) {
      logger.error('Erro ao atualizar pedido na Shopify:', error);
      throw error;
    }
  }

  async cancelOrder(appmaxOrder) {
    try {
      const existingOrder = await this.findOrderByAppmaxId(appmaxOrder.id);
      
      if (!existingOrder) {
        logger.info(`Pedido Appmax #${appmaxOrder.id} não encontrado na Shopify para cancelamento`);
        return null;
      }

      const { data } = await this.client.post(`/orders/${existingOrder.id}/cancel.json`);
      return data.order;
    } catch (error) {
      logger.error('Erro ao cancelar pedido na Shopify:', error);
      throw error;
    }
  }

  async refundOrder(appmaxOrder) {
    try {
      const existingOrder = await this.findOrderByAppmaxId(appmaxOrder.id);
      
      if (!existingOrder) {
        logger.info(`Pedido Appmax #${appmaxOrder.id} não encontrado na Shopify para reembolso`);
        return null;
      }

      // Busca as transações do pedido
      const { data: transactionsData } = await this.client.get(
        `/orders/${existingOrder.id}/transactions.json`
      );

      // Encontra a transação de pagamento
      const paymentTransaction = transactionsData.transactions.find(
        t => t.kind === 'sale' || t.kind === 'capture'
      );

      if (!paymentTransaction) {
        throw new Error('Transação de pagamento não encontrada');
      }

      // Cria o reembolso
      const refundData = {
        refund: {
          currency: existingOrder.currency,
          notify: true,
          note: `Reembolso automático - Appmax #${appmaxOrder.id}`,
          transactions: [{
            parent_id: paymentTransaction.id,
            amount: existingOrder.total_price,
            kind: 'refund'
          }]
        }
      };

      const { data } = await this.client.post(
        `/orders/${existingOrder.id}/refunds.json`,
        refundData
      );

      return data.refund;
    } catch (error) {
      logger.error('Erro ao reembolsar pedido na Shopify:', error);
      throw error;
    }
  }
}

module.exports = new ShopifyService(); 