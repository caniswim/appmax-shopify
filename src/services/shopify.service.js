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

    // Controle de rate limit
    this.requestQueue = [];
    this.processing = false;
    this.lastRequestTime = 0;
    this.minRequestInterval = 500; // 500ms entre requisições (2 por segundo)
    this.queueTimeout = null;

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
    return new Promise((resolve, reject) => {
      this.requestQueue.push({ 
        requestFn, 
        resolve, 
        reject,
        timestamp: Date.now()
      });
      
      // Garante que a fila será processada
      this.ensureQueueProcessing();
    });
  }

  ensureQueueProcessing() {
    if (!this.processing && !this.queueTimeout) {
      this.queueTimeout = setTimeout(() => {
        this.processQueue();
      }, 100); // Inicia o processamento após 100ms se não estiver processando
    }
  }

  async processQueue() {
    if (this.processing || this.requestQueue.length === 0) {
      return;
    }

    this.processing = true;
    this.queueTimeout = null;

    logger.info(`Iniciando processamento da fila. Itens: ${this.requestQueue.length}`);

    while (this.requestQueue.length > 0) {
      const request = this.requestQueue[0]; // Peek no primeiro item sem remover
      const waitTime = Date.now() - request.timestamp;
      
      logger.info(`Processando requisição da fila. Tempo de espera: ${waitTime}ms`);

      try {
        const result = await this.makeRequest(request.requestFn);
        this.requestQueue.shift(); // Remove apenas após sucesso
        request.resolve(result);
      } catch (error) {
        if (error.response?.status === 429) {
          logger.info('Rate limit atingido, aguardando antes de tentar novamente');
          await new Promise(resolve => setTimeout(resolve, this.minRequestInterval * 2));
          continue;
        }
        
        this.requestQueue.shift(); // Remove em caso de erro não recuperável
        request.reject(error);
      }
    }

    this.processing = false;
    logger.info('Processamento da fila concluído');
  }

  async createOrUpdateOrder({ appmaxOrder, status, financialStatus }) {
    return this.enqueueRequest(async () => {
      try {
        // Validação dos dados necessários
        if (!appmaxOrder || !appmaxOrder.bundles) {
          throw new AppError('Dados do pedido Appmax inválidos', 400);
        }

        // Adiciona retry com backoff exponencial para busca
        let existingOrder = null;
        let attempts = 0;
        const maxAttempts = 3;
        const baseDelay = 1000;

        while (attempts < maxAttempts && !existingOrder) {
          try {
            existingOrder = await this.findOrderByAppmaxId(appmaxOrder.id);
            
            if (existingOrder) {
              logger.info(`Pedido Appmax #${appmaxOrder.id} encontrado na Shopify: #${existingOrder.id}`);
              return this.updateOrder(existingOrder.id, { appmaxOrder, status, financialStatus });
            }

            if (attempts > 0) {
              break;
            }
          } catch (error) {
            attempts++;
            
            if (attempts === maxAttempts || !this.isRetryableError(error)) {
              throw error;
            }

            const delay = baseDelay * Math.pow(2, attempts - 1);
            logger.info(`Tentativa ${attempts} de buscar pedido falhou, aguardando ${delay}ms antes de tentar novamente`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }

        const orderData = this.formatOrderData(appmaxOrder, status, financialStatus);
        logger.info('Criando pedido na Shopify:', orderData);

        attempts = 0;
        while (attempts < maxAttempts) {
          try {
            const { data } = await this.client.post('/orders.json', orderData);
            return data.order;
          } catch (error) {
            attempts++;

            if (error.response?.status === 422 && error.response?.data?.errors?.['customer.email']) {
              logger.info(`Email duplicado detectado, verificando pedido novamente para Appmax #${appmaxOrder.id}`);
              existingOrder = await this.findOrderByAppmaxId(appmaxOrder.id);
              
              if (existingOrder) {
                logger.info(`Pedido encontrado após erro de email duplicado, atualizando Appmax #${appmaxOrder.id}`);
                return this.updateOrder(existingOrder.id, { appmaxOrder, status, financialStatus });
              }
            }

            if (attempts === maxAttempts || !this.isRetryableError(error)) {
              throw error;
            }

            const delay = baseDelay * Math.pow(2, attempts - 1);
            logger.info(`Tentativa ${attempts} de criar pedido falhou, aguardando ${delay}ms antes de tentar novamente`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
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
    return this.enqueueRequest(async () => {
      try {
        const { data } = await this.client.get('/orders.json', {
          params: {
            status: 'any',
            fields: 'id,note_attributes,financial_status,fulfillment_status',
            limit: 1,
            query: `note_attribute:appmax_id:${appmaxId}`
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
    });
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