const shopifyService = require('../services/shopify.service');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');

class WebhookController {
  /**
   * Verifica se os dados do pedido estão completos.
   * Aqui, por exemplo, consideramos que o pedido é completo se possuir o array "bundles"
   * (que contém os produtos) e informações do cliente.
   */
  hasFullOrderDetails(order) {
    return order && Array.isArray(order.bundles) && order.customer;
  }

  async handleWebhook(req, res, next) {
    try {
      // Extrai o evento e os dados do webhook
      const { event, data } = req.body;
      if (!event || !data) {
        throw new AppError('Dados do webhook inválidos', 400);
      }

      // Caso os dados do pedido estejam aninhados em "order", utiliza-os; caso contrário, usa o objeto data
      const orderData = data.order || data;

      // Extrai os nomes do cliente, considerando variações na nomenclatura (camelCase ou minúsculo)
      const firstName = orderData.customer?.firstName || orderData.customer?.firstname || 'N/A';
      const lastName = orderData.customer?.lastName || orderData.customer?.lastname || '';
      logger.info('Webhook recebido:', {
        event,
        orderId: orderData.id,
        status: orderData.status,
        customer: `${firstName} ${lastName}`.trim()
      });

      // Processa o evento recebido conforme seu tipo
      switch (event) {
        case 'OrderApproved':
        case 'OrderPaid':
        case 'OrderPaidByPix':
        case 'OrderIntegrated':
          await shopifyService.createOrUpdateOrder({
            appmaxOrder: orderData,
            status: 'paid',
            financialStatus: 'paid'
          });
          break;

        case 'OrderRefund':
          await shopifyService.refundOrder(orderData);
          break;

        case 'PaymentNotAuthorized':
        case 'PixExpired':
        case 'BoletoExpired':
          await shopifyService.cancelOrder(orderData);
          break;

        case 'OrderAuthorized':
        case 'PixGenerated':
        case 'OrderBilletCreated':
        case 'OrderPixCreated':
          await shopifyService.createOrUpdateOrder({
            appmaxOrder: orderData,
            status: 'pending',
            financialStatus: 'pending'
          });
          break;

        case 'ChargebackDispute':
          await shopifyService.createOrUpdateOrder({
            appmaxOrder: orderData,
            status: 'under_review',
            financialStatus: 'pending'
          });
          break;

        case 'ChargebackWon':
          await shopifyService.createOrUpdateOrder({
            appmaxOrder: orderData,
            status: 'authorized',
            financialStatus: 'paid'
          });
          break;

        default:
          logger.info(`Evento não tratado: ${event}`);
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
