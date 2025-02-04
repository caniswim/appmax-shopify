const shopifyService = require('../services/shopify.service');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');
const db = require('../database/db');

class WebhookController {
  // Lista de eventos que devem ser ignorados
  ignoredEvents = [
    'CustomerInterested',
    'CustomerCreated',
    'CustomerUpdated',
    'CustomerDeleted'
  ];

  /**
   * Verifica se os dados do pedido estão completos e válidos
   */
  validateOrderData(orderData) {
    // Verifica se há dados básicos do pedido
    if (!orderData || !orderData.id) {
      throw new AppError('Dados básicos do pedido ausentes', 400);
    }

    // Garante que existe a estrutura de cliente
    if (!orderData.customer) {
      orderData.customer = {};
    }

    // Normaliza os campos do cliente
    orderData.customer = {
      firstname: orderData.customer.firstName || orderData.customer.firstname || 'N/A',
      lastname: orderData.customer.lastName || orderData.customer.lastname || '',
      email: orderData.customer.email || null,
      telephone: orderData.customer.telephone || orderData.customer.phone || null,
      document_number: orderData.customer.document_number || '',
      // Endereço padrão se não existir
      address_street: orderData.customer.address_street || 'Não informado',
      address_street_number: orderData.customer.address_street_number || 'S/N',
      address_street_complement: orderData.customer.address_street_complement || '',
      address_city: orderData.customer.address_city || 'Não informado',
      address_state: orderData.customer.address_state || 'SP',
      postcode: orderData.customer.postcode || '00000-000'
    };

    // Garante que existe a estrutura de produtos
    if (!Array.isArray(orderData.bundles)) {
      orderData.bundles = [{
        products: [{
          name: 'Produto não especificado',
          quantity: 1,
          price: orderData.total || 0,
          sku: 'SKU-NAO-INFORMADO'
        }]
      }];
    }

    // Log de validação
    logger.info('Dados do pedido normalizados:', {
      orderId: orderData.id,
      customer: {
        name: `${orderData.customer.firstname} ${orderData.customer.lastname}`.trim(),
        email: orderData.customer.email,
        phone: orderData.customer.telephone
      },
      hasProducts: orderData.bundles.length > 0
    });

    return orderData;
  }

  /**
   * Verifica se os dados do pedido estão completos.
   */
  hasFullOrderDetails(order) {
    return order && Array.isArray(order.bundles) && order.customer;
  }

  /**
   * Adiciona prefixo ao email para evitar emails transacionais da Shopify
   */
  formatEmailForShopify(email) {
    if (!email) return null;
    return email.includes('email_') ? email : `email_${email}`;
  }

  /**
   * Remove o prefixo do email para armazenamento local
   */
  getOriginalEmail(email) {
    if (!email) return null;
    return email.replace(/^email_/, '');
  }

  /**
   * Normaliza o formato do telefone para o padrão aceito pela Shopify
   * Remove caracteres especiais e mantém apenas números
   * Adiciona código do país se necessário
   */
  normalizePhoneForShopify(phone) {
    if (!phone) return null;
    
    // Remove todos os caracteres não numéricos
    let normalized = phone.replace(/\D/g, '');
    
    // Se o número já começar com 55, não adiciona novamente
    if (!normalized.startsWith('55')) {
      normalized = `55${normalized}`;
    }
    
    // Garante que o número tem pelo menos 8 dígitos (sem contar código do país)
    if (normalized.length < 10) {
      logger.warn('Número de telefone muito curto:', { original: phone, normalized });
      return null;
    }
    
    // Formata como +55XXXXXXXXXX
    return `+${normalized}`;
  }

  async handleWebhook(req, res, next) {
    try {
      // Log da requisição completa
      logger.info('Webhook recebido - Request completo:', {
        headers: req.headers,
        body: req.body,
        ip: req.ip,
        timestamp: new Date().toISOString()
      });

      // Extrai o evento e os dados do webhook
      const { event, data, session_id } = req.body;
      if (!event || !data) {
        logger.warn('Dados do webhook inválidos:', { body: req.body });
        throw new AppError('Dados do webhook inválidos', 400);
      }

      // Verifica se o evento deve ser ignorado
      if (this.ignoredEvents.includes(event)) {
        logger.info(`Ignorando evento ${event}`, {
          orderId: data.id || 'N/A',
          session_id,
          event,
          customer: data.fullname || `${data.firstname || ''} ${data.lastname || ''}`.trim() || 'N/A',
          timestamp: new Date().toISOString()
        });
        return res.status(200).json({ 
          success: true, 
          message: `Evento ${event} ignorado`,
          ignored: true
        });
      }

      // Caso os dados do pedido estejam aninhados em "order", utiliza-os; caso contrário, usa o objeto data
      let orderData = data.order || data;

      // Valida e normaliza os dados do pedido
      orderData = this.validateOrderData(orderData);

      // Extrai os nomes do cliente já normalizados
      const customerName = `${orderData.customer.firstname} ${orderData.customer.lastname}`.trim();
      const originalEmail = this.getOriginalEmail(orderData.customer.email);

      // Log detalhado do pedido
      logger.info('Processando webhook:', {
        event,
        orderId: orderData.id,
        status: orderData.status,
        customer: {
          name: customerName,
          email: originalEmail,
          phone: orderData.customer.telephone
        },
        session_id,
        platform: orderData.platform || 'unknown',
        woocommerce_id: orderData.woocommerce_order_id,
        timestamp: new Date().toISOString(),
        validatedData: true
      });

      // Prepara os metadados do pedido
      const metadata = {
        customer: {
          name: customerName,
          email: originalEmail,
          phone: orderData.customer.telephone,
          document: orderData.customer.document_number,
          address: {
            street: orderData.customer.address_street,
            number: orderData.customer.address_street_number,
            complement: orderData.customer.address_street_complement,
            city: orderData.customer.address_city,
            state: orderData.customer.address_state,
            postcode: orderData.customer.postcode
          }
        },
        payment: {
          method: orderData.payment?.method || 'N/A',
          installments: orderData.payment?.installments || 1
        },
        products: orderData.bundles,
        raw_data: {
          ...orderData,
          customer: {
            ...orderData.customer,
            email: originalEmail
          }
        }
      };

      // Define o status baseado no evento
      let status = 'pending';
      let financialStatus = 'pending';

      switch (event) {
        case 'OrderApproved':
        case 'OrderPaid':
        case 'OrderPaidByPix':
        case 'OrderIntegrated':
        case 'ChargebackWon':
          status = 'paid';
          financialStatus = 'paid';
          break;

        case 'PaymentNotAuthorized':
        case 'PixExpired':
        case 'BoletoExpired':
          status = 'cancelled';
          financialStatus = 'cancelled';
          break;

        case 'OrderRefund':
          status = 'refunded';
          financialStatus = 'refunded';
          break;

        case 'ChargebackDispute':
          status = 'under_review';
          financialStatus = 'pending';
          break;

        case 'OrderAuthorized':
        case 'PixGenerated':
        case 'OrderBilletCreated':
        case 'OrderPixCreated':
          status = 'pending';
          financialStatus = 'pending';
          break;
      }

      // Salva ou atualiza o pedido no banco local
      await db.saveAppmaxOrder(orderData.id, status, {
        ...metadata,
        event,
        financial_status: financialStatus,
        normalized: true
      });

      // Modifica o email e normaliza o telefone antes de enviar para Shopify
      const normalizedPhone = this.normalizePhoneForShopify(orderData.customer.telephone);
      const shopifyOrderData = {
        ...orderData,
        customer: {
          ...orderData.customer,
          email: this.formatEmailForShopify(orderData.customer.email),
          telephone: normalizedPhone,
          phone: normalizedPhone
        }
      };

      // Atualiza também o telefone nos endereços
      if (shopifyOrderData.shipping_address) {
        shopifyOrderData.shipping_address.phone = normalizedPhone;
      }
      if (shopifyOrderData.billing_address) {
        shopifyOrderData.billing_address.phone = normalizedPhone;
      }

      // Log antes de enviar para Shopify
      logger.info('Enviando dados para Shopify:', {
        orderId: orderData.id,
        email: shopifyOrderData.customer.email,
        originalPhone: orderData.customer.telephone,
        normalizedPhone,
        status,
        financialStatus
      });

      // Processa o pedido no Shopify
      if (status === 'cancelled') {
        await shopifyService.cancelOrder(shopifyOrderData);
      } else if (status === 'refunded') {
        await shopifyService.refundOrder(shopifyOrderData);
      } else {
        await shopifyService.createOrUpdateOrder({
          appmaxOrder: shopifyOrderData,
          status,
          financialStatus
        });
      }

      // Log de sucesso no final
      logger.info('Webhook processado com sucesso:', {
        event,
        orderId: orderData.id,
        status,
        financialStatus,
        customer: {
          name: customerName,
          hasEmail: !!originalEmail,
          hasPhone: !!orderData.customer.telephone
        },
        timestamp: new Date().toISOString()
      });

      res.status(200).json({ success: true });
    } catch (error) {
      // Log detalhado de erro
      logger.error('Erro ao processar webhook:', {
        error: {
          message: error.message,
          stack: error.stack,
          code: error.statusCode || 500
        },
        request: {
          body: req.body,
          headers: req.headers,
          ip: req.ip
        },
        timestamp: new Date().toISOString()
      });

      if (error instanceof AppError) {
        return next(error);
      }
      next(new AppError('Erro interno ao processar webhook', 500));
    }
  }
}

module.exports = new WebhookController();
