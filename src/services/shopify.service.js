const axios = require('axios');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');

class ShopifyService {
  constructor() {
    this.client = axios.create({
      baseURL: `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2024-01`,
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    });

    // Adiciona interceptor para tratar erros
    this.client.interceptors.response.use(
      response => response,
      error => {
        if (error.response) {
          const { data, status } = error.response;
          logger.error('Erro na resposta da Shopify:', {
            status,
            errors: data.errors,
            body: error.config.data
          });
          
          // Trata erros específicos
          if (data.errors) {
            const errorMessages = [];
            Object.entries(data.errors).forEach(([field, messages]) => {
              errorMessages.push(`${field}: ${messages.join(', ')}`);
            });
            throw new AppError(
              `Erro de validação na Shopify: ${errorMessages.join('; ')}`,
              status
            );
          }
          
          throw new AppError(
            'Erro inesperado na API da Shopify',
            status
          );
        }
        throw error;
      }
    );
  }

  async createOrUpdateOrder({ appmaxOrder, status, financialStatus }) {
    try {
      // Validação dos dados necessários
      if (!appmaxOrder || !appmaxOrder.bundles) {
        throw new AppError('Dados do pedido Appmax inválidos', 400);
      }

      // Verifica se o pedido já existe na Shopify
      const existingOrder = await this.findOrderByAppmaxId(appmaxOrder.id);
      
      if (existingOrder) {
        return this.updateOrder(existingOrder.id, { appmaxOrder, status, financialStatus });
      }

      const orderData = this.formatOrderData(appmaxOrder, status, financialStatus);
      logger.info('Criando pedido na Shopify:', orderData);
      const { data } = await this.client.post('/orders.json', orderData);
      
      return data.order;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        `Erro ao criar/atualizar pedido na Shopify: ${error.message}`,
        error.response?.status || 500
      );
    }
  }

  formatPhoneNumber(phone) {
    if (!phone) return null;
    
    // Remove todos os caracteres não numéricos
    const numbers = phone.replace(/\D/g, '');
    
    // Verifica se é um número brasileiro (com ou sem +55)
    if (numbers.length === 11 || numbers.length === 13) {
      // Formato: +55 (XX) XXXXX-XXXX
      const ddd = numbers.slice(-11, -9);
      const firstPart = numbers.slice(-9, -4);
      const lastPart = numbers.slice(-4);
      return `+55 (${ddd}) ${firstPart}-${lastPart}`;
    } else if (numbers.length === 10 || numbers.length === 12) {
      // Formato: +55 (XX) XXXX-XXXX
      const ddd = numbers.slice(-10, -8);
      const firstPart = numbers.slice(-8, -4);
      const lastPart = numbers.slice(-4);
      return `+55 (${ddd}) ${firstPart}-${lastPart}`;
    }
    
    // Se não conseguir formatar, retorna null
    return null;
  }

  formatOrderData(appmaxOrder, status, financialStatus) {
    const lineItems = [];
    const formattedPhone = this.formatPhoneNumber(appmaxOrder.customer.telephone);

    if (appmaxOrder.bundles && Array.isArray(appmaxOrder.bundles)) {
      appmaxOrder.bundles.forEach(bundle => {
        if (bundle.products) {
          bundle.products.forEach(product => {
            lineItems.push({
              title: product.name,
              quantity: product.quantity,
              price: product.price,
              sku: product.sku,
              requires_shipping: true,
              taxable: true,
              fulfillment_service: 'manual',
              grams: 0
            });
          });
        }
      });
    }

    if (lineItems.length === 0) {
      throw new AppError('Pedido não contém produtos', 400);
    }

    return {
      order: {
        line_items: lineItems,
        email: appmaxOrder.customer.email,
        phone: formattedPhone,
        customer: {
          first_name: appmaxOrder.customer.firstname,
          last_name: appmaxOrder.customer.lastname,
          email: appmaxOrder.customer.email,
          phone: formattedPhone
        },
        shipping_address: {
          first_name: appmaxOrder.customer.firstname,
          last_name: appmaxOrder.customer.lastname,
          address1: appmaxOrder.customer.address_street,
          address2: appmaxOrder.customer.address_street_complement,
          city: appmaxOrder.customer.address_city,
          province: appmaxOrder.customer.address_state,
          zip: appmaxOrder.customer.postcode,
          country: 'BR',
          phone: formattedPhone
        },
        billing_address: {
          first_name: appmaxOrder.customer.firstname,
          last_name: appmaxOrder.customer.lastname,
          address1: appmaxOrder.customer.address_street,
          address2: appmaxOrder.customer.address_street_complement,
          city: appmaxOrder.customer.address_city,
          province: appmaxOrder.customer.address_state,
          zip: appmaxOrder.customer.postcode,
          country: 'BR',
          phone: formattedPhone
        },
        financial_status: financialStatus,
        fulfillment_status: null,
        currency: 'BRL',
        total_price: appmaxOrder.total,
        subtotal_price: appmaxOrder.total_products,
        total_tax: '0.00',
        total_discounts: appmaxOrder.discount || '0.00',
        shipping_lines: [{
          price: appmaxOrder.freight_value || '0.00',
          code: appmaxOrder.freight_type || 'Standard',
          title: appmaxOrder.freight_type || 'Frete Padrão'
        }],
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