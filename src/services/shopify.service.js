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
        logger.info(`Pedido Appmax #${appmaxOrder.id} encontrado na Shopify #${existingOrder.id}`);
        return this.updateOrder(existingOrder.id, { appmaxOrder, status, financialStatus });
      }

      logger.info(`Criando novo pedido para Appmax #${appmaxOrder.id}`);
      const orderData = this.formatOrderData(appmaxOrder, status, financialStatus);
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

  getPaymentMethod(appmaxOrder) {
    const paymentMapping = {
      'credit_card': {
        gateway: 'credit_card',
        name: 'Cartão de Crédito',
        payment_method_details: appmaxOrder.payment_info?.card_brand || ''
      },
      'pix': {
        gateway: 'pix',
        name: 'PIX',
        payment_method_details: 'PIX'
      },
      'billet': {
        gateway: 'billet',
        name: 'Boleto',
        payment_method_details: appmaxOrder.payment_info?.billet_url || ''
      },
      'default': {
        gateway: 'manual',
        name: 'Outro',
        payment_method_details: ''
      }
    };

    const method = paymentMapping[appmaxOrder.payment_type] || paymentMapping.default;
    
    return {
      gateway: method.gateway,
      payment_method: {
        name: method.name,
        payment_details: method.payment_method_details
      }
    };
  }

  formatOrderData(appmaxOrder, status, financialStatus, additionalTags = []) {
    const lineItems = [];
    const formattedPhone = this.formatPhoneNumber(appmaxOrder.customer.telephone);
    const paymentMethod = this.getPaymentMethod(appmaxOrder);

    // Mapeia os status da Appmax para os status da Shopify
    const shopifyStatus = {
      financial: {
        pending: 'pending',
        paid: 'paid',
        refunded: 'refunded',
        cancelled: 'voided',
        dispute: 'pending'
      },
      fulfillment: {
        pending: null,
        paid: null,
        refunded: null,
        cancelled: 'cancelled',
        dispute: null
      }
    };

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

    // Determina os status corretos
    const finalFinancialStatus = shopifyStatus.financial[financialStatus] || 'pending';
    const finalFulfillmentStatus = shopifyStatus.fulfillment[status] || null;

    const tags = [
      appmaxOrder.status,
      `appmax_status_${status}`,
      `payment_${appmaxOrder.payment_type || 'unknown'}`,
      ...additionalTags
    ].filter(Boolean);

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
        financial_status: finalFinancialStatus,
        fulfillment_status: finalFulfillmentStatus,
        currency: 'BRL',
        tags: tags,
        gateway: paymentMethod.gateway,
        payment_gateway_names: [paymentMethod.gateway],
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
          },
          {
            name: 'appmax_status',
            value: appmaxOrder.status
          },
          {
            name: 'appmax_payment_type',
            value: appmaxOrder.payment_type || ''
          },
          {
            name: 'appmax_last_event',
            value: status
          },
          {
            name: 'payment_method',
            value: paymentMethod.payment_method.name
          },
          {
            name: 'payment_details',
            value: paymentMethod.payment_method.payment_details
          }
        ],
        payment_details: [{
          credit_card_company: appmaxOrder.payment_info?.card_brand || null,
          credit_card_number: appmaxOrder.payment_info?.card_last4 ? `****${appmaxOrder.payment_info.card_last4}` : null,
          credit_card_wallet: appmaxOrder.payment_info?.wallet || null
        }],
        transactions: [{
          kind: 'authorization',
          status: status === 'paid' ? 'success' : 'pending',
          amount: appmaxOrder.total,
          gateway: paymentMethod.gateway,
          payment_details: paymentMethod.payment_method.payment_details
        }]
      }
    };
  }

  async findOrderByAppmaxId(appmaxId) {
    try {
      // Busca com query mais específica
      const { data } = await this.client.get('/orders.json?status=any', {
        params: {
          query: `note_attribute:appmax_id=${appmaxId}`
        }
      });

      if (data.orders && data.orders.length > 0) {
        return data.orders[0]; // Retorna o primeiro pedido encontrado
      }
      return null;
    } catch (error) {
      logger.error('Erro ao buscar pedido na Shopify:', {
        appmaxId,
        error: error.message,
        response: error.response?.data
      });
      return null;
    }
  }

  async updateOrder(orderId, { appmaxOrder, status, financialStatus }) {
    try {
      logger.info(`Atualizando pedido Shopify #${orderId}`, {
        appmaxId: appmaxOrder.id,
        status,
        financialStatus
      });

      const orderData = this.formatOrderData(appmaxOrder, status, financialStatus);
      
      // Primeiro, atualiza os status
      await this.updateOrderStatus(orderId, status, financialStatus);
      
      // Depois atualiza os outros dados
      const { data } = await this.client.put(`/orders/${orderId}.json`, {
        order: {
          ...orderData.order,
          // Mantém o ID original do pedido
          id: orderId,
          // Não tenta atualizar campos imutáveis
          line_items: undefined,
          customer: undefined,
          billing_address: undefined,
          shipping_address: undefined
        }
      });

      return data.order;
    } catch (error) {
      logger.error('Erro ao atualizar pedido na Shopify:', {
        orderId,
        appmaxId: appmaxOrder.id,
        error: error.message,
        response: error.response?.data
      });
      throw new AppError(
        `Erro ao atualizar pedido na Shopify: ${error.message}`,
        error.response?.status || 500
      );
    }
  }

  async updateOrderStatus(orderId, status, financialStatus) {
    try {
      const updates = [];

      // Atualiza status financeiro se necessário
      if (financialStatus) {
        updates.push(
          this.client.post(`/orders/${orderId}/transactions.json`, {
            transaction: {
              kind: this.getTransactionKind(financialStatus),
              status: 'success',
              amount: 0 // Valor zero pois é apenas atualização de status
            }
          })
        );
      }

      // Atualiza status de fulfillment se necessário
      if (status === 'cancelled') {
        updates.push(
          this.client.post(`/orders/${orderId}/cancel.json`)
        );
      }

      if (updates.length > 0) {
        await Promise.all(updates);
      }
    } catch (error) {
      logger.error('Erro ao atualizar status do pedido:', {
        orderId,
        status,
        financialStatus,
        error: error.message
      });
      throw error;
    }
  }

  getTransactionKind(financialStatus) {
    const kindMapping = {
      'pending': 'authorization',
      'paid': 'capture',
      'refunded': 'refund',
      'cancelled': 'void'
    };
    return kindMapping[financialStatus] || 'authorization';
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