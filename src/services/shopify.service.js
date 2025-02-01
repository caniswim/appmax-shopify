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

    this.processing = false;
    this.lastRequestTime = 0;
    this.minRequestInterval = 500;
    this.orderLocks = new Map();

    // Inicia o processamento da fila
    this.startQueueProcessing();

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

  async startQueueProcessing() {
    // Processa a fila a cada 5 segundos
    setInterval(async () => {
      await this.processQueue();
    }, 5000);

    // Inicia o processamento imediatamente
    await this.processQueue();
  }

  async processQueue() {
    if (this.processing) {
      return;
    }

    this.processing = true;
    logger.info('Iniciando processamento da fila');

    try {
      const requests = await db.getUnprocessedRequests();
      logger.info(`Encontradas ${requests.length} requisições para processar`);

      for (const request of requests) {
        try {
          logger.info(`Processando requisição #${request.id} para pedido Appmax #${request.appmax_id}`);
          
          const result = await this.createOrUpdateOrder({
            appmaxOrder: request.request_data,
            status: request.status,
            financialStatus: request.financial_status
          });

          await db.markRequestAsProcessed(request.id);
          logger.info(`Requisição #${request.id} processada com sucesso`);
        } catch (error) {
          const errorMessage = error.message || 'Erro desconhecido';
          logger.error(`Erro ao processar requisição #${request.id}:`, error);
          await db.markRequestAsProcessed(request.id, errorMessage);

          // Se for um erro de rate limit, pausa o processamento
          if (error.response?.status === 429) {
            logger.info('Rate limit atingido, pausando processamento');
            await new Promise(resolve => setTimeout(resolve, this.minRequestInterval * 2));
          }
        }

        // Aguarda o intervalo mínimo entre requisições
        await new Promise(resolve => setTimeout(resolve, this.minRequestInterval));
      }
    } catch (error) {
      logger.error('Erro ao processar fila:', error);
    } finally {
      this.processing = false;
      logger.info('Processamento da fila concluído');
    }
  }

  async enqueueRequest(requestFn) {
    // Salva a requisição no banco
    const requestId = await db.saveQueueRequest({
      appmaxId: requestFn.appmaxOrder.id,
      eventType: requestFn.event,
      status: requestFn.status,
      financialStatus: requestFn.financialStatus,
      requestData: requestFn.appmaxOrder
    });

    logger.info(`Requisição #${requestId} adicionada à fila`);

    // Inicia o processamento se não estiver em andamento
    if (!this.processing) {
      this.processQueue();
    }

    return new Promise((resolve, reject) => {
      // Aguarda o processamento ser concluído
      const checkStatus = async () => {
        const request = await db.getRequestStatus(requestId);
        if (request.processed_at) {
          if (request.error) {
            reject(new Error(request.error));
          } else {
            resolve();
          }
        } else {
          setTimeout(checkStatus, 1000);
        }
      };

      checkStatus();
    });
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

    // Prepara os atributos de nota
    const noteAttributes = [
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
        name: 'appmax_url',
        value: `https://admin.appmax.com.br/v2/sales/orders?order_by=id&sorted_by=desc&page=1&page_size=10&term=${appmaxOrder.id}`
      }
    ];

    // Adiciona informações de cartão de crédito se disponíveis
    if (appmaxOrder.payment_type === 'CreditCard') {
      const paymentDetails = [];
      
      if (appmaxOrder.card_brand) {
        paymentDetails.push(`Bandeira: ${appmaxOrder.card_brand}`);
      }
      
      if (appmaxOrder.installments) {
        const installmentValue = (parseFloat(appmaxOrder.total) / appmaxOrder.installments).toFixed(2);
        paymentDetails.push(`${appmaxOrder.installments}x de R$ ${installmentValue}`);
      }

      if (paymentDetails.length > 0) {
        noteAttributes.push({
          name: 'payment_details',
          value: paymentDetails.join(' | ')
        });
      }

      // Adiciona atributos individuais para facilitar consultas
      if (appmaxOrder.card_brand) {
        noteAttributes.push({
          name: 'card_brand',
          value: appmaxOrder.card_brand
        });
      }
      if (appmaxOrder.installments) {
        noteAttributes.push({
          name: 'installments',
          value: appmaxOrder.installments.toString()
        });
      }
    }

    // Adiciona informações de boleto se disponíveis
    if (appmaxOrder.payment_type === 'Boleto') {
      if (appmaxOrder.billet_url) {
        noteAttributes.push({
          name: 'billet_url',
          value: appmaxOrder.billet_url
        });
      }
      if (appmaxOrder.billet_date_overdue) {
        noteAttributes.push({
          name: 'billet_date_overdue',
          value: appmaxOrder.billet_date_overdue
        });
      }
    }

    const orderData = {
      order: {
        line_items: lineItems,
        email: appmaxOrder.customer.email,
        phone: formattedPhone,
        customer: {
          first_name: appmaxOrder.customer.firstname,
          last_name: appmaxOrder.customer.lastname,
          email: appmaxOrder.customer.email,
          phone: formattedPhone,
          company: appmaxOrder.customer.document_number || ''
        },
        shipping_address: {
          first_name: appmaxOrder.customer.firstname,
          last_name: appmaxOrder.customer.lastname,
          company: appmaxOrder.customer.document_number || '',
          address1: `${appmaxOrder.customer.address_street}, ${appmaxOrder.customer.address_street_number}`,
          address2: appmaxOrder.customer.address_street_complement || '',
          city: appmaxOrder.customer.address_city,
          province: appmaxOrder.customer.address_state,
          zip: appmaxOrder.customer.postcode,
          country: 'BR',
          phone: formattedPhone
        },
        billing_address: {
          first_name: appmaxOrder.customer.firstname,
          last_name: appmaxOrder.customer.lastname,
          company: appmaxOrder.customer.document_number || '',
          address1: `${appmaxOrder.customer.address_street}, ${appmaxOrder.customer.address_street_number}`,
          address2: appmaxOrder.customer.address_street_complement || '',
          city: appmaxOrder.customer.address_city,
          province: appmaxOrder.customer.address_state,
          zip: appmaxOrder.customer.postcode,
          country: 'BR',
          phone: formattedPhone
        },
        financial_status: finalFinancialStatus,
        fulfillment_status: finalFulfillmentStatus,
        currency: 'BRL',
        tags: [appmaxOrder.status, `appmax_status_${status}`],
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
        note_attributes: noteAttributes,
        additional_details: appmaxOrder.payment_type === 'CreditCard' ? [
          `Bandeira: ${appmaxOrder.card_brand || 'N/A'}`,
          `Parcelas: ${appmaxOrder.installments || 1}x de R$ ${((parseFloat(appmaxOrder.total) || 0) / (appmaxOrder.installments || 1)).toFixed(2)}`
        ] : []
      }
    };

    return orderData;
  }

  async findOrderByAppmaxId(appmaxId) {
    try {
      // Primeiro tenta encontrar no banco local
      const shopifyId = await db.findShopifyOrderId(appmaxId);
      if (shopifyId) {
        logger.info(`Pedido encontrado no banco local: Appmax #${appmaxId} -> Shopify #${shopifyId}`);
        return { id: shopifyId };
      }

      // Se não encontrar, busca na API da Shopify
      const { data } = await this.makeRequest(async () => {
        return this.client.get('/orders.json', {
          params: {
            status: 'any',
            created_at_min: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), // últimos 30 dias
            fields: 'id,note_attributes,financial_status,fulfillment_status',
            limit: 250 // máximo permitido pela API
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
        logger.info(`Pedido encontrado na Shopify: Appmax #${appmaxId} -> Shopify #${order.id}`);
        await db.saveOrderMapping(appmaxId, order.id);
      } else {
        logger.info(`Pedido não encontrado na Shopify: Appmax #${appmaxId}`);
      }

      return order;
    } catch (error) {
      // Se for erro 404, significa que não encontrou o pedido
      if (error.response?.status === 404) {
        logger.info(`Pedido não encontrado na Shopify: Appmax #${appmaxId}`);
        return null;
      }

      logger.error('Erro ao buscar pedido na Shopify:', error);
      throw error;
    }
  }

  async updateOrder(orderId, { appmaxOrder, status, financialStatus }) {
    return this.enqueueRequest(async () => {
      try {
        logger.info(`Iniciando atualização do pedido Shopify #${orderId}. Status: ${status}, Financial Status: ${financialStatus}`);

        // Mapeia os status
        const mappedFinancialStatus = this.mapFinancialStatus(financialStatus);
        
        // Prepara os dados de atualização
        const updateData = {
          order: {
            id: orderId,
            financial_status: mappedFinancialStatus,
            tags: [appmaxOrder.status, `appmax_status_${status}`].filter(Boolean),
            note_attributes: this.formatNoteAttributes(appmaxOrder),
            additional_details: this.formatAdditionalDetails(appmaxOrder)
          }
        };

        logger.info(`Atualizando pedido Shopify #${orderId}:`, updateData);
        
        const { data } = await this.makeRequest(() => 
          this.client.put(`/orders/${orderId}.json`, updateData)
        );

        logger.info(`Pedido Shopify #${orderId} atualizado com sucesso. Novo status: ${data.order.financial_status}`);
        return data.order;
      } catch (error) {
        logger.error(`Erro ao atualizar pedido Shopify #${orderId}:`, error);
        throw new AppError(
          `Erro ao atualizar pedido na Shopify: ${error.message}`,
          error.response?.status || 500
        );
      }
    });
  }

  formatNoteAttributes(appmaxOrder) {
    const noteAttributes = [
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
        name: 'appmax_url',
        value: `https://admin.appmax.com.br/v2/sales/orders?order_by=id&sorted_by=desc&page=1&page_size=10&term=${appmaxOrder.id}`
      }
    ];

    if (appmaxOrder.payment_type === 'CreditCard' && (appmaxOrder.card_brand || appmaxOrder.installments)) {
      const paymentDetails = [];
      
      if (appmaxOrder.card_brand) {
        paymentDetails.push(`Bandeira: ${appmaxOrder.card_brand}`);
        noteAttributes.push({
          name: 'card_brand',
          value: appmaxOrder.card_brand
        });
      }
      
      if (appmaxOrder.installments) {
        const installmentValue = (parseFloat(appmaxOrder.total) / appmaxOrder.installments).toFixed(2);
        paymentDetails.push(`${appmaxOrder.installments}x de R$ ${installmentValue}`);
        noteAttributes.push({
          name: 'installments',
          value: appmaxOrder.installments.toString()
        });
      }

      if (paymentDetails.length > 0) {
        noteAttributes.push({
          name: 'payment_details',
          value: paymentDetails.join(' | ')
        });
      }
    }

    if (appmaxOrder.payment_type === 'Boleto') {
      if (appmaxOrder.billet_url) {
        noteAttributes.push({
          name: 'billet_url',
          value: appmaxOrder.billet_url
        });
      }
      if (appmaxOrder.billet_date_overdue) {
        noteAttributes.push({
          name: 'billet_date_overdue',
          value: appmaxOrder.billet_date_overdue
        });
      }
    }

    return noteAttributes;
  }

  formatAdditionalDetails(appmaxOrder) {
    if (appmaxOrder.payment_type === 'CreditCard') {
      return [
        `Bandeira: ${appmaxOrder.card_brand || 'N/A'}`,
        `Parcelas: ${appmaxOrder.installments || 1}x de R$ ${((parseFloat(appmaxOrder.total) || 0) / (appmaxOrder.installments || 1)).toFixed(2)}`
      ];
    }
    return [];
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