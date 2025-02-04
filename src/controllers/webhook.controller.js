const shopifyService = require('../services/shopify.service');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');
const db = require('../database/db');

class WebhookController {
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

  async handleWebhook(req, res, next) {
    try {
      // Extrai o evento e os dados do webhook
      const { event, data, session_id } = req.body;
      if (!event || !data) {
        throw new AppError('Dados do webhook inválidos', 400);
      }

      // Ignora o evento CustomerInterested
      if (event === 'CustomerInterested') {
        logger.info(`Ignorando evento ${event} para o pedido #${data.id || 'N/A'}`);
        return res.status(200).json({ success: true, message: 'Evento ignorado' });
      }

      // Caso os dados do pedido estejam aninhados em "order", utiliza-os; caso contrário, usa o objeto data
      const orderData = data.order || data;

      // Extrai os nomes do cliente, considerando variações na nomenclatura
      const firstName = orderData.customer?.firstName || orderData.customer?.firstname || 'N/A';
      const lastName = orderData.customer?.lastName || orderData.customer?.lastname || '';
      const customerName = `${firstName} ${lastName}`.trim();
      const originalEmail = this.getOriginalEmail(orderData.customer?.email);

      logger.info('Webhook recebido:', {
        event,
        orderId: orderData.id,
        status: orderData.status,
        customer: customerName,
        email: originalEmail,
        session_id
      });

      // Prepara os metadados do pedido
      const metadata = {
        customer: {
          name: customerName,
          email: originalEmail
        },
        payment: {
          method: orderData.payment?.method,
          installments: orderData.payment?.installments
        },
        products: orderData.bundles,
        raw_data: {
          ...orderData,
          customer: orderData.customer ? {
            ...orderData.customer,
            email: originalEmail
          } : null
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
        financial_status: financialStatus
      });

      // Modifica o email no objeto antes de enviar para Shopify
      const shopifyOrderData = {
        ...orderData,
        customer: orderData.customer ? {
          ...orderData.customer,
          email: this.formatEmailForShopify(orderData.customer.email)
        } : null
      };

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

      res.status(200).json({ success: true });
    } catch (error) {
      if (error instanceof AppError) {
        return next(error);
      }
      next(new AppError('Erro interno ao processar webhook', 500));
    }
  }
}

module.exports = new WebhookController();
