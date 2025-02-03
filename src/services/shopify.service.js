const axios = require('axios');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');
const db = require('../database/db');

class ShopifyService {
  constructor() {
    // Valida as variáveis de ambiente necessárias
    if (!process.env.SHOPIFY_STORE_DOMAIN || !process.env.SHOPIFY_ACCESS_TOKEN) {
      throw new Error("As variáveis de ambiente SHOPIFY_STORE_DOMAIN e SHOPIFY_ACCESS_TOKEN são obrigatórias.");
    }

    this.client = axios.create({
      baseURL: `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2024-01`,
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    });

    this.graphqlClient = axios.create({
      baseURL: `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/graphql.json`,
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    });

    // Configura interceptor para tratar erros de resposta da Shopify
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

          // Em caso de rate limit, aguarda um intervalo antes de retentar
          if (status === 429) {
            logger.info('Rate limit atingido, aguardando antes de tentar novamente');
            await new Promise(resolve => setTimeout(resolve, this.minRequestInterval));
            return this.client.request(error.config);
          }

          // Trata erros de validação e outros erros específicos
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
            throw new AppError(`Erro de validação na Shopify: ${errorMessage}`, status);
          }

          throw new AppError('Erro inesperado na API da Shopify', status);
        }
        throw error;
      }
    );

    this.processing = false;
    this.lastRequestTime = 0;
    this.minRequestInterval = 500; // intervalo mínimo entre chamadas (em ms)
    this.orderLocks = new Map();

    // Inicia o processamento da fila assim que o banco estiver inicializado
    this.init();
  }

  async init() {
    try {
      await db.waitForInit();
      logger.info('Banco de dados inicializado, iniciando processamento da fila');
      this.startQueueProcessing();
    } catch (error) {
      logger.error('Erro ao inicializar serviço:', error);
    }
  }

  /**
   * Processa a fila e, ao finalizar, agenda nova execução em 5 segundos.
   */
  async startQueueProcessing() {
    try {
      await this.processQueue();
    } catch (error) {
      logger.error('Erro no processamento da fila:', error);
    } finally {
      setTimeout(() => this.startQueueProcessing(), 5000);
    }
  }

  /**
   * Busca requisições não processadas no DB e as processa sequencialmente.
   */
  async processQueue() {
    if (this.processing) return;
    this.processing = true;
    try {
      const requests = await db.getUnprocessedRequests();
      if (requests.length > 0) {
        logger.info(`Iniciando processamento da fila. Encontradas ${requests.length} requisições para processar`);
        for (const request of requests) {
          try {
            logger.info(`Processando requisição #${request.id} para pedido Appmax #${request.appmax_id}`);
            const result = await this.processOrder({
              appmaxOrder: request.request_data,
              status: request.status,
              financialStatus: request.financial_status
            });
            await db.markRequestAsProcessed(request.id, null, result);
            logger.info(`Requisição #${request.id} processada com sucesso`);
          } catch (error) {
            const errorMessage = error.message || 'Erro desconhecido';
            logger.error(`Erro ao processar requisição #${request.id}:`, error);
            await db.markRequestAsProcessed(request.id, errorMessage);
            if (error.response?.status === 429) {
              logger.info('Rate limit atingido, pausando processamento');
              await new Promise(resolve => setTimeout(resolve, this.minRequestInterval * 2));
            }
          }
          // Aguarda intervalo mínimo entre requisições
          await new Promise(resolve => setTimeout(resolve, this.minRequestInterval));
        }
        logger.info('Processamento da fila concluído');
      }
    } catch (error) {
      logger.error('Erro ao processar fila:', error);
    } finally {
      this.processing = false;
    }
  }

  /**
   * Enfileira uma requisição de pedido, salvando os dados no banco.
   * Retorna uma Promise que é resolvida quando o processamento é concluído.
   */
  async enqueueOrder({ appmaxOrder, status, financialStatus }) {
    try {
      if (!appmaxOrder || !appmaxOrder.id) {
        throw new AppError('Dados do pedido Appmax inválidos', 400);
      }
      const requestId = await db.saveQueueRequest({
        appmaxId: appmaxOrder.id,
        eventType: appmaxOrder.event || 'unknown',
        status: status || 'pending',
        financialStatus: financialStatus || 'pending',
        requestData: appmaxOrder
      });
      logger.info(`Requisição #${requestId} adicionada à fila para pedido Appmax #${appmaxOrder.id}`);
      return new Promise((resolve, reject) => {
        const checkStatus = async () => {
          try {
            const request = await db.getRequestStatus(requestId);
            if (request.processed_at) {
              if (request.error) {
                reject(new Error(request.error));
              } else {
                resolve(request);
              }
            } else {
              setTimeout(checkStatus, 1000);
            }
          } catch (error) {
            reject(error);
          }
        };
        checkStatus();
      });
    } catch (error) {
      logger.error('Erro ao enfileirar requisição:', error);
      throw error;
    }
  }

  /**
   * Método público para criação/atualização do pedido na Shopify.
   * Enfileira a requisição e aguarda seu processamento.
   */
  async createOrUpdateOrder({ appmaxOrder, status, financialStatus }) {
    return this.enqueueOrder({ appmaxOrder, status, financialStatus });
  }

  /**
   * Processa a lógica de criação ou atualização do pedido na Shopify.
   * Esse método é chamado a partir do processQueue.
   */
  async processOrder({ appmaxOrder, status, financialStatus }) {
    try {
      if (!appmaxOrder) {
        throw new AppError('Dados do pedido Appmax inválidos', 400);
      }
      
      // Adquire lock do pedido com timeout para evitar deadlock
      await this.lockOrder(appmaxOrder.id);
      logger.info(`Lock adquirido para pedido Appmax #${appmaxOrder.id}`);
      try {
        logger.info(`Verificando existência do pedido Appmax #${appmaxOrder.id}`);
        const existingOrder = await this.findOrderByAppmaxId(appmaxOrder.id);
        if (existingOrder) {
          logger.info(`Pedido Appmax #${appmaxOrder.id} encontrado na Shopify: #${existingOrder.id}`);
          return await this.updateOrder(existingOrder.id, { appmaxOrder, status, financialStatus });
        }
        const orderData = this.formatOrderData(appmaxOrder, status, financialStatus);
        logger.info('Criando pedido na Shopify:', orderData);
        try {
          const { data } = await this.makeRequest(() => this.client.post('/orders.json', orderData));
          logger.info(`Pedido Appmax #${appmaxOrder.id} criado com sucesso na Shopify: #${data.order.id}`);
          // Salva o mapeamento entre Appmax e Shopify no banco
          await db.saveOrderMapping(appmaxOrder.id, data.order.id);
          return data.order;
        } catch (error) {
          // Caso o erro seja devido a email duplicado, tenta buscar o pedido e atualizar
          if (error.response?.status === 422 && error.response?.data?.errors?.['customer.email']) {
            logger.info(`Email duplicado detectado, verificando pedido novamente para Appmax #${appmaxOrder.id}`);
            const retryOrder = await this.findOrderByAppmaxId(appmaxOrder.id);
            if (retryOrder) {
              logger.info(`Pedido encontrado após erro de email duplicado, atualizando Appmax #${appmaxOrder.id}`);
              return await this.updateOrder(retryOrder.id, { appmaxOrder, status, financialStatus });
            }
          }
          throw error;
        }
      } finally {
        this.releaseLock(appmaxOrder.id);
        logger.info(`Lock liberado para pedido Appmax #${appmaxOrder.id}`);
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(`Erro ao criar/atualizar pedido na Shopify: ${error.message}`, error.response?.status || 500);
    }
  }

  /**
   * Realiza uma chamada à API encapsulada em uma função, com retentativas e backoff exponencial.
   */
  async makeRequest(requestFn, attempt = 1) {
    const maxAttempts = 5;
    const backoff = Math.pow(2, attempt) * 100; // cálculo simples de backoff
    try {
      const response = await requestFn();
      return response;
    } catch (error) {
      if (attempt < maxAttempts && this.isRetryableError(error)) {
        logger.info(`Tentativa ${attempt} falhou. Retentando após ${backoff}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoff));
        return this.makeRequest(requestFn, attempt + 1);
      }
      throw error;
    }
  }

  /**
   * Adquire um lock para um determinado pedido, evitando processamentos concorrentes.
   * Se o lock não for liberado em até 5 segundos, lança um erro.
   */
  async lockOrder(orderId) {
    const timeout = 5000;
    const interval = 100;
    let waited = 0;
    while (this.orderLocks.has(orderId)) {
      logger.info(`Aguardando lock do pedido #${orderId} ser liberado`);
      await new Promise(resolve => setTimeout(resolve, interval));
      waited += interval;
      if (waited >= timeout) {
        throw new AppError(`Timeout ao aguardar lock do pedido #${orderId}`, 500);
      }
    }
    this.orderLocks.set(orderId, true);
  }

  releaseLock(orderId) {
    this.orderLocks.delete(orderId);
  }

/**
 * Busca um pedido a partir do ID da Appmax.
 * Se o pedido for encontrado no DB, obtém os detalhes completos na Shopify.
 */
async findOrderByAppmaxId(appmaxId) {
  try {
    // Tenta primeiro buscar o mapeamento no banco local
    let shopifyId = await db.findShopifyOrderId(appmaxId);
    if (shopifyId) {
      // Normaliza o shopifyId para remover casas decimais (por exemplo, "5988756947115.0" → "5988756947115")
      shopifyId = String(parseInt(shopifyId, 10));
      logger.info(`Pedido encontrado no banco local: Appmax #${appmaxId} -> Shopify #${shopifyId}`);
      try {
        const { data } = await this.makeRequest(() =>
          this.client.get(`/orders/${shopifyId}.json`)
        );
        return data.order;
      } catch (error) {
        // Se o GET com o shopifyId retornar 404, significa que o pedido não existe mais na Shopify.
        if (
          (error.response && error.response.status === 404) ||
          (error.statusCode && error.statusCode === 404) ||
          (error.message && error.message.includes('Not Found'))
        ) {
          logger.info(`Pedido não encontrado na Shopify com o ID mapeado: Appmax #${appmaxId}`);
          // Opcional: remover o mapeamento desatualizado do DB
          // await db.deleteOrderMapping(appmaxId);
          return null;
        }
        throw error;
      }
    }

    // Se não há mapeamento, tenta buscar o pedido na Shopify por meio da listagem
    const { data } = await this.makeRequest(() => {
      return this.client.get('/orders.json', {
        params: {
          status: 'any',
          created_at_min: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), // últimos 30 dias
          fields: 'id,note_attributes,financial_status,fulfillment_status,currency,total_price',
          limit: 250
        }
      });
    });

    const order = data.orders.find(order => {
      const appmaxAttr = order.note_attributes.find(attr =>
        attr.name === 'appmax_id' && attr.value === appmaxId.toString()
      );
      return !!appmaxAttr;
    });

    if (order) {
      logger.info(`Pedido encontrado na Shopify: Appmax #${appmaxId} -> Shopify #${order.id}`);
      // Salva o mapeamento normalizando o ID (como string sem casas decimais)
      await db.saveOrderMapping(appmaxId, String(order.id));
    } else {
      logger.info(`Pedido não encontrado na Shopify: Appmax #${appmaxId}`);
    }
    return order;
  } catch (error) {
    // Se o erro indicar "Not Found", trata-o retornando null
    if (
      (error.response && error.response.status === 404) ||
      (error.statusCode && error.statusCode === 404) ||
      (error.message && error.message.includes('Not Found'))
    ) {
      logger.info(`Pedido não encontrado na Shopify: Appmax #${appmaxId}`);
      return null;
    }
    logger.error('Erro ao buscar pedido na Shopify:', error);
    throw error;
  }
}

  
  /**
   * Atualiza um pedido existente na Shopify com os dados da Appmax.
   */
  async updateOrder(orderId, { appmaxOrder, status, financialStatus }) {
    try {
      logger.info(`Iniciando atualização do pedido Shopify #${orderId}. Status: ${status}, Financial Status: ${financialStatus}`);
      
      // Busca o status atual do pedido
      const currentOrder = await this.getOrder(orderId);
      logger.info(`Status atual do pedido #${orderId}: ${currentOrder.financial_status}`);

      // Prepara os dados para atualização
      const updateData = {
        order: {
          id: orderId,
          tags: this.formatTags(appmaxOrder, status),
          note_attributes: this.formatNoteAttributes(appmaxOrder)
        }
      };

      logger.info(`Atualizando pedido Shopify #${orderId}:`, updateData);
      
      // Atualiza os dados básicos do pedido
      const { data: updatedOrder } = await this.makeRequest(() =>
        this.client.put(`/orders/${orderId}.json`, updateData)
      );

      // Atualiza o status do pedido via GraphQL de acordo com o status solicitado
      if (status === 'cancelled' || financialStatus === 'cancelled') {
        if (currentOrder.financial_status !== 'voided') {
          await this.cancelOrder(orderId);
        }
      } else if (financialStatus === 'refunded') {
        if (currentOrder.financial_status !== 'refunded') {
          await this.refundOrder(orderId);
        }
      } else if (financialStatus === 'paid') {
        // Só tenta marcar como pago se o pedido não estiver já pago ou reembolsado
        if (!['paid', 'refunded', 'voided'].includes(currentOrder.financial_status)) {
          try {
            await this.markOrderAsPaid(orderId);
          } catch (error) {
            // Se não conseguir marcar como pago via GraphQL, registra o erro mas não falha
            logger.warn(`Não foi possível marcar o pedido #${orderId} como pago via GraphQL: ${error.message}`);
          }
        } else {
          logger.info(`Pedido #${orderId} já está com status ${currentOrder.financial_status}, não será atualizado`);
        }
      }

      return updatedOrder.order;
    } catch (error) {
      logger.error(`Erro ao atualizar pedido Shopify #${orderId}:`, error);
      throw new AppError(`Erro ao atualizar pedido na Shopify: ${error.message}`, error.response?.status || 500);
    }
  }

  /**
   * Busca um pedido específico na Shopify
   */
  async getOrder(orderId) {
    try {
      const { data } = await this.makeRequest(() =>
        this.client.get(`/orders/${orderId}.json`)
      );
      return data.order;
    } catch (error) {
      logger.error(`Erro ao buscar pedido Shopify #${orderId}:`, error);
      throw new AppError(`Erro ao buscar pedido na Shopify: ${error.message}`, error.response?.status || 500);
    }
  }

  /**
   * Captura o pagamento de um pedido na Shopify
   */
  async capturePayment(orderId) {
    try {
      // Primeiro, busca as transações do pedido
      const { data: transactionsData } = await this.makeRequest(() =>
        this.client.get(`/orders/${orderId}/transactions.json`)
      );

      // Encontra a transação autorizada mais recente
      const authorizedTransaction = transactionsData.transactions
        .reverse()
        .find(t => t.kind === 'authorization' && t.status === 'success');

      if (!authorizedTransaction) {
        throw new AppError('Nenhuma transação autorizada encontrada para captura', 400);
      }

      // Captura o pagamento
      const { data } = await this.makeRequest(() =>
        this.client.post(`/orders/${orderId}/transactions.json`, {
          transaction: {
            kind: 'capture',
            parent_id: authorizedTransaction.id
          }
        })
      );

      logger.info(`Pagamento capturado com sucesso para pedido Shopify #${orderId}`);
      return data.transaction;
    } catch (error) {
      logger.error(`Erro ao capturar pagamento do pedido Shopify #${orderId}:`, error);
      throw new AppError(`Erro ao capturar pagamento na Shopify: ${error.message}`, error.response?.status || 500);
    }
  }

  /**
   * Reembolsa um pedido na Shopify
   */
  async refundOrder(orderId) {
    try {
      // Primeiro, busca as transações do pedido
      const { data: transactionsData } = await this.makeRequest(() =>
        this.client.get(`/orders/${orderId}/transactions.json`)
      );

      // Encontra a transação de captura mais recente
      const captureTransaction = transactionsData.transactions
        .reverse()
        .find(t => t.kind === 'capture' && t.status === 'success');

      if (!captureTransaction) {
        throw new AppError('Nenhuma transação capturada encontrada para reembolso', 400);
      }

      // Calcula o valor total do pedido
      const { data: orderData } = await this.makeRequest(() =>
        this.client.get(`/orders/${orderId}.json`)
      );

      // Cria o reembolso
      const { data } = await this.makeRequest(() =>
        this.client.post(`/orders/${orderId}/refunds.json`, {
          refund: {
            currency: orderData.order.currency,
            notify: true,
            note: 'Reembolso automático via Appmax',
            shipping: {
              full_refund: true
            },
            refund_line_items: orderData.order.line_items.map(item => ({
              line_item_id: item.id,
              quantity: item.quantity,
              restock: false
            }))
          }
        })
      );

      logger.info(`Reembolso criado com sucesso para pedido Shopify #${orderId}`);
      return data.refund;
    } catch (error) {
      logger.error(`Erro ao reembolsar pedido Shopify #${orderId}:`, error);
      throw new AppError(`Erro ao reembolsar pedido na Shopify: ${error.message}`, error.response?.status || 500);
    }
  }

  formatPhoneNumber(phone) {
    if (!phone) return null;
    // Remove caracteres não numéricos
    const numbers = phone.replace(/\D/g, '');
    if (numbers.length === 11 || numbers.length === 13) {
      const ddd = numbers.slice(-11, -9);
      const firstPart = numbers.slice(-9, -4);
      const lastPart = numbers.slice(-4);
      return `+55 (${ddd}) ${firstPart}-${lastPart}`;
    } else if (numbers.length === 10 || numbers.length === 12) {
      const ddd = numbers.slice(-10, -8);
      const firstPart = numbers.slice(-8, -4);
      const lastPart = numbers.slice(-4);
      return `+55 (${ddd}) ${firstPart}-${lastPart}`;
    }
    return null;
  }

  /**
   * Formata os dados do pedido para envio à Shopify.
   * Foi removido o campo additional_details, pois não faz parte da especificação.
   */
  formatOrderData(appmaxOrder, status, financialStatus) {
    const lineItems = [];
    const formattedPhone = this.formatPhoneNumber(appmaxOrder.customer.telephone);

    // Mapeia os status da Appmax para os da Shopify
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

    const finalFinancialStatus = shopifyStatus.financial[financialStatus] || 'pending';
    const finalFulfillmentStatus = shopifyStatus.fulfillment[status] || null;

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
        note_attributes: noteAttributes
      }
    };

    return orderData;
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

  isRetryableError(error) {
    const retryableStatusCodes = [408, 429, 500, 502, 503, 504];
    return retryableStatusCodes.includes(error.response?.status);
  }

  mapFinancialStatus(status) {
    const statusMap = {
      pending: 'pending',
      paid: 'paid',
      refunded: 'refunded',
      cancelled: 'voided'
    };
    return statusMap[status] || 'pending';
  }

  /**
   * Executa uma query/mutation GraphQL na API da Shopify
   */
  async graphql(query, variables = {}) {
    try {
      const { data } = await this.graphqlClient.post('', {
        query,
        variables
      });

      if (data.errors) {
        const errorMessage = data.errors.map(e => e.message).join('; ');
        throw new AppError(`Erro na chamada GraphQL: ${errorMessage}`, 400);
      }

      return data.data;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(`Erro ao executar query GraphQL: ${error.message}`, error.response?.status || 500);
    }
  }

  /**
   * Marca um pedido como pago usando a mutation orderMarkAsPaid
   */
  async markOrderAsPaid(orderId) {
    const mutation = `
      mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
        orderMarkAsPaid(input: $input) {
          order {
            id
            displayFinancialStatus
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables = {
      input: {
        id: `gid://shopify/Order/${orderId}`
      }
    };

    logger.info(`Marcando pedido #${orderId} como pago via GraphQL`);
    const result = await this.graphql(mutation, variables);

    if (result.orderMarkAsPaid.userErrors?.length > 0) {
      const errors = result.orderMarkAsPaid.userErrors.map(e => e.message).join('; ');
      throw new AppError(`Erro ao marcar pedido como pago: ${errors}`, 400);
    }

    return result.orderMarkAsPaid.order;
  }

  /**
   * Cancela um pedido usando a mutation orderCancel
   */
  async cancelOrder(orderId) {
    const mutation = `
      mutation orderCancel($input: OrderCancelInput!) {
        orderCancel(input: $input) {
          order {
            id
            displayFinancialStatus
            cancelledAt
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables = {
      input: {
        id: `gid://shopify/Order/${orderId}`
      }
    };

    logger.info(`Cancelando pedido #${orderId} via GraphQL`);
    const result = await this.graphql(mutation, variables);

    if (result.orderCancel.userErrors?.length > 0) {
      const errors = result.orderCancel.userErrors.map(e => e.message).join('; ');
      throw new AppError(`Erro ao cancelar pedido: ${errors}`, 400);
    }

    return result.orderCancel.order;
  }

  /**
   * Reembolsa um pedido usando a mutation refundCreate
   */
  async refundOrder(orderId) {
    // Primeiro, busca os detalhes do pedido para calcular o reembolso
    const { data: orderData } = await this.makeRequest(() =>
      this.client.get(`/orders/${orderId}.json`)
    );

    const mutation = `
      mutation refundCreate($input: RefundInput!) {
        refundCreate(input: $input) {
          refund {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const variables = {
      input: {
        orderId: `gid://shopify/Order/${orderId}`,
        notify: true,
        note: "Reembolso automático via Appmax",
        shipping: {
          fullRefund: true
        },
        refundLineItems: orderData.order.line_items.map(item => ({
          lineItemId: `gid://shopify/LineItem/${item.id}`,
          quantity: item.quantity,
          restockType: "NO_RESTOCK"
        }))
      }
    };

    logger.info(`Reembolsando pedido #${orderId} via GraphQL`);
    const result = await this.graphql(mutation, variables);

    if (result.refundCreate.userErrors?.length > 0) {
      const errors = result.refundCreate.userErrors.map(e => e.message).join('; ');
      throw new AppError(`Erro ao reembolsar pedido: ${errors}`, 400);
    }

    return result.refundCreate.refund;
  }

  formatTags(appmaxOrder, status) {
    const tags = [appmaxOrder.status, `appmax_status_${status}`];
    return tags.filter(Boolean);
  }
}

module.exports = new ShopifyService();
