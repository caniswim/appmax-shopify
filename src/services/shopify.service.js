const axios = require('axios');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');
const db = require('../database/db');

class ShopifyService {
  constructor() {
    this.client = axios.create({
      baseURL: `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2024-01`,
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    });

    // Controle de rate limit
    this.requestQueue = [];
    this.processing = false;
    this.lastRequestTime = 0;
    this.minRequestInterval = 500; // 500ms entre requisições (2 por segundo)
    this.orderLocks = new Map(); // Controle de locks por pedido

    // Adiciona interceptor para tratar erros
    this.client.interceptors.response.use(
      response => response,
      async error => {
        if (error.response) {
          const { data, status } = error.response;
          logger.error('Erro na resposta da Shopify:', {
            status,
            errors: data.errors,
            body: error.config.data
          });

          // Se for erro de rate limit, aguarda e tenta novamente
          if (status === 429) {
            logger.info('Rate limit atingido, aguardando antes de tentar novamente');
            await new Promise(resolve => setTimeout(resolve, this.minRequestInterval));
            return this.client.request(error.config);
          }
          
          // Trata erros específicos
          if (data.errors) {
            let errorMessage = '';
            if (typeof data.errors === 'string') {
              errorMessage = data.errors;
            } else if (typeof data.errors === 'object') {
              const messages = [];
              Object.entries(data.errors).forEach(([field, fieldErrors]) => {
                if (Array.isArray(fieldErrors)) {
                  messages.push(`${field}: ${fieldErrors.join(', ')}`);
                } else if (typeof fieldErrors === 'string') {
                  messages.push(`${field}: ${fieldErrors}`);
                }
              });
              errorMessage = messages.join('; ');
            }
            
            throw new AppError(
              `Erro de validação na Shopify: ${errorMessage}`,
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

  async makeRequest(requestFn) {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.minRequestInterval) {
      const waitTime = this.minRequestInterval - timeSinceLastRequest;
      logger.info(`Aguardando ${waitTime}ms antes da próxima requisição`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    this.lastRequestTime = Date.now();
    return requestFn();
  }

  async enqueueRequest(requestFn) {
    logger.info(`Adicionando requisição à fila. Tamanho atual: ${this.requestQueue.length}`);
    const promise = new Promise((resolve, reject) => {
      this.requestQueue.push({ 
        requestFn, 
        resolve, 
        reject,
        timestamp: Date.now()
      });
    });

    // Se não estiver processando, inicia o processamento
    if (!this.processing) {
      this.processQueue();
    }

    return promise;
  }

  async processQueue() {
    if (this.processing || this.requestQueue.length === 0) {
      return;
    }

    this.processing = true;
    logger.info(`Iniciando processamento da fila. Itens: ${this.requestQueue.length}`);

    try {
      while (this.requestQueue.length > 0) {
        const request = this.requestQueue[0];
        const waitTime = Date.now() - request.timestamp;
        
        logger.info(`Processando requisição da fila. Tempo de espera: ${waitTime}ms`);

        try {
          const result = await this.makeRequest(request.requestFn);
          this.requestQueue.shift();
          request.resolve(result);
        } catch (error) {
          if (error.response?.status === 429) {
            logger.info('Rate limit atingido, aguardando antes de tentar novamente');
            await new Promise(resolve => setTimeout(resolve, this.minRequestInterval * 2));
            continue;
          }
          
          this.requestQueue.shift();
          request.reject(error);
        }
      }
    } finally {
      this.processing = false;
      logger.info('Processamento da fila concluído');

      // Se ainda houver itens na fila (adicionados durante o processamento)
      if (this.requestQueue.length > 0) {
        this.processQueue();
      }
    }
  }

  async lockOrder(orderId) {
    while (this.orderLocks.has(orderId)) {
      logger.info(`Aguardando lock do pedido #${orderId} ser liberado`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    this.orderLocks.set(orderId, true);
  }

  releaseLock(orderId) {
    this.orderLocks.delete(orderId);
  }

  async createOrUpdateOrder({ appmaxOrder, status, financialStatus }) {
    return this.enqueueRequest(async () => {
      try {
        if (!appmaxOrder || !appmaxOrder.bundles) {
          throw new AppError('Dados do pedido Appmax inválidos', 400);
        }

        // Adquire lock do pedido
        await this.lockOrder(appmaxOrder.id);
        logger.info(`Lock adquirido para pedido Appmax #${appmaxOrder.id}`);

        try {
          logger.info(`Verificando existência do pedido Appmax #${appmaxOrder.id}`);
          const existingOrder = await this.findOrderByAppmaxId(appmaxOrder.id);
          
          if (existingOrder) {
            logger.info(`Pedido Appmax #${appmaxOrder.id} encontrado na Shopify: #${existingOrder.id}`);
            return this.updateOrder(existingOrder.id, { appmaxOrder, status, financialStatus });
          }

          const orderData = this.formatOrderData(appmaxOrder, status, financialStatus);
          logger.info('Criando pedido na Shopify:', orderData);

          try {
            const { data } = await this.makeRequest(() => this.client.post('/orders.json', orderData));
            logger.info(`Pedido Appmax #${appmaxOrder.id} criado com sucesso na Shopify: #${data.order.id}`);
            
            // Salva o mapeamento no banco local
            await db.saveOrderMapping(appmaxOrder.id, data.order.id);
            
            return data.order;
          } catch (error) {
            if (error.response?.status === 422 && error.response?.data?.errors?.['customer.email']) {
              logger.info(`Email duplicado detectado, verificando pedido novamente para Appmax #${appmaxOrder.id}`);
              const retryOrder = await this.findOrderByAppmaxId(appmaxOrder.id);
              
              if (retryOrder) {
                logger.info(`Pedido encontrado após erro de email duplicado, atualizando Appmax #${appmaxOrder.id}`);
                return this.updateOrder(retryOrder.id, { appmaxOrder, status, financialStatus });
              }
            }
            throw error;
          }
        } finally {
          // Libera o lock do pedido
          this.releaseLock(appmaxOrder.id);
          logger.info(`Lock liberado para pedido Appmax #${appmaxOrder.id}`);
        }
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(
          `Erro ao criar/atualizar pedido na Shopify: ${error.message}`,
          error.response?.status || 500
        );
      }
    });
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

    // Mapeia os status da Appmax para os status da Shopify
    const shopifyStatus = {
      financial: {
        pending: 'pending',
        paid: 'paid',
        refunded: 'refunded',
        cancelled: 'voided'
      },
      fulfillment: {
        pending: null,
        paid: null,
        refunded: null,
        cancelled: 'cancelled'
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
        tags: [appmaxOrder.status, `appmax_status_${status}`], // Adiciona tags para rastreamento
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
          }
        ]
      }
    };
  }

  async findOrderByAppmaxId(appmaxId) {
    try {
      // Primeiro tenta encontrar no banco local
      const shopifyId = await db.findShopifyOrderId(appmaxId);
      if (shopifyId) {
        logger.info(`Pedido encontrado no banco local: Appmax #${appmaxId} -> Shopify #${shopifyId}`);
        return { id: shopifyId };
      }

      // Se não encontrar, busca na API da Shopify usando o endpoint de busca por nome/número
      const { data } = await this.makeRequest(async () => {
        return this.client.get('/orders/search.json', {
          params: {
            fields: 'id,note_attributes,financial_status,fulfillment_status',
            limit: 1,
            // Busca pelo número do pedido da Appmax que está nas notas
            query: `name:${appmaxId} OR note:"Pedido Appmax #${appmaxId}"`
          }
        });
      });

      // Verifica se o pedido encontrado realmente corresponde ao ID da Appmax
      const order = data.orders.find(order => {
        const appmaxAttr = order.note_attributes.find(attr => 
          attr.name === 'appmax_id' && attr.value === appmaxId.toString()
        );
        return !!appmaxAttr;
      });

      // Se encontrou na Shopify, salva no banco local
      if (order) {
        logger.info(`Pedido encontrado na Shopify via busca: Appmax #${appmaxId} -> Shopify #${order.id}`);
        await db.saveOrderMapping(appmaxId, order.id);
      } else {
        logger.info(`Pedido não encontrado na Shopify: Appmax #${appmaxId}`);
      }

      return order;
    } catch (error) {
      logger.error('Erro ao buscar pedido na Shopify:', error);
      throw error;
    }
  }

  async updateOrder(orderId, { appmaxOrder, status, financialStatus }) {
    return this.enqueueRequest(async () => {
      try {
        const updateData = {
          order: {
            id: orderId,
            financial_status: this.mapFinancialStatus(financialStatus),
            tags: [appmaxOrder.status, `appmax_status_${status}`],
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
              }
            ]
          }
        };

        logger.info(`Atualizando pedido Shopify #${orderId} para status ${status}`);
        const { data } = await this.client.put(`/orders/${orderId}.json`, updateData);
        return data.order;
      } catch (error) {
        logger.error('Erro ao atualizar pedido na Shopify:', error);
        throw error;
      }
    });
  }

  isRetryableError(error) {
    // Lista de códigos de erro que podem ser resolvidos com retry
    const retryableStatusCodes = [408, 429, 500, 502, 503, 504];
    return retryableStatusCodes.includes(error.response?.status);
  }

  mapFinancialStatus(status) {
    const statusMap = {
      'pending': 'pending',
      'paid': 'paid',
      'refunded': 'refunded',
      'cancelled': 'voided'
    };
    return statusMap[status] || 'pending';
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